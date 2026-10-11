/**
 * 结构化搜索语法（D1 纯函数模块）：解析 `model:xxx` 字段限定 / `-` 排除 / 引号含空格 /
 * 数值与日期范围等语法，并对单个条目做匹配判定。零 Vue 依赖、可独立单测；
 * 唯一的外部状态是标签账本（hasTag / recordKey 经 QueryEnv 注入）。
 */
import type { ImageItem, ParsedParams } from '../types'

/* ---------- 搜索域 ---------- */

/**
 * 搜索域：相对路径 / 文件名 + 提示词 + 模型 / LoRA（含哈希）/ 采样参数 + VAE / 放大模型 /
 * ControlNet，按任意生成要素定位图片。
 * 在解析结果落定时（parseItem）构建一次并小写化，应用时挂上，筛选热路径不再重复拼接；
 * 存档项走 searchTextField 按需构建（P2 惰性化，恢复期不逐条拼接长串）。
 */
export function buildSearchText(it: ImageItem, p: ParsedParams | undefined): string {
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

export function searchTextField(it: ImageItem): string {
  const eager = it.searchText
  if (eager !== undefined) return eager
  let built = searchTextCache.get(it)
  if (built === undefined) {
    built = buildSearchText(it, it.params)
    searchTextCache.set(it, built)
  }
  return built
}

/** 空闲预热存档项的搜索串（restoreArchivedInChunks 分批调用，命中缓存后首次搜索零等待） */
export function prewarmSearchText(it: ImageItem): void {
  if (it.searchText !== undefined || searchTextCache.has(it)) return
  searchTextCache.set(it, buildSearchText(it, it.params))
}

/* ---------- 字段定义表（D2）：语法正则 / 数值别名 / 条件桶的唯一事实来源 ---------- */

export type NumField = 'steps' | 'cfg' | 'width' | 'height' | 'batch' | 'clip'

/** `has:` 存在性条件：图片具备对应生成要素（可配 `-` 排除「有某要素」的图） */
export type HasField = 'lora' | 'vae' | 'hires' | 'upscale' | 'controlnet' | 'tag'

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
  /** `vae:xxx` / `upscale:xxx` / `controlnet:xxx` 模型资产定向 */
  vae: string[]
  upscale: string[]
  controlnet: string[]
  /** `tag:xxx` 自定义标签定向（标签按去重指纹记忆） */
  tag: string[]
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

export const QUERY_KINDS = [
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
  'controlnet',
  'tag',
] as const
export type QueryKind = (typeof QUERY_KINDS)[number]

interface FieldDef {
  /** 语法里的字段名；QUERY_FIELD_RE 与数值别名都由本表派生（D2） */
  name: string
  /** 条件桶：字符串字段与 QueryKind 同名；has / num 为聚合桶 */
  kind: QueryKind | 'has' | 'num'
  /** kind === 'num' 时的数值字段（w / h 为别名） */
  num?: NumField
}

export const FIELD_DEFS: FieldDef[] = [
  { name: 'model', kind: 'model' },
  { name: 'lora', kind: 'lora' },
  { name: 'seed', kind: 'seed' },
  { name: 'path', kind: 'path' },
  { name: 'date', kind: 'date' },
  { name: 'pos', kind: 'pos' },
  { name: 'neg', kind: 'neg' },
  { name: 'sampler', kind: 'sampler' },
  { name: 'scheduler', kind: 'scheduler' },
  { name: 'vae', kind: 'vae' },
  { name: 'upscale', kind: 'upscale' },
  { name: 'controlnet', kind: 'controlnet' },
  { name: 'tag', kind: 'tag' },
  { name: 'has', kind: 'has' },
  { name: 'steps', kind: 'num', num: 'steps' },
  { name: 'cfg', kind: 'num', num: 'cfg' },
  { name: 'width', kind: 'num', num: 'width' },
  { name: 'w', kind: 'num', num: 'width' },
  { name: 'height', kind: 'num', num: 'height' },
  { name: 'h', kind: 'num', num: 'height' },
  { name: 'batch', kind: 'num', num: 'batch' },
  { name: 'clip', kind: 'num', num: 'clip' },
]

/** 语法正则由字段表派生：新增搜索字段只改 FIELD_DEFS + hitCondition 的一个 case */
export const QUERY_FIELD_RE = new RegExp(`^(${FIELD_DEFS.map((f) => f.name).join('|')}):(.*)$`, 'i')

const FIELD_BY_NAME = new Map(FIELD_DEFS.map((f) => [f.name, f]))

const HAS_FIELDS: Record<string, HasField> = {
  lora: 'lora',
  vae: 'vae',
  hires: 'hires',
  upscale: 'upscale',
  controlnet: 'controlnet',
  tag: 'tag',
}

/* ---------- 条件匹配 ---------- */

/** O1：64 位种子不能安全转 Number，范围比较用「位数 + 字典序」比较非负整数字符串；
 * 先去前导零再比位数——入口校验放行 "007" 这类写法，须按数值位数比较才成立 */
function compareSeed(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '')
  const y = b.replace(/^0+(?=\d)/, '')
  if (x.length !== y.length) return x.length - y.length
  return x < y ? -1 : x > y ? 1 : 0
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
export function localDayKey(d: Date): string {
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

/** 数值字段值解析：支持 > / >= / < / <= 前缀；空值或非数值时忽略该条件 */
function parseNumCondition(field: NumField, raw: string): NumCondition | null {
  const m = raw.trim().match(/^(>=|<=|>|<)?\s*(\S+)$/)
  if (!m) return null
  const value = Number(m[2])
  if (!Number.isFinite(value)) return null
  return { field, op: m[1] as NumCondition['op'], value }
}

/**
 * 标签账本注入（D1）：tag: / has:tag 匹配依赖 store 的指纹标签表；
 * 搜索串与指纹键的缓存构造也由宿主提供，本模块不持有任何全局可变状态。
 */
export interface QueryEnv {
  recordKey(it: ImageItem): string
  hasTag(key: string, tag: string | null): boolean
}

function hitCondition(kind: QueryKind, value: string, it: ImageItem, env: QueryEnv): boolean {
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
    case 'controlnet':
      return (it.params?.controlNets ?? []).some((v) => v.toLowerCase().includes(value))
    case 'tag':
      return env.hasTag(env.recordKey(it), value)
  }
}

/** has: 存在性条件：hires 以「多阶段采样」为标志（高清修复第二阶段），其余按对应资产列表非空 */
function hitHas(field: HasField, it: ImageItem, env: QueryEnv): boolean {
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
    case 'tag':
      return env.hasTag(env.recordKey(it), null)
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

export function matchConditions(
  conds: QueryConditions,
  it: ImageItem,
  want: boolean,
  env: QueryEnv,
): boolean {
  for (const kind of QUERY_KINDS) {
    for (const v of conds[kind]) {
      if (hitCondition(kind, v, it, env) !== want) return false
    }
  }
  for (const f of conds.has) {
    if (hitHas(f, it, env) !== want) return false
  }
  for (const cond of conds.num) {
    if (hitNum(cond, it) !== want) return false
  }
  return true
}

/** 搜索匹配：正向条件全 AND，排除条件任一命中即否决 */
export function matchQuery(it: ImageItem, query: ParsedQuery, env: QueryEnv): boolean {
  return matchConditions(query.all, it, true, env) && matchConditions(query.none, it, false, env)
}

/** 空条件桶（parseQuery 与测试共用同一形状） */
export function emptyConditions(): QueryConditions {
  return {
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
    controlnet: [],
    tag: [],
    has: [],
    num: [],
  }
}

/* ---------- 语法解析 ---------- */

/**
 * 解析搜索框语法（O1 增强）：
 * - 字段限定 `model:xxx` / `lora:xxx` / `seed:123` / `path:目录`，普通关键词匹配搜索域
 * - 提示词定向 `pos:xxx` / `neg:xxx` 仅匹配正向 / 负向提示词（裸关键词搜全域）
 * - 采样与资产定向 `sampler:xxx` / `scheduler:xxx` / `vae:xxx` / `upscale:xxx` / `controlnet:xxx`
 * - 自定义标签定向 `tag:xxx`（has:tag 看有标签的图，可配 `-` 排除）
 * - 存在性 `has:lora|vae|hires|upscale|controlnet`，可配 `-` 排除
 * - 日期（本地时区）：`date:2026-01-31` 精确到天，`date:2026-01` / `date:2026` 按前缀，
 *   `date:>2026-01-01` / `date:<=2026-06` 范围筛选（前缀展开为区间端点再比较）
 * - 数值范围（FEAT-3）：`steps:>30` / `cfg:<8` / `w:>=1024` / `h:<768` / `batch:2` / `clip:>1`，
 *   无操作符为精确相等；非数值值忽略该条件
 * - `seed:>100`（支持 > / >= / < / <=）范围筛选，大种子按数字字符串比较不丢精度
 * - `"model:a b"` / `model:"a b"`：带引号的字段值可含空格（两种引号位置均可）
 * - `-关键词` / `-model:xxx` 排除条件，任一命中即整条不匹配
 * - 正向条件按 AND 组合，大小写不敏感。
 */
export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = { all: emptyConditions(), none: emptyConditions() }
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
      const def = FIELD_BY_NAME.get(m[1]!.toLowerCase())
      if (def) {
        if (def.kind === 'num') {
          const cond = parseNumCondition(def.num!, m[2]!)
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
          if (value && (def.kind !== 'seed' || /^(>=|<=|>|<)?\d+$/.test(value))) {
            // has: 存在性条件只收已知要素名，未知值忽略（与空值字段同语义）
            if (def.kind === 'has') {
              const hf = HAS_FIELDS[value.toLowerCase()]
              if (hf) bucket.has.push(hf)
            } else {
              bucket[def.kind].push(value.toLowerCase())
            }
          }
        }
      }
    } else {
      bucket.terms.push(token.toLowerCase())
    }
  }
  return out
}

