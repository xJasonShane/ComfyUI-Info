import { computed, reactive, ref, watch } from 'vue'
import type { ImageItem, ImageSource, IncomingFile, ParsedParams, RawMetadata } from '../types'
import {
  clearInternPool,
  hasSupportedSignature,
  isMetaTextFile,
  isSupportedImage,
} from '../lib/metadata'
import { parseImage, usingWorkers } from '../lib/parser'
import { bytesToBase64 } from '../lib/utils'
import { safeGetItem, safeSetItem, safeRemoveItem } from '../lib/prefs'
import { clusterByWorkflow, clusterBySameSource } from '../lib/cluster'
import {
  buildSearchText,
  cachedParseQuery,
  localDayKey,
  matchQuery,
  prewarmSearchText,
  type QueryEnv,
} from '../lib/query'
import { collectDirectoryFiles, ensureReadPermission } from '../lib/fs'
import { scanDuplicateFiles } from '../lib/dupes'
import type { FileDupeScanResult } from '../lib/dupes'
import { setLocale, t } from '../locales'
import {
  clearContentHashCache,
  clearDirBookmarks as clearPersistedBookmarks,
  clearPersisted,
  contentVersionKey,
  deletePersisted,
  fileIdentityKey,
  fromRecord,
  inspectArchive,
  importPersisted,
  loadDirBookmarks,
  loadPersisted,
  probePersistence,
  putPersisted,
  recordKey,
  requestPersistentStorage,
  saveDirBookmark,
  serializeArchive,
  storageEstimate,
  storagePersistedState,
  toRecord,
  type ArchiveInspection,
  type ArchivePreferences,
  type ArchivePreset,
  type DirBookmark,
  type PersistRecord,
} from '../lib/persist'

export { parseQuery, tokenizeQuery, removeQueryToken } from '../lib/query'
export type { QueryConditions, ParsedQuery, NumField, HasField, NumCondition } from '../lib/query'

export type SourceFilter = 'all' | 'comfyui' | 'a1111' | 'fooocus' | 'none' | 'error'
export type SortMode = 'default' | 'time-desc' | 'time-asc' | 'name-asc' | 'name-desc' | 'workflow'
export type PersistenceStatus = 'checking' | 'saved' | 'saving' | 'error' | 'unavailable'
const SORT_MODES: SortMode[] = [
  'default',
  'time-desc',
  'time-asc',
  'name-asc',
  'name-desc',
  'workflow',
]

interface StoreState {
  items: ImageItem[]
  search: string
  modelFilter: string | null
  sourceFilter: SourceFilter
  sortMode: SortMode
  dark: boolean
  batchTotal: number
  batchDone: number
  /** 记住的扫描目录名（句柄本体不进响应式状态，避免被代理后无法结构化克隆回写） */
  rescanName: string | null
  /** 已记住的目录书签名列表（FEAT-7 多目录；句柄本体在模块级 Map 中） */
  dirBookmarks: string[]
  /** 目录监视自动重扫：开启后周期增量重扫记住的目录（边出图边看，偏好记忆） */
  autoRescan: boolean
  /** 自动重扫间隔（秒，5 / 10 / 30 / 60）：出图节奏不同，扫描频率需求不同（偏好记忆） */
  autoRescanInterval: number
  /** IndexedDB 会话存档状态；失败时保留待写操作并提供手动重试 */
  persistenceStatus: PersistenceStatus
  persistenceError: string | null
  /** 持久存储授予状态（C1）：true 已授予 / false 未授予 / null 环境不支持或未申请 */
  storagePersisted: boolean | null
  /** 存档占用估算（C1）：null 表示环境不支持或尚未读取 */
  storageUsage: { usage: number; quota: number } | null
  /** 只看重复（FEAT-4）：仅显示同工作流同种子的同源出图；无重复组时开关自动隐藏 */
  dupeOnly: boolean
  /** 只看完全重复文件（FEAT-2）：扫描结果中的字节级重复条目 */
  fileDupeOnly: boolean
  /** 只看收藏：仅显示已星标的条目；无收藏时开关自动隐藏（收藏本身按指纹跨会话记忆） */
  favOnly: boolean
  /** 画廊缩略图最小列宽（px，150–420）：卡片大小调节偏好 */
  thumbSize: number
  /** 安全模式：画廊缩略图模糊显示（悬停临时揭示），公共场合 / 屏幕分享防走光（偏好记忆） */
  safeMode: boolean
}

const storedSort = safeGetItem('cii:sort') as SortMode | null

/* ---------- 筛选 / 搜索状态持久化（U2）：刷新后还原上次的使用状态 ---------- */
const FILTERS_KEY = 'cii:filters'
/** 目录监视自动重扫的偏好键 */
const AUTO_RESCAN_KEY = 'cii:auto-rescan'
const SOURCE_FILTERS: SourceFilter[] = ['all', 'comfyui', 'a1111', 'fooocus', 'none', 'error']

function loadStoredFilters(): {
  search: string
  modelFilter: string | null
  sourceFilter: SourceFilter
} {
  try {
    const raw = safeGetItem(FILTERS_KEY)
    if (!raw) return { search: '', modelFilter: null, sourceFilter: 'comfyui' }
    const o = JSON.parse(raw) as { search?: unknown; model?: unknown; source?: unknown }
    return {
      search: typeof o.search === 'string' ? o.search : '',
      modelFilter: typeof o.model === 'string' && o.model !== '' ? o.model : null,
      sourceFilter: SOURCE_FILTERS.includes(o.source as SourceFilter)
        ? (o.source as SourceFilter)
        : 'comfyui',
    }
  } catch {
    return { search: '', modelFilter: null, sourceFilter: 'comfyui' }
  }
}

const storedFilters = loadStoredFilters()

// FEAT-8：主题显式偏好优先；未设置过时跟随系统 prefers-color-scheme 并实时跟随切换
// （系统变化驱动的翻转不落盘——显式偏好只在 toggleDark 里写入，写入后不再跟随系统）
const storedTheme = safeGetItem('cii:theme')
const schemeQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null

/* ---------- 缩略图大小偏好：画廊卡片最小列宽（150–420px），非法存储值回退默认 ---------- */
const THUMB_KEY = 'cii:thumb'
const THUMB_DEFAULT = 206

function loadThumbSize(): number {
  try {
    const v = Number(safeGetItem(THUMB_KEY))
    return Number.isFinite(v) && v >= 150 && v <= 420 ? v : THUMB_DEFAULT
  } catch {
    return THUMB_DEFAULT
  }
}

/* ---------- 安全模式偏好：缩略图模糊防走光，仅在用户切换时落盘 ---------- */
const SAFE_MODE_KEY = 'cii:safe'

/* ---------- 自动重扫间隔偏好（秒）：state 初始化即读取，须先于 state 定义 ---------- */
/** 可选间隔（秒）：TopBar 下拉与非法存储值校验共用 */
export const RESCAN_INTERVALS = [5, 10, 30, 60]
const AUTO_RESCAN_INTERVAL_KEY = 'cii:auto-rescan-interval'
const AUTO_RESCAN_INTERVAL_DEFAULT = 10

function loadRescanInterval(): number {
  try {
    const v = Number(safeGetItem(AUTO_RESCAN_INTERVAL_KEY))
    return RESCAN_INTERVALS.includes(v) ? v : AUTO_RESCAN_INTERVAL_DEFAULT
  } catch {
    return AUTO_RESCAN_INTERVAL_DEFAULT
  }
}

const state = reactive<StoreState>({
  items: [],
  search: storedFilters.search,
  modelFilter: storedFilters.modelFilter,
  sourceFilter: storedFilters.sourceFilter,
  sortMode: storedSort && SORT_MODES.includes(storedSort) ? storedSort : 'default',
  dark: storedTheme ? storedTheme === 'dark' : !(schemeQuery?.matches ?? false),
  batchTotal: 0,
  batchDone: 0,
  rescanName: null,
  dirBookmarks: [],
  autoRescan: safeGetItem(AUTO_RESCAN_KEY) === '1',
  autoRescanInterval: loadRescanInterval(),
  persistenceStatus: 'checking',
  persistenceError: null,
  storagePersisted: null,
  storageUsage: null,
  dupeOnly: false,
  fileDupeOnly: false,
  favOnly: false,
  thumbSize: loadThumbSize(),
  safeMode: safeGetItem(SAFE_MODE_KEY) === '1',
})

if (!storedTheme && schemeQuery) {
  schemeQuery.addEventListener('change', (e) => {
    // 用户手动切换后（toggleDark 落盘）显式偏好优先，不再跟随系统
    if (safeGetItem('cii:theme') !== null) return
    state.dark = !e.matches
  })
}

watch(
  () => state.sortMode,
  (m) => {
    safeSetItem('cii:sort', m)
  },
)

watch(
  () => state.thumbSize,
  (v) => {
    safeSetItem(THUMB_KEY, String(v))
  },
)

watch(
  () => [state.search, state.modelFilter, state.sourceFilter] as const,
  ([search, model, source]) => {
    safeSetItem(FILTERS_KEY, JSON.stringify({ search, model, source }))
  },
)

/* ---------- 指纹缓存（C1） ---------- */
// 版本键在同一内容版本的条目生命周期内不变；文件更新时主动清除该缓存，
// favoriteFlags / favCount / tagLists / favOnly 筛选等 computed 每拍失效都要为全量条目
// 重拼串，WeakMap 命中后 O(1) 复用；键为响应式代理，与原始对象各存一份无碍（值相同）
const recordKeyCache = new WeakMap<ImageItem, string>()
const fileIdentityKeyCache = new WeakMap<ImageItem, string>()

function fileIdentityKeyOf(it: ImageItem): string {
  let k = fileIdentityKeyCache.get(it)
  if (k === undefined) {
    k = fileIdentityKey(it)
    fileIdentityKeyCache.set(it, k)
  }
  return k
}

function recordKeyOf(it: ImageItem): string {
  let k = recordKeyCache.get(it)
  if (k === undefined) {
    k = recordKey({
      path: it.path,
      name: it.name,
      sourceId: it.sourceId,
      size: it.size,
      mtime: it.mtime,
    })
    recordKeyCache.set(it, k)
  }
  return k
}

/** 忽略来源 ID 的位置别名；无相对路径时保留完整版本条件以免误认同名文件。 */
function legacyRecordKey(it: Pick<ImageItem, 'path' | 'name' | 'size' | 'mtime'>): string {
  if (it.path) return `legacy:${encodeURIComponent(it.path)}`
  return `legacy:${recordKey({ name: it.name, size: it.size, mtime: it.mtime })}`
}

const legacyItemsByKey = new Map<string, Set<ImageItem>>()
const itemsByIdentityKey = new Map<string, Set<ImageItem>>()

function indexIdentityItem(item: ImageItem) {
  const key = fileIdentityKeyOf(item)
  let group = itemsByIdentityKey.get(key)
  if (!group) itemsByIdentityKey.set(key, (group = new Set()))
  group.add(item)
}

function unindexIdentityItem(item: ImageItem) {
  const key = fileIdentityKeyOf(item)
  const group = itemsByIdentityKey.get(key)
  group?.delete(item)
  if (group?.size === 0) itemsByIdentityKey.delete(key)
}

function indexLegacyItem(item: ImageItem) {
  const key = legacyRecordKey(item)
  let group = legacyItemsByKey.get(key)
  if (!group) legacyItemsByKey.set(key, (group = new Set()))
  group.add(item)
}

function unindexLegacyItem(item: ImageItem) {
  const key = legacyRecordKey(item)
  const group = legacyItemsByKey.get(key)
  group?.delete(item)
  if (group?.size === 0) legacyItemsByKey.delete(key)
}

