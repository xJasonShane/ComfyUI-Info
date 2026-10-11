/**
 * 会话持久化：把解析结果（来源 / 参数 / 诊断 / 失败原因，不含图片本体）存入 IndexedDB，
 * 刷新或关闭浏览器后历史记录仍在，重新拖入原文件即按指纹自动回挂。
 * file:// 直接打开、隐私模式等场景下 IndexedDB 可能不可用——启动时用真实读写探测，
 * 不可用则由 store 降级为纯内存并显示状态；存档写入错误向上抛出，由 store 保留待写数据并允许重试。
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
  /** File System Access 目录来源 ID；旧版记录缺省时仍可由路径指纹回挂 */
  sourceId?: string
  size: number
  mtime: number
  status: 'done' | 'error'
  source: ImageSource
  raw: RawMetadata
  params?: ParsedParams
  error?: string
  savedAt: number
  /** F2：EXIF 内嵌缩略图（base64 JPEG）——瞬态字段，序列化备份时剥离，经 blobs store 持久化 */
  thumbB64?: string
}

/** 存档主键 = 来源 ID（如有）+ 路径或文件名 + 大小 + 修改时间；回挂与去重共用此构造。 */
export function recordKey(it: {
  path?: string
  name: string
  sourceId?: string
  size: number
  mtime: number
}): string {
  const pathKey = `${it.path ?? it.name}|${it.size}|${it.mtime}`
  return it.sourceId ? `source:${encodeURIComponent(it.sourceId)}|${pathKey}` : pathKey
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
    sourceId: item.sourceId,
    size: item.size,
    mtime: item.mtime,
    status: item.status === 'error' ? 'error' : 'done',
    source: item.source,
    raw: toRaw(item.raw),
    params: item.params ? toRaw(item.params) : undefined,
    error: item.error,
    savedAt: Date.now(),
    thumbB64: item.thumbB64,
  }
}

