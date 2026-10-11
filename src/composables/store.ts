import { computed, reactive, watch } from 'vue'
import type { ImageItem, ImageSource, IncomingFile, ParsedParams, RawMetadata } from '../types'
import {
  clearInternPool,
  hasSupportedSignature,
  isMetaTextFile,
  isSupportedImage,
} from '../lib/metadata'
import { parseImage } from '../lib/parser'
import { collectDirectoryFiles, ensureReadPermission } from '../lib/fs'
import { t } from '../locales'
import {
  clearDirBookmarks as clearPersistedBookmarks,
  clearPersisted,
  deletePersisted,
  fromRecord,
  importPersisted,
  loadDirBookmarks,
  loadPersisted,
  parseArchive,
  probePersistence,
  putPersisted,
  recordKey,
  removeDirBookmark,
  saveDirBookmark,
  serializeArchive,
  toRecord,
  type PersistRecord,
} from '../lib/persist'

export type SourceFilter = 'all' | 'comfyui' | 'a1111' | 'none' | 'error'
export type SortMode = 'default' | 'time-desc' | 'time-asc' | 'name-asc' | 'name-desc' | 'workflow'
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
  /** 只看重复（FEAT-4）：仅显示同工作流同种子的同源出图；无重复组时开关自动隐藏 */
  dupeOnly: boolean
  /** 只看收藏：仅显示已星标的条目；无收藏时开关自动隐藏（收藏本身按指纹跨会话记忆） */
  favOnly: boolean
  /** 画廊缩略图最小列宽（px，150–420）：卡片大小调节偏好 */
  thumbSize: number
}

const storedSort = localStorage.getItem('cii:sort') as SortMode | null

/* ---------- 筛选 / 搜索状态持久化（U2）：刷新后还原上次的使用状态 ---------- */
const FILTERS_KEY = 'cii:filters'
/** 目录监视自动重扫的偏好键 */
const AUTO_RESCAN_KEY = 'cii:auto-rescan'
const SOURCE_FILTERS: SourceFilter[] = ['all', 'comfyui', 'a1111', 'none', 'error']

function loadStoredFilters(): {
  search: string
  modelFilter: string | null
  sourceFilter: SourceFilter
} {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
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
const storedTheme = localStorage.getItem('cii:theme')
const schemeQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null

/* ---------- 缩略图大小偏好：画廊卡片最小列宽（150–420px），非法存储值回退默认 ---------- */
const THUMB_KEY = 'cii:thumb'
const THUMB_DEFAULT = 206

function loadThumbSize(): number {
  try {
    const v = Number(localStorage.getItem(THUMB_KEY))
    return Number.isFinite(v) && v >= 150 && v <= 420 ? v : THUMB_DEFAULT
  } catch {
    return THUMB_DEFAULT
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
  autoRescan: localStorage.getItem(AUTO_RESCAN_KEY) === '1',
  dupeOnly: false,
  favOnly: false,
  thumbSize: loadThumbSize(),
})

if (!storedTheme && schemeQuery) {
  schemeQuery.addEventListener('change', (e) => {
    // 用户手动切换后（toggleDark 落盘）显式偏好优先，不再跟随系统
    if (localStorage.getItem('cii:theme') !== null) return
    state.dark = !e.matches
  })
}

watch(
  () => state.sortMode,
  (m) => localStorage.setItem('cii:sort', m),
)

watch(
  () => state.thumbSize,
  (v) => {
    try {
      localStorage.setItem(THUMB_KEY, String(v))
    } catch {
      // 配额 / 环境限制时忽略：仅影响下次刷新的还原
    }
  },
)

watch(
  () => [state.search, state.modelFilter, state.sourceFilter] as const,
  ([search, model, source]) => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ search, model, source }))
    } catch {
      // 配额 / 环境限制时忽略：仅影响下次刷新的还原
    }
  },
)

/* ---------- 解析队列（有限并发） ---------- */
let active = 0
const queue: ImageItem[] = []
const PARSE_LIMIT = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) * 2))
// 清空列表时递增：旧批次的在途解析完成时不再计数，避免污染新批次进度
let batchEpoch = 0
// 在途任务（从开始解析到结果应用）：与响应式 status 解耦——批量扫描期间 status 保持
// 'pending' 直到结果应用，removeItem 据此集合区分「排队 / 在途 / 已出结果」做计数对账
const inflight = new Set<string>()
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
  raw: RawMetadata
  params?: ParsedParams
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
    inflight.delete(r.item.id)
    // 已移除 / 已清空的项：丢弃孤儿结果（与 markDirty 的存活校验同源，B1）
    if (!liveIds.has(r.item.id)) continue
    r.item.raw = r.raw
    r.item.source = r.raw.source
    r.item.params = r.params
    r.item.searchText = r.searchText
    r.item.error = r.error
    r.item.status = r.error ? 'error' : 'done'
    markDirty(r.item)
  }
}

function pump() {
  while (active < PARSE_LIMIT && queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    active++
    void parseItem(item, batchEpoch)
  }
}

async function parseItem(item: ImageItem, epoch: number) {
  inflight.add(item.id)
  try {
    // 入队的都是实文件项（存档项不解析）
    const { raw, params } = await parseImage(item.file!)
    // 搜索串在结果落定时构建一次（应用时直接挂上）：筛选热路径只做 includes，不再每键重建
    pendingResults.push({ item, raw, params, searchText: buildSearchText(item, params) })
  } catch (e) {
    pendingResults.push({
      item,
      raw: { source: 'none' },
      error: e instanceof Error ? e.message : String(e),
    })
  } finally {
    active--
    if (epoch === batchEpoch) state.batchDone++
    if (active === 0 && queue.length === 0) applyPending()
    else scheduleApply()
    pump()
  }
}