/** 将旧 / 外部存档的唯一匹配项绑定到当前目录，并迁移收藏、标签和 IndexedDB 主键。 */
function adoptSourceId(item: ImageItem, sourceId: string): boolean {
  const oldKey = recordKeyOf(item)
  const newKey = recordKey({
    path: item.path,
    name: item.name,
    sourceId,
    size: item.size,
    mtime: item.mtime,
  })
  if (oldKey === newKey) return true
  if (seenKeys.has(newKey)) return false

  if (item.detached) detachedByKey.delete(oldKey)
  else seenKeys.delete(oldKey)
  unindexIdentityItem(item)
  dirtyItems.delete(oldKey)
  const pendingThumb = dirtyThumbs.get(oldKey)
  if (pendingThumb) {
    dirtyThumbs.delete(oldKey)
    dirtyThumbs.set(newKey, pendingThumb)
  }
  item.sourceId = sourceId
  recordKeyCache.delete(item)
  fileIdentityKeyCache.delete(item)
  indexIdentityItem(item)
  if (item.detached) detachedByKey.set(newKey, item)
  else seenKeys.add(newKey)

  migrateUserMetadataKey(oldKey, newKey)
  if (persistAvailable) {
    deletedKeys.add(oldKey)
    markDirty(item)
  }
  return true
}

function migrateUserMetadataKey(oldKey: string, newKey: string) {
  if (favKeys.has(oldKey)) {
    favKeys.delete(oldKey)
    favKeys.add(newKey)
    persistFavorites()
  }
  const oldTags = itemTags[oldKey]
  if (oldTags?.length) {
    itemTags[newKey] = [...new Set([...(itemTags[newKey] ?? []), ...oldTags])]
    delete itemTags[oldKey]
    persistTags()
  }
}

/* ---------- 解析队列（有限并发） ---------- */
let active = 0
const queue: ImageItem[] = []
const PARSE_LIMIT = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) * 2))
// Worker 池整体回退主线程时（B3），全部解析都压在 UI 线程上——并发收敛到不卡交互的水平
const MAIN_THREAD_PARSE_LIMIT = 3
// 单次移除达到该数量即回收长文本缓存（OPT-2）：小批删除保留复用价值，大批删除释放内存
const CACHE_RESET_REMOVAL = 200
// 清空列表时递增：旧批次的在途解析完成时不再计数，避免污染新批次进度
let batchEpoch = 0
// 解析代数：同一位置的文件版本更新时作废旧结果，并让旧任务收尾后只重排最新版本。
const parseRevision = new WeakMap<ImageItem, number>()
// 同一条目可同时有旧结果待应用和新版本解析任务；按解析代数分别记账。
const inflight = new Map<string, Set<number>>()
const activeParses = new Set<string>()

function markInflight(id: string, revision: number) {
  let revisions = inflight.get(id)
  if (!revisions) inflight.set(id, (revisions = new Set()))
  revisions.add(revision)
}

function unmarkInflight(id: string, revision: number) {
  const revisions = inflight.get(id)
  revisions?.delete(revision)
  if (revisions?.size === 0) inflight.delete(id)
}

function hasInflight(id: string): boolean {
  return (inflight.get(id)?.size ?? 0) > 0
}
// 已计入批次总数（batchTotal）的项：只有实文件入列 / 重试会递增 batchTotal，
// 存档恢复与回挂项从未计入——removeItems 对账时只对已计入项递减，否则移除存档卡片
// 会把计数减成负数，后续扫描的进度条与 parsing 边界随之错乱
const batchCounted = new WeakSet<ImageItem>()

/* ---------- 解析结果节拍应用（P1：聚合计算去抖） ---------- */
// 每张图完成时直接写响应式字段会触发 stats / filteredItems / usageStats / modelOptions
// 等全量重算，万级扫描是 O(n²) 总量。结果先进暂存区，按节拍批量应用——每批只引发一轮
// 重算；扫描全部结束（active 归零且队列空）时立即收尾应用，单张 / 小批量场景零延迟。
interface PendingResult {
  item: ImageItem
  revision: number
  raw: RawMetadata
  params?: ParsedParams
  /** F2：EXIF 内嵌缩略图（原始字节），随写库批次存入 blobs store */
  thumb?: Uint8Array
  /** 成功时预构建的小写搜索串；失败项不构建（沿用 name 兜底匹配） */
  searchText?: string
  error?: string
}
const APPLY_INTERVAL_MS = 200
let pendingResults: PendingResult[] = []
let applyTimer: ReturnType<typeof setTimeout> | null = null

function scheduleApply() {
  if (applyTimer !== null) return
  applyTimer = setTimeout(() => {
    applyTimer = null
    applyPending()
  }, APPLY_INTERVAL_MS)
}

function applyPending() {
  if (applyTimer !== null) {
    clearTimeout(applyTimer)
    applyTimer = null
  }
  if (!pendingResults.length) return
  const batch = pendingResults
  pendingResults = []
  for (const r of batch) {
    unmarkInflight(r.item.id, r.revision)
    // 已移除 / 已清空的项：丢弃孤儿结果（与 markDirty 的存活校验同源，B1）
    if (!liveIds.has(r.item.id)) continue
    if ((parseRevision.get(r.item) ?? 0) !== r.revision) continue
    r.item.raw = r.raw
    r.item.source = r.raw.source
    r.item.params = r.params
    r.item.searchText = r.searchText
    r.item.error = r.error
    r.item.status = r.error ? 'error' : 'done'
    if (r.thumb) dirtyThumbs.set(recordKeyOf(r.item), r.thumb)
    markDirty(r.item)
  }
}

function pump() {
  const limit = usingWorkers() ? PARSE_LIMIT : Math.min(PARSE_LIMIT, MAIN_THREAD_PARSE_LIMIT)
  while (active < limit && queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    active++
    void parseItem(item, batchEpoch)
  }
}

async function parseItem(item: ImageItem, epoch: number) {
  const revision = parseRevision.get(item) ?? 0
  markInflight(item.id, revision)
  activeParses.add(item.id)
  try {
    // 入队的都是实文件项（存档项不解析）
    const { raw, params, thumb } = await parseImage(item.file!)
    // 搜索串在结果落定时构建一次（应用时直接挂上）：筛选热路径只做 includes，不再每键重建
    pendingResults.push({
      item,
      revision,
      raw,
      params,
      thumb,
      searchText: buildSearchText(item, params),
    })
  } catch (e) {
    pendingResults.push({
      item,
      revision,
      raw: { source: 'none' },
      error: e instanceof Error ? e.message : String(e),
    })
  } finally {
    active--
    activeParses.delete(item.id)
    if (epoch === batchEpoch) state.batchDone++
    if (
      epoch === batchEpoch &&
      liveIds.has(item.id) &&
      (parseRevision.get(item) ?? 0) !== revision &&
      !queue.includes(item)
    ) {
      // 当前解析结果已经过期：计入旧任务完成，再为最新文件版本补一项解析任务。
      state.batchTotal++
      queue.push(item)
    }
    if (active === 0 && queue.length === 0) applyPending()
    else scheduleApply()
    pump()
  }
}

/* ---------- 添加 / 清空 ---------- */
let seq = 0
// 已加载文件的版本键（recordKey：位置|大小|修改时间），O(1) 查精确版本；增删 items 时必须同步维护
const seenKeys = new Set<string>()
// 存活项 id 集合（与 seenKeys 同步增删）：markDirty 写库前校验，
// 防止已移除 / 已清空的项在解析完成时把孤儿记录重新写回存档（「复活」竞态）
const liveIds = new Set<string>()
// 待回挂的存档项索引（版本键 → item），addFiles 时按精确版本自动回挂
const detachedByKey = new Map<string, ImageItem>()

export function retryItem(item: ImageItem) {
  // 仅允许重试当前列表中的失败实文件项（存档失败项无文件可读，列表清空时抽屉会被关闭，这里兜底）
  if (item.status !== 'error' || !item.file || !state.items.includes(item)) return
  item.status = 'pending'
  item.error = undefined
  state.batchTotal++
  queue.push(item)
  pump()
}

/** 批量重试全部可重试的失败项（O4）；存档失败项无文件，仍需重新拖入原文件。返回重新排队数量 */
export function retryAllFailed(): number {
  let n = 0
  for (const item of [...state.items]) {
    if (item.status !== 'error' || !item.file) continue
    item.status = 'pending'
    item.error = undefined
    state.batchTotal++
    queue.push(item)
    n++
  }
  if (n) pump()
  return n
}

/** 返回本次新增或更新并触发解析的数量（去重后）；无扩展名文件嗅探为异步操作，不计入返回值 */
export function addFiles(files: IncomingFile[]): number {
  const deferred: IncomingFile[] = []
  let added = 0
  for (const { file, path, sourceId } of files) {
    if (isSupportedImage(file)) {
      added += enqueueFile(file, path, false, sourceId)
    } else if (isMetaTextFile(file)) {
      // F1：工作流 JSON / 参数文本拖入即解析，无需配图
      added += enqueueFile(file, path, true, sourceId)
    } else {
      // 无扩展名 / 生僻扩展名：按文件头魔数嗅探，异步确认后再入列
      deferred.push({ file, path, sourceId })
    }
  }
  pump()
  for (const incoming of deferred) void acceptBySniff(incoming)
  return added
}

function discardIdentityVersions(
  items: ImageItem[],
  keep: ImageItem | undefined,
  targetKey: string,
) {
  for (const item of items) {
    if (item === keep) continue
    const oldKey = recordKeyOf(item)
    if (oldKey === targetKey) continue
    removeItems([item])
    migrateUserMetadataKey(oldKey, targetKey)
  }
}

/** Update an existing location in place, preserving its UI identity and user metadata. */
function updateExistingVersion(
  item: ImageItem,
  file: File,
  path?: string,
  metaOnly = false,
  sourceId?: string,
): number {
  const oldKey = recordKeyOf(item)
  const nextIdentity = {
    path,
    name: file.name,
    sourceId,
    size: file.size,
    mtime: file.lastModified,
  }
  const nextKey = recordKey(nextIdentity)
  if (
    oldKey === nextKey ||
    contentVersionKey(item) === contentVersionKey({ size: file.size, mtime: file.lastModified })
  )
    return 0

  const queued = queue.includes(item)
  const parsingNow = activeParses.has(item.id)
  const revision = parseRevision.get(item) ?? 0
  unindexIdentityItem(item)
  unindexLegacyItem(item)
  seenKeys.delete(oldKey)
  detachedByKey.delete(oldKey)
  dirtyItems.delete(oldKey)
  dirtyThumbs.delete(oldKey)
  deletedKeys.add(oldKey)
  migrateUserMetadataKey(oldKey, nextKey)

  if (item.url) URL.revokeObjectURL(item.url)
  if (item.thumb) URL.revokeObjectURL(item.thumb)
  item.file = file
  item.url = ''
  item.name = file.name
  item.path = path
  item.sourceId = sourceId
  item.size = file.size
  item.mtime = file.lastModified
  item.status = 'pending'
  item.source = 'none'
  item.raw = { source: 'none' }
  item.params = undefined
  item.error = undefined
  item.searchText = undefined
  item.thumb = undefined
  item.thumbB64 = undefined
  item.detached = false
  item.metaOnly = metaOnly || undefined
  recordKeyCache.delete(item)
  fileIdentityKeyCache.delete(item)
  parseRevision.set(item, revision + 1)
  seenKeys.add(nextKey)
  indexIdentityItem(item)
  indexLegacyItem(item)

  if (!queued && !parsingNow) {
    // Includes completed files and parser results already staged for the next UI apply tick.
    state.batchTotal++
    batchCounted.add(item)
    queue.push(item)
  }
  schedulePersist()
  pump()
  return 1
}

