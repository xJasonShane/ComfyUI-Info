import { computed, reactive, watch } from 'vue'
import type { ImageItem, ImageSource, IncomingFile } from '../types'
import { clearInternPool, hasSupportedSignature, isSupportedImage } from '../lib/metadata'
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
export type SortMode = 'default' | 'time-desc' | 'time-asc'
const SORT_MODES: SortMode[] = ['default', 'time-desc', 'time-asc']

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

const state = reactive<StoreState>({
  items: [],
  search: '',
  modelFilter: null,
  sourceFilter: 'comfyui',
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

/* ---------- 解析队列（有限并发） ---------- */
let active = 0
const queue: ImageItem[] = []
const PARSE_LIMIT = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) * 2))
// 清空列表时递增：旧批次的在途解析完成时不再计数，避免污染新批次进度
let batchEpoch = 0

function pump() {
  while (active < PARSE_LIMIT && queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    active++
    void parseItem(item, batchEpoch)
  }
}

async function parseItem(item: ImageItem, epoch: number) {
  item.status = 'parsing'
  try {
    // 入队的都是实文件项（存档项不解析）
    const { raw, params } = await parseImage(item.file!)
    item.raw = raw
    item.source = raw.source
    item.params = params
    // 搜索串在解析结果落定后构建一次：筛选热路径只做 includes，不再每键重建
    item.searchText = buildSearchText(item)
    item.status = 'done'
  } catch (e) {
    item.status = 'error'
    item.error = e instanceof Error ? e.message : String(e)
  } finally {
    markDirty(item)
    active--
    if (epoch === batchEpoch) state.batchDone++
    pump()
  }
}

/* ---------- 添加 / 清空 ---------- */
let seq = 0
// 已加载文件的指纹（recordKey：路径或文件名|大小|修改时间），O(1) 查重；增删 items 时必须同步维护
const seenKeys = new Set<string>()
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

export function addFiles(files: IncomingFile[]) {
  const deferred: IncomingFile[] = []
  for (const { file, path } of files) {
    if (isSupportedImage(file)) {
      enqueueFile(file, path)
    } else {
      // 无扩展名 / 生僻扩展名：按文件头魔数嗅探，异步确认后再入列
      deferred.push({ file, path })
    }
  }
  pump()
  for (const incoming of deferred) void acceptBySniff(incoming)
}

function enqueueFile(file: File, path?: string) {
  const key = recordKey({ path, name: file.name, size: file.size, mtime: file.lastModified })
  if (seenKeys.has(key)) return
  // 与存档项同指纹：回挂文件恢复预览，元数据已在库中，不再重新解析
  const archived = detachedByKey.get(key)
  if (archived) {
    archived.file = file
    archived.url = URL.createObjectURL(file)
    archived.detached = false
    seenKeys.add(key)
    detachedByKey.delete(key)
    return
  }
  seenKeys.add(key)
  // 必须以响应式代理入队：解析是异步改写 item 字段，绕过代理不会触发视图更新
  const item = reactive<ImageItem>({
    id: `img-${++seq}`,
    file,
    url: URL.createObjectURL(file),
    name: file.name,
    path,
    size: file.size,
    mtime: file.lastModified,
    status: 'pending',
    source: 'none',
    raw: { source: 'none' },
  })
  state.items.push(item)
  state.batchTotal++
  queue.push(item)
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
  const key = recordKey(item)
  seenKeys.delete(key)
  if (item.detached) detachedByKey.delete(key)
  dirtyItems.delete(key)
  deletedKeys.add(key)
  schedulePersist()
  URL.revokeObjectURL(item.url)
  if (item.status === 'pending') {
    // 未开始的直接出队
    const qi = queue.indexOf(item)
    if (qi >= 0) queue.splice(qi, 1)
    state.batchTotal--
  } else if (item.status !== 'parsing') {
    // done / error：两本账一起减
    state.batchTotal--
    state.batchDone--
  }
  // 在途（parsing）无法中断也不动计数：其完成时的 batchDone++ 会与保留的 batchTotal 对齐，
  // 不会出现永久“扫描中”或进度超过 100%
}