/* ---------- 添加 / 清空 ---------- */
let seq = 0
// 已加载文件的指纹（recordKey：路径或文件名|大小|修改时间），O(1) 查重；增删 items 时必须同步维护
const seenKeys = new Set<string>()
// 存活项 id 集合（与 seenKeys 同步增删）：markDirty 写库前校验，
// 防止已移除 / 已清空的项在解析完成时把孤儿记录重新写回存档（「复活」竞态）
const liveIds = new Set<string>()
// 待回挂的存档项索引（recordKey → item），addFiles 时按指纹自动回挂
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

/** 返回本次直接入列的新增数量（去重后）；无扩展名文件的嗅探确认是异步入列，不计入返回值 */
export function addFiles(files: IncomingFile[]): number {
  const deferred: IncomingFile[] = []
  let added = 0
  for (const { file, path } of files) {
    if (isSupportedImage(file)) {
      added += enqueueFile(file, path)
    } else if (isMetaTextFile(file)) {
      // F1：工作流 JSON / 参数文本拖入即解析，无需配图
      added += enqueueFile(file, path, true)
    } else {
      // 无扩展名 / 生僻扩展名：按文件头魔数嗅探，异步确认后再入列
      deferred.push({ file, path })
    }
  }
  pump()
  for (const incoming of deferred) void acceptBySniff(incoming)
  return added
}

/** 入列单个文件：返回是否新增（指纹已存在 / 存档回挂不产生解析任务，均不算新增） */
function enqueueFile(file: File, path?: string, metaOnly = false): number {
  const key = recordKey({ path, name: file.name, size: file.size, mtime: file.lastModified })
  if (seenKeys.has(key)) return 0
  // 与存档项同指纹：回挂文件恢复预览，元数据已在库中，不再重新解析
  const archived = detachedByKey.get(key)
  if (archived) {
    archived.file = file
    archived.url = URL.createObjectURL(file)
    archived.detached = false
    seenKeys.add(key)
    detachedByKey.delete(key)
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
    size: file.size,
    mtime: file.lastModified,
    status: 'pending',
    source: 'none',
    raw: { source: 'none' },
    metaOnly: metaOnly || undefined,
  })
  state.items.push(item)
  liveIds.add(item.id)
  state.batchTotal++
  batchCounted.add(item)
  queue.push(item)
  return 1
}

/** 无扩展名文件的嗅探入列：确认是受支持图片才加入，普通杂项文件维持静默跳过 */
async function acceptBySniff(incoming: IncomingFile) {
  try {
    if (await hasSupportedSignature(incoming.file)) {
      enqueueFile(incoming.file, incoming.path)
    }
  } catch {
    // 读取失败按不支持处理
  }
  pump()
}

export function removeItem(item: ImageItem) {
  removeItems([item])
}

/**
 * 批量移除：单次遍历重建列表，统一维护指纹 / 存活账本与进度计数，整批 O(n)
 * （逐条 removeItem 是 O(n·m)，万级列表批量删除会卡顿）。语义与单条移除一致：
 * 不在当前列表中的项跳过；在途项不动计数（完成时对账），排队项整体出队，
 * done / error 两本账一起减。
 */
export function removeItems(items: ImageItem[]) {
  const removing = new Set<ImageItem>(items)
  if (!removing.size) return
  const removedItems: ImageItem[] = []
  const keep: ImageItem[] = []
  for (const it of state.items) {
    if (removing.delete(it)) removedItems.push(it)
    else keep.push(it)
  }
  if (!removedItems.length) return
  state.items = keep
  const queuedIds = new Set<string>()
  for (const it of removedItems) {
    liveIds.delete(it.id)
    const key = recordKey(it)
    seenKeys.delete(key)
    if (it.detached) detachedByKey.delete(key)
    dirtyItems.delete(key)
    deletedKeys.add(key)
    URL.revokeObjectURL(it.url)
    if (inflight.has(it.id)) {
      // 在途（含结果已入暂存未应用）：无法中断也不动计数，其 batchDone++ 已在完成时
      // 与保留的 batchTotal 对齐，应用时结果被 liveIds 拦截，不会出现进度错乱或写库复活
    } else if (it.status === 'pending') {
      queuedIds.add(it.id)
      if (batchCounted.has(it)) state.batchTotal--
    } else {
      // done / error：两本账一起减（仅限已计入批次的项；存档项从未计入，不能动账）
      if (batchCounted.has(it)) {
        state.batchTotal--
        state.batchDone--
      }
    }
  }
  // 排队项一次性出队（逐条 indexOf 是 O(队列长 × 移除数)）
  if (queuedIds.size) {
    let w = 0
    for (let i = 0; i < queue.length; i++) {
      if (!queuedIds.has(queue[i]!.id)) queue[w++] = queue[i]!
    }
    queue.length = w
  }
  schedulePersist()
}

export function clearAll() {
  for (const i of state.items) URL.revokeObjectURL(i.url)
  state.items = []
  seenKeys.clear()
  liveIds.clear()
  detachedByKey.clear()
  queue.length = 0
  inflight.clear()
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
  persistEpoch++ // 作废在途写库批次，历史记录一并清除（所见即所得）
  dirtyItems.clear()
  deletedKeys.clear()
  if (persistAvailable) void clearPersisted().catch(() => {})
}