/** 存档记录 → 无文件的存档项（detached），等待重新拖入原文件回挂 */
export function fromRecord(rec: PersistRecord): ImageItem {
  return {
    id: `img-archived-${++archivedSeq}`,
    url: '',
    name: rec.name,
    path: rec.path,
    sourceId: rec.sourceId,
    size: rec.size,
    mtime: rec.mtime,
    status: rec.status,
    source: rec.source,
    raw: rec.raw,
    params: rec.params,
    error: rec.error,
    thumbB64: rec.thumbB64,
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
    (rec.sourceId === undefined || typeof rec.sourceId === 'string') &&
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
  sourceId?: string
  size: number
  mtime: number
  status: 'done' | 'error'
  source: ImageSource
  /** 诊断线索（小文本，内联存储） */
  hints?: string[]
  error?: string
  savedAt: number
  /** 以下五者为 blobs 引用（内容哈希），undefined = 无此内容 */
  prompt?: string
  workflow?: string
  parameters?: string
  rawText?: string
  /** F2：EXIF 缩略图（base64 JPEG 文本） */
  thumb?: string
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
    sourceId: rec.sourceId,
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
    thumb: ref(rec.thumbB64),
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
  const thumb = pick(stored.thumb)
  return {
    key: stored.key,
    name: stored.name,
    path: stored.path,
    sourceId: stored.sourceId,
    size: stored.size,
    mtime: stored.mtime,
    status: stored.status,
    source: stored.source,
    raw: { source: stored.source, prompt, workflow, parameters, hints: stored.hints },
    params,
    error: stored.error,
    savedAt: stored.savedAt,
    thumbB64: thumb,
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
    (rec.sourceId === undefined || typeof rec.sourceId === 'string') &&
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

/* ---------- 目录书签（FEAT-7 多目录：按来源 ID 存储，可切换重扫目标） ---------- */

export interface DirBookmark {
  /** 句柄身份键；同名目录使用不同 ID */
  id: string
  name: string
  handle: FileSystemDirectoryHandle
  savedAt: number
}

/** 保存 / 更新目录书签；调用方提供的 ID 让同名目录可以并存。 */
export async function saveDirBookmark(
  handle: FileSystemDirectoryHandle,
  id = handle.name,
): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).put({ id, name: handle.name, handle, savedAt: Date.now() })
  await settled(tx)
}

/** 读取全部书签（新→旧）；迁移旧版单一 'last' 行时保留独立身份，避免覆盖同名目录。 */
export async function loadDirBookmarks(): Promise<DirBookmark[]> {
  const db = await getDb()
  const rows = (await getAllFrom(db, HANDLE_STORE)) as {
    id?: string
    name?: string
    handle?: FileSystemDirectoryHandle
    savedAt?: number
  }[]
  const out: DirBookmark[] = []
  let legacy: DirBookmark | null = null
  for (const row of rows) {
    if (!row?.handle) continue
    if (row.id === 'last') {
      legacy = {
        id: 'legacy:last',
        name: row.handle.name,
        handle: row.handle,
        savedAt: row.savedAt ?? 0,
      }
    } else if (typeof row.id === 'string') {
      out.push({
        id: row.id,
        name: typeof row.name === 'string' ? row.name : row.handle.name,
        handle: row.handle,
        savedAt: row.savedAt ?? 0,
      })
    }
  }
  if (legacy) {
    out.push(legacy)
    try {
      await saveDirBookmark(legacy.handle, legacy.id)
      await removeDirBookmarkRow('last')
    } catch {
      // 迁移失败时保留旧行，下次启动继续尝试；当前会话仍可使用已读取的句柄。
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

async function removeDirBookmarkRow(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).delete(id)
  await settled(tx)
}

export async function removeDirBookmark(id: string): Promise<void> {
  await removeDirBookmarkRow(id)
}

export async function clearDirBookmarks(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  tx.objectStore(HANDLE_STORE).clear()
  await settled(tx)
}

/* ---------- 存档备份（FEAT-6：导出 / 导入，防清库与跨设备迁移） ---------- */

const ARCHIVE_VERSION = 3

export interface ArchiveInspection {
  records: PersistRecord[]
  favorites: string[]
  tags: Record<string, string[]>
  /** Missing version is accepted as an unversioned legacy archive. */
  version?: number
  exportedAt?: string
  invalidRecords: number
  duplicateRecords: number
  warningCount: number
}

/**
 * 存档备份序列化：与存档记录同构（含参数与诊断信息，不含图片本体）。
 * favorites 为收藏标记的指纹键列表，tags 为「指纹键 → 标签名列表」映射
 * （两者都按指纹跨会话记忆，与记录主键同一构造），随备份走实现跨设备迁移——
 * 不带收藏 / 标签的旧版备份 / 旧版应用双向兼容（可选字段）。
 */
export function serializeArchive(
  records: PersistRecord[],
  favorites?: string[],
  tags?: Record<string, string[]>,
): string {
  return JSON.stringify(
    {
      version: ARCHIVE_VERSION,
      exportedAt: new Date().toISOString(),
      count: records.length,
      // 缩略图是本地浏览的便利数据，不入备份（体积换体验，重新解析原图可再得）
      records: records.map((r) => ({ ...r, thumbB64: undefined })),
      ...(favorites?.length ? { favorites } : {}),
      ...(tags && Object.keys(tags).length ? { tags } : {}),
    },
    null,
    2,
  )
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isImageSource = (value: unknown): value is ImageSource =>
  value === 'comfyui' || value === 'a1111' || value === 'none'

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFiniteOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function normalizeParsedParams(value: unknown): ParsedParams | null {
  if (!isObject(value)) return null
  if (
    !isStringArray(value.positive) ||
    !isStringArray(value.negative) ||
    !isStringArray(value.models) ||
    (value.vaes !== undefined && !isStringArray(value.vaes)) ||
    (value.upscalers !== undefined && !isStringArray(value.upscalers)) ||
    (value.controlNets !== undefined && !isStringArray(value.controlNets)) ||
    !Array.isArray(value.loras) ||
    !Array.isArray(value.samplers) ||
    (value.nodeCount !== undefined &&
      (typeof value.nodeCount !== 'number' || !Number.isFinite(value.nodeCount)))
  )
    return null
  if (
    (value.modelHash !== undefined && typeof value.modelHash !== 'string') ||
    (value.rawText !== undefined && typeof value.rawText !== 'string') ||
    !isFiniteOptionalNumber(value.width) ||
    !isFiniteOptionalNumber(value.height) ||
    !isFiniteOptionalNumber(value.batch) ||
    !isFiniteOptionalNumber(value.clipSkip)
  )
    return null
  if (
    !value.loras.every(
      (item) =>
        isObject(item) &&
        typeof item.name === 'string' &&
        isFiniteOptionalNumber(item.strengthModel) &&
        isFiniteOptionalNumber(item.strengthClip) &&
        (item.hash === undefined || typeof item.hash === 'string'),
    ) ||
    !value.samplers.every(
      (item) =>
        isObject(item) &&
        typeof item.nodeId === 'string' &&
        typeof item.classType === 'string' &&
        isFiniteOptionalNumber(item.steps) &&
        isFiniteOptionalNumber(item.cfg) &&
        isFiniteOptionalNumber(item.denoise) &&
        (item.sampler === undefined || typeof item.sampler === 'string') &&
        (item.scheduler === undefined || typeof item.scheduler === 'string') &&
        (item.seed === undefined || typeof item.seed === 'string'),
    )
  )
    return null
  return {
    positive: value.positive as string[],
    negative: value.negative as string[],
    models: value.models as string[],
    loras: value.loras as ParsedParams['loras'],
    samplers: value.samplers as ParsedParams['samplers'],
    vaes: (value.vaes as string[] | undefined) ?? [],
    upscalers: (value.upscalers as string[] | undefined) ?? [],
    controlNets: (value.controlNets as string[] | undefined) ?? [],
    nodeCount: (value.nodeCount as number | undefined) ?? 0,
    ...(typeof value.modelHash === 'string' ? { modelHash: value.modelHash } : {}),
    ...(typeof value.rawText === 'string' ? { rawText: value.rawText } : {}),
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(typeof value.batch === 'number' ? { batch: value.batch } : {}),
    ...(typeof value.clipSkip === 'number' ? { clipSkip: value.clipSkip } : {}),
  }
}

/** Normalize archive records before they reach rendering, search, or persistence code. */
function normalizeArchiveRecord(value: unknown): PersistRecord | null {
  if (!isObject(value)) return null
  const source = value.source
  const status = value.status
  const raw = value.raw
  const params = value.params === undefined ? undefined : normalizeParsedParams(value.params)
  if (
    typeof value.key !== 'string' ||
    !value.key.trim() ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.mtime !== 'number' ||
    !Number.isFinite(value.mtime) ||
    value.mtime < 0 ||
    (status !== 'done' && status !== 'error') ||
    !isImageSource(source) ||
    !isObject(raw) ||
    (raw.source !== undefined && (!isImageSource(raw.source) || raw.source !== source)) ||
    (value.path !== undefined && typeof value.path !== 'string') ||
    (value.sourceId !== undefined && (typeof value.sourceId !== 'string' || !value.sourceId)) ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.params !== undefined && !params)
  )
    return null

  for (const key of ['prompt', 'workflow', 'parameters'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') return null
  }
  if (raw.hints !== undefined && !isStringArray(raw.hints)) return null
  if (value.savedAt !== undefined && (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt))) {
    return null
  }

  const normalizedRaw: RawMetadata = {
    source,
    ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
    ...(typeof raw.workflow === 'string' ? { workflow: raw.workflow } : {}),
    ...(typeof raw.parameters === 'string' ? { parameters: raw.parameters } : {}),
    ...(Array.isArray(raw.hints) ? { hints: raw.hints as string[] } : {}),
  }
  return {
    key: value.key,
    name: value.name,
    path: value.path as string | undefined,
    sourceId: value.sourceId as string | undefined,
    size: value.size,
    mtime: value.mtime,
    status,
    source,
    raw: normalizedRaw,
    params: params ?? undefined,
    error: value.error as string | undefined,
    // Older archives may omit savedAt. mtime is the closest stable fallback.
    savedAt: (value.savedAt as number | undefined) ?? value.mtime,
  }
}

/** Inspect archive structure and records, retaining counts for a safe import preview. */
export function inspectArchive(text: string): ArchiveInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }
  if (!isObject(parsed) || !Array.isArray(parsed.records)) {
    throw new Error('缺少 records 数组，不是存档备份文件')
  }
  const o = parsed
  if (
    o.version !== undefined &&
    (typeof o.version !== 'number' ||
      !Number.isInteger(o.version) ||
      o.version < 1 ||
      o.version > ARCHIVE_VERSION)
  ) {
    throw new Error(`不支持的存档版本：${String(o.version)}（当前支持 1–${ARCHIVE_VERSION}）`)
  }

  let warningCount = 0
  if (o.count !== undefined) {
    if (typeof o.count !== 'number' || !Number.isInteger(o.count) || o.count < 0) warningCount++
    else if (o.count !== o.records.length) warningCount++
  }
  const exportedAt =
    typeof o.exportedAt === 'string' && Number.isFinite(Date.parse(o.exportedAt))
      ? o.exportedAt
      : undefined
  if (o.exportedAt !== undefined && exportedAt === undefined) warningCount++

  const records: PersistRecord[] = []
  const recordKeys = new Set<string>()
  let invalidRecords = 0
  let duplicateRecords = 0
  for (const value of o.records) {
    const rec = normalizeArchiveRecord(value)
    if (!rec) {
      invalidRecords++
      continue
    }
    if (recordKeys.has(rec.key)) {
      duplicateRecords++
      continue
    }
    recordKeys.add(rec.key)
    records.push(rec)
  }
  warningCount += invalidRecords + duplicateRecords

  const favorites: string[] = []
  const favoriteKeys = new Set<string>()
  if (o.favorites !== undefined) {
    if (!Array.isArray(o.favorites)) warningCount++
    else {
      for (const key of o.favorites) {
        if (typeof key !== 'string' || !key.trim()) {
          warningCount++
          continue
        }
        if (favoriteKeys.has(key)) {
          warningCount++
          continue
        }
        favoriteKeys.add(key)
        favorites.push(key)
      }
    }
  }
  const tags: Record<string, string[]> = {}
  if (o.tags !== undefined) {
    if (!isObject(o.tags)) warningCount++
    else {
      for (const [key, value] of Object.entries(o.tags)) {
        if (
          !key.trim() ||
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype' ||
          !Array.isArray(value)
        ) {
          warningCount++
          continue
        }
        const names: string[] = []
        for (const name of value) {
          if (typeof name !== 'string' || !name.trim()) {
            warningCount++
            continue
          }
          if (!names.includes(name)) names.push(name)
          else warningCount++
        }
        if (names.length) tags[key] = names
      }
    }
  }
  return {
    records,
    favorites,
    tags,
    version: typeof o.version === 'number' ? o.version : undefined,
    exportedAt,
    invalidRecords,
    duplicateRecords,
    warningCount,
  }
}

/** Parse archive payload while retaining the long-standing public return shape. */
export function parseArchive(text: string): {
  records: PersistRecord[]
  favorites: string[]
  tags: Record<string, string[]>
} {
  const { records, favorites, tags } = inspectArchive(text)
  return { records, favorites, tags }
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