/** 入列文件：先按稳定位置身份发现新版本，再按版本键去重或回挂精确存档。 */
function enqueueFile(file: File, path?: string, metaOnly = false, sourceId?: string): number {
  const identity = { path, name: file.name, sourceId, size: file.size, mtime: file.lastModified }
  const key = recordKey(identity)
  const identityKey = fileIdentityKey(identity)
  const exactItems = [...(itemsByIdentityKey.get(identityKey) ?? [])]
  const exactItem = exactItems.find((item) => recordKeyOf(item) === key)
  if (exactItem) {
    discardIdentityVersions(exactItems, exactItem, key)
    if (!exactItem.detached || seenKeys.has(key)) return 0
    exactItem.file = file
    exactItem.url = URL.createObjectURL(file)
    if (exactItem.thumb) URL.revokeObjectURL(exactItem.thumb)
    exactItem.thumb = undefined
    exactItem.thumbB64 = undefined
    exactItem.detached = false
    seenKeys.add(key)
    detachedByKey.delete(key)
    markDirty(exactItem)
    return 0
  }

  if (seenKeys.has(key)) return 0

  // 与存档项同版本：回挂原文件即可；较旧版本会在位置身份匹配后清理。
  let archived = detachedByKey.get(key)
  if (archived) {
    const sameIdentity = [...(itemsByIdentityKey.get(identityKey) ?? [])]
    discardIdentityVersions(sameIdentity, archived, key)
  }

  if (!archived && sourceId) {
    // 升级前 / 跨设备备份里的记录没有本机目录 ID。仅当路径身份唯一时迁移，
    // 避免同名目录中的记录被错误吸收到当前来源。
    const legacyGroup = legacyItemsByKey.get(legacyRecordKey(identity))
    if (legacyGroup?.size === 1) {
      const candidate = legacyGroup.values().next().value as ImageItem | undefined
      const canAdopt =
        candidate &&
        candidate.detached &&
        candidate.sourceId !== sourceId &&
        (!candidate.sourceId || candidate.sourceId.startsWith('imported:'))
      if (candidate && canAdopt && adoptSourceId(candidate, sourceId)) {
        if (recordKeyOf(candidate) === key) {
          archived = candidate
          const sameIdentity = [...(itemsByIdentityKey.get(identityKey) ?? [])]
          discardIdentityVersions(sameIdentity, candidate, key)
        } else {
          const sameIdentity = [...(itemsByIdentityKey.get(identityKey) ?? [])]
          discardIdentityVersions(sameIdentity, candidate, key)
          return updateExistingVersion(candidate, file, path, metaOnly, sourceId)
        }
      }
    }
  }

  if (!archived) {
    const sameIdentity = [...(itemsByIdentityKey.get(identityKey) ?? [])]
    if (sameIdentity.length) {
      const candidate = sameIdentity.sort(
        (a, b) => Number(Boolean(b.file)) - Number(Boolean(a.file)) || b.mtime - a.mtime,
      )[0]!
      discardIdentityVersions(sameIdentity, candidate, key)
      return updateExistingVersion(candidate, file, path, metaOnly, sourceId)
    }
  }

  if (archived) {
    archived.file = file
    archived.url = URL.createObjectURL(file)
    if (archived.thumb) URL.revokeObjectURL(archived.thumb)
    archived.thumb = undefined
    archived.thumbB64 = undefined
    archived.detached = false
    seenKeys.add(key)
    detachedByKey.delete(key)
    markDirty(archived)
    return 0
  }

  seenKeys.add(key)
  // 必须以响应式代理入队：解析是异步改写 item 字段，绕过代理不会触发视图更新
  const item = reactive<ImageItem>({
    id: `img-${++seq}`,
    file,
    // P2：预览 URL 惰性创建（ensureItemUrl），入列时先不占 Blob URL
    url: '',
    name: file.name,
    path,
    sourceId,
    size: file.size,
    mtime: file.lastModified,
    status: 'pending',
    source: 'none',
    raw: { source: 'none' },
    metaOnly: metaOnly || undefined,
  })
  state.items.push(item)
  liveIds.add(item.id)
  indexIdentityItem(item)
  indexLegacyItem(item)
  state.batchTotal++
  batchCounted.add(item)
  queue.push(item)
  return 1
}

/** 无扩展名文件的嗅探入列：确认是受支持图片才加入，普通杂项文件维持静默跳过 */
async function acceptBySniff(incoming: IncomingFile) {
  try {
    if (await hasSupportedSignature(incoming.file)) {
      enqueueFile(incoming.file, incoming.path, false, incoming.sourceId)
    }
  } catch {
    // 读取失败按不支持处理
  }
  pump()
}

/** 撤销窗口：移除后 10 秒内可恢复（FEAT-1） */
const UNDO_WINDOW_MS = 10_000

interface RemovalEntry {
  item: ImageItem
  key: string
  /** 移除时对批次计数的增量（负值）；撤销时取反恢复 */
  totalDelta: number
  doneDelta: number
}

let undoEntries: RemovalEntry[] | null = null
let undoTimer: ReturnType<typeof setTimeout> | null = null

/** 撤销条状态：非 null 时 App 显示「已移除 N 项 / 撤销」 */
export const undoState = ref<{ count: number } | null>(null)

/** 关闭撤销窗口（用户主动关闭 / 清空列表 / 新一次移除覆盖旧窗口） */
export function dismissUndo(): void {
  if (undoTimer !== null) {
    clearTimeout(undoTimer)
    undoTimer = null
  }
  undoEntries = null
  undoState.value = null
}

function startUndoWindow(entries: RemovalEntry[]) {
  dismissUndo()
  undoEntries = entries
  undoState.value = { count: entries.length }
  undoTimer = setTimeout(() => {
    undoTimer = null
    undoEntries = null
    undoState.value = null
  }, UNDO_WINDOW_MS)
}

/**
 * 撤销最近一次用户移除（FEAT-1）：恢复条目、索引、预览 URL 与存档记录。
 * 期间列表已变化（同位置出现新版本 / 同指纹被重新添加）时跳过该项，避免出现重复版本；
 * 返回实际恢复的条目数。
 */
export function undoLastRemoval(): number {
  const entries = undoEntries
  dismissUndo()
  if (!entries?.length) return 0
  let restored = 0
  for (const entry of entries) {
    const { item, key } = entry
    if (liveIds.has(item.id)) continue
    // 同位置已有其他版本（扫描 / 拖入在撤销窗口内更新了文件）：不恢复旧版本
    if ((itemsByIdentityKey.get(fileIdentityKeyOf(item))?.size ?? 0) > 0) continue
    if (seenKeys.has(key) || detachedByKey.has(key)) continue
    liveIds.add(item.id)
    if (item.detached) detachedByKey.set(key, item)
    else seenKeys.add(key)
    indexIdentityItem(item)
    indexLegacyItem(item)
    state.items.push(item)
    deletedKeys.delete(key)
    // 移除时已回收缩略图 URL；存档项由卡片进入视口时按 thumbB64 惰性重建
    item.thumb = undefined
    if (item.file && !item.metaOnly && !item.detached) item.url = URL.createObjectURL(item.file)
    // 恢复移除时扣减的批次账（在途项移除时未动账，增量为 0）
    state.batchTotal -= entry.totalDelta
    state.batchDone -= entry.doneDelta
    if (item.status === 'pending' && !queue.includes(item) && !hasInflight(item.id)) {
      queue.push(item)
      // 在途结果若已在移除期间丢弃，需重新计一次总数，避免进度条永远差一项
      if (entry.totalDelta === 0) state.batchTotal++
      batchCounted.add(item)
    }
    if (persistAvailable) markDirty(item)
    restored++
  }
  if (restored) {
    pump()
    schedulePersist()
  }
  return restored
}

export function removeItem(item: ImageItem) {
  removeItems([item])
}

/** 用户单条移除（可撤销）：卡片移除 / 详情键盘删除共用 */
export function removeItemUndoable(item: ImageItem) {
  removeItemsInternal([item], true)
}

/**
 * 批量移除：单次遍历重建列表，统一维护指纹 / 存活账本与进度计数，整批 O(n)
 * （逐条 removeItem 是 O(n·m)，万级列表批量删除会卡顿）。语义与单条移除一致：
 * 不在当前列表中的项跳过；在途项不动计数（完成时对账），排队项整体出队，
 * done / error 两本账一起减。
 * 用户入口使用 removeItemsUndoable：保留 10 秒撤销窗口；内部清理走本函数。
 */
export function removeItems(items: ImageItem[]) {
  removeItemsInternal(items, false)
}

/** 用户批量移除（可撤销）：批量操作条 / 重复治理共用 */
export function removeItemsUndoable(items: ImageItem[]): number {
  return removeItemsInternal(items, true)
}

function removeItemsInternal(items: ImageItem[], undoable: boolean): number {
  const removing = new Set<ImageItem>(items)
  if (!removing.size) return 0
  const removedItems: ImageItem[] = []
  const keep: ImageItem[] = []
  for (const it of state.items) {
    if (removing.delete(it)) removedItems.push(it)
    else keep.push(it)
  }
  if (!removedItems.length) return 0
  state.items = keep
  const queuedItems = new Set(queue)
  const queuedIds = new Set<string>()
  const entries: RemovalEntry[] = []
  for (const it of removedItems) {
    liveIds.delete(it.id)
    const key = recordKeyOf(it)
    unindexIdentityItem(it)
    unindexLegacyItem(it)
    seenKeys.delete(key)
    if (it.detached) detachedByKey.delete(key)
    dirtyItems.delete(key)
    dirtyThumbs.delete(key)
    deletedKeys.add(key)
    URL.revokeObjectURL(it.url)
    if (it.thumb) URL.revokeObjectURL(it.thumb)
    const wasQueued = queuedItems.has(it)
    const counted = batchCounted.has(it)
    let totalDelta = 0
    let doneDelta = 0
    if (wasQueued) {
      queuedIds.add(it.id)
      if (counted) totalDelta = -1
    }
    if (hasInflight(it.id)) {
      // 在途（含结果已入暂存未应用）：无法中断也不动计数，其 batchDone++ 已在完成时
      // 与保留的 batchTotal 对齐；若另有排队的新版本，上面已单独撤销其计数
    } else if (it.status === 'pending') {
      if (!wasQueued && counted) totalDelta = -1
    } else if (counted) {
      // done / error：两本账一起减（仅限已计入批次的项；存档项从未计入，不能动账）
      totalDelta = -1
      doneDelta = -1
    }
    state.batchTotal += totalDelta
    state.batchDone += doneDelta
    if (undoable) entries.push({ item: it, key, totalDelta, doneDelta })
  }
  // 排队项一次性出队（逐条 indexOf 是 O(队列长 × 移除数)）
  if (queuedIds.size) {
    let w = 0
    for (let i = 0; i < queue.length; i++) {
      if (!queuedIds.has(queue[i]!.id)) queue[w++] = queue[i]!
    }
    queue.length = w
  }
  // 大批移除后清空长文本常驻池（OPT-2）：被删条目的工作流文本通常不会再被命中，
  // 继续留在池里只会占用内存；清空只释放池引用，不影响列表内其余条目。
  if (removedItems.length >= CACHE_RESET_REMOVAL) {
    clearInternPool()
    clearContentHashCache()
  }
  if (undoable && entries.length) startUndoWindow(entries)
  schedulePersist()
  return removedItems.length
}

export function clearAll() {
  // 清空后撤销窗口与完全重复扫描结果必须失效：否则撤销 / 清理会作用于已清空列表
  dismissUndo()
  invalidateFileDupes()
  for (const i of state.items) {
    URL.revokeObjectURL(i.url)
    if (i.thumb) URL.revokeObjectURL(i.thumb)
  }
  state.items = []
  seenKeys.clear()
  liveIds.clear()
  detachedByKey.clear()
  legacyItemsByKey.clear()
  itemsByIdentityKey.clear()
  queue.length = 0
  inflight.clear()
  activeParses.clear()
  scanEpoch++ // 在途目录枚举的后续批次按代际丢弃，不得把清掉的文件找回
  // 自动重扫开着的话，下一拍会把目录里所有文件当新文件全部拉回，「清空」形同虚设——
  // 清空即停止监视（偏好开关同步熄灭，重新记住目录 / 手动开启可恢复）
  state.autoRescan = false
  // 丢弃未应用的解析结果并取消节拍定时器：孤儿结果在应用时也会被 liveIds 拦截，这里直接清干净
  if (applyTimer !== null) {
    clearTimeout(applyTimer)
    applyTimer = null
  }
  pendingResults = []
  state.batchTotal = 0
  state.batchDone = 0
  batchEpoch++ // 在途解析完成后不再计入新批次
  clearInternPool() // 在途解析完成时会把结果串重新入池，无碍
  clearContentHashCache() // 清空后内容哈希缓存不再有复用价值，回收其持有的长文本
  persistEpoch++ // 作废在途写库批次，历史记录一并清除（所见即所得）
  dirtyItems.clear()
  dirtyThumbs.clear()
  deletedKeys.clear()
  pendingClear = true
  void flushPersistNow()
}

