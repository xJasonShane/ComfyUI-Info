/**
 * persist.ts 真实 IndexedDB 路径直测（E2）：store.test.ts 把 persist 全量 mock，
 * 探测 / 建库 / blob 去重 / 目录书签 / v2→v3 迁移等真实库行为在那里覆盖不到，
 * 这里以 fake-indexeddb 走完整读写链路。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  clearContentHashCache,
  clearDirBookmarks,
  clearPersisted,
  deletePersisted,
  importPersisted,
  loadDirBookmarks,
  loadPersisted,
  materializeRecord,
  parseArchive,
  probePersistence,
  putPersisted,
  recordKey,
  removeDirBookmark,
  saveDirBookmark,
  serializeArchive,
  splitPersistRecord,
  type DirBookmark,
  type PersistRecord,
} from '../src/lib/persist'

const rec = (over: Partial<PersistRecord> = {}): PersistRecord => ({
  key: 'a.png|1|1000',
  name: 'a.png',
  size: 1,
  mtime: 1000,
  status: 'done',
  source: 'comfyui',
  raw: { source: 'comfyui' },
  savedAt: 1,
  ...over,
})

/** 直接打开底层库（与 persist 同名同版本），用于断言 store 形状 / blob 去重 / 手工植行 */
async function rawDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('comfyui-info')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function rawPut(storeName: string, value: unknown): Promise<void> {
  const db = await rawDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function rawCount(storeName: string): Promise<number> {
  const db = await rawDb()
  const n = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(storeName).objectStore(storeName).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return n
}

async function rawGet(storeName: string, key: string): Promise<unknown> {
  const db = await rawDb()
  const row = await new Promise<unknown>((resolve, reject) => {
    const req = db.transaction(storeName).objectStore(storeName).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return row
}

beforeAll(async () => {
  expect(await probePersistence()).toBe(true)
})

beforeEach(async () => {
  await clearPersisted()
  await clearDirBookmarks()
})

describe('存档读写（真实 IndexedDB）', () => {
  it('写入后完整读回：大文本经 blobs 物化还原，同内容全局去重', async () => {
    const bigPrompt = `{"class_type":"KSampler","inputs":{"seed":${'x'.repeat(500)}}}`
    await putPersisted([
      rec({ key: 'v1/a.png|1|1', name: 'a.png', raw: { source: 'comfyui', prompt: bigPrompt } }),
      rec({ key: 'v1/b.png|2|2', name: 'b.png', raw: { source: 'comfyui', prompt: bigPrompt } }),
      rec({
        key: 'v1/c.png|3|3',
        name: 'c.png',
        source: 'a1111',
        raw: { source: 'a1111', parameters: 'cat\nSteps: 20' },
        params: {
          positive: ['cat'],
          negative: [],
          models: [],
          loras: [],
          samplers: [],
          vaes: [],
          upscalers: [],
          controlNets: [],
          nodeCount: 0,
          rawText: 'cat\nSteps: 20',
        },
      }),
    ])
    const rows = await loadPersisted()
    expect(rows).toHaveLength(3)
    const a = rows.find((r) => r.name === 'a.png')!
    const b = rows.find((r) => r.name === 'b.png')!
    const c = rows.find((r) => r.name === 'c.png')!
    expect(a.raw.prompt).toBe(bigPrompt)
    expect(b.raw.prompt).toBe(bigPrompt)
    expect(c.params?.rawText).toBe('cat\nSteps: 20')
    expect(c.raw.parameters).toBe('cat\nSteps: 20')

    // 同内容 prompt 只占一个 blob 行（内容寻址去重）
    expect(await rawCount('blobs')).toBe(2) // bigPrompt + 'cat\nSteps: 20'
  })

  it('同批同内容记录只提交一次 blob，避免万级批次写放大（OPT-1）', async () => {
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put')
    try {
      const prompt = '{"3":{"class_type":"KSampler","inputs":{"seed":42}}}'
      const records = Array.from({ length: 50 }, (_, i) =>
        rec({
          key: `batch/${i}.png|1|1`,
          name: `${i}.png`,
          raw: { source: 'comfyui', prompt },
        }),
      )
      await putPersisted(records)
      const blobPuts = putSpy.mock.calls.filter(
        ([value]) => typeof (value as { hash?: unknown }).hash === 'string',
      )
      expect(blobPuts).toHaveLength(1)
      expect(await rawCount('items')).toBe(50)
      expect(await rawCount('blobs')).toBe(1)
    } finally {
      putSpy.mockRestore()
    }
  })

  it('清空内容哈希缓存后相同内容仍生成同一 blob 引用（OPT-2）', () => {
    const text = '{"3":{"class_type":"KSampler","inputs":{"seed":7}}}'
    const first = splitPersistRecord(rec({ raw: { source: 'comfyui', prompt: text } })).stored
    clearContentHashCache()
    const second = splitPersistRecord(rec({ raw: { source: 'comfyui', prompt: text } })).stored
    expect(second.prompt).toBe(first.prompt)
  })

  it('删除与清空：deletePersisted 精确删行，clearPersisted 连 blobs 一起清', async () => {
    await putPersisted([rec({ key: 'k1' }), rec({ key: 'k2' })])
    await deletePersisted(['k1'])
    expect((await loadPersisted()).map((r) => r.key)).toEqual(['k2'])
    await clearPersisted()
    expect(await loadPersisted()).toEqual([])
    expect(await rawCount('blobs')).toBe(0)
  })

  it('cancelled 回调为真时放弃本次写入（清空列表在途作废语义）', async () => {
    await putPersisted([rec()], () => true)
    expect(await loadPersisted()).toEqual([])
  })

  it('importPersisted 与库存同指纹跳过，只写新增', async () => {
    await putPersisted([rec({ key: 'exists|1|1' })])
    const fresh = await importPersisted([
      rec({ key: 'exists|1|1' }),
      rec({ key: 'new|2|2', name: 'b.png' }),
    ])
    expect(fresh.map((r) => r.key)).toEqual(['new|2|2'])
    expect(await rawCount('items')).toBe(2)
  })
})

describe('v2 → v3 迁移（真实库）', () => {
  it('旧形状记录（无 v 字段、大文本内联）读回可用并一次性写回 v3', async () => {
    await rawPut('items', {
      key: 'legacy|1|1',
      name: 'old.png',
      size: 1,
      mtime: 1,
      status: 'done',
      source: 'comfyui',
      raw: { source: 'comfyui', prompt: '{"class_type":"KSampler"}' },
      savedAt: 1,
    })
    const rows = await loadPersisted()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.raw.prompt).toBe('{"class_type":"KSampler"}')
    // 迁移写回：库内该行已升级为 v3 存储形状（大文本拆 blobs）
    const row = (await rawGet('items', 'legacy|1|1')) as { v?: number; prompt?: unknown }
    expect(row?.v).toBe(3)
    expect(typeof row?.prompt).toBe('string') // blob 哈希引用
  })

  it('损坏行（缺 status / raw）被剔除，不污染其余记录', async () => {
    await rawPut('items', { key: 'bad', name: 'x.png' })
    await putPersisted([rec({ key: 'good|1|1' })])
    const rows = await loadPersisted()
    expect(rows.map((r) => r.key)).toEqual(['good|1|1'])
  })

  it('materializeRecord 悬空 blob 引用视为损坏返回 null', () => {
    const { stored } = splitPersistRecord(rec({ raw: { source: 'comfyui', prompt: 'w' } }))
    expect(materializeRecord(stored, new Map())).toBeNull()
    expect(materializeRecord(stored, new Map([[stored.prompt!, 'w']]))?.raw.prompt).toBe('w')
  })
})

describe('目录书签（真实 IndexedDB）', () => {
  const handle = (name: string) => ({ name }) as unknown as FileSystemDirectoryHandle

  it('保存 / 读取 / 删除书签，按保存时间新→旧排序', async () => {
    await saveDirBookmark(handle('dir-a'))
    await new Promise((r) => setTimeout(r, 5))
    await saveDirBookmark(handle('dir-b'))
    let rows = await loadDirBookmarks()
    expect(rows.map((r) => r.name)).toEqual(['dir-b', 'dir-a'])
    await removeDirBookmark('dir-a')
    rows = await loadDirBookmarks()
    expect(rows.map((r) => r.name)).toEqual(['dir-b'])
  })

  it('v2 单一 last 行读取时迁移为按目录名存储', async () => {
    await rawPut('handles', { id: 'last', handle: handle('legacy-dir'), savedAt: 42 })
    const rows = await loadDirBookmarks()
    expect(rows.map((r) => r.name)).toEqual(['legacy-dir'])
    const migrated = (await rawGet('handles', 'legacy-dir')) as { id?: string }
    expect(migrated?.id).toBe('legacy-dir')
    expect(await rawGet('handles', 'last')).toBeUndefined()
  })

  it('目录恰好名为 last 时迁移不误删同键行', async () => {
    await rawPut('handles', { id: 'last', handle: handle('last'), savedAt: 42 })
    const rows: DirBookmark[] = await loadDirBookmarks()
    expect(rows.map((r) => r.name)).toEqual(['last'])
    expect(await rawGet('handles', 'last')).not.toBeUndefined()
  })
})

describe('缩略图持久化（F2）', () => {
  it('thumbB64 随 blobs 内容寻址入库并在读回时还原', async () => {
    const r = rec({ key: 'thumb|1|1', thumbB64: 'QUJDREVG' })
    const { stored, blobs } = splitPersistRecord(r)
    expect(stored.thumb).toBe(blobs.find((b) => b.text === 'QUJDREVG')!.hash)
    await putPersisted([r])
    const rows = await loadPersisted()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.thumbB64).toBe('QUJDREVG')
  })

  it('备份导出剥离缩略图（体积换体验，重新解析原图可再得）', () => {
    const text = serializeArchive([rec({ key: 'k1', thumbB64: 'QUJDREVG' })])
    expect(text).not.toContain('QUJDREVG')
    const { records } = parseArchive(text)
    expect(records[0]!.thumbB64).toBeUndefined()
  })
})

describe('存档备份（serialize / parse）', () => {
  it('备份往返保留 records / favorites / tags；非法条目剔除', () => {
    const text = serializeArchive(
      [rec({ key: 'k1' }), { key: 42 } as unknown as PersistRecord],
      ['fav|1|1'],
      { k1: ['精选'] },
    )
    const { records, favorites, tags } = parseArchive(text)
    expect(records.map((r) => r.key)).toEqual(['k1'])
    expect(favorites).toEqual(['fav|1|1'])
    expect(tags).toEqual({ k1: ['精选'] })
  })

  it('非 JSON / 缺 records 数组时抛可读错误', () => {
    expect(() => parseArchive('not json')).toThrow('JSON')
    expect(() => parseArchive('{"foo":1}')).toThrow('records')
  })

  it('recordKey 与指纹构造一致', () => {
    // path 形态（省略 name）是刻意的鸭子类型调用：recordKey 以 path ?? name 取位置段
    expect(
      recordKey({ path: 'v1/a.png', size: 3, mtime: 9 } as unknown as Parameters<
        typeof recordKey
      >[0]),
    ).toBe('v1/a.png|3|9')
    expect(recordKey({ name: 'a.png', size: 3, mtime: 9 })).toBe('a.png|3|9')
  })
})