/* ---------- 目录书签（FEAT-7 多目录：切换重扫目标 / 一键重扫） ---------- */
// 句柄不放进 reactive 状态：代理对象无法结构化克隆回写 IndexedDB，界面只依赖 rescanName / dirBookmarks
let rescanHandle: FileSystemDirectoryHandle | null = null
const dirBookmarks = new Map<string, { handle: FileSystemDirectoryHandle; savedAt: number }>()

function refreshDirNames() {
  state.dirBookmarks = [...dirBookmarks.entries()]
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .map(([name]) => name)
}

/** 记住目录并设为当前重扫目标（加入 / 刷新书签，同名覆盖） */
export async function setRescanHandle(handle: FileSystemDirectoryHandle) {
  rescanHandle = handle
  state.rescanName = handle.name
  dirBookmarks.set(handle.name, { handle, savedAt: Date.now() })
  refreshDirNames()
  syncAutoRescanTimer()
  try {
    // 句柄持久化不可用的浏览器（不支持结构化克隆）仅本次会话有效
    if (persistAvailable) await saveDirBookmark(handle)
  } catch {
    // 忽略：重扫按钮仍在本会话可用
  }
}

/** 切换当前重扫目标为已记住的目录（不立即扫描）；无此书签返回 false */
export function switchRescanTarget(name: string): boolean {
  const bm = dirBookmarks.get(name)
  if (!bm) return false
  rescanHandle = bm.handle
  state.rescanName = name
  syncAutoRescanTimer()
  return true
}

/** 不再记住当前目录（仅移除该书签，其余书签保留） */
export function forgetRescanHandle() {
  const name = state.rescanName
  if (name) {
    dirBookmarks.delete(name)
    refreshDirNames()
  }
  rescanHandle = null
  state.rescanName = null
  syncAutoRescanTimer() // 自动重扫随当前目标消失停表；偏好保留，下次记住目录时自动恢复
  if (persistAvailable && name) void removeDirBookmark(name).catch(() => {})
}

/** 清除全部目录书签（含当前重扫目标） */
export function clearAllDirBookmarks() {
  dirBookmarks.clear()
  refreshDirNames()
  rescanHandle = null
  state.rescanName = null
  syncAutoRescanTimer()
  if (persistAvailable) void clearPersistedBookmarks().catch(() => {})
}

/**
 * 一键重扫记住的目录：只增量添加新文件，已有文件按指纹回挂 / 去重，不会重复解析。
 * 分批边扫边入列；返回新增入列的文件数，无句柄或未获授权返回 null。
 */
export async function rescanDirectory(): Promise<number | null> {
  if (!rescanHandle) return null
  if (!(await ensureReadPermission(rescanHandle))) return null
  let added = 0
  try {
    await collectDirectoryFiles(rescanHandle, (files) => {
      added += addFiles(files)
    })
  } catch {
    // 目录被删除 / 移动（U 盘拔出等）：本拍按不可用处理。手动重扫由调用方提示无权限，
    // 自动重扫各拍静默重试，不再把枚举异常抛成全局错误横幅 / unhandled rejection
    return null
  }
  return added
}

/* ---------- 目录监视自动重扫（FEAT-1：边出图边看） ---------- */
const AUTO_RESCAN_INTERVAL_MS = 10_000
let autoRescanTimer: ReturnType<typeof setInterval> | null = null
let autoTickBusy = false

/** 按偏好与句柄的有无启停周期定时器；偏好切换 / 句柄变化时调用 */
function syncAutoRescanTimer() {
  const shouldRun = state.autoRescan && rescanHandle !== null
  if (shouldRun && autoRescanTimer === null) {
    autoRescanTimer = setInterval(() => void autoRescanTick(), AUTO_RESCAN_INTERVAL_MS)
  } else if (!shouldRun && autoRescanTimer !== null) {
    clearInterval(autoRescanTimer)
    autoRescanTimer = null
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
    try {
      localStorage.setItem(AUTO_RESCAN_KEY, on ? '1' : '0')
    } catch {
      // 配额 / 环境限制时忽略：仅影响下次刷新的还原
    }
    syncAutoRescanTimer()
  },
)

/* ---------- 会话持久化（探测失败时静默降级为纯内存） ---------- */
let persistAvailable = false
let persistEpoch = 0
const dirtyItems = new Map<string, ImageItem>()
const deletedKeys = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 把存档记录装回列表（hydrate 与测试共用）：跳过同指纹已存在项
 * （用户在恢复完成前已拖入同指纹文件时，以实际文件为准）。
 * 必须以响应式代理入列并用同一代理建回挂索引：addFiles 回挂时改写的是这个代理，
 * 绕过代理的原始对象不会触发视图更新。
 * 搜索串不在此构建（P2 惰性化，见 searchTextField）——万级存档恢复只做建项，
 * 长文本拼接与小写化按需 / 空闲分批进行。
 */
export function restoreArchived(records: PersistRecord[]) {
  for (const rec of records) {
    if (seenKeys.has(rec.key)) continue
    const item = reactive<ImageItem>(fromRecord(rec))
    detachedByKey.set(rec.key, item)
    liveIds.add(item.id)
    state.items.push(item)
  }
}

function markDirty(item: ImageItem) {
  if (!persistAvailable) return
  // 已移除 / 已清空的项不再写库：removeItem / clearAll 后完成的在途解析不得“复活”到存档
  if (!liveIds.has(item.id)) return
  const key = recordKey(item)
  deletedKeys.delete(key)
  dirtyItems.set(key, item)
  schedulePersist()
}

function schedulePersist() {
  if (!persistAvailable || flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPersist()
  }, 500)
}

