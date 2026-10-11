/**
 * 从 ComfyUI API 格式工作流 JSON（prompt）中提取人类可读的生成参数。
 * 不依赖固定节点名：按 class_type 匹配 + 输入槽启发式双重识别，兼容自定义节点。
 */
import type { LoraInfo, ParsedParams, SamplerInfo } from '../types'

type NodeInputs = Record<string, unknown>

interface ComfyNode {
  class_type: string
  inputs: NodeInputs
  _meta?: { title?: string }
}

type WorkflowMap = Record<string, ComfyNode>

/** latent 链上收集到的出图信息：宽高与批量可能来自链上不同的节点（如 EmptyLatent → Upscale） */
interface LatentInfo {
  width?: number
  height?: number
  batch?: number
}

function isLink(v: unknown): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    (typeof v[0] === 'string' || typeof v[0] === 'number') &&
    typeof v[1] === 'number'
  )
}

function asText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 2^53 ≈ 9.007e15（16 位起）以上的整数 JSON.parse 会丢精度，统一替换成字符串保原样 */
const UNSAFE_INT_MIN_DIGITS = 16

/**
 * 把 JSON 文本里所有 ≥2^53 的裸整数替换成等值字符串，避免 JSON.parse 丢精度
 * （ComfyUI 的 seed 是 64 位随机数）。逐字符扫描而非正则替换：大整数不一定紧跟在
 * 已知键后——UI 格式 widgets_values 数组的第 N 位（KSamplerAdvanced 以 add_noise
 * 开头）、PrimitiveINT 之类节点的自定义键都可能是 seed；字符串字面量内部原样跳过
 * （提示词可能含长数字串），小数 / 科学计数法的尾段不得当成独立整数改写。
 */
function quoteUnsafeBigInts(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (ch === '"') {
      // 字符串字面量（含转义）原样复制
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') j += 2
        else if (text[j] === '"') {
          j++
          break
        } else j++
      }
      out += text.slice(i, j)
      i = j
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < n && text[j]! >= '0' && text[j]! <= '9') j++
      const digits = text.slice(i, j)
      const prev = out.charAt(out.length - 1)
      const next = j < n ? text[j]! : ''
      // 前邻小数点 / 指数符或后接小数点 / 指数符：是小数或科学计数法的片段，不是独立整数
      const standalone =
        prev !== '.' && prev !== 'e' && prev !== 'E' && next !== '.' && next !== 'e' && next !== 'E'
      if (digits.length >= UNSAFE_INT_MIN_DIGITS && standalone) {
        // 负号留在引号外会产生非法 JSON：一并移进引号（seed 恒为非负，防御性处理）
        if (prev === '-') out = `${out.slice(0, -1)}"-${digits}"`
        else out += `"${digits}"`
      } else {
        out += digits
      }
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

function parseWorkflow(text: string): WorkflowMap | null {
  const safe = quoteUnsafeBigInts(text)
  try {
    const obj: unknown = JSON.parse(safe)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    return obj as WorkflowMap
  } catch {
    return null
  }
}

