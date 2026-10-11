/**
 * 会话持久化：把解析结果（来源 / 参数 / 诊断 / 失败原因，不含图片本体）存入 IndexedDB，
 * 刷新或关闭浏览器后历史记录仍在，重新拖入原文件即按指纹自动回挂。
 * file:// 直接打开、隐私模式等场景下 IndexedDB 可能不可用——启动时用真实读写探测，
 * 不可用则整体降级为纯内存（与未引入持久化前行为一致）；所有读写失败均静默吞掉。
 *
 * v3 存储布局（OPT-5）：工作流 / 参数文本等大字段按内容寻址拆入 blobs store，
 * 同内容全库存一份、记录侧只存引用——同工作流批量出图的万级存档体积降一个量级。
 * v2 旧记录（大文本内联）读取时原样可用，并一次性写回迁移为 v3。
 * 孤儿 blob（记录被删 / 内容更新后遗留）以「历史去重内容数」为上界，体积可忽略，
 * 不做 GC——回收需要跨 store 对账，竞态风险大于收益。
 */
import { toRaw } from 'vue'
import type { ImageItem, ImageSource, ParsedParams, RawMetadata } from '../types'

const DB_NAME = 'comfyui-info'
const DB_VERSION = 3
const STORE = 'items'
const BLOB_STORE = 'blobs'
const HANDLE_STORE = 'handles'

/** IndexedDB 中的单条存档；主键与列表去重指纹同一构造 */
export interface PersistRecord {
  key: string
  name: string
  path?: string
  size: number
  mtime: number
  status: 'done' | 'error'
  source: ImageSource
  raw: RawMetadata
  params?: ParsedParams
  error?: string
  savedAt: number
}

/** 存档主键 = 去重指纹（路径或文件名|大小|修改时间）：回挂匹配与去重共用同一构造 */
export function recordKey(it: {
  path?: string
  name: string
  size: number
  mtime: number
}): string {
  return `${it.path ?? it.name}|${it.size}|${it.mtime}`
}

let archivedSeq = 0

/** 列表项 → 存档记录；解析中的项不入库（等出结果时再写） */
export function toRecord(item: ImageItem): PersistRecord | null {
  if (item.status === 'pending') return null
  // item 是 reactive 深代理：直接引用 item.raw / item.params 会把 Proxy 传给 put，
  // 结构化克隆抛 DataCloneError 导致写入永久失败——toRaw 解出原始可克隆对象
  return {
    key: recordKey(item),
    name: item.name,
    path: item.path,
    size: item.size,
    mtime: item.mtime,
    status: item.status === 'error' ? 'error' : 'done',
    source: item.source,
    raw: toRaw(item.raw),
    params: item.params ? toRaw(item.params) : undefined,
    error: item.error,
    savedAt: Date.now(),
  }
}

/** 存档记录 → 无文件的存档项（detached），等待重新拖入原文件回挂 */
export function fromRecord(rec: PersistRecord): ImageItem {
  return {
    id: `img-archived-${++archivedSeq}`,
    url: '',
    name: rec.name,
    path: rec.path,
    size: rec.size,
    mtime: rec.mtime,
    status: rec.status,
    source: rec.source,
    raw: rec.raw,
    params: rec.params,
    error: rec.error,
    detached: true,
  }
}

function isValidRecord(value: unknown): value is PersistRecord {
  const rec = value as PersistRecord
  return (
    !!rec &&
    typeof rec.key === 'string' &&
    typeof rec.name === 'string' &&
    typeof rec.mtime === 'number' &&
    (rec.status === 'done' || rec.status === 'error') &&
    !!rec.raw
  )
}

/* ---------- v3：大文本内容寻址 ---------- */

/**
 * 工作流 / 参数文本的内容指纹：双 32 位 FNV 车道（不同乘数）+ 精确长度，
 * ~64 位有效位宽——键即存储地址，万级去重下碰撞概率可忽略。
 * 结果按内容缓存：同工作流批量出图的重复串在一次会话里只需哈希一次。
 */