async function flushPersist() {
  const epoch = persistEpoch
  // 取消检查贯穿到事务创建前：flush 在 await getDb 期间遇 clearAll 时，
  // persistEpoch 已作废本轮，写库若继续排队会落在 clearPersisted 之后，把已清历史写回
  const isStale = () => epoch !== persistEpoch
  const items = [...dirtyItems.values()]
  dirtyItems.clear()
  const keys = [...deletedKeys]
  deletedKeys.clear()
  try {
    // 清空列表会作废本轮写库，避免把已删除的历史写回去
    if (isStale()) return
    const records = items.map(toRecord).filter((r) => r !== null)
    if (records.length) await putPersisted(records, isStale)
    if (keys.length && !isStale()) await deletePersisted(keys, isStale)
  } catch (err) {
    // 写库失败（配额 / 环境限制）不影响功能，本轮丢弃；保留告警便于定位环境问题
    console.warn('[comfyui-info] 存档写入失败，本轮丢弃:', err)
  }
  if (dirtyItems.size || deletedKeys.size) schedulePersist() // 写库期间又有变更
}

/** 启动恢复：探测 IndexedDB 可用性，可用则装回历史存档与记住的扫描目录；失败静默降级纯内存 */
async function hydrate() {
  try {
    persistAvailable = await probePersistence()
    if (!persistAvailable) return
    await restoreArchivedInChunks(await loadPersisted())
    // 恢复全部目录书签（FEAT-7），最近记住的作为当前重扫目标
    const bookmarks = await loadDirBookmarks()
    for (const bm of bookmarks) {
      dirBookmarks.set(bm.name, { handle: bm.handle, savedAt: bm.savedAt })
    }
    refreshDirNames()
    const latest = bookmarks[0]
    if (latest) {
      rescanHandle = latest.handle
      state.rescanName = latest.name
      syncAutoRescanTimer() // 偏好为开时恢复自动监视（权限需重新授权时各拍静默重试）
    }
  } catch (err) {
    // 恢复失败等同不可用：静默降级纯内存，但保留一条告警便于排查环境问题
    console.warn('[comfyui-info] 会话恢复失败，本次会话不启用持久化:', err)
    persistAvailable = false
  }
}

/* ---------- 启动恢复分批进行（OPT-6）：万级存档不整段阻塞首屏 ---------- */

const RESTORE_CHUNK = 1000

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * 存档分批装回：每批之间让出主线程处理渲染与输入，卡片渐进出现；
 * 全部装回后再空闲分批预热存档项的搜索串（命中 WeakMap 缓存后首次搜索零等待）。
 */
async function restoreArchivedInChunks(records: PersistRecord[]) {
  for (let i = 0; i < records.length; i += RESTORE_CHUNK) {
    restoreArchived(records.slice(i, i + RESTORE_CHUNK))
    await yieldToMain()
  }
  for (let i = 0; i < state.items.length; i += RESTORE_CHUNK) {
    let warmed = false
    for (let j = i; j < Math.min(i + RESTORE_CHUNK, state.items.length); j++) {
      const it = state.items[j]!
      if (it.searchText === undefined && !searchTextCache.has(it)) {
        searchTextCache.set(it, buildSearchText(it, it.params))
        warmed = true
      }
    }
    if (warmed) await yieldToMain()
  }
}

/* ---------- 存档备份（FEAT-6：防清库 / 跨设备迁移） ---------- */

/** 当前列表全部可存档项 → 备份文本（含参数与诊断信息 + 收藏标记，不含图片本体） */
export function buildArchiveBackup(): { text: string; count: number } {
  const records = state.items.map(toRecord).filter((r) => r !== null)
  return { text: serializeArchive(records, [...favKeys]), count: records.length }
}

/**
 * 导入存档备份：与库存 / 存档同指纹的记录跳过，返回实际恢复的记录数与
 * 合并的收藏标记数（备份里的收藏按指纹并入本机账本，存档卡片即带星标）；
 * 持久化不可用时仅恢复到本会话内存。备份结构非法时抛错由调用方提示。
 */