export function extractComfyParams(promptText: string): ParsedParams | null {
  const map = parseWorkflow(promptText)
  if (!map) return null

  const out: ParsedParams = {
    positive: [],
    negative: [],
    models: [],
    loras: [],
    samplers: [],
    vaes: [],
    upscalers: [],
    controlNets: [],
    nodeCount: Object.keys(map).length,
  }

  // 沿连线向上找文本输入（CLIPTextEncode 及各种提示词组合节点）。
  // 回溯结果以「节点 × depth」为键记忆化（depth 上限 8，每节点至多 9 键）：
  // 菱形拓扑与多阶段采样器共享上游时不再重复展开同一子图；同键输入不变，结果确定性相同
  const textMemo = new Map<string, string | null>()
  const resolveNodeText = (id: unknown, depth = 0): string | null => {
    const key = String(id)
    const node = map[key]
    if (!node || depth > 8) return null
    const memoKey = `${key}@${depth}`
    if (textMemo.has(memoKey)) return textMemo.get(memoKey)!
    // 字符串原语节点（PrimitiveString / PrimitiveStringMultiline 等）把文本存在 `string` 输入槽
    const direct = asText(node.inputs?.text) ?? asText(node.inputs?.string)
    if (direct) {
      textMemo.set(memoKey, direct)
      return direct
    }
    for (const v of Object.values(node.inputs || {})) {
      if (isLink(v)) {
        const found = resolveNodeText(v[0], depth + 1)
        if (found) {
          textMemo.set(memoKey, found)
          return found
        }
      }
    }
    textMemo.set(memoKey, null)
    return null
  }

  // 沿连线向上找选择值：KSamplerSelect / SchedulerSelect 等选择节点把 sampler_name /
  // scheduler 以连线传入采样器，采样器输入槽里只能读到 link 数组。
  // 记忆化键需带上 slots——同一节点会分别以 sampler_name / scheduler 槽位查询
  const choiceMemo = new Map<string, string | null>()
  const resolveNodeChoice = (id: unknown, slots: string[], depth = 0): string | null => {
    const key = String(id)
    const node = map[key]
    if (!node || depth > 8) return null
    const memoKey = `${key}@${depth}@${slots.join('|')}`
    if (choiceMemo.has(memoKey)) return choiceMemo.get(memoKey)!
    const inputs = (node.inputs || {}) as NodeInputs
    for (const slot of slots) {
      const direct = asText(inputs[slot])
      if (direct) {
        choiceMemo.set(memoKey, direct)
        return direct
      }
    }
    for (const v of Object.values(inputs)) {
      if (isLink(v)) {
        const found = resolveNodeChoice(v[0], slots, depth + 1)
        if (found) {
          choiceMemo.set(memoKey, found)
          return found
        }
      }
    }
    choiceMemo.set(memoKey, null)
    return null
  }

  // 沿 latent 链向上找出图信息：宽高取链上最近显式声明的节点（最终输出由末端缩放节点决定），
  // batch_size 独立就近补齐（LatentUpscale 等节点不声明批量，批量保留自上游 EmptyLatentImage）。
  // 回溯结果同样以「节点 × depth」记忆化，返回对象只读共享
  const latentMemo = new Map<string, LatentInfo | null>()
  const resolveLatent = (id: unknown, depth = 0): LatentInfo | null => {
    const key = String(id)
    const node = map[key]
    if (!node || depth > 8) return null
    const memoKey = `${key}@${depth}`
    if (latentMemo.has(memoKey)) return latentMemo.get(memoKey)!
    const inputs = (node.inputs || {}) as NodeInputs
    const info: LatentInfo = {}
    const w = asNum(inputs.width)
    const h = asNum(inputs.height)
    if (w !== undefined && h !== undefined) {
      info.width = w
      info.height = h
    }
    const batch = asNum(inputs.batch_size)
    if (batch !== undefined) info.batch = batch
    if (info.width !== undefined && info.batch !== undefined) {
      latentMemo.set(memoKey, info)
      return info
    }
    for (const v of Object.values(inputs)) {
      if (!isLink(v)) continue
      const up = resolveLatent(v[0], depth + 1)
      if (!up) continue
      if (info.width === undefined && up.width !== undefined) {
        info.width = up.width
        info.height = up.height
      }
      if (info.batch === undefined && up.batch !== undefined) info.batch = up.batch
      if (info.width !== undefined && info.batch !== undefined) {
        latentMemo.set(memoKey, info)
        return info
      }
    }
    const result = info.width !== undefined || info.batch !== undefined ? info : null
    latentMemo.set(memoKey, result)
    return result
  }

  for (const [id, node] of Object.entries(map)) {
    const inputs = (node.inputs || {}) as NodeInputs
    const cls = node.class_type || ''

    const looksSampler =
      /KSampler|Sampler/i.test(cls) ||
      (typeof inputs.steps === 'number' && typeof inputs.cfg === 'number')
    if (looksSampler) {
      const s: SamplerInfo = {
        nodeId: id,
        classType: cls,
        steps: asNum(inputs.steps),
        cfg: asNum(inputs.cfg),
        sampler:
          asText(inputs.sampler_name) ??
          (isLink(inputs.sampler_name)
            ? resolveNodeChoice(inputs.sampler_name[0], ['sampler_name'])
            : undefined) ??
          (isLink(inputs.sampler)
            ? resolveNodeChoice(inputs.sampler[0], ['sampler_name'])
            : undefined) ??
          undefined,
        scheduler:
          asText(inputs.scheduler) ??
          (isLink(inputs.scheduler)
            ? resolveNodeChoice(inputs.scheduler[0], ['scheduler'])
            : undefined) ??
          undefined,
        seed:
          asText(inputs.seed) ??
          asText(inputs.noise_seed) ??
          (asNum(inputs.seed) !== undefined
            ? String(inputs.seed)
            : asNum(inputs.noise_seed) !== undefined
              ? String(inputs.noise_seed)
              : undefined),
        denoise: asNum(inputs.denoise),
      }
      out.samplers.push(s)

      const pos = isLink(inputs.positive)
        ? resolveNodeText(inputs.positive[0])
        : asText(inputs.positive)
      const neg = isLink(inputs.negative)
        ? resolveNodeText(inputs.negative[0])
        : asText(inputs.negative)
      if (pos && !out.positive.includes(pos)) out.positive.push(pos)
      if (neg && !out.negative.includes(neg)) out.negative.push(neg)
    }

    const model = asText(inputs.ckpt_name) ?? asText(inputs.unet_name)
    if (model && !out.models.includes(model)) out.models.push(model)

    const loraName = asText(inputs.lora_name)
    if (loraName) {
      const lora: LoraInfo = {
        name: loraName,
        strengthModel: asNum(inputs.strength_model),
        strengthClip: asNum(inputs.strength_clip),
      }
      if (!out.loras.some((l) => l.name === lora.name)) out.loras.push(lora)
    }

    // FEAT-2 扩展参数：按 class_type 匹配的辅助模型 / 设置，同名去重
    if (/CLIPSetLastLayer/i.test(cls)) {
      const stop = asNum(inputs.stop_at_clip_layer)
      // stop_at_clip_layer 为负：-1 = 跳过最后 1 层（即 A1111 语境的 Clip Skip 2）
      if (stop !== undefined && stop < 0) out.clipSkip = 1 - stop
    }
    if (/VAELoader/i.test(cls)) {
      const v = asText(inputs.vae_name)
      if (v && !out.vaes.includes(v)) out.vaes.push(v)
    }
    if (/UpscaleModelLoader/i.test(cls)) {
      const v = asText(inputs.model_name)
      if (v && !out.upscalers.includes(v)) out.upscalers.push(v)
    }
    if (/ControlNetLoader/i.test(cls)) {
      const v = asText(inputs.control_net_name)
      if (v && !out.controlNets.includes(v)) out.controlNets.push(v)
    }
  }

  out.samplers.sort((a, b) => (Number(a.nodeId) || 0) - (Number(b.nodeId) || 0))

  // 出图尺寸：从最后一个采样器的 latent_image 沿链向上回溯（主采样器之后不再有改变尺寸的节点），
  // 从后往前逐个采样器尝试以兼容分支图；链上找不到显式宽高（如 img2img）时保持未定义
  for (let i = out.samplers.length - 1; i >= 0 && out.width === undefined; i--) {
    const node = map[out.samplers[i].nodeId]
    const latent = ((node?.inputs ?? {}) as NodeInputs).latent_image
    if (!isLink(latent)) continue
    const info = resolveLatent(latent[0])
    if (info?.width !== undefined && info.height !== undefined) {
      out.width = info.width
      out.height = info.height
      out.batch = info.batch
    }
  }
  return out
}