// 解析结果按搜索串缓存（C1）：filteredItems 每拍失效（扫描期间约 200ms 一次）都会
// 重跑 tokenize + 正则，搜索串未变时直接复用；调用方只读桶内容，共享安全
const queryCache = new Map<string, ParsedQuery>()

export function cachedParseQuery(q: string): ParsedQuery {
  let parsed = queryCache.get(q)
  if (!parsed) {
    parsed = parseQuery(q)
    if (queryCache.size >= 32) queryCache.clear() // 简单防膨胀：历史搜索串快速淘汰
    queryCache.set(q, parsed)
  }
  return parsed
}

/** 搜索串 token 化（F5 chips）：保留原文与位置，供逐个移除条件后重组搜索串 */
export interface QueryToken {
  text: string
  start: number
  end: number
}

export function tokenizeQuery(raw: string): QueryToken[] {
  const out: QueryToken[] = []
  for (const m of raw.matchAll(/-?(?:[A-Za-z]+:)?"[^"]*"|\S+/g)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** 移除第 index 个 token（F5 chips）：按原文位置剪除并收敛多余空白 */
export function removeQueryToken(raw: string, index: number): string {
  const tokens = tokenizeQuery(raw)
  const t = tokens[index]
  if (!t) return raw
  const before = raw.slice(0, t.start)
  const after = raw.slice(t.end)
  return `${before}${after}`.replace(/\s{2,}/g, ' ').trim()
}