export async function importArchive(text: string): Promise<{ n: number; favs: number }> {
  const { records, favorites } = parseArchive(text)
  const fresh = records.filter((r) => !seenKeys.has(r.key) && !detachedByKey.has(r.key))
  if (persistAvailable) {
    const written = await importPersisted(fresh)
    restoreArchived(written)
    return { n: written.length, favs: mergeArchivedFavorites(favorites) }
  }
  restoreArchived(fresh)
  return { n: fresh.length, favs: mergeArchivedFavorites(favorites) }
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
void hydrate()

/* ---------- 派生数据 ---------- */
export const parsing = computed(() => state.batchDone < state.batchTotal)
export const scanProgress = computed(() =>
  state.batchTotal === 0
    ? 0
    : Math.min(100, Math.round((state.batchDone / state.batchTotal) * 100)),
)

const sourceRank: Record<string, number> = { comfyui: 0, a1111: 1, none: 2 }

const rankBySource = (it: ImageItem) => (it.status === 'error' ? 3 : (sourceRank[it.source] ?? 3))
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

export const stats = computed(() => {
  const c: Record<ImageSource | 'error', number> = { comfyui: 0, a1111: 0, none: 0, error: 0 }
  for (const i of state.items) {
    // 解析失败的项没有来源，单独计数，不冒充“无元数据”；
    // 解析中的项来源未定，同样不计数（初始 source:'none' 只是占位）
    if (i.status === 'error') c.error++
    else if (i.status === 'done') c[i.source]++
  }
  return c
})

/**
 * 模型筛选下拉：复用 usageStats 的聚合一份数据源（同集合），按使用频次降序、
 * 同频次按名排序——「最常用的模型」排在最前，与统计抽屉的排行一致。
 */
export const modelOptions = computed(() =>
  usageStats.value.models.map((m) => ({ label: m.name, value: m.name })),
)

export interface UsageStat {
  name: string
  count: number
}

/**
 * 生成统计：对已解析出参数的图片聚合模型 / LoRA / 采样器使用频次（次数降序，同次数按名排序）。
 * computed 缓存：解析中每个 item 出结果都会触发一次重算，开销 O(全部参数项)，量级可忽略。
 */
export const usageStats = computed(() => {
  const models = new Map<string, number>()
  const loras = new Map<string, number>()
  const samplers = new Map<string, number>()
  for (const it of state.items) {
    const p = it.params
    if (!p) continue
    for (const m of p.models) models.set(m, (models.get(m) ?? 0) + 1)
    for (const l of p.loras) loras.set(l.name, (loras.get(l.name) ?? 0) + 1)
    for (const s of p.samplers) {
      if (s.sampler) samplers.set(s.sampler, (samplers.get(s.sampler) ?? 0) + 1)
    }
  }
  const toList = (m: Map<string, number>): UsageStat[] =>
    Array.from(m, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count || nameCollator.compare(a.name, b.name),
    )
  return { models: toList(models), loras: toList(loras), samplers: toList(samplers) }
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
 * 搜索域：相对路径 / 文件名 + 提示词 + 模型 / LoRA（含哈希）/ 采样参数 + VAE / 放大模型 /
 * ControlNet，按任意生成要素定位图片。
 * 在解析结果落定时（parseItem）构建一次并小写化，应用时挂上，筛选热路径不再重复拼接；
 * 存档项走 searchTextField 按需构建（P2 惰性化，恢复期不逐条拼接长串）。
 */
function buildSearchText(it: ImageItem, p: ParsedParams | undefined): string {
  const parts = [
    it.path ?? it.name,
    ...(p?.positive ?? []),
    ...(p?.negative ?? []),
    ...(p?.models ?? []),
  ]
  if (p?.modelHash) parts.push(p.modelHash)
  for (const l of p?.loras ?? []) {
    parts.push(l.name)
    if (l.hash) parts.push(l.hash)
  }
  for (const s of p?.samplers ?? []) {
    if (s.sampler) parts.push(s.sampler)
    if (s.scheduler) parts.push(s.scheduler)
    if (s.classType) parts.push(s.classType)
    if (s.seed) parts.push(s.seed)
  }
  parts.push(...(p?.vaes ?? []), ...(p?.upscalers ?? []), ...(p?.controlNets ?? []))
  return parts.join('\n').toLowerCase()
}

/**
 * 搜索串按需缓存：解析路径在结果落定时构建（item.searchText，随节拍分摊）；
 * 存档项恢复时没有搜索串，首次命中筛选热路径时按需构建并缓存——
 * 避免万级存档恢复时整段拼接长文本阻塞首屏。
 */
const searchTextCache = new WeakMap<ImageItem, string>()

function searchTextField(it: ImageItem): string {
  const eager = it.searchText
  if (eager !== undefined) return eager
  let built = searchTextCache.get(it)
  if (built === undefined) {
    built = buildSearchText(it, it.params)
    searchTextCache.set(it, built)
  }
  return built
}

export type NumField = 'steps' | 'cfg' | 'width' | 'height' | 'batch' | 'clip'

/** `has:` 存在性条件：图片具备对应生成要素（可配 `-` 排除「有某要素」的图） */
export type HasField = 'lora' | 'vae' | 'hires' | 'upscale' | 'controlnet'

const HAS_FIELDS: Record<string, HasField> = {
  lora: 'lora',
  vae: 'vae',
  hires: 'hires',
  upscale: 'upscale',
  controlnet: 'controlnet',
}

/** 数值范围条件（FEAT-3）：op 缺省为精确相等 */
export interface NumCondition {
  field: NumField
  op?: '>' | '>=' | '<' | '<='
  value: number
}

export interface QueryConditions {
  terms: string[]
  model: string[]
  lora: string[]
  seed: string[]
  path: string[]
  /** `date:YYYY-MM-DD`（支持 YYYY / YYYY-MM 前缀与 > >= < <= 范围，本地时区按天匹配 mtime） */
  date: string[]
  /** `pos:xxx` 仅匹配正向提示词 */
  pos: string[]
  /** `neg:xxx` 仅匹配负向提示词 */
  neg: string[]
  /** `sampler:xxx` / `scheduler:xxx` 采样参数定向 */
  sampler: string[]
  scheduler: string[]
  /** `vae:xxx` / `upscale:xxx` 模型资产定向 */
  vae: string[]
  upscale: string[]
  /** `has:lora|vae|hires|upscale|controlnet` 存在性条件 */
  has: HasField[]
  num: NumCondition[]
}

export interface ParsedQuery {
  /** 正向条件：全部满足才命中 */
  all: QueryConditions
  /** O1：`-` 前缀排除条件，任一命中即整条不匹配 */
  none: QueryConditions
}

const QUERY_FIELD_RE =
  /^(model|lora|seed|path|date|pos|neg|sampler|scheduler|vae|upscale|has|steps|cfg|width|w|height|h|batch|clip):(.*)$/i

/** 数值字段别名：w / h 是 width / height 的简写 */
const NUM_FIELDS: Record<string, NumField> = {
  steps: 'steps',
  cfg: 'cfg',
  width: 'width',
  w: 'width',
  height: 'height',
  h: 'height',
  batch: 'batch',
  clip: 'clip',
}

/** 数值字段值解析：支持 > / >= / < / <= 前缀；空值或非数值时忽略该条件 */
function parseNumCondition(field: NumField, raw: string): NumCondition | null {
  const m = raw.trim().match(/^(>=|<=|>|<)?\s*(\S+)$/)
  if (!m) return null
  const value = Number(m[2])
  if (!Number.isFinite(value)) return null
  return { field, op: m[1] as NumCondition['op'], value }
}

/** O1：64 位种子不能安全转 Number，范围比较用「位数 + 字典序」比较非负整数字符串 */
function compareSeed(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

function hitSeed(cond: string, it: ImageItem): boolean {
  const m = cond.match(/^(>=|<=|>|<)?(.+)$/)!
  const seeds = (it.params?.samplers ?? []).map((s) => s.seed).filter((s): s is string => !!s)
  if (!seeds.length) return false
  if (!m[1]) return seeds.some((s) => s.includes(m[2]!))
  const target = m[2]!
  switch (m[1]) {
    case '>':
      return seeds.some((s) => compareSeed(s, target) > 0)
    case '<':
      return seeds.some((s) => compareSeed(s, target) < 0)
    case '>=':
      return seeds.some((s) => compareSeed(s, target) >= 0)
    default:
      return seeds.some((s) => compareSeed(s, target) <= 0)
  }
}

/** 本地时区的 YYYY-MM-DD（dailyCounts 与 date: 搜索共用同一构造） */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

/** date: 条件：按 mtime 的本地时区日期匹配；支持 YYYY / YYYY-MM / YYYY-MM-DD 前缀与 > >= < <= 范围 */
function hitDate(cond: string, it: ImageItem): boolean {
  const m = cond.match(/^(>=|<=|>|<)?(.+)$/)!
  const target = m[2]!
  if (!/^\d{4}(-\d{2})?(-\d{2})?$/.test(target)) return false
  const day = localDayKey(new Date(it.mtime))
  if (!m[1]) return day.startsWith(target)
  // 范围按 ISO 零填充串的字典序比较；年 / 月前缀先展开成对应区间的起止日，
  // 使 `date:>2026-01` 语义为「1 月之后」（而非 1 月内日期按字符串大于前缀）
  const start =
    target.length === 4 ? `${target}-01-01` : target.length === 7 ? `${target}-01` : target
  const end =
    target.length === 4 ? `${target}-12-31` : target.length === 7 ? `${target}-31` : target
  switch (m[1]) {
    case '>':
      return day > end
    case '<':
      return day < start
    case '>=':
      return day >= start
    default:
      return day <= end
  }
}

function hitCondition(
  kind:
    | 'terms'
    | 'model'
    | 'lora'
    | 'seed'
    | 'path'
    | 'date'
    | 'pos'
    | 'neg'
    | 'sampler'
    | 'scheduler'
    | 'vae'
    | 'upscale',
  value: string,
  it: ImageItem,
): boolean {
  switch (kind) {
    case 'terms':
      return searchTextField(it).includes(value)
    case 'model':
      return (it.params?.models ?? []).some((m) => m.toLowerCase().includes(value))
    case 'lora':
      return (it.params?.loras ?? []).some(
        (l) => l.name.toLowerCase().includes(value) || (l.hash ?? '').toLowerCase().includes(value),
      )
    case 'seed':
      return hitSeed(value, it)
    case 'path':
      return (it.path ?? it.name).toLowerCase().includes(value)
    case 'date':
      return hitDate(value, it)
    case 'pos':
      return (it.params?.positive ?? []).some((s) => s.toLowerCase().includes(value))
    case 'neg':
      return (it.params?.negative ?? []).some((s) => s.toLowerCase().includes(value))
    case 'sampler':
      return (it.params?.samplers ?? []).some((s) =>
        (s.sampler ?? '').toLowerCase().includes(value),
      )
    case 'scheduler':
      return (it.params?.samplers ?? []).some((s) =>
        (s.scheduler ?? '').toLowerCase().includes(value),
      )
    case 'vae':
      return (it.params?.vaes ?? []).some((v) => v.toLowerCase().includes(value))
    case 'upscale':
      return (it.params?.upscalers ?? []).some((v) => v.toLowerCase().includes(value))
  }
}

/** has: 存在性条件：hires 以「多阶段采样」为标志（高清修复第二阶段），其余按对应资产列表非空 */
function hitHas(field: HasField, it: ImageItem): boolean {
  const p = it.params
  if (!p) return false
  switch (field) {
    case 'lora':
      return p.loras.length > 0
    case 'vae':
      return p.vaes.length > 0
    case 'hires':
      return p.samplers.length > 1
    case 'upscale':
      return p.upscalers.length > 0
    case 'controlnet':
      return p.controlNets.length > 0
  }
}

/** 数值字段在条目上的取值集合（采样参数取全部阶段，任一命中即可） */
function numValues(field: NumField, p: ParsedParams): number[] {
  if (field === 'steps' || field === 'cfg') {
    const out: number[] = []
    for (const s of p.samplers) {
      const v = field === 'steps' ? s.steps : s.cfg
      if (v !== undefined) out.push(v)
    }
    return out
  }
  const v =
    field === 'width'
      ? p.width
      : field === 'height'
        ? p.height
        : field === 'batch'
          ? p.batch
          : p.clipSkip
  return v !== undefined ? [v] : []
}

function hitNum(cond: NumCondition, it: ImageItem): boolean {
  const p = it.params
  if (!p) return false
  const values = numValues(cond.field, p)
  if (!values.length) return false
  return values.some((v) =>
    cond.op === undefined
      ? v === cond.value
      : cond.op === '>'
        ? v > cond.value
        : cond.op === '>='
          ? v >= cond.value
          : cond.op === '<'
            ? v < cond.value
            : v <= cond.value,
  )
}

function matchConditions(conds: QueryConditions, it: ImageItem, want: boolean): boolean {
  for (const kind of [
    'terms',
    'model',
    'lora',
    'seed',
    'path',
    'date',
    'pos',
    'neg',
    'sampler',
    'scheduler',
    'vae',
    'upscale',
  ] as const) {
    for (const v of conds[kind]) {
      if (hitCondition(kind, v, it) !== want) return false
    }
  }
  for (const f of conds.has) {
    if (hitHas(f, it) !== want) return false
  }
  for (const cond of conds.num) {
    if (hitNum(cond, it) !== want) return false
  }
  return true
}

/**
 * 解析搜索框语法（O1 增强）：
 * - 字段限定 `model:xxx` / `lora:xxx` / `seed:123` / `path:目录`，普通关键词匹配搜索域
 * - 提示词定向 `pos:xxx` / `neg:xxx` 仅匹配正向 / 负向提示词（裸关键词搜全域）
 * - 采样与资产定向 `sampler:xxx` / `scheduler:xxx` / `vae:xxx` / `upscale:xxx`
 * - 存在性 `has:lora|vae|hires|upscale|controlnet`，可配 `-` 排除
 * - 日期（本地时区）：`date:2026-01-31` 精确到天，`date:2026-01` / `date:2026` 按前缀，
 *   `date:>2026-01-01` / `date:<=2026-06` 范围筛选（前缀展开为区间端点再比较）
 * - 数值范围（FEAT-3）：`steps:>30` / `cfg:<8` / `w:>=1024` / `h:<768` / `batch:2` / `clip:>1`，
 *   无操作符为精确相等；非数值值忽略该条件
 * - `seed:>100`（支持 > / >= / < / <=）范围筛选，大种子按数字字符串比较不丢精度
 * - `"model:a b"` / `model:"a b"`：带引号的字段值可含空格（两种引号位置均可）
 * - `-关键词` / `-model:xxx` 排除条件，任一命中即整条不匹配
 * 正向条件按 AND 组合，大小写不敏感。
 */
export function parseQuery(raw: string): ParsedQuery {
  const empty = (): QueryConditions => ({
    terms: [],
    model: [],
    lora: [],
    seed: [],
    path: [],
    date: [],
    pos: [],
    neg: [],
    sampler: [],
    scheduler: [],
    vae: [],
    upscale: [],
    has: [],
    num: [],
  })
  const out: ParsedQuery = { all: empty(), none: empty() }
  // 可选 `-` 前缀必须与引号在同一 token 内识别，否则 `-"model:a b"` 会在空格处被拆坏；
  // 引号也可跟在冒号后（`model:"a b"`），同样作为整体 token
  const tokens = raw.trim().match(/-?(?:[A-Za-z]+:)?"[^"]*"|\S+/g) ?? []
  for (let token of tokens) {
    let negated = false
    if (token.startsWith('-') && token.length > 1) {
      negated = true
      token = token.slice(1)
    }
    if (token.startsWith('"') && token.endsWith('"') && token.length > 1) {
      token = token.slice(1, -1)
    }
    if (!token) continue
    const m = token.match(QUERY_FIELD_RE)
    const bucket = negated ? out.none : out.all
    if (m) {
      const field = m[1]!.toLowerCase()
      const numField = NUM_FIELDS[field]
      if (numField) {
        const cond = parseNumCondition(numField, m[2]!)
        if (cond) bucket.num.push(cond)
      } else if (m[2]) {
        // `model:"a b"` 形态：值外侧的成对引号剥离后再入桶
        let value = m[2]
        if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1)
        }
        // 空值字段（如裸 `model:`）忽略：空串子串匹配会恒真，不符合直觉。
        // seed 条件须为「可选比较符 + 数字」——`seed:>=` 这类残缺值会在 hitSeed 里
        // 经比较符回溯匹配成空目标而退化为恒真，这里直接忽略
        if (value && (field !== 'seed' || /^(>=|<=|>|<)?\d+$/.test(value))) {
          // has: 存在性条件只收已知要素名，未知值忽略（与空值字段同语义）
          if (field === 'has') {
            const hf = HAS_FIELDS[value.toLowerCase()]
            if (hf) bucket.has.push(hf)
          } else {
            bucket[
              field as
                | 'model'
                | 'lora'
                | 'seed'
                | 'path'
                | 'date'
                | 'pos'
                | 'neg'
                | 'sampler'
                | 'scheduler'
                | 'vae'
                | 'upscale'
            ].push(value.toLowerCase())
          }
        }
      }
    } else {
      bucket.terms.push(token.toLowerCase())
    }
  }
  return out
}

export const filteredItems = computed(() => {
  const q = state.search.trim().toLowerCase()
  const query = q ? parseQuery(q) : null
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
      if (state.favOnly && !favKeys.has(recordKey(it))) return false
      if (query && !matchQuery(it, query)) return false
      return true
    })
    .sort(sorters[state.sortMode])
})