const hashCache = new Map<string, string>()

function contentHash(text: string): string {
  const cached = hashCache.get(text)
  if (cached) return cached
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  const hash = `${(h1 >>> 0).toString(36)}${(h2 ^ text.length).toString(36)}${text.length.toString(36)}`
  if (hashCache.size > 8192) hashCache.clear() // 防御性上限：内容种类异常膨胀时整体重来
  hashCache.set(text, hash)
  return hash
}

/** v3 存储记录：大文本字段以内容哈希引用 blobs store，结构化参数已摘除 rawText */
export interface StoredRecord {
  v: 3
  key: string
  name: string
  path?: string
  size: number
  mtime: number
  status: 'done' | 'error'
  source: ImageSource
  /** 诊断线索（小文本，内联存储） */
  hints?: string[]
  error?: string
  savedAt: number
  /** 以下四者为 blobs 引用（内容哈希），undefined = 无此内容 */
  prompt?: string
  workflow?: string
  parameters?: string
  rawText?: string
  params?: Omit<ParsedParams, 'rawText'>
}

export interface BlobRow {
  hash: string
  text: string
}

/** 记录 → 存储形状：大文本拆入 blobs（同内容去重），params 摘除 rawText（导出供往返单测） */
export function splitPersistRecord(rec: PersistRecord): { stored: StoredRecord; blobs: BlobRow[] } {
  const blobs: BlobRow[] = []
  const ref = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined
    const hash = contentHash(text)
    if (!blobs.some((b) => b.hash === hash)) blobs.push({ hash, text })
    return hash
  }
  let params: StoredRecord['params']
  if (rec.params) {
    const copy: ParsedParams = { ...rec.params }
    delete copy.rawText
    params = copy
  }
  const stored: StoredRecord = {
    v: 3,
    key: rec.key,
    name: rec.name,
    path: rec.path,
    size: rec.size,
    mtime: rec.mtime,
    status: rec.status,
    source: rec.source,
    hints: rec.raw.hints,
    error: rec.error,
    savedAt: rec.savedAt,
    prompt: ref(rec.raw.prompt),
    workflow: ref(rec.raw.workflow),
    parameters: ref(rec.raw.parameters),
    rawText: ref(rec.params?.rawText),
    params,
  }
  return { stored, blobs }
}

/** 存储形状 → 记录：按 blobs 物化引用；引用悬空视为记录损坏，返回 null 剔除 */
export function materializeRecord(
  stored: StoredRecord,
  blobs: Map<string, string>,
): PersistRecord | null {
  const pick = (hash: string | undefined): string | undefined =>
    hash === undefined ? undefined : blobs.get(hash)
  const prompt = pick(stored.prompt)
  const workflow = pick(stored.workflow)
  const parameters = pick(stored.parameters)
  const rawText = pick(stored.rawText)
  if (
    (stored.prompt !== undefined && prompt === undefined) ||
    (stored.workflow !== undefined && workflow === undefined) ||
    (stored.parameters !== undefined && parameters === undefined) ||
    (stored.rawText !== undefined && rawText === undefined)
  ) {
    return null
  }
  let params: ParsedParams | undefined
  if (stored.params) {
    // 旧记录缺少 v3 新增的数组字段：显式回填空数组保证类型与运行时完整
    params = {
      ...stored.params,
      vaes: stored.params.vaes ?? [],
      upscalers: stored.params.upscalers ?? [],
      controlNets: stored.params.controlNets ?? [],
    }
    if (rawText !== undefined) params.rawText = rawText
  }
  return {
    key: stored.key,
    name: stored.name,
    path: stored.path,
    size: stored.size,
    mtime: stored.mtime,
    status: stored.status,
    source: stored.source,
    raw: { source: stored.source, prompt, workflow, parameters, hints: stored.hints },
    params,
    error: stored.error,
    savedAt: stored.savedAt,
  }
}

