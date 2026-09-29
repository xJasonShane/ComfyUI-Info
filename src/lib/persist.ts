/**
 * 会话持久化：把解析结果（来源 / 参数 / 诊断 / 失败原因，不含图片本体）存入 IndexedDB，
 * 刷新或关闭浏览器后历史记录仍在，重新拖入原文件即按指纹自动回挂。
 * file:// 直接打开、隐私模式等场景下 IndexedDB 可能不可用——启动时用真实读写探测，
 * 不可用则整体降级为纯内存（与未引入持久化前行为一致）；所有读写失败均静默吞掉。
 */
import { toRaw } from 'vue'
import type { ImageItem, ImageSource, ParsedParams, RawMetadata } from '../types'

const DB_NAME = 'comfyui-info'
const DB_VERSION = 2
const STORE = 'items'
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
export function recordKey(it: { path?: string; name: string; size: number; mtime: number }): string {
  return `${it.path ?? it.name}|${it.size}|${it.mtime}`
}

let archivedSeq = 0

/** 列表项 → 存档记录；解析中的项不入库（等出结果时再写） */
export function toRecord(item: ImageItem): PersistRecord | null {
  if (item.status === 'pending' || item.status === 'parsing') return null
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

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
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
    dbPromise = openDb().then((db) => {
      db.onclose = () => {
        dbPromise = null
      }
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      return db
    }, (err) => {
      dbPromise = null
      throw err
    })
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

/** 读取全部存档，剔除无法识别的历史记录（如旧版本结构） */
export async function loadPersisted(): Promise<PersistRecord[]> {
  const db = await getDb()
  const req = db.transaction(STORE).objectStore(STORE).getAll()
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as unknown[])
    req.onerror = () => reject(req.error ?? new Error('读取存档失败'))
  })
  return rows.filter(isValidRecord)
}

export async function putPersisted(records: PersistRecord[]): Promise<void> {
  if (!records.length) return
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const rec of records) store.put(rec)
  await settled(tx)
}

export async function deletePersisted(keys: string[]): Promise<void> {
  if (!keys.length) return
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const key of keys) store.delete(key)
  await settled(tx)
}

/** 清空全部存档（随「清空列表」一并触发，所见即所得） */
export async function clearPersisted(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await settled(tx)
}

/* ---------- 目录句柄（一键重扫的书签，不随清空列表删除） ---------- */

/** 保存目录句柄；浏览器不支持结构化克隆句柄时抛错，由调用方降级为仅本会话有效 */
export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).put({ id: 'last', handle, savedAt: Date.now() })
  await settled(tx)
}

export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await getDb()
  const req = db.transaction(HANDLE_STORE).objectStore(HANDLE_STORE).get('last')
  const row = await new Promise<{ id: string; handle?: FileSystemDirectoryHandle } | undefined>(
    (resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('读取目录句柄失败'))
    },
  )
  return row?.handle ?? null
}

export async function clearHandle(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).delete('last')
  await settled(tx)
}