/* ---------- 目录书签（FEAT-7 多目录：切换重扫目标 / 一键重扫） ---------- */
// 句柄不放进 reactive 状态：代理对象无法结构化克隆回写 IndexedDB，界面只依赖 rescanName / dirBookmarks
let rescanHandle: FileSystemDirectoryHandle | null = null
let rescanBookmarkId: string | null = null
const dirBookmarks = new Map<string, DirBookmark>()
const bookmarkLabelToId = new Map<string, string>()
let directoryIdSeq = 0
let hydrationPromise: Promise<void> = Promise.resolve()

function newDirectorySourceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid
    ? `dir:${uuid}`
    : `dir:${Date.now().toString(36)}:${(++directoryIdSeq).toString(36)}:${Math.random().toString(36).slice(2)}`
}

/** 为当前句柄取稳定身份；FileSystemDirectoryHandle.isSameEntry 可跨重新选择识别同一目录。 */
export async function getDirectorySourceId(handle: FileSystemDirectoryHandle): Promise<string> {
  // 先完成 IndexedDB 书签恢复，避免启动早期选择目录时给已记住的来源误分配新 ID。
  await hydrationPromise
  const comparable = handle as FileSystemDirectoryHandle & {
    isSameEntry?: (other: FileSystemHandle) => Promise<boolean>
  }
  for (const [id, bookmark] of dirBookmarks) {
    if (bookmark.handle === handle) return id
    if (!comparable.isSameEntry) continue
    try {
      if (await comparable.isSameEntry(bookmark.handle)) return id
    } catch {
      // 浏览器可能因旧句柄失效而拒绝比较；该项按不同来源处理，不能误合并。
    }
  }
  return newDirectorySourceId()
}

function refreshDirNames() {
  const sorted = [...dirBookmarks.values()].sort((a, b) => b.savedAt - a.savedAt)
  const totals = new Map<string, number>()
  for (const bookmark of sorted) totals.set(bookmark.name, (totals.get(bookmark.name) ?? 0) + 1)
  const seen = new Map<string, number>()
  bookmarkLabelToId.clear()
  const labels = sorted.map((bookmark) => {
    const occurrence = (seen.get(bookmark.name) ?? 0) + 1
    seen.set(bookmark.name, occurrence)
    const baseLabel =
      (totals.get(bookmark.name) ?? 0) > 1 ? `${bookmark.name} (${occurrence})` : bookmark.name
    let label = baseLabel
    if (bookmarkLabelToId.has(label)) label = `${baseLabel} · ${bookmark.id.slice(-4)}`
    let suffix = 2
    while (bookmarkLabelToId.has(label))
      label = `${baseLabel} · ${bookmark.id.slice(-4)}-${suffix++}`
    bookmarkLabelToId.set(label, bookmark.id)
    return label
  })
  state.dirBookmarks = labels
  state.rescanName = rescanBookmarkId
    ? (sorted.find((bookmark) => bookmark.id === rescanBookmarkId)?.name ?? null)
    : null
  // When names collide, the visible label carries the ordinal used by the menu.
  if (rescanBookmarkId) {
    const index = sorted.findIndex((bookmark) => bookmark.id === rescanBookmarkId)
    if (index >= 0) state.rescanName = labels[index] ?? state.rescanName
  }
}

/** 记住目录并设为当前重扫目标；同名但不同句柄的目录保留为独立书签。 */
export async function setRescanHandle(
  handle: FileSystemDirectoryHandle,
  sourceId?: string,
): Promise<string> {
  const id = sourceId ?? (await getDirectorySourceId(handle))
  rescanHandle = handle
  rescanBookmarkId = id
  dirBookmarks.set(id, { id, name: handle.name, handle, savedAt: Date.now() })
  refreshDirNames()
  syncAutoRescanTimer()
  dirtyBookmarks = true
  bookmarkRevision++
  await flushPersistNow()
  return id
}

/** 切换当前重扫目标为已记住的目录（不立即扫描）；无此书签返回 false */
export function switchRescanTarget(label: string): boolean {
  const id = bookmarkLabelToId.get(label) ?? (dirBookmarks.has(label) ? label : null)
  const bm = id ? dirBookmarks.get(id) : undefined
  if (!bm) return false
  rescanHandle = bm.handle
  rescanBookmarkId = bm.id
  refreshDirNames()
  syncAutoRescanTimer()
  return true
}

/** 不再记住当前目录（仅移除该书签，其余书签保留） */
export function forgetRescanHandle() {
  const id = rescanBookmarkId
  if (id) {
    dirBookmarks.delete(id)
    refreshDirNames()
  }
  rescanHandle = null
  rescanBookmarkId = null
  state.rescanName = null
  syncAutoRescanTimer() // 自动重扫随当前目标消失停表；偏好保留，下次记住目录时自动恢复
  if (id) {
    dirtyBookmarks = true
    bookmarkRevision++
    void flushPersistNow()
  }
}

/** 清除全部目录书签（含当前重扫目标） */
export function clearAllDirBookmarks() {
  dirBookmarks.clear()
  refreshDirNames()
  rescanHandle = null
  rescanBookmarkId = null
  state.rescanName = null
  syncAutoRescanTimer()
  dirtyBookmarks = true
  clearBookmarksPending = true
  bookmarkRevision++
  void flushPersistNow()
}

/** 扫描单个目录句柄（增量入列）：返回新增或更新数，无权限 / 枚举失败返回 null（F3 抽取复用） */
async function scanDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  sourceId: string,
): Promise<number | null> {
  // 代际号在入口捕获（含权限等待之前）：清空列表前发起的整轮扫描都属旧代际
  const epoch = scanEpoch
  if (!(await ensureReadPermission(handle))) return null
  let added = 0
  try {
    await collectDirectoryFiles(handle, (files) => {
      // 代际检查：clearAll 后在途枚举的后续批次不再入列——seenKeys 已清空，
      // 继续入列会把刚清掉的文件全部当新文件重新解析（「清空后自己回来」）
      if (epoch !== scanEpoch) return
      added += addFiles(files.map((file) => ({ ...file, sourceId })))
    })
  } catch {
    // 目录被删除 / 移动（U 盘拔出等）：本拍按不可用处理。手动重扫由调用方提示无权限，
    // 自动重扫各拍静默重试，不再把枚举异常抛成全局错误横幅 / unhandled rejection
    return null
  }
  return added
}

/**
 * 一键重扫记住的目录：新增文件入列；同位置的新版本更新原项并重解析，精确版本去重 / 回挂。
 * 分批边扫边入列；返回新增或更新并重新解析的文件数，无句柄或未获授权返回 null。
 */
export async function rescanDirectory(): Promise<number | null> {
  if (!rescanHandle || !rescanBookmarkId) return null
  return scanDirectoryHandle(rescanHandle, rescanBookmarkId)
}

/**
 * 一键重扫全部记住的目录（F3）：顺序扫描每个书签并增量入列。
 * 返回新增或更新总数与失败的目录数（无权限 / 目录已失联）。
 */
export async function rescanAllDirectories(): Promise<{ added: number; failed: number }> {
  let added = 0
  let failed = 0
  for (const [id, { handle }] of dirBookmarks) {
    const n = await scanDirectoryHandle(handle, id)
    if (n === null) failed++
    else added += n
  }
  return { added, failed }
}

/* ---------- 目录监视自动重扫（FEAT-1：边出图边看） ---------- */
let autoRescanTimer: ReturnType<typeof setInterval> | null = null
let autoTickBusy = false
// 目录枚举代际：clearAll 递增，作废在途枚举的后续批次（见 rescanDirectory）
let scanEpoch = 0

/** 按偏好与句柄的有无启停周期定时器；偏好切换 / 句柄变化时调用。先清后建：
 * 定时器已在运行时改间隔也要按新值重建，否则永远沿用旧间隔（I1） */
function syncAutoRescanTimer() {
  const shouldRun = state.autoRescan && rescanHandle !== null
  if (autoRescanTimer !== null) {
    clearInterval(autoRescanTimer)
    autoRescanTimer = null
  }
  if (shouldRun) {
    autoRescanTimer = setInterval(() => void autoRescanTick(), state.autoRescanInterval * 1000)
  }
}

/**
 * 单次自动重扫：上一轮解析未完（或上一拍扫描未返回）时跳过，等下一拍；
 * 权限未授予时静默重试——授权需用户手势，手动点「重扫」授权后自动监视随之恢复；
 * 目录句柄已不存在时自动关闭并停表。
 */
async function autoRescanTick() {
  if (autoTickBusy || !state.autoRescan || parsing.value) return
  autoTickBusy = true
  try {
    const added = await rescanDirectory()
    if (added === null && rescanHandle === null) state.autoRescan = false
  } finally {
    autoTickBusy = false
  }
}

watch(
  () => state.autoRescan,
  (on) => {
    safeSetItem(AUTO_RESCAN_KEY, on ? '1' : '0')
    syncAutoRescanTimer()
  },
)

watch(
  () => state.autoRescanInterval,
  (v) => {
    safeSetItem(AUTO_RESCAN_INTERVAL_KEY, String(v))
    syncAutoRescanTimer() // 按新间隔重启周期定时器
  },
)

/* ---------- 会话持久化：失败状态可见，未提交的数据留在内存待重试 ---------- */
let persistAvailable = false
let persistEpoch = 0
const dirtyItems = new Map<string, ImageItem>()
/** F2：待写库的缩略图字节（指纹 → JPEG 原始字节），与 dirtyItems 同批同生命周期 */
const dirtyThumbs = new Map<string, Uint8Array>()
const deletedKeys = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushRunning = false
let pendingClear = false
let dirtyBookmarks = false
let clearBookmarksPending = false
let bookmarkRevision = 0

function persistenceErrorText(err: unknown): string {
  // 配额满是最常见的可自愈失败：给可行动指引而非裸异常名（C1）
  const name = err instanceof Error ? err.name : ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return t('persistence.quota')
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** 读取持久存储授予状态与占用估算写入响应式状态（C1），供状态徽章提示 */
async function refreshStorageUsage() {
  state.storagePersisted = storagePersistedState()
  state.storageUsage = await storageEstimate()
}

function hasPendingPersistence(): boolean {
  return (
    pendingClear ||
    dirtyBookmarks ||
    dirtyItems.size > 0 ||
    dirtyThumbs.size > 0 ||
    deletedKeys.size > 0
  )
}

/**
 * 把存档记录装回列表（hydrate 与测试共用）：跳过同位置已存在的实时文件，
 * 并保留同一位置最新内容版本（用户已拖入的文件优先）。
 * 必须以响应式代理入列并用同一代理建回挂索引：addFiles 回挂时改写的是这个代理，
 * 绕过代理的原始对象不会触发视图更新。
 * 搜索串不在此构建（P2 惰性化，见 searchTextField）——万级存档恢复只做建项，
 * 长文本拼接与小写化按需 / 空闲分批进行。
 */
export function restoreArchived(records: PersistRecord[]) {
  for (const rec of records) {
    if (deletedKeys.has(rec.key)) continue
    if (seenKeys.has(rec.key)) continue
    // 同指纹存档卡已在列：hydrate 分批恢复未完成时导入备份，同一记录会从两条路径到达，
    // 存档项从不写入 seenKeys（为了允许回挂），这里以 detachedByKey 兜底防重复卡片
    if (detachedByKey.has(rec.key)) continue
    const item = reactive<ImageItem>(fromRecord(rec))
    const sameIdentity = [...(itemsByIdentityKey.get(fileIdentityKeyOf(item)) ?? [])]
    const liveItem = sameIdentity.find((existing) => !existing.detached)
    if (liveItem) {
      const liveKey = recordKeyOf(liveItem)
      migrateUserMetadataKey(rec.key, liveKey)
      if (rec.key !== liveKey) {
        deletedKeys.add(rec.key)
        schedulePersist()
      }
      continue
    }
    const archivedItems = sameIdentity.filter((existing) => existing.detached)
    if (archivedItems.length) {
      const latest = archivedItems.reduce((best, candidate) =>
        candidate.mtime >= best.mtime ? candidate : best,
      )
      const useIncoming = rec.mtime >= latest.mtime
      const targetKey = useIncoming ? rec.key : recordKeyOf(latest)
      for (const stale of archivedItems) {
        if (stale === latest) continue
        const staleKey = recordKeyOf(stale)
        removeItems([stale])
        migrateUserMetadataKey(staleKey, targetKey)
      }
      if (useIncoming) replaceDetachedRecord(latest, rec)
      else if (rec.key !== targetKey) {
        migrateUserMetadataKey(rec.key, targetKey)
        deletedKeys.add(rec.key)
        schedulePersist()
      }
      continue
    }
    detachedByKey.set(rec.key, item)
    liveIds.add(item.id)
    indexIdentityItem(item)
    indexLegacyItem(item)
    state.items.push(item)
  }
}

/** Replace a detached archive snapshot while keeping its UI identity and stable identity index. */
function replaceDetachedRecord(item: ImageItem, rec: PersistRecord) {
  const oldKey = recordKeyOf(item)
  const replacement = fromRecord(rec)
  const id = item.id
  unindexIdentityItem(item)
  unindexLegacyItem(item)
  detachedByKey.delete(oldKey)
  dirtyItems.delete(oldKey)
  dirtyThumbs.delete(oldKey)
  if (item.thumb) URL.revokeObjectURL(item.thumb)
  if (oldKey !== rec.key) {
    deletedKeys.add(oldKey)
    migrateUserMetadataKey(oldKey, rec.key)
  }
  Object.assign(item, replacement, { id, searchText: undefined, thumb: undefined })
  recordKeyCache.delete(item)
  fileIdentityKeyCache.delete(item)
  detachedByKey.set(rec.key, item)
  indexIdentityItem(item)
  indexLegacyItem(item)
  markDirty(item)
}

function markDirty(item: ImageItem) {
  if (!persistAvailable) return
  // 已移除 / 已清空的项不再写库：removeItem / clearAll 后完成的在途解析不得“复活”到存档
  if (!liveIds.has(item.id)) return
  const key = recordKeyOf(item)
  deletedKeys.delete(key)
  dirtyItems.set(key, item)
  schedulePersist()
}

function schedulePersist() {
  if (!persistAvailable) return
  state.persistenceStatus = 'saving'
  state.persistenceError = null
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPersist()
  }, 500)
}

