import { computed, reactive, watch } from 'vue'
import type { ImageItem, ImageSource, IncomingFile, ParsedParams, RawMetadata } from '../types'
import { clearInternPool, hasSupportedSignature, isMetaTextFile, isSupportedImage } from '../lib/metadata'
import { parseImage } from '../lib/parser'
import { collectDirectoryFiles, ensureReadPermission } from '../lib/fs'
import {
  clearHandle,
  clearPersisted,
  deletePersisted,
  fromRecord,
  loadHandle,
  loadPersisted,
  probePersistence,
  putPersisted,
  recordKey,
  saveHandle,
  toRecord,
  type PersistRecord,
} from '../lib/persist'

export type SourceFilter = 'all' | 'comfyui' | 'a1111' | 'none' | 'error'
export type SortMode = 'default' | 'time-desc' | 'time-asc' | 'workflow'
const SORT_MODES: SortMode[] = ['default', 'time-desc', 'time-asc', 'workflow']

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
}

const storedSort = localStorage.getItem('cii:sort') as SortMode | null

/* ---------- 筛选 / 搜索状态持久化（U2）：刷新后还原上次的使用状态 ---------- */
const FILTERS_KEY = 'cii:filters'
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

const state = reactive<StoreState>({
  items: [],
  search: storedFilters.search,
  modelFilter: storedFilters.modelFilter,
  sourceFilter: storedFilters.sourceFilter,
  sortMode: storedSort && SORT_MODES.includes(storedSort) ? storedSort : 'default',
  dark: localStorage.getItem('cii:theme') !== 'light',
  batchTotal: 0,
  batchDone: 0,
  rescanName: null,
})

watch(
  () => state.dark,
  (d) => localStorage.setItem('cii:theme', d ? 'dark' : 'light'),
)

