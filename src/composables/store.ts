import { computed, reactive, watch } from 'vue'
import type { ImageItem, ImageSource } from '../types'
import { isSupportedImage, readImageMetadata } from '../lib/metadata'
import { extractComfyParams } from '../lib/comfyExtract'
import { parseA1111Parameters } from '../lib/a1111'

export type SourceFilter = 'all' | 'comfyui' | 'a1111' | 'none' | 'error'

interface StoreState {
  items: ImageItem[]
  search: string
  modelFilter: string | null
  sourceFilter: SourceFilter
  dark: boolean
  batchTotal: number
  batchDone: number
}

const state = reactive<StoreState>({
  items: [],
  search: '',
  modelFilter: null,
  sourceFilter: 'comfyui',
  dark: localStorage.getItem('cii:theme') !== 'light',
  batchTotal: 0,
  batchDone: 0,
})

watch(
  () => state.dark,
  (d) => localStorage.setItem('cii:theme', d ? 'dark' : 'light'),
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
    const raw = await readImageMetadata(item.file)
    item.raw = raw
    item.source = raw.source
    if (raw.source === 'comfyui' && raw.prompt) {
      item.params = extractComfyParams(raw.prompt) ?? undefined
    } else if (raw.source === 'a1111' && raw.parameters) {
      item.params = parseA1111Parameters(raw.parameters)
    }
    item.status = 'done'
  } catch (e) {
    item.status = 'error'
    item.error = e instanceof Error ? e.message : String(e)
  } finally {
    active--
    if (epoch === batchEpoch) state.batchDone++
    pump()
  }
}

/* ---------- 添加 / 清空 ---------- */
let seq = 0
// 已加载文件的指纹（name|size|lastModified），O(1) 查重；增删 items 时必须同步维护
const seenKeys = new Set<string>()

export function retryItem(item: ImageItem) {
  // 仅允许重试当前列表中的失败项（列表清空时抽屉会被关闭，这里兜底）
  if (item.status !== 'error' || !state.items.includes(item)) return
  item.status = 'pending'
  item.error = undefined
  state.batchTotal++
  queue.push(item)
  pump()
}

export function addFiles(files: File[]) {
  for (const file of files) {
    if (!isSupportedImage(file)) continue
    const key = `${file.name}|${file.size}|${file.lastModified}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    // 必须以响应式代理入队：解析是异步改写 item 字段，绕过代理不会触发视图更新
    const item = reactive<ImageItem>({
      id: `img-${++seq}`,
      file,
      url: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      status: 'pending',
      source: 'none',
      raw: { source: 'none' },
    })
    state.items.push(item)
    state.batchTotal++
    queue.push(item)
  }
  pump()
}

export function removeItem(item: ImageItem) {
  const idx = state.items.indexOf(item)
  if (idx < 0) return
  state.items.splice(idx, 1)
  seenKeys.delete(`${item.name}|${item.size}|${item.file.lastModified}`)
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
  queue.length = 0
  state.batchTotal = 0
  state.batchDone = 0
  batchEpoch++ // 在途解析完成后不再计入新批次
}

/* ---------- 派生数据 ---------- */
export const parsing = computed(() => state.batchDone < state.batchTotal)
export const scanProgress = computed(() =>
  state.batchTotal === 0 ? 0 : Math.min(100, Math.round((state.batchDone / state.batchTotal) * 100)),
)

const sourceRank: Record<string, number> = { comfyui: 0, a1111: 1, none: 2 }

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

/** 搜索域：文件名 + 提示词 + 模型 / LoRA（含哈希）/ 采样参数，按任意生成要素定位图片 */
function searchHaystack(it: ImageItem): string[] {
  const p = it.params
  const parts = [it.name, ...(p?.positive ?? []), ...(p?.negative ?? []), ...(p?.models ?? [])]
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
  return parts
}

export const filteredItems = computed(() => {
  const q = state.search.trim().toLowerCase()
  return state.items
    .filter((it) => {
      // 解析失败的项不受搜索 / 模型筛选影响，由来源筛选统一控制可见性
      if (it.status === 'error') {
        return state.sourceFilter === 'error' || state.sourceFilter === 'all'
      }
      if (state.sourceFilter === 'error') return false
      if (state.sourceFilter !== 'all' && it.source !== state.sourceFilter) return false
      if (state.modelFilter && !(it.params?.models ?? []).includes(state.modelFilter)) return false
      if (q) {
        const hay = searchHaystack(it).join('\n').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    .sort(
      (a, b) =>
        (a.status === 'error' ? 3 : sourceRank[a.source] ?? 3) -
          (b.status === 'error' ? 3 : sourceRank[b.source] ?? 3) ||
        a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
    )
})

export const sourceOptions: { label: string; value: SourceFilter }[] = [
  { label: 'ComfyUI 原图', value: 'comfyui' },
  { label: 'A1111 / WebUI', value: 'a1111' },
  { label: '无元数据', value: 'none' },
  { label: '解析失败', value: 'error' },
  { label: '全部图片', value: 'all' },
]

export function toggleDark() {
  state.dark = !state.dark
}

export { state as store }