async function flushPersistNow() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushPersist()
}

async function flushPersist() {
  if (!persistAvailable) return
  if (flushRunning) {
    schedulePersist()
    return
  }
  flushRunning = true
  state.persistenceStatus = 'saving'
  state.persistenceError = null
  const epoch = persistEpoch
  // 取消检查贯穿到事务创建前：flush 在 await getDb 期间遇 clearAll 时，
  // persistEpoch 已作废本轮，写库若继续排队会落在 clearPersisted 之后，把已清历史写回
  const isStale = () => epoch !== persistEpoch
  const clearBatch = pendingClear
  const bookmarkBatch = dirtyBookmarks ? [...dirBookmarks.values()] : null
  const bookmarkRevisionBatch = bookmarkRevision
  const clearBookmarksBatch = clearBookmarksPending
  const items = [...dirtyItems.values()]
  dirtyItems.clear()
  const thumbs = new Map(dirtyThumbs)
  dirtyThumbs.clear()
  const keys = [...deletedKeys]
  deletedKeys.clear()
  let failed = false
  try {
    // 清空列表会作废本轮写库，避免把已删除的历史写回去
    if (isStale()) return
    if (clearBatch) {
      await clearPersisted()
      if (isStale()) return
      pendingClear = false
    }
    const records = items
      .map((it) => {
        const r = toRecord(it)
        if (!r) return null
        // F2：本批解析得到的缩略图以 base64 入 blobs store（内容寻址，同图去重）
        const tb = thumbs.get(recordKeyOf(it))
        if (tb) r.thumbB64 = bytesToBase64(tb)
        return r
      })
      .filter((r) => r !== null)
    if (records.length) await putPersisted(records, isStale)
    if (keys.length && !isStale()) await deletePersisted(keys, isStale)
    if (bookmarkBatch && !isStale()) {
      await clearPersistedBookmarks()
      for (const bookmark of bookmarkBatch) {
        if (isStale()) return
        await saveDirBookmark(bookmark.handle, bookmark.id)
      }
    }
    if (isStale()) return
    if (bookmarkBatch && bookmarkRevisionBatch === bookmarkRevision) {
      dirtyBookmarks = false
      clearBookmarksPending = false
    }
  } catch (err) {
    failed = true
    // 失败时保留整个批次；UI 提供显式重试，避免持久错误下无界自动重试。
    if (!isStale()) {
      for (const it of items) {
        if (!liveIds.has(it.id)) continue
        const k = recordKeyOf(it)
        dirtyItems.set(k, it)
        const tb = thumbs.get(k)
        if (tb) dirtyThumbs.set(k, tb)
      }
      // 删除标记不覆盖写库期间被重新 markDirty 的指纹（后者已从 deletedKeys 摘除）
      for (const k of keys) if (!dirtyItems.has(k)) deletedKeys.add(k)
      if (bookmarkBatch) dirtyBookmarks = true
      if (clearBookmarksBatch) clearBookmarksPending = true
      state.persistenceStatus = 'error'
      state.persistenceError = persistenceErrorText(err)
    }
    console.warn('[comfyui-info] 存档写入失败，暂存区保留待重试:', err)
  } finally {
    flushRunning = false
  }
  if (isStale() || failed) return
  if (hasPendingPersistence()) schedulePersist()
  else {
    state.persistenceStatus = 'saved'
    state.persistenceError = null
    void refreshStorageUsage() // 存档体积随写入变化，成功后刷新占用估算（C1）
  }
}

/** 启动 / 手动重试恢复 IndexedDB；失败状态写入界面供用户判断和重试。 */
async function hydrate() {
  state.persistenceStatus = 'checking'
  state.persistenceError = null
  // 清空竞态哨兵：恢复期间 clearAll 会递增 persistEpoch 并清库，flushPersist 成功后
  // pendingClear 复位为 false——单靠它拦不住「读库取到清库前快照 → 清库完成 → 旧记录装回」
  // 的时序（磁盘已清、界面复活，刷新即消失），必须以代际号作第二取消条件
  const epoch = persistEpoch
  try {
    persistAvailable = await probePersistence()
    if (!persistAvailable) {
      state.persistenceStatus = 'unavailable'
      state.persistenceError = null
      return
    }
    // 首次成功探测即申请持久存储（防浏览器磁盘压力下静默清库），并读取占用估算（C1）
    requestPersistentStorage()
    void refreshStorageUsage()
    if (!pendingClear && epoch === persistEpoch) {
      const records = await loadPersisted()
      await restoreArchivedInChunks(records, () => pendingClear || epoch !== persistEpoch)
    }
    // 恢复全部目录书签（FEAT-7），最近记住的作为当前重扫目标
    const bookmarks = clearBookmarksPending ? [] : await loadDirBookmarks()
    for (const bm of bookmarks) dirBookmarks.set(bm.id, bm)
    refreshDirNames()
    const latest = bookmarks[0]
    if (latest && !rescanBookmarkId) {
      rescanHandle = latest.handle
      rescanBookmarkId = latest.id
      syncAutoRescanTimer() // 偏好为开时恢复自动监视（权限需重新授权时各拍静默重试）
    }
    if (hasPendingPersistence()) schedulePersist()
    else state.persistenceStatus = 'saved'
  } catch (err) {
    persistAvailable = false
    state.persistenceStatus = 'error'
    state.persistenceError = persistenceErrorText(err)
    console.warn('[comfyui-info] 会话恢复失败，本次会话不启用持久化:', err)
  }
}

/** 手动重试失败的 IndexedDB 操作；恢复连接后将当前内存记录一并补写。 */
export async function retryPersistence(): Promise<void> {
  if (state.persistenceStatus === 'checking' || flushRunning) return
  if (!persistAvailable) {
    await hydrate()
    if (!persistAvailable) return
    for (const item of state.items) {
      if (item.status !== 'pending') markDirty(item)
    }
  }
  if (hasPendingPersistence()) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    await flushPersist()
  } else {
    state.persistenceStatus = 'saved'
    state.persistenceError = null
  }
}

/* ---------- 启动恢复分批进行（OPT-6）：万级存档不整段阻塞首屏 ---------- */

const RESTORE_CHUNK = 1000

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * 存档分批装回：每批之间让出主线程处理渲染与输入，卡片渐进出现；
 * 全部装回后再空闲分批预热存档项的搜索串（命中 WeakMap 缓存后首次搜索零等待）。
 */
async function restoreArchivedInChunks(records: PersistRecord[], cancelled = () => false) {
  for (let i = 0; i < records.length; i += RESTORE_CHUNK) {
    if (cancelled()) return
    restoreArchived(records.slice(i, i + RESTORE_CHUNK))
    await yieldToMain()
  }
  for (let i = 0; i < state.items.length; i += RESTORE_CHUNK) {
    if (cancelled()) return
    let warmed = false
    for (let j = i; j < Math.min(i + RESTORE_CHUNK, state.items.length); j++) {
      const it = state.items[j]!
      if (it.searchText === undefined) {
        prewarmSearchText(it)
        warmed = true
      }
    }
    if (warmed) await yieldToMain()
  }
}

/* ---------- 存档备份（FEAT-6：防清库 / 跨设备迁移） ---------- */

export interface ArchiveImportPreview {
  version?: number
  exportedAt?: string
  records: number
  invalidRecords: number
  duplicateRecords: number
  alreadyPresent: number
  willImport: number
  favorites: number
  newFavorites: number
  tagRecords: number
  changedTagRecords: number
  /** v4：备份携带的筛选预设 / 新增预设 / 搜索历史 / 可应用偏好项数 */
  presets: number
  newPresets: number
  searchHistory: number
  preferences: number
  warningCount: number
}

interface PreparedArchiveImport {
  inspection: ArchiveInspection
  localRecords: PersistRecord[]
  fresh: PersistRecord[]
  alreadyPresent: number
  localFavorites: string[]
  localTags: Record<string, string[]>
  localPresets: ArchivePreset[]
  localSearchHistory: string[]
  localPreferences?: ArchivePreferences
  duplicateRecords: number
}

/** Share identity remapping between preview and commit so the counts match the import path. */
function prepareArchiveImport(text: string): PreparedArchiveImport {
  const inspection = inspectArchive(text)
  const { records, favorites, tags, presets, searchHistory, preferences } = inspection
  // 来源 ID 是目录句柄的本机身份。当前机器已有同一来源时保留它以便幂等导入；
  // 外部备份的 ID 加 imported 前缀，重新选择本机目录时可按唯一旧路径别名迁移。
  const remappedKeys = new Map<string, string>()
  const candidatesByIdentity = new Map<string, { record: PersistRecord; sourceKeys: string[] }>()
  let duplicateRecords = inspection.duplicateRecords
  let identityMatches = 0
  for (const rec of records) {
    const alreadyKnown = seenKeys.has(rec.key) || detachedByKey.has(rec.key)
    const sourceId =
      rec.sourceId &&
      !rec.sourceId.startsWith('imported:') &&
      !dirBookmarks.has(rec.sourceId) &&
      !alreadyKnown
        ? `imported:${rec.sourceId}`
        : rec.sourceId
    const key = recordKey({
      path: rec.path,
      name: rec.name,
      sourceId,
      size: rec.size,
      mtime: rec.mtime,
    })
    const localIdentity = { ...rec, sourceId }
    let current = [...(itemsByIdentityKey.get(fileIdentityKey(localIdentity)) ?? [])].find(
      (item) => !item.detached,
    )
    if (!current && rec.path) {
      const legacyMatches = [...(legacyItemsByKey.get(legacyRecordKey(rec)) ?? [])].filter(
        (item) => !item.detached,
      )
      if (legacyMatches.length === 1) current = legacyMatches[0]
    }
    if (current) {
      remappedKeys.set(rec.key, recordKeyOf(current))
      identityMatches++
      continue
    }
    const candidate = candidatesByIdentity.get(fileIdentityKey(localIdentity))
    if (candidate) {
      candidate.sourceKeys.push(rec.key)
      duplicateRecords++
      if (rec.mtime >= candidate.record.mtime) {
        candidate.record = { ...rec, sourceId, key }
      }
    } else {
      candidatesByIdentity.set(fileIdentityKey(localIdentity), {
        record: { ...rec, sourceId, key },
        sourceKeys: [rec.key],
      })
    }
  }
  const localRecords: PersistRecord[] = []
  const localKeys = new Set<string>()
  for (const candidate of candidatesByIdentity.values()) {
    for (const sourceKey of candidate.sourceKeys) {
      remappedKeys.set(sourceKey, candidate.record.key)
    }
    if (localKeys.has(candidate.record.key)) {
      duplicateRecords++
      continue
    }
    localKeys.add(candidate.record.key)
    localRecords.push(candidate.record)
  }
  const localFavorites = [...new Set(favorites.map((key) => remappedKeys.get(key) ?? key))]
  const localTags: Record<string, string[]> = {}
  for (const [key, names] of Object.entries(tags)) {
    const mapped = remappedKeys.get(key) ?? key
    localTags[mapped] = [...new Set([...(localTags[mapped] ?? []), ...names])]
  }
  const fresh = localRecords.filter((r) => !seenKeys.has(r.key) && !detachedByKey.has(r.key))
  return {
    inspection,
    localRecords,
    fresh,
    alreadyPresent: identityMatches + localRecords.length - fresh.length,
    localFavorites,
    localTags,
    localPresets: presets,
    localSearchHistory: searchHistory,
    localPreferences: preferences,
    duplicateRecords,
  }
}