/** 搜索匹配：正向条件全 AND，排除条件任一命中即否决 */
function matchQuery(it: ImageItem, query: ParsedQuery): boolean {
  return matchConditions(query.all, it, true) && matchConditions(query.none, it, false)
}

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

/**
 * F3：工作流内容指纹。同串同引用来自 interning（本会话解析），存档恢复的是内容副本，
 * 统一走 FNV-1a 哈希 + 长度兜底，同工作流的图（无论实文件还是存档）都能归入同组。
 * 按条目缓存指纹：长 JSON 的全量哈希在聚类排序的每次重算里是
 * O(全部条目 × 串长) 的主线程开销，缓存后每条在 raw 不变期间至多算一次
 * （raw 一经应用不再变化，以引用比对失效覆盖「结果应用前后」的唯一变更点）。
 */
const workflowKeyCache = new WeakMap<ImageItem, { rawRef: string | undefined; key: string }>()

function workflowKey(it: ImageItem): string {
  const raw = it.raw.prompt ?? it.raw.parameters ?? it.raw.workflow
  const cached = workflowKeyCache.get(it)
  if (cached && cached.rawRef === raw) return cached.key
  let key = `id:${it.id}` // 无元数据 / 失败项各自成组
  if (raw) {
    let h = 0x811c9dc5
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    key = `${(h >>> 0).toString(36)}:${raw.length}`
  }
  workflowKeyCache.set(it, { rawRef: raw, key })
  return key
}