watch(
  () => state.sortMode,
  (m) => localStorage.setItem('cii:sort', m),
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
  const idx = state.items.indexOf(item)
  if (idx < 0) return
  state.items.splice(idx, 1)
  liveIds.delete(item.id)
  const key = recordKey(item)
  seenKeys.delete(key)
  if (item.detached) detachedByKey.delete(key)
  dirtyItems.delete(key)
  deletedKeys.add(key)
  schedulePersist()
  URL.revokeObjectURL(item.url)
  if (inflight.has(item.id)) {
    // 在途（含结果已入暂存未应用）：无法中断也不动计数，其 batchDone++ 已在完成时
    // 与保留的 batchTotal 对齐，应用时结果被 liveIds 拦截，不会出现进度错乱或写库复活
  } else if (item.status === 'pending') {
    // 未开始的直接出队
    const qi = queue.indexOf(item)
    if (qi >= 0) queue.splice(qi, 1)
    state.batchTotal--
  } else {
    // done / error：两本账一起减
    state.batchTotal--
    state.batchDone--
  }
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

/* ---------- 目录句柄（File System Access，一键重扫） ---------- */
// 句柄不放进 reactive 状态：代理对象无法结构化克隆回写 IndexedDB，界面只依赖 rescanName
let rescanHandle: FileSystemDirectoryHandle | null = null

export async function setRescanHandle(handle: FileSystemDirectoryHandle) {
  rescanHandle = handle
  state.rescanName = handle.name
  try {
    // 句柄持久化不可用的浏览器（不支持结构化克隆）仅本次会话有效
    if (persistAvailable) await saveHandle(handle)
  } catch {
    // 忽略：重扫按钮仍在本会话可用
  }
}

export function forgetRescanHandle() {
  rescanHandle = null
  state.rescanName = null
  if (persistAvailable) void clearHandle().catch(() => {})
}

/**
 * 一键重扫记住的目录：只增量添加新文件，已有文件按指纹回挂 / 去重，不会重复解析。
 * 分批边扫边入列；返回新增入列的文件数，无句柄或未获授权返回 null。
 */
export async function rescanDirectory(): Promise<number | null> {
  if (!rescanHandle) return null
  if (!(await ensureReadPermission(rescanHandle))) return null
  let added = 0
  await collectDirectoryFiles(rescanHandle, (files) => {
    added += addFiles(files)
  })
  return added
}

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
 */
export function restoreArchived(records: PersistRecord[]) {
  for (const rec of records) {
    if (seenKeys.has(rec.key)) continue
    const item = reactive<ImageItem>(fromRecord(rec))
    item.searchText = buildSearchText(item, item.params)
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
  const items = [...dirtyItems.values()]
  dirtyItems.clear()
  const keys = [...deletedKeys]
  deletedKeys.clear()
  try {
    // 清空列表会作废本轮写库，避免把已删除的历史写回去
    if (epoch !== persistEpoch) return
    const records = items.map(toRecord).filter((r) => r !== null)
    if (records.length) await putPersisted(records)
    if (keys.length) await deletePersisted(keys)
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
    restoreArchived(await loadPersisted())
    const handle = await loadHandle()
    if (handle) {
      rescanHandle = handle
      state.rescanName = handle.name
    }
  } catch (err) {
    // 恢复失败等同不可用：静默降级纯内存，但保留一条告警便于排查环境问题
    console.warn('[comfyui-info] 会话恢复失败，本次会话不启用持久化:', err)
    persistAvailable = false
  }
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
  'time-asc': (a, b) =>
    errLast(a) - errLast(b) || a.mtime - b.mtime || byName(a, b),
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

export const modelOptions = computed(() => {
  const set = new Set<string>()
  for (const i of state.items) {
    if (i.source === 'none') continue
    for (const m of i.params?.models ?? []) set.add(m)
  }
  return Array.from(set)
    .sort()
    .map((m) => ({ label: m, value: m }))
})

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

/**
 * 搜索域：相对路径 / 文件名 + 提示词 + 模型 / LoRA（含哈希）/ 采样参数，按任意生成要素定位图片。
 * 在解析结果落定时（parseItem）构建一次并小写化，应用时挂上，筛选热路径不再重复拼接。
 */
function buildSearchText(it: ImageItem, p: ParsedParams | undefined): string {
  const parts = [it.path ?? it.name, ...(p?.positive ?? []), ...(p?.negative ?? []), ...(p?.models ?? [])]
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
  return parts.join('\n').toLowerCase()
}

export interface QueryConditions {
  terms: string[]
  model: string[]
  lora: string[]
  seed: string[]
  path: string[]
}

export interface ParsedQuery {
  /** 正向条件：全部满足才命中 */
  all: QueryConditions
  /** O1：`-` 前缀排除条件，任一命中即整条不匹配 */
  none: QueryConditions
}

const QUERY_FIELD_RE = /^(model|lora|seed|path):(.+)$/i

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

function hitCondition(kind: keyof QueryConditions, value: string, it: ImageItem): boolean {
  switch (kind) {
    case 'terms':
      return (it.searchText ?? it.name.toLowerCase()).includes(value)
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
  }
}

function matchConditions(conds: QueryConditions, it: ImageItem, want: boolean): boolean {
  for (const kind of Object.keys(conds) as (keyof QueryConditions)[]) {
    for (const v of conds[kind]) {
      if (hitCondition(kind, v, it) !== want) return false
    }
  }
  return true
}

/**
 * 解析搜索框语法（O1 增强）：
 * - 字段限定 `model:xxx` / `lora:xxx` / `seed:123` / `path:目录`，普通关键词匹配搜索域
 * - `seed:>100`（支持 > / >= / < / <=）范围筛选，大种子按数字字符串比较不丢精度
 * - `"model:a b"` 带引号的字段值可含空格
 * - `-关键词` / `-model:xxx` 排除条件，任一命中即整条不匹配
 * 正向条件按 AND 组合，大小写不敏感。
 */
export function parseQuery(raw: string): ParsedQuery {
  const empty = (): QueryConditions => ({ terms: [], model: [], lora: [], seed: [], path: [] })
  const out: ParsedQuery = { all: empty(), none: empty() }
  const tokens = raw.trim().match(/"[^"]*"|\S+/g) ?? []
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
      bucket[m[1]!.toLowerCase() as keyof Omit<QueryConditions, 'terms'>].push(m[2]!.toLowerCase())
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
      if (it.status === 'pending' || it.status === 'parsing') {
        return state.sourceFilter === 'all'
      }
      if (state.sourceFilter !== 'all' && it.source !== state.sourceFilter) return false
      if (state.modelFilter && !(it.params?.models ?? []).includes(state.modelFilter)) return false
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

export const sourceOptions: { label: string; value: SourceFilter }[] = [  { label: 'ComfyUI 原图', value: 'comfyui' },
  { label: 'A1111 / WebUI', value: 'a1111' },
  { label: '无元数据', value: 'none' },
  { label: '解析失败', value: 'error' },
  { label: '全部图片', value: 'all' },
]

export const sortOptions: { label: string; value: SortMode }[] = [
  { label: '默认排序', value: 'default' },
  { label: '时间 新→旧', value: 'time-desc' },
  { label: '时间 旧→新', value: 'time-asc' },
  { label: '按工作流聚类', value: 'workflow' },
]

/**
 * F3：工作流内容指纹。同串同引用来自 interning（本会话解析），存档恢复的是内容副本，
 * 统一走 FNV-1a 哈希 + 长度兜底，同工作流的图（无论实文件还是存档）都能归入同组。
 */
function workflowKey(it: ImageItem): string {
  const raw = it.raw.prompt ?? it.raw.parameters ?? it.raw.workflow
  if (!raw) return `id:${it.id}` // 无元数据 / 失败项各自成组
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}:${raw.length}`
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
    const sorted = [...members].sort((a, b) => b.mtime - a.mtime || nameCollator.compare(a.name, b.name))
    sorted.forEach((it, i) => out.set(it.id, { group: gi, seq: i + 1, total: members.length }))
  })
  return out
})

export function toggleDark() {
  state.dark = !state.dark
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