/* ---------- UI 格式工作流兜底提取（O2：仅有 workflow、未内嵌 API prompt 的场景） ---------- */

interface UiNode {
  id: number
  type: string
  /** 4 = bypass（旁路），不参与参数提取 */
  mode?: number
  inputs?: { name?: string; link?: number | null }[]
  widgets_values?: unknown[]
}

interface UiWorkflow {
  nodes?: UiNode[]
  /** [linkId, 源节点 id, 源槽位, 目标节点 id, 目标槽位, 类型] */
  links?: number[][]
}

const CONTROL_WORDS = new Set(['fixed', 'randomize', 'increment', 'decrement'])

/**
 * widgets_values → 采样参数。UI 格式里部件值按控件顺序排列，无字段名可依，
 * 按 KSampler / KSamplerAdvanced 的已知布局 + 逐项校验解析：
 * [seed, control_after_generate, steps, cfg, sampler, scheduler, denoise]
 * （KSamplerAdvanced 以 add_noise 的 enable/disable 开头，seed 实为 noise_seed）。
 */
function samplerFromWidgets(wv: unknown[]): Omit<SamplerInfo, 'nodeId' | 'classType'> | null {
  let i = 0
  if (wv[0] === 'enable' || wv[0] === 'disable') i = 1
  let seed: string | undefined
  const rawSeed = wv[i]
  if (typeof rawSeed === 'number' && Number.isFinite(rawSeed)) {
    seed = String(rawSeed)
    i++
  } else if (typeof rawSeed === 'string' && /^\d+$/.test(rawSeed)) {
    seed = rawSeed // 大整数 seed 已在解析前转为字符串保精度
    i++
  }
  if (typeof wv[i] === 'string' && CONTROL_WORDS.has(wv[i] as string)) i++
  const steps = asNum(wv[i])
  if (steps !== undefined) i++
  const cfg = asNum(wv[i])
  if (cfg !== undefined) i++
  const sampler = asText(wv[i]) ?? undefined
  if (sampler !== undefined) i++
  const scheduler = asText(wv[i]) ?? undefined
  if (scheduler !== undefined) i++
  const denoise = asNum(wv[i])
  if (steps === undefined && cfg === undefined && !sampler) return null
  return { steps, cfg, sampler, scheduler, seed, denoise }
}

/**
 * 从 UI 格式工作流（nodes + links + widgets_values）提取结构化参数。
 * 不依赖固定节点名：class_type 正则匹配 + widgets_values 位置校验，覆盖常见
 * 官方节点（Checkpoint / KSampler 族 / LoraLoader / EmptyLatent / CLIPTextEncode）；
 * 正负向提示词沿 links 回溯到文本节点。提取不到任何参数时返回 null。
 */