function isStoredRecord(value: unknown): value is StoredRecord {
  const rec = value as StoredRecord
  return (
    !!rec &&
    rec.v === 3 &&
    typeof rec.key === 'string' &&
    typeof rec.name === 'string' &&
    typeof rec.mtime === 'number' &&
    (rec.status === 'done' || rec.status === 'error') &&
    typeof rec.source === 'string'
  )
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
      if (!req.result.objectStoreNames.contains(BLOB_STORE)) {
        // v3：大文本内容寻址存储（同内容只存一份，记录侧存哈希引用）
        req.result.createObjectStore(BLOB_STORE, { keyPath: 'hash' })
      }
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        // 记住「最近扫描目录」的句柄（File System Access API，仅 Chromium 系支持并可结构化克隆）
        req.result.createObjectStore(HANDLE_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'))
  })
}

/**
 * 连接单例：批量扫描时每 500ms 就有一次写库事务，缓存连接避免每次开关数据库的开销。
 * 打开失败不缓存（下次调用重试）；连接被意外关闭或其他标签页升级版本时重置，后续调用重新打开。
 */
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().then(
      (db) => {
        db.onclose = () => {
          dbPromise = null
        }
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        return db
      },
      (err) => {
        dbPromise = null
        throw err
      },
    )
  }
  return dbPromise
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

function getAllFrom(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  const req = db.transaction(storeName).objectStore(storeName).getAll()
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as unknown[])
    req.onerror = () => reject(req.error ?? new Error('读取存档失败'))
  })
}

/**
 * 可用性探测：完整走一遍「建库 → 写入 → 删除」探测记录。
 * 任何一步失败（含 file:// 受限、Safari 隐私模式直接抛错）即判定不可用，结果进程内缓存。
 */
export async function probePersistence(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false
    const db = await getDb()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.put({ key: '__probe__', savedAt: Date.now() })
    store.delete('__probe__')
    await settled(tx)
    return true
  } catch (err) {
    // 探测失败即判定环境不可用；保留告警便于定位具体失败环节
    console.warn('[comfyui-info] 持久化探测失败，降级纯内存:', err)
    return false
  }
}

/** 读取全部存档：v3 记录按 blobs 物化，v2 旧记录原样可用并写回迁移 */
export async function loadPersisted(): Promise<PersistRecord[]> {
  const db = await getDb()
  const itemRows = await getAllFrom(db, STORE)
  const blobRows = (await getAllFrom(db, BLOB_STORE)) as BlobRow[]
  const blobs = new Map(blobRows.map((b) => [b.hash, b.text]))
  const records: PersistRecord[] = []
  const legacy: PersistRecord[] = []
  for (const row of itemRows) {
    if (isStoredRecord(row)) {
      const rec = materializeRecord(row, blobs)
      if (rec) records.push(rec)
    } else if (isValidRecord(row)) {
      records.push(row)
      legacy.push(row)
    }
  }
  // v2 → v3 一次性迁移：写失败只是维持旧形状（下次读取再试），不影响本次会话
  if (legacy.length) void putPersisted(legacy).catch(() => {})
  return records
}

export async function putPersisted(
  records: PersistRecord[],
  /** 可选取消检查：await getDb 期间批次被作废（清空列表）时放弃本次写入，防复活已清历史 */
  cancelled?: () => boolean,
): Promise<void> {
  if (!records.length) return
  const splits = records.map(splitPersistRecord)
  const db = await getDb()
  if (cancelled?.()) return
  // 同一事务先写 blobs 再写记录：中断最多留下无引用的孤儿 blob，不会出现记录引用悬空
  const tx = db.transaction([STORE, BLOB_STORE], 'readwrite')
  const blobStore = tx.objectStore(BLOB_STORE)
  const itemStore = tx.objectStore(STORE)
  for (const { blobs } of splits) {
    for (const b of blobs) blobStore.put(b)
  }
  for (const { stored } of splits) itemStore.put(stored)
  await settled(tx)
}

