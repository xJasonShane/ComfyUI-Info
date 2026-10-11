/**
 * 工作流聚类（D1 纯函数模块）：按工作流内容指纹把同一工作流的出图聚成组，
 * 并检测同源重复（同工作流同种子）。输入条目数组与排序 collator，输出
 * 「条目 id → 组号 / 组内序号 / 组大小」；不含任何响应式状态，可独立单测。
 */
import type { ImageItem } from '../types'

export interface ClusterInfo {
  group: number
  seq: number
  total: number
}

/**
 * 工作流内容指纹（FNV-1a + 长度兜底）：prompt / parameters / workflow 任一存在即按内容归组，
 * 同工作流的图（无论实文件还是存档）都能归入同组；无元数据 / 失败项各自成组。
 * 按条目缓存指纹：长 JSON 的全量哈希在聚类排序的每次重算里是
 * O(全部条目 × 串长) 的主线程开销，缓存后每条在 raw 不变期间至多算一次
 * （raw 一经应用不再变化，以引用比对失效覆盖「结果应用前后」的唯一变更点）。
 */
const workflowKeyCache = new WeakMap<ImageItem, { rawRef: string | undefined; key: string }>()

export function workflowKey(it: ImageItem): string {
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

/** 组内最新 mtime：循环求 max——同一工作流的组可达数万张，Math.max(...spread)
 * 超引擎参数上限会抛 RangeError 打断渲染（I3） */
export function latestMtime(members: ImageItem[]): number {
  let max = 0
  for (const m of members) if (m.mtime > max) max = m.mtime
  return max
}

function groupAndNumber(
  items: ImageItem[],
  keyOf: (it: ImageItem) => string | null,
  nameCollator: Intl.Collator,
  /** 组间排序含组大小 tiebreak（工作流聚类用）；同源分组仅按最新时间 */
  bySizeTiebreak: boolean,
): Map<string, ClusterInfo> {
  const groups = new Map<string, ImageItem[]>()
  for (const it of items) {
    const k = keyOf(it)
    if (!k) continue
    const g = groups.get(k)
    if (g) g.push(it)
    else groups.set(k, [it])
  }
  const ordered = [...groups.values()]
    .map((members) => ({ members, latest: latestMtime(members) }))
    .sort((a, b) =>
      bySizeTiebreak
        ? b.latest - a.latest || b.members.length - a.members.length
        : b.latest - a.latest,
    )
  const out = new Map<string, ClusterInfo>()
  ordered.forEach(({ members }, gi) => {
    const sorted = [...members].sort(
      (a, b) => b.mtime - a.mtime || nameCollator.compare(a.name, b.name),
    )
    sorted.forEach((it, i) => out.set(it.id, { group: gi, seq: i + 1, total: members.length }))
  })
  return out
}

/** F3：同工作流聚类信息（itemId → { group: 组序, seq/total: 组内序号 }）。
 * 组按组内最新时间新→旧排组序（同时间按组大小），组内同规则编号 */
export function clusterByWorkflow(
  items: ImageItem[],
  nameCollator: Intl.Collator,
): Map<string, ClusterInfo> {
  return groupAndNumber(items, workflowKey, nameCollator, true)
}

/** F4：同源出图指纹 = 工作流内容 + 首阶段种子；同键即同一生成来源（重跑 / 同参再生成） */
export function sameSourceKey(it: ImageItem): string | null {
  const p = it.params
  if (!p) return null
  const seed = p.samplers.find((s) => s.seed)?.seed
  if (!seed) return null
  return `${workflowKey(it)}|${seed}`
}

/** F4：同源出图分组（仅统计已解析项），排序规则与工作流聚类一致 */
export function clusterBySameSource(
  items: ImageItem[],
  nameCollator: Intl.Collator,
): Map<string, ClusterInfo> {
  return groupAndNumber(items, sameSourceKey, nameCollator, false)
}