export function extractUiWorkflowParams(text: string): ParsedParams | null {
  // widgets_values 里的 64 位大整数 seed 统一转字符串保精度（seed 不一定在数组首位，
  // KSamplerAdvanced 以 add_noise 开头——与 parseWorkflow 共用同一扫描器）
  const safe = quoteUnsafeBigInts(text)
  let data: UiWorkflow
  try {
    const obj: unknown = JSON.parse(safe)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    data = obj as UiWorkflow
  } catch {
    return null
  }
  const nodes = Array.isArray(data.nodes) ? data.nodes : null
  if (!nodes?.length) return null

  const out: ParsedParams = {
    positive: [],
    negative: [],
    models: [],
    loras: [],
    samplers: [],
    vaes: [],
    upscalers: [],
    controlNets: [],
    nodeCount: nodes.length,
  }

  const linkSource = new Map<number, number>()
  for (const l of data.links ?? []) {
    if (Array.isArray(l) && l.length >= 3 && typeof l[0] === 'number') {
      linkSource.set(l[0], l[1] as number)
    }
  }
  // 文本节点（widgets_values[0] 为字符串）登记，供采样器经连线回溯正 / 负向提示词
  const textByNode = new Map<number, string>()
  const drafts: { node: UiNode; info: SamplerInfo }[] = []

  for (const node of nodes) {
    const cls = String(node.type ?? '')
    const wv = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const bypassed = node.mode === 4

    if (typeof wv[0] === 'string' && wv[0].trim() !== '' && !CONTROL_WORDS.has(wv[0])) {
      textByNode.set(node.id, wv[0])
    }

    if (!bypassed && /KSampler|Sampler/i.test(cls)) {
      const fields = samplerFromWidgets(wv)
      if (fields)
        drafts.push({ node, info: { nodeId: String(node.id), classType: cls, ...fields } })
    }

    if (bypassed) continue
    const firstText = asText(wv[0])
    if (/CheckpointLoader|UNETLoader/i.test(cls) && firstText && !out.models.includes(firstText)) {
      out.models.push(firstText)
    }
    if (/LoraLoader/i.test(cls) && firstText) {
      const lora: LoraInfo = {
        name: firstText,
        strengthModel: asNum(wv[1]),
        // ModelOnly 变体没有文本强度
        strengthClip: /ModelOnly/i.test(cls) ? undefined : asNum(wv[2]),
      }
      if (!out.loras.some((l) => l.name === lora.name)) out.loras.push(lora)
    }
    if (/EmptyLatentImage|EmptySD3LatentImage|EmptyHunyuanLatentVideo/i.test(cls)) {
      const w = asNum(wv[0])
      const h = asNum(wv[1])
      if (w !== undefined && h !== undefined) {
        out.width = w
        out.height = h
      }
      const b = asNum(wv[2])
      if (b !== undefined) out.batch = b
    }
    // FEAT-2 扩展参数：UI 格式 widgets_values[0] 即对应值，同名去重
    if (/CLIPSetLastLayer/i.test(cls)) {
      const stop = asNum(wv[0])
      // stop_at_clip_layer 为负：-1 = 跳过最后 1 层（即 A1111 语境的 Clip Skip 2）
      if (stop !== undefined && stop < 0) out.clipSkip = 1 - stop
    }
    if (/VAELoader/i.test(cls) && firstText && !out.vaes.includes(firstText))
      out.vaes.push(firstText)
    if (/UpscaleModelLoader/i.test(cls) && firstText && !out.upscalers.includes(firstText)) {
      out.upscalers.push(firstText)
    }
    if (/ControlNetLoader/i.test(cls) && firstText && !out.controlNets.includes(firstText)) {
      out.controlNets.push(firstText)
    }
  }

  const resolveText = (linkId: unknown): string | null => {
    if (typeof linkId !== 'number') return null
    const src = linkSource.get(linkId)
    return (src !== undefined ? textByNode.get(src) : undefined) ?? null
  }
  for (const { node, info } of drafts) {
    for (const inp of node.inputs ?? []) {
      if (inp.name !== 'positive' && inp.name !== 'negative') continue
      const t = resolveText(inp.link)
      if (!t) continue
      const slot = inp.name === 'positive' ? out.positive : out.negative
      if (!slot.includes(t)) slot.push(t)
    }
    out.samplers.push(info)
  }
  out.samplers.sort((a, b) => (Number(a.nodeId) || 0) - (Number(b.nodeId) || 0))

  const hasAny =
    out.positive.length > 0 ||
    out.negative.length > 0 ||
    out.samplers.length > 0 ||
    out.models.length > 0 ||
    out.loras.length > 0
  return hasAny ? out : null
}