export function clearAll() {
  for (const i of state.items) URL.revokeObjectURL(i.url)
  state.items = []
  seenKeys.clear()
  detachedByKey.clear()
  queue.length = 0
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

/** 一键重扫记住的目录：只增量添加新文件，已有文件按指纹回挂 / 去重，不会重复解析 */
export async function rescanDirectory(): Promise<boolean> {
  if (!rescanHandle) return false
  if (!(await ensureReadPermission(rescanHandle))) return false
  addFiles(await collectDirectoryFiles(rescanHandle))
  return true
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
    item.searchText = buildSearchText(item)
    detachedByKey.set(rec.key, item)
    state.items.push(item)
  }
}

function markDirty(item: ImageItem) {
  if (!persistAvailable) return
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
  } catch {
    // 写库失败（配额 / 环境限制）不影响功能，本轮丢弃
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
  } catch {
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
}

export const stats = computed(() => {
  const c: Record<ImageSource | 'error', number> = { comfyui: 0, a1111: 0, none: 0, error: 0 }
  for (const i of state.items) {
    // 解析失败的项没有来源，单独计数，不冒充“无元数据”
    if (i.status === 'error') c.error++
    else c[i.source]++
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

/**
 * 搜索域：相对路径 / 文件名 + 提示词 + 模型 / LoRA（含哈希）/ 采样参数，按任意生成要素定位图片。
 * 在解析完成时（parseItem）构建一次并小写化，筛选热路径不再重复拼接。
 */
function buildSearchText(it: ImageItem): string {
  const p = it.params
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

export interface ParsedQuery {
  terms: string[]
  model: string[]
  lora: string[]
  seed: string[]
  path: string[]
}

const QUERY_FIELD_RE = /^(model|lora|seed|path):(.+)$/i

/**
 * 解析搜索框语法：`model:xxx` / `lora:xxx` / `seed:123` / `path:目录` 字段限定 +
 * 普通关键词，全部条件按 AND 组合；字段值不能含空格，大小写不敏感。
 */
export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], model: [], lora: [], seed: [], path: [] }
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue
    const m = token.match(QUERY_FIELD_RE)
    if (m) {
      out[m[1]!.toLowerCase() as keyof Omit<ParsedQuery, 'terms'>].push(m[2]!.toLowerCase())
    } else {
      out.terms.push(token.toLowerCase())
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
      if (state.sourceFilter !== 'all' && it.source !== state.sourceFilter) return false
      if (state.modelFilter && !(it.params?.models ?? []).includes(state.modelFilter)) return false
      if (query && !matchQuery(it, query)) return false
      return true
    })
    .sort(sorters[state.sortMode])
})

/** 搜索匹配：普通词命中搜索串，字段限定各自命中结构化参数，全部条件 AND */
function matchQuery(it: ImageItem, query: ParsedQuery): boolean {
  const fallbackHay = it.searchText ?? it.name.toLowerCase()
  for (const term of query.terms) {
    if (!fallbackHay.includes(term)) return false
  }
  for (const v of query.model) {
    if (!(it.params?.models ?? []).some((m) => m.toLowerCase().includes(v))) return false
  }
  for (const v of query.lora) {
    const hit = (it.params?.loras ?? []).some(
      (l) => l.name.toLowerCase().includes(v) || (l.hash ?? '').toLowerCase().includes(v),
    )
    if (!hit) return false
  }
  for (const v of query.seed) {
    if (!(it.params?.samplers ?? []).some((s) => (s.seed ?? '').includes(v))) return false
  }
  for (const v of query.path) {
    if (!(it.path ?? it.name).toLowerCase().includes(v)) return false
  }
  return true
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
]

export function toggleDark() {
  state.dark = !state.dark
}

export { state as store }
