/**
 * 会话持久化：把解析结果（来源 / 参数 / 诊断 / 失败原因，不含图片本体）存入 IndexedDB，
 * 刷新或关闭浏览器后历史记录仍在，重新拖入原文件即按指纹自动回挂。
 * file:// 直接打开、隐私模式等场景下 IndexedDB 可能不可用——启动时用真实读写探测，
 * 不可用则整体降级为纯内存（与未引入持久化前行为一致）；所有读写失败均静默吞掉。
 */
import type { ImageItem, ImageSource, ParsedParams, RawMetadata } from '../types'

const DB_NAME = 'comfyui-info'
const DB_VERSION = 1
const STORE = 'items'

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
export function recordKey(it: { path?: string; name: string; size: number; mtime: number }): string {
  return `${it.path ?? it.name}|${it.size}|${it.mtime}`
}

let archivedSeq = 0

/** 列表项 → 存档记录；解析中的项不入库（等出结果时再写） */
export function toRecord(item: ImageItem): PersistRecord | null {
  if (item.status === 'pending' || item.status === 'parsing') return null
  return {
    key: recordKey(item),
    name: item.name,
    path: item.path,
    size: item.size,
    mtime: item.mtime,
    status: item.status === 'error' ? 'error' : 'done',
    source: item.source,
    raw: item.raw,
    params: item.params,
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'))
  })
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

/**
 * 可用性探测：完整走一遍「建库 → 写入 → 删除」探测记录。
 * 任何一步失败（含 file:// 受限、Safari 隐私模式直接抛错）即判定不可用，结果进程内缓存。
 */
export async function probePersistence(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false
    const db = await openDb()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      store.put({ key: '__probe__', savedAt: Date.now() })
      store.delete('__probe__')
      await settled(tx)
    } finally {
      db.close()
    }
    return true
  } catch {
    return false
  }
}

/** 读取全部存档，剔除无法识别的历史记录（如旧版本结构） */
export async function loadPersisted(): Promise<PersistRecord[]> {
  const db = await openDb()
  try {
    const req = db.transaction(STORE).objectStore(STORE).getAll()
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as unknown[])
      req.onerror = () => reject(req.error ?? new Error('读取存档失败'))
    })
    return rows.filter(isValidRecord)
  } finally {
    db.close()
  }
}

export async function putPersisted(records: PersistRecord[]): Promise<void> {
  if (!records.length) return
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const rec of records) store.put(rec)
    await settled(tx)
  } finally {
    db.close()
  }
}

export async function deletePersisted(keys: string[]): Promise<void> {
  if (!keys.length) return
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const key of keys) store.delete(key)
    await settled(tx)
  } finally {
    db.close()
  }
}

/** 清空全部存档（随「清空列表」一并触发，所见即所得） */
export async function clearPersisted(): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await settled(tx)
  } finally {
    db.close()
  }
}