/** Validate without mutation and report what the eventual import will add or skip. */
export function previewArchiveImport(text: string): ArchiveImportPreview {
  const prepared = prepareArchiveImport(text)
  let newFavorites = 0
  for (const key of prepared.localFavorites) if (!favKeys.has(key)) newFavorites++
  let changedTagRecords = 0
  for (const [key, names] of Object.entries(prepared.localTags)) {
    const existing = itemTags[key] ?? []
    if (names.some((name) => !existing.includes(name))) changedTagRecords++
  }
  return {
    version: prepared.inspection.version,
    exportedAt: prepared.inspection.exportedAt,
    records: prepared.inspection.records.length,
    invalidRecords: prepared.inspection.invalidRecords,
    duplicateRecords: prepared.duplicateRecords,
    alreadyPresent: prepared.alreadyPresent,
    willImport: prepared.fresh.length,
    favorites: prepared.localFavorites.length,
    newFavorites,
    tagRecords: Object.keys(prepared.localTags).length,
    changedTagRecords,
    presets: prepared.localPresets.length,
    newPresets: prepared.localPresets.filter(
      (preset) => !filterPresets.value.some((existing) => existing.name === preset.name),
    ).length,
    searchHistory: prepared.localSearchHistory.length,
    preferences: prepared.localPreferences ? Object.keys(prepared.localPreferences).length : 0,
    warningCount:
      prepared.inspection.warningCount +
      (prepared.duplicateRecords - prepared.inspection.duplicateRecords),
  }
}

/** 当前列表全部可存档项 → 备份文本（含参数、诊断信息、收藏 / 标签、预设与视图偏好，不含图片本体） */
export function buildArchiveBackup(): { text: string; count: number } {
  const records = state.items.map(toRecord).filter((r) => r !== null)
  const preferences: ArchivePreferences = {
    sortMode: state.sortMode,
    thumbSize: state.thumbSize,
    safeMode: state.safeMode,
  }
  // 主题 / 语言只有用户显式选择过才随备份走；跟随系统 / 浏览器的用户迁移后保持自动跟随
  const storedTheme = safeGetItem('cii:theme')
  if (storedTheme === 'dark' || storedTheme === 'light') preferences.theme = storedTheme
  const storedLocale = safeGetItem('cii:locale')
  if (storedLocale === 'zh' || storedLocale === 'en') preferences.locale = storedLocale
  return {
    text: serializeArchive(
      records,
      [...favKeys],
      { ...itemTags },
      {
        presets: filterPresets.value,
        searchHistory: recentSearches.value,
        preferences,
      },
    ),
    count: records.length,
  }
}

/**
 * 导入存档备份：与库存 / 存档同指纹的记录跳过，返回实际恢复的记录数与
 * 合并的收藏标记数、新增标签的指纹数（备份里的收藏 / 标签按指纹并入本机账本，
 * 存档卡片即带星标与标签）；持久化不可用时仅恢复到本会话内存。
 * 备份结构非法时抛错由调用方提示。
 */
export async function importArchive(text: string): Promise<{
  n: number
  favs: number
  tags: number
  presets: number
  history: number
  prefs: number
}> {
  const { fresh, localFavorites, localTags, localPresets, localSearchHistory, localPreferences } =
    prepareArchiveImport(text)
  let n = fresh.length
  if (persistAvailable) {
    const written = await importPersisted(fresh)
    restoreArchived(written)
    n = written.length
  } else {
    restoreArchived(fresh)
  }
  // v4 附带数据：记录恢复完成后统一合并，避免中途失败留下半套偏好
  return {
    n,
    favs: mergeArchivedFavorites(localFavorites),
    tags: mergeArchivedTags(localTags),
    presets: mergeArchivedPresets(localPresets),
    history: mergeArchivedSearchHistory(localSearchHistory),
    prefs: applyArchivePreferences(localPreferences),
  }
}

/** 把备份携带的收藏指纹并入本机账本（幂等：已存在的跳过），返回实际新增数 */
function mergeArchivedFavorites(favorites: string[]): number {
  let added = 0
  for (const key of favorites) {
    if (!favKeys.has(key)) {
      favKeys.add(key)
      added++
    }
  }
  if (added) persistFavorites()
  return added
}

/** 把备份携带的标签映射并入本机账本（幂等：同指纹同标签跳过），返回新增指纹数 */
function mergeArchivedTags(tags: Record<string, string[]>): number {
  let added = 0
  for (const [key, names] of Object.entries(tags)) {
    if (!names.length) continue
    const existing = itemTags[key] ?? []
    const merged = [...new Set([...existing, ...names])]
    if (merged.length !== existing.length) {
      itemTags[key] = merged
      added++
    }
  }
  if (added) persistTags()
  return added
}

/** 合并备份预设：同名覆盖、其余追加，返回应用数量（FEAT-5） */
function mergeArchivedPresets(presets: ArchivePreset[]): number {
  if (!presets.length) return 0
  for (const preset of presets) {
    const i = filterPresets.value.findIndex((p) => p.name === preset.name)
    if (i >= 0) filterPresets.value.splice(i, 1, preset)
    else filterPresets.value.push(preset)
  }
  persistPresets()
  return presets.length
}

/** 合并备份搜索历史：大小写不敏感去重，保留最近 10 条（FEAT-5） */
function mergeArchivedSearchHistory(history: string[]): number {
  if (!history.length) return 0
  const existing = new Set(recentSearches.value.map((q) => q.toLowerCase()))
  let added = 0
  for (const query of history) {
    const key = query.toLowerCase()
    if (existing.has(key)) continue
    recentSearches.value.push(query)
    existing.add(key)
    added++
  }
  if (recentSearches.value.length > HISTORY_LIMIT) recentSearches.value.length = HISTORY_LIMIT
  if (added) safeSetItem(HISTORY_KEY, JSON.stringify(recentSearches.value))
  return added
}

/** 应用备份视图偏好（主题 / 语言 / 排序 / 缩略图 / 安全模式），返回应用项数（FEAT-5） */
function applyArchivePreferences(preferences?: ArchivePreferences): number {
  if (!preferences) return 0
  let applied = 0
  if (preferences.theme) {
    state.dark = preferences.theme === 'dark'
    safeSetItem('cii:theme', preferences.theme)
    applied++
  }
  if (preferences.locale) {
    setLocale(preferences.locale)
    applied++
  }
  if (preferences.sortMode) {
    state.sortMode = preferences.sortMode
    applied++
  }
  if (preferences.thumbSize !== undefined) {
    state.thumbSize = preferences.thumbSize
    applied++
  }
  if (preferences.safeMode !== undefined) {
    state.safeMode = preferences.safeMode
    safeSetItem(SAFE_MODE_KEY, preferences.safeMode ? '1' : '0')
    applied++
  }
  return applied
}

hydrationPromise = hydrate()

/* ---------- 派生数据 ---------- */
export const parsing = computed(() => state.batchDone < state.batchTotal)
export const scanProgress = computed(() =>
  state.batchTotal === 0
    ? 0
    : Math.min(100, Math.round((state.batchDone / state.batchTotal) * 100)),
)

const sourceRank: Record<string, number> = { comfyui: 0, a1111: 1, fooocus: 2, none: 3 }

const rankBySource = (it: ImageItem) => (it.status === 'error' ? 4 : (sourceRank[it.source] ?? 4))
// 时间模式下失败项始终靠后（它们不属于时间线），时间相同再按文件名兜底
const errLast = (it: ImageItem) => (it.status === 'error' ? 1 : 0)
// Collator 预实例化：排序是 O(n log n) 次比较，复用实例走 Intl 快路径，大列表排序不再每次重建比较器
const nameCollator = new Intl.Collator('zh-CN', { numeric: true })
const byName = (a: ImageItem, b: ImageItem) => nameCollator.compare(a.name, b.name)

const sorters: Record<SortMode, (a: ImageItem, b: ImageItem) => number> = {
  default: (a, b) => rankBySource(a) - rankBySource(b) || byName(a, b),
  'time-desc': (a, b) => errLast(a) - errLast(b) || b.mtime - a.mtime || byName(a, b),
  'time-asc': (a, b) => errLast(a) - errLast(b) || a.mtime - b.mtime || byName(a, b),
  // 文件名排序：跨来源全局按名排（default 先按来源分组再按名），失败项同样垫底
  'name-asc': (a, b) => errLast(a) - errLast(b) || byName(a, b),
  'name-desc': (a, b) => errLast(a) - errLast(b) || byName(b, a),
  // F3：同工作流聚类——组按组内最新时间排列，组内新→旧，失败项垫底
  workflow: (a, b) => {
    const ea = errLast(a)
    const eb = errLast(b)
    if (ea !== eb) return ea - eb
    const ca = workflowClusters.value.get(a.id)
    const cb = workflowClusters.value.get(b.id)
    if (ca && cb && ca.group !== cb.group) return ca.group - cb.group
    return b.mtime - a.mtime || byName(a, b)
  },
}

export interface UsageStat {
  name: string
  count: number
}

/**
 * 一次遍历同时产出来源计数与模型 / LoRA / 采样器频次（OPT-6）：
 * 顶栏常驻读取 stats 与 modelOptions，原先两路 computed 各扫一遍全量条目；
 * 合并后每个解析批次只做一次 O(n) 聚合，再分别派生轻量结果。
 */
const libraryUsage = computed(() => {
  const sources: Record<ImageSource | 'error', number> = {
    comfyui: 0,
    a1111: 0,
    fooocus: 0,
    none: 0,
    error: 0,
  }
  const models = new Map<string, number>()
  const loras = new Map<string, number>()
  const samplers = new Map<string, number>()
  for (const it of state.items) {
    // 解析失败的项没有来源，单独计数，不冒充“无元数据”；
    // 解析中的项来源未定，同样不计数（初始 source:'none' 只是占位）
    if (it.status === 'error') sources.error++
    else if (it.status === 'done') sources[it.source]++
    const p = it.params
    if (!p) continue
    for (const m of p.models) models.set(m, (models.get(m) ?? 0) + 1)
    for (const l of p.loras) loras.set(l.name, (loras.get(l.name) ?? 0) + 1)
    for (const s of p.samplers) {
      if (s.sampler) samplers.set(s.sampler, (samplers.get(s.sampler) ?? 0) + 1)
    }
  }
  return { sources, models, loras, samplers }
})

export const stats = computed(() => libraryUsage.value.sources)

/**
 * 模型筛选下拉：复用 usageStats 的聚合一份数据源（同集合），按使用频次降序、
 * 同频次按名排序——「最常用的模型」排在最前，与统计抽屉的排行一致。
 */
export const modelOptions = computed(() =>
  usageStats.value.models.map((m) => ({ label: m.name, value: m.name })),
)

/** 生成统计：模型 / LoRA / 采样器使用频次（次数降序，同次数按名排序），复用同一次聚合结果 */
export const usageStats = computed(() => {
  const toList = (m: Map<string, number>): UsageStat[] =>
    Array.from(m, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count || nameCollator.compare(a.name, b.name),
    )
  return {
    models: toList(libraryUsage.value.models),
    loras: toList(libraryUsage.value.loras),
    samplers: toList(libraryUsage.value.samplers),
  }
})