export async function deletePersisted(keys: string[], cancelled?: () => boolean): Promise<void> {
  if (!keys.length) return
  const db = await getDb()
  if (cancelled?.()) return
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const key of keys) store.delete(key)
  await settled(tx)
}

/** 清空全部存档（随「清空列表」一并触发，所见即所得），内容 blob 一并清除 */
export async function clearPersisted(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction([STORE, BLOB_STORE], 'readwrite')
  tx.objectStore(STORE).clear()
  tx.objectStore(BLOB_STORE).clear()
  await settled(tx)
}

/* ---------- 目录书签（FEAT-7 多目录：按目录名存储，可切换重扫目标） ---------- */

export interface DirBookmark {
  name: string
  handle: FileSystemDirectoryHandle
  savedAt: number
}

/** 保存 / 更新目录书签（以目录名为键，同名覆盖并刷新时间） */
export async function saveDirBookmark(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).put({ id: handle.name, handle, savedAt: Date.now() })
  await settled(tx)
}

/** 读取全部书签（新→旧）；v2 单一 'last' 行一次性迁移为按目录名存储 */
export async function loadDirBookmarks(): Promise<DirBookmark[]> {
  const db = await getDb()
  const rows = (await getAllFrom(db, HANDLE_STORE)) as {
    id?: string
    handle?: FileSystemDirectoryHandle
    savedAt?: number
  }[]
  const out: DirBookmark[] = []
  let legacy: DirBookmark | null = null
  for (const row of rows) {
    if (!row?.handle) continue
    if (row.id === 'last') {
      legacy = { name: row.handle.name, handle: row.handle, savedAt: row.savedAt ?? 0 }
    } else if (typeof row.id === 'string') {
      out.push({ name: row.id, handle: row.handle, savedAt: row.savedAt ?? 0 })
    }
  }
  if (legacy) {
    out.push(legacy)
    void saveDirBookmark(legacy.handle)
      .then(() => {
        // 目录恰好名为 "last" 时迁移写入与旧行同键，不能再删
        if (legacy!.name !== 'last') return removeDirBookmarkRow('last')
      })
      .catch(() => {})
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

async function removeDirBookmarkRow(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).delete(id)
  await settled(tx)
}

export async function removeDirBookmark(name: string): Promise<void> {
  await removeDirBookmarkRow(name)
}

export async function clearDirBookmarks(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).clear()
  await settled(tx)
}

/* ---------- 存档备份（FEAT-6：导出 / 导入，防清库与跨设备迁移） ---------- */

const ARCHIVE_VERSION = 3

/** 存档备份序列化：与存档记录同构（含参数与诊断信息，不含图片本体） */
export function serializeArchive(records: PersistRecord[]): string {
  return JSON.stringify(
    {
      version: ARCHIVE_VERSION,
      exportedAt: new Date().toISOString(),
      count: records.length,
      records,
    },
    null,
    2,
  )
}

/** 解析存档备份：剔除无法识别的条目；整体结构不对时抛错由调用方提示 */
export function parseArchive(text: string): PersistRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }
  const o = parsed as { records?: unknown }
  if (!o || !Array.isArray(o.records)) throw new Error('缺少 records 数组，不是存档备份文件')
  return o.records.filter(isValidRecord)
}

/** 导入存档：与库存同指纹（key）的记录跳过，返回实际写入的新记录 */
export async function importPersisted(records: PersistRecord[]): Promise<PersistRecord[]> {
  if (!records.length) return []
  const db = await getDb()
  const rows = await getAllFrom(db, STORE)
  const existing = new Set(rows.map((r) => (r as { key?: unknown }).key))
  const fresh = records.filter((r) => !existing.has(r.key))
  if (fresh.length) await putPersisted(fresh)
  return fresh
}