/**
 * F3：同工作流聚类信息（itemId → { group: 组序, seq/total: 组内序号 }）。
 * 组按组内最新时间新→旧排组序，组内同规则编号；卡片在聚类模式下展示「第 x/y 张」。
 */
export const workflowClusters = computed(() => {
  const groups = new Map<string, ImageItem[]>()
  for (const it of state.items) {
    const k = workflowKey(it)
    const g = groups.get(k)
    if (g) g.push(it)
    else groups.set(k, [it])
  }
  const ordered = [...groups.values()]
    .map((members) => ({
      members,
      latest: Math.max(...members.map((m) => m.mtime)),
    }))
    .sort((a, b) => b.latest - a.latest || b.members.length - a.members.length)
  const out = new Map<string, { group: number; seq: number; total: number }>()
  ordered.forEach(({ members }, gi) => {
    const sorted = [...members].sort(
      (a, b) => b.mtime - a.mtime || nameCollator.compare(a.name, b.name),
    )
    sorted.forEach((it, i) => out.set(it.id, { group: gi, seq: i + 1, total: members.length }))
  })
  return out
})

/** F4：同源出图指纹 = 工作流内容 + 首阶段种子；同键即同一生成来源（重跑 / 同参再生成） */
function sameSourceKey(it: ImageItem): string | null {
  const p = it.params
  if (!p) return null
  const seed = p.samplers.find((s) => s.seed)?.seed
  if (!seed) return null
  return `${workflowKey(it)}|${seed}`
}