export interface ModelStat {
  name: string
  count: number
  /** 最近一次用该模型出图的时间（mtime 最大值） */
  lastUsed: number
  /** A1111 Model hash（同名模型区分具体版本）；ComfyUI 工作流不提供 */
  hash?: string
}

/**
 * F4：按主模型聚合的出图统计（模型库抽屉数据源）。主模型取 params.models[0]
 * （checkpoint / unet；LoRA 等资产行另有统计），按张数降序、同数按名排序。
 */
export const modelStats = computed<ModelStat[]>(() => {
  const agg = new Map<string, { count: number; lastUsed: number; hash?: string }>()
  for (const it of state.items) {
    const name = it.params?.models?.[0]
    if (!name) continue
    const cur = agg.get(name)
    if (cur) {
      cur.count++
      if (it.mtime > cur.lastUsed) cur.lastUsed = it.mtime
      if (!cur.hash && it.params?.modelHash) cur.hash = it.params.modelHash
    } else {
      agg.set(name, { count: 1, lastUsed: it.mtime, hash: it.params?.modelHash })
    }
  }
  return Array.from(agg, ([name, v]) => ({ name, ...v })).sort(
    (a, b) => b.count - a.count || nameCollator.compare(a.name, b.name),
  )
})

export interface DayCount {
  /** 本地时区的 YYYY-MM-DD */
  day: string
  count: number
}