/** F4：同源出图分组（itemId → 组号 / 组内序号 / 组大小），排序规则与工作流聚类一致 */
export const sameSourceGroups = computed(() => {
  const groups = new Map<string, ImageItem[]>()
  for (const it of state.items) {
    if (it.status !== 'done') continue
    const k = sameSourceKey(it)
    if (!k) continue
    const g = groups.get(k)
    if (g) g.push(it)
    else groups.set(k, [it])
  }
  const out = new Map<string, { group: number; seq: number; total: number }>()
  ;[...groups.values()]
    .map((members) => ({ members, latest: Math.max(...members.map((m) => m.mtime)) }))
    .sort((a, b) => b.latest - a.latest)
    .forEach(({ members }, gi) => {
      const sorted = [...members].sort(
        (a, b) => b.mtime - a.mtime || nameCollator.compare(a.name, b.name),
      )
      sorted.forEach((it, i) => out.set(it.id, { group: gi, seq: i + 1, total: members.length }))
    })
  return out
})

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

/* ---------- 收藏星标：按去重指纹（recordKey）记忆，跨会话保留 ---------- */
// 收藏是用户策展数据：清空列表 / 移除条目都不动账，同指纹文件重新拖入或存档恢复后自动生效
const FAVS_KEY = 'cii:favs'

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVS_KEY)
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
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify([...favKeys]))
  } catch {
    // 配额 / 环境限制时忽略：仅影响下次刷新的还原
  }
}

/** 收藏标记表（itemId → 是否已收藏）：computed 一次算全量，卡片与详情抽屉共用 */
export const favoriteFlags = computed(() => {
  const flags = new Map<string, boolean>()
  for (const it of state.items) flags.set(it.id, favKeys.has(recordKey(it)))
  return flags
})

/** 当前列表内已收藏条数（驱动「只看收藏」开关的显隐） */
export const favCount = computed(() => {
  let n = 0
  for (const it of state.items) if (favKeys.has(recordKey(it))) n++
  return n
})

export function toggleFavorite(item: ImageItem) {
  const key = recordKey(item)
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
    const key = recordKey(it)
    if (faved ? !favKeys.has(key) : favKeys.has(key)) {
      if (faved) favKeys.add(key)
      else favKeys.delete(key)
      changed = true
    }
  }
  if (changed) persistFavorites()
}

export function toggleDark() {
  state.dark = !state.dark
  // 显式偏好只在用户切换时落盘；系统跟随（见 schemeQuery 监听）不写入，
  // 未设置过偏好的用户始终保留「跟随系统」语义
  try {
    localStorage.setItem('cii:theme', state.dark ? 'dark' : 'light')
  } catch {
    // 配额 / 环境限制时忽略：仅影响下次刷新的还原
  }
}

/**
 * P2：预览 URL 惰性创建——由卡片 / 抽屉在渲染时调用。
 * 入列时不再为每张图创建 Blob URL，万级扫描只有实际渲染过的条目才占 URL 与解码内存。
 */
export function ensureItemUrl(item: ImageItem): void {
  if (item.url || item.metaOnly || item.detached || !item.file) return
  item.url = URL.createObjectURL(item.file)
}

export { state as store }