/** F5：按天出图量（本地时区聚合，仅含有出图的日期，新→旧，最多 14 天） */
export const dailyCounts = computed<DayCount[]>(() => {
  const byDay = new Map<string, number>()
  for (const it of state.items) {
    if (it.status !== 'done') continue
    const key = localDayKey(new Date(it.mtime))
    byDay.set(key, (byDay.get(key) ?? 0) + 1)
  }
  return Array.from(byDay, ([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, 14)
})

/** 提示词分词：按空白与常见标点切分，单字符与纯数字视为噪声 */
const KEYWORD_SPLIT_RE = /[\s,，、;；:：|()[\]{}<>"'`~·!！?？.]+/
const KEYWORD_LIMIT = 30

/** F5：正向提示词高频词 Top-N（跨条目累计出现次数），点击可应用搜索筛选 */
export const keywordStats = computed<UsageStat[]>(() => {
  const freq = new Map<string, number>()
  for (const it of state.items) {
    if (!it.params) continue
    for (const prompt of it.params.positive) {
      for (const raw of prompt.split(KEYWORD_SPLIT_RE)) {
        const w = raw.trim().toLowerCase()
        if (w.length < 2 || /^\d+$/.test(w)) continue
        freq.set(w, (freq.get(w) ?? 0) + 1)
      }
    }
  }
  return Array.from(freq, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || nameCollator.compare(a.name, b.name))
    .slice(0, KEYWORD_LIMIT)
})

const DIR_STAT_LIMIT = 20

/**
 * 按目录聚合出图量：取相对路径的父目录（浏览器文件 API 统一为 `/` 分隔），
 * 无路径信息的条目（单选添加）不参与；次数降序，最多 20 条，点击应用 `path:` 筛选。
 */
export const dirStats = computed<UsageStat[]>(() => {
  const freq = new Map<string, number>()
  for (const it of state.items) {
    if (it.status !== 'done' || !it.path) continue
    const i = it.path.lastIndexOf('/')
    if (i <= 0) continue
    const dir = it.path.slice(0, i)
    freq.set(dir, (freq.get(dir) ?? 0) + 1)
  }
  return Array.from(freq, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || nameCollator.compare(a.name, b.name))
    .slice(0, DIR_STAT_LIMIT)
})

/**
 * 分辨率分布：按参数出图尺寸 w×h 聚合频次（次数降序，同频次按名排序，最多 20 条），
 * 点击应用 `w:W h:H` 数值条件筛选。无参数尺寸的条目（未解析 / 纯提示词）不参与。
 */
export const resolutionStats = computed<UsageStat[]>(() => {
  const freq = new Map<string, number>()
  for (const it of state.items) {
    const p = it.params
    if (!p?.width || !p?.height) continue
    const key = `${p.width}×${p.height}`
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }
  return Array.from(freq, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || nameCollator.compare(a.name, b.name))
    .slice(0, DIR_STAT_LIMIT)
})

/* ---------- 完全重复文件（FEAT-2）：按需扫描，结果只保留本次会话 ---------- */

export interface FileDupeGroupInfo {
  group: number
  seq: number
  total: number
}

export interface FileDupeState {
  status: 'idle' | 'scanning' | 'done'
  done: number
  total: number
  /** 精确重复组数 / 组内条目数 */
  groups: number
  duplicates: number
}

export const fileDupeState = reactive<FileDupeState>({
  status: 'idle',
  done: 0,
  total: 0,
  groups: 0,
  duplicates: 0,
})

export const fileDupeGroups = ref<Map<string, FileDupeGroupInfo>>(new Map())
export const fileDupeCount = computed(() => fileDupeGroups.value.size)

let fileDupeScanToken = 0

/** 列表变化 / 新解析任务开始 / 用户取消时作废旧结果，避免用过期哈希做删除 */
function invalidateFileDupes() {
  fileDupeScanToken++
  fileDupeState.status = 'idle'
  fileDupeState.done = 0
  fileDupeState.total = 0
  fileDupeState.groups = 0
  fileDupeState.duplicates = 0
  fileDupeGroups.value = new Map()
  state.fileDupeOnly = false
}

export function cancelFileDupeScan() {
  invalidateFileDupes()
}

/**
 * 扫描字节级完全重复文件（FEAT-2）：只在用户主动触发时读文件，结果按精确比较确认。
 * 扫描期间列表变化 / 开始新一轮解析会作废本次扫描，防止对已变化文件执行清理。
 */
export async function scanFileDuplicates(): Promise<number> {
  const token = ++fileDupeScanToken
  const snapshot = state.items.slice()
  fileDupeState.status = 'scanning'
  fileDupeState.done = 0
  fileDupeState.total = 0
  fileDupeState.groups = 0
  fileDupeState.duplicates = 0
  fileDupeGroups.value = new Map()
  state.fileDupeOnly = false

  let result: FileDupeScanResult
  try {
    result = await scanDuplicateFiles(snapshot, {
      cancelled: () => token !== fileDupeScanToken,
      onProgress: (done, total) => {
        if (token !== fileDupeScanToken) return
        fileDupeState.done = done
        fileDupeState.total = total
      },
    })
  } catch {
    if (token === fileDupeScanToken) invalidateFileDupes()
    return 0
  }
  if (token !== fileDupeScanToken) return 0

  // 扫描期间被移除的条目从组里剔除；剩余不足两条的组不再成立
  const groups = new Map<string, FileDupeGroupInfo>()
  let groupIndex = 0
  for (const ids of result.groups) {
    const live = ids.filter((id) => liveIds.has(id))
    if (live.length < 2) continue
    live.forEach((id, i) => groups.set(id, { group: groupIndex, seq: i + 1, total: live.length }))
    groupIndex++
  }
  fileDupeGroups.value = groups
  fileDupeState.status = 'done'
  fileDupeState.done = result.scanned
  fileDupeState.total = result.total
  fileDupeState.groups = groupIndex
  fileDupeState.duplicates = groups.size
  return groupIndex
}

/** 完全重复治理：每组保留最新一张，其余整批移除（可撤销），并清空过期扫描结果 */
export function keepLatestFileDupes(): ImageItem[] {
  const groups = fileDupeGroups.value
  const toRemove: ImageItem[] = []
  for (const it of state.items) {
    const info = groups.get(it.id)
    if (info && info.total > 1 && info.seq > 1) toRemove.push(it)
  }
  if (!toRemove.length) return []
  removeItemsUndoable(toRemove)
  invalidateFileDupes()
  return toRemove
}

// 列表长度变化（新增 / 移除）或解析重新开始：旧重复结果立即作废
watch(
  () => state.items.length,
  () => {
    if (fileDupeState.status !== 'idle') invalidateFileDupes()
  },
)
watch(
  () => parsing.value,
  (parsingNow) => {
    if (parsingNow && fileDupeState.status !== 'idle') invalidateFileDupes()
  },
)

/** 查询环境（D1）：标签匹配与指纹键由 store 注入，lib/query 保持纯函数 */
const queryEnv: QueryEnv = { recordKey: recordKeyOf, hasTag: hitTagKey }

export const filteredItems = computed(() => {
  const q = state.search.trim().toLowerCase()
  const query = q ? cachedParseQuery(q) : null
  return state.items
    .filter((it) => {
      // 解析失败的项不受搜索 / 模型筛选影响，由来源筛选统一控制可见性
      if (it.status === 'error') {
        return state.sourceFilter === 'error' || state.sourceFilter === 'all'
      }
      if (state.sourceFilter === 'error') return false
      // 解析中的项来源未定，只在「全部图片」下展示——
      // 避免以占位 source:'none' 冒充「无元数据」、解析完成后又突然消失
      if (it.status === 'pending') {
        return state.sourceFilter === 'all'
      }
      if (state.sourceFilter !== 'all' && it.source !== state.sourceFilter) return false
      if (state.modelFilter && !(it.params?.models ?? []).includes(state.modelFilter)) return false
      if (state.dupeOnly && !sameSourceIds.value.has(it.id)) return false
      if (state.fileDupeOnly && !fileDupeGroups.value.has(it.id)) return false
      if (state.favOnly && !favKeys.has(recordKeyOf(it))) return false
      if (query && !matchQuery(it, query, queryEnv)) return false
      return true
    })
    .sort(sorters[state.sortMode])
})

/**
 * 区间选择：取有序列表中锚点与目标之间（含两端）的全部 id。
 * 锚点为空或已不在列表中时退化为仅目标——调用方随后应把锚点设为目标。
 */
export function rangeIds(
  list: { id: string }[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const to = list.findIndex((i) => i.id === targetId)
  if (to < 0) return []
  const from = anchorId ? list.findIndex((i) => i.id === anchorId) : -1
  if (from < 0) return [targetId]
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return list.slice(lo, hi + 1).map((i) => i.id)
}

export const sourceOptions = computed<{ label: string; value: SourceFilter }[]>(() => [
  { label: t('src.comfyui'), value: 'comfyui' },
  { label: t('src.a1111'), value: 'a1111' },
  { label: t('src.fooocus'), value: 'fooocus' },
  { label: t('src.none'), value: 'none' },
  { label: t('src.error'), value: 'error' },
  { label: t('src.all'), value: 'all' },
])

export const sortOptions = computed<{ label: string; value: SortMode }[]>(() => [
  { label: t('sort.default'), value: 'default' },
  { label: t('sort.timeDesc'), value: 'time-desc' },
  { label: t('sort.timeAsc'), value: 'time-asc' },
  { label: t('sort.nameAsc'), value: 'name-asc' },
  { label: t('sort.nameDesc'), value: 'name-desc' },
  { label: t('sort.workflow'), value: 'workflow' },
])

/** F3：同工作流聚类（指纹 / 分组逻辑在 lib/cluster.ts，此处仅响应式接线） */
export const workflowClusters = computed(() => clusterByWorkflow(state.items, nameCollator))

export const sameSourceGroups = computed(() => clusterBySameSource(state.items, nameCollator))

/** F4：处于同源组（组内 ≥2 张）中的条目 id 集合，供「只看重复」筛选 */
const sameSourceIds = computed(() => {
  const ids = new Set<string>()
  for (const [id, info] of sameSourceGroups.value) {
    if (info.total > 1) ids.add(id)
  }
  return ids
})

/** F4：同源重复条目总数（≥2 张的组内条目），0 表示当前没有同源组 */
export const dupeCount = computed(() => sameSourceIds.value.size)

/**
 * G3：重复治理——每个同源组（同工作流同种子）只保留最新一张（seq 1，组内按
 * mtime 新→旧编号），其余整批移除。作用于全库（组划分与筛选无关），
 * 返回移除的条目数组，供调用方收起正打开的详情 / 对比抽屉。
 * 用户点击入口传 undoable=true，保留撤销窗口（FEAT-1）。
 */
export function keepLatestOfDupes(undoable = false): ImageItem[] {
  const groups = sameSourceGroups.value
  const toRemove: ImageItem[] = []
  for (const it of state.items) {
    const info = groups.get(it.id)
    if (info && info.total > 1 && info.seq > 1) toRemove.push(it)
  }
  if (undoable) removeItemsUndoable(toRemove)
  else removeItems(toRemove)
  return toRemove
}

/* ---------- 收藏星标：按去重指纹（recordKey）记忆，跨会话保留 ---------- */
// 收藏是用户策展数据：清空列表 / 移除条目都不动账，同指纹文件重新拖入或存档恢复后自动生效
const FAVS_KEY = 'cii:favs'

function loadFavorites(): Set<string> {
  try {
    const raw = safeGetItem(FAVS_KEY)
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr)
      ? new Set(arr.filter((k): k is string => typeof k === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

const favKeys = reactive(loadFavorites())

function persistFavorites() {
  safeSetItem(FAVS_KEY, JSON.stringify([...favKeys]))
}

/** 收藏标记表（itemId → 是否已收藏）：computed 一次算全量，卡片与详情抽屉共用 */
export const favoriteFlags = computed(() => {
  const flags = new Map<string, boolean>()
  for (const it of state.items) flags.set(it.id, favKeys.has(recordKeyOf(it)))
  return flags
})

/** 当前列表内已收藏条数（驱动「只看收藏」开关的显隐）：复用 favoriteFlags 的同一次扫描（OPT-6） */
export const favCount = computed(() => {
  let n = 0
  for (const flagged of favoriteFlags.value.values()) if (flagged) n++
  return n
})

export function toggleFavorite(item: ImageItem) {
  const key = recordKeyOf(item)
  if (favKeys.has(key)) favKeys.delete(key)
  else favKeys.add(key)
  persistFavorites()
}

/**
 * 批量收藏 / 取消收藏选中项（幂等：已处于目标状态的项跳过，指纹账本只写一次）。
 * 与单张收藏同账本：按 recordKey 跨会话记忆，清空列表 / 移除条目不动账。
 */
export function setItemsFavorite(items: ImageItem[], faved: boolean) {
  let changed = false
  for (const it of items) {
    const key = recordKeyOf(it)
    if (faved ? !favKeys.has(key) : favKeys.has(key)) {
      if (faved) favKeys.add(key)
      else favKeys.delete(key)
      changed = true
    }
  }
  if (changed) persistFavorites()
}

/* ---------- 自定义标签：按去重指纹记忆，与收藏同一套用户策展数据语义 ---------- */
// 清空列表 / 移除条目不动账，同指纹文件重新拖入或存档恢复后自动生效
const TAGS_KEY = 'cii:tags'

function loadTags(): Record<string, string[]> {
  try {
    const raw = safeGetItem(TAGS_KEY)
    if (!raw) return {}
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const names = v.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        if (names.length) out[k] = [...new Set(names)]
      }
    }
    return out
  } catch {
    return {}
  }
}

const itemTags = reactive(loadTags())

function persistTags() {
  safeSetItem(TAGS_KEY, JSON.stringify(itemTags))
}

/** 标签表（itemId → 标签名列表）：computed 一次算全量，卡片与详情抽屉共用 */
export const tagLists = computed(() => {
  const m = new Map<string, string[]>()
  for (const it of state.items) {
    const tags = itemTags[recordKeyOf(it)]
    if (tags?.length) m.set(it.id, tags)
  }
  return m
})

/** 全库标签频次（名称 → 打标条目数，按频次降序）：标签面板与打标建议共用 */
export const tagCounts = computed(() => {
  const freq = new Map<string, number>()
  for (const tags of Object.values(itemTags)) {
    for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return Array.from(freq, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || nameCollator.compare(a.name, b.name),
  )
})

/** 全库出现过的标签名（按使用频次降序）：详情页添加标签的候选建议 */
export const allTagNames = computed(() => tagCounts.value.map((t) => t.name))

/** 切换单个标签：加 / 移除并落盘，返回切换后是否带上该标签 */
export function toggleItemTag(item: ImageItem, tag: string): boolean {
  const key = recordKeyOf(item)
  const list = itemTags[key] ?? []
  const i = list.indexOf(tag)
  if (i >= 0) {
    list.splice(i, 1)
    if (list.length) itemTags[key] = list
    else delete itemTags[key]
    persistTags()
    return false
  }
  list.push(tag)
  itemTags[key] = list
  persistTags()
  return true
}

/** 当前条目是否带某标签（has:tag 与 tag: 匹配共用） */
function hitTagKey(key: string, tag: string | null): boolean {
  const tags = itemTags[key]
  if (!tags?.length) return false
  if (tag === null) return true
  return tags.some((t) => t.toLowerCase().includes(tag))
}

/**
 * 批量打标 / 移除标签（F1，幂等）：与单张标签同账本（按指纹跨会话记忆，
 * 清空列表 / 移除条目不动账），返回实际变更的条目数。
 */
export function setItemsTag(items: ImageItem[], tag: string, on: boolean): number {
  const name = tag.trim()
  if (!name) return 0
  let changed = 0
  for (const it of items) {
    const key = recordKeyOf(it)
    const list = itemTags[key] ?? []
    const i = list.indexOf(name)
    if (on && i < 0) {
      list.push(name)
      itemTags[key] = list
      changed++
    } else if (!on && i >= 0) {
      list.splice(i, 1)
      if (list.length) itemTags[key] = list
      else delete itemTags[key]
      changed++
    }
  }
  if (changed) persistTags()
  return changed
}

/** 全库重命名标签（F1）：所有条目上的旧名替换为新名（重名去重），返回涉及条目数 */
export function renameTag(from: string, to: string): number {
  const oldName = from.trim()
  const newName = to.trim()
  if (!oldName || !newName || oldName === newName) return 0
  let n = 0
  for (const [key, list] of Object.entries(itemTags)) {
    if (!list.includes(oldName)) continue
    const next = list.filter((t) => t !== oldName)
    if (!next.includes(newName)) next.push(newName)
    itemTags[key] = next
    n++
  }
  persistTags()
  return n
}

/** 全库删除标签（F1）：所有条目上的该标签一并移除，返回涉及条目数 */
export function removeTagEverywhere(tag: string): number {
  const name = tag.trim()
  if (!name) return 0
  let n = 0
  for (const [key, list] of Object.entries(itemTags)) {
    if (!list.includes(name)) continue
    const next = list.filter((t) => t !== name)
    if (next.length) itemTags[key] = next
    else delete itemTags[key]
    n++
  }
  persistTags()
  return n
}

export function toggleDark() {
  state.dark = !state.dark
  // 显式偏好只在用户切换时落盘；系统跟随（见 schemeQuery 监听）不写入，
  // 未设置过偏好的用户始终保留「跟随系统」语义
  safeSetItem('cii:theme', state.dark ? 'dark' : 'light')
}

/** 安全模式开关：缩略图模糊 ↔ 直接显示，显式偏好落盘 */
export function toggleSafeMode() {
  state.safeMode = !state.safeMode
  safeSetItem(SAFE_MODE_KEY, state.safeMode ? '1' : '0')
}

/* ---------- 筛选预设：保存 / 应用命名的筛选组合（搜索 + 模型 + 来源），localStorage 记忆 ---------- */
export interface FilterPreset {
  name: string
  search: string
  modelFilter: string | null
  sourceFilter: SourceFilter
}

const PRESETS_KEY = 'cii:filter-presets'

function loadPresets(): FilterPreset[] {
  try {
    const arr: unknown = JSON.parse(safeGetItem(PRESETS_KEY) ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr.flatMap((p) => {
      const o = p as Partial<FilterPreset>
      return typeof o?.name === 'string' &&
        typeof o.search === 'string' &&
        (o.modelFilter === null || typeof o.modelFilter === 'string') &&
        SOURCE_FILTERS.includes(o.sourceFilter as SourceFilter)
        ? [
            {
              name: o.name,
              search: o.search,
              modelFilter: o.modelFilter ?? null,
              sourceFilter: o.sourceFilter as SourceFilter,
            },
          ]
        : []
    })
  } catch {
    return []
  }
}

export const filterPresets = ref<FilterPreset[]>(loadPresets())

function persistPresets() {
  safeSetItem(PRESETS_KEY, JSON.stringify(filterPresets.value))
}

/** 把当前筛选组合（搜索 / 模型 / 来源）保存为预设；同名覆盖，空名拒绝 */
export function saveFilterPreset(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const preset: FilterPreset = {
    name: trimmed,
    search: state.search,
    modelFilter: state.modelFilter,
    sourceFilter: state.sourceFilter,
  }
  const i = filterPresets.value.findIndex((p) => p.name === trimmed)
  if (i >= 0) filterPresets.value.splice(i, 1, preset)
  else filterPresets.value.push(preset)
  persistPresets()
  return true
}

/** 应用预设：还原搜索 / 模型 / 来源筛选（dupeOnly / favOnly 不动）；无此名返回 false */
export function applyFilterPreset(name: string): boolean {
  const p = filterPresets.value.find((x) => x.name === name)
  if (!p) return false
  state.search = p.search
  state.modelFilter = p.modelFilter
  state.sourceFilter = p.sourceFilter
  return true
}

export function deleteFilterPreset(name: string): void {
  const i = filterPresets.value.findIndex((x) => x.name === name)
  if (i >= 0) {
    filterPresets.value.splice(i, 1)
    persistPresets()
  }
}

/* ---------- 搜索历史：最近使用的搜索词一键重用（去重、最多 10 条，localStorage 记忆） ---------- */
const HISTORY_KEY = 'cii:search-history'
const HISTORY_LIMIT = 10
/** 搜索词落定防抖：停止变动后视为一次完整查询 */
const HISTORY_SETTLE_MS = 1500

function loadSearchHistory(): string[] {
  try {
    const arr: unknown = JSON.parse(safeGetItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(arr)
      ? arr.filter((q): q is string => typeof q === 'string').slice(0, HISTORY_LIMIT)
      : []
  } catch {
    return []
  }
}

export const recentSearches = ref<string[]>(loadSearchHistory())

export function clearSearchHistory() {
  recentSearches.value = []
  safeRemoveItem(HISTORY_KEY)
}

let historyTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => state.search,
  (q) => {
    const key = q.trim()
    // 清空搜索不取消待写项：刚用过的词即使随即清空也算用过
    if (historyTimer !== null) clearTimeout(historyTimer)
    if (!key) return
    historyTimer = setTimeout(() => {
      historyTimer = null
      // 大小写不敏感去重；命中已有项提升到最前（recently-used 语义）
      const i = recentSearches.value.findIndex((s) => s.toLowerCase() === key.toLowerCase())
      if (i === 0) return
      if (i > 0) recentSearches.value.splice(i, 1)
      recentSearches.value.unshift(key)
      if (recentSearches.value.length > HISTORY_LIMIT) recentSearches.value.length = HISTORY_LIMIT
      safeSetItem(HISTORY_KEY, JSON.stringify(recentSearches.value))
    }, HISTORY_SETTLE_MS)
  },
)

/**
 * P2：预览 URL 惰性创建——由卡片 / 抽屉在渲染时调用。
 * 入列时不再为每张图创建 Blob URL，万级扫描只有实际渲染过的条目才占 URL 与解码内存。
 */
/**
 * F2：存档卡片缩略图惰性回挂——thumbB64（base64 JPEG）仅在卡片进入视口时转 objectURL，
 * 万级存档恢复不整批物化；转成 URL 后释放对 base64 串的持有（体积转移给 URL 注册表）
 */
export async function ensureItemThumb(item: ImageItem): Promise<void> {
  if (!item.thumbB64 || item.thumb) return
  const bin = atob(item.thumbB64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  if (!liveIds.has(item.id)) return // 取值期间被移除 / 清空
  item.thumb = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  item.thumbB64 = undefined
}

export function ensureItemUrl(item: ImageItem): void {
  if (item.url || item.metaOnly || item.detached || !item.file) return
  item.url = URL.createObjectURL(item.file)
}

export { state as store }
