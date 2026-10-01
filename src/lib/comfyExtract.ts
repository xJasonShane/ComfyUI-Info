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

/**
 * JSON.parse 会丢失超过 2^53 的整数精度（ComfyUI 的 seed 是 64 位随机数），
 * 解析前先把大整数 seed 替换成字符串，保证原样展示。
 */
function parseWorkflow(text: string): WorkflowMap | null {
  const safe = text.replace(/("(?:seed|noise_seed)"\s*:\s*)(\d{15,})/g, '$1"$2"')
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
    nodeCount: Object.keys(map).length,
  }

  // 沿连线向上找文本输入（CLIPTextEncode 及各种提示词组合节点）
  const resolveNodeText = (id: unknown, depth = 0): string | null => {
    const node = map[String(id)]
    if (!node || depth > 8) return null
    // 字符串原语节点（PrimitiveString / PrimitiveStringMultiline 等）把文本存在 `string` 输入槽
    const direct = asText(node.inputs?.text) ?? asText(node.inputs?.string)
    if (direct) return direct
    for (const v of Object.values(node.inputs || {})) {
      if (isLink(v)) {
        const found = resolveNodeText(v[0], depth + 1)
        if (found) return found
      }
    }
    return null
  }

  // 沿连线向上找选择值：KSamplerSelect / SchedulerSelect 等选择节点把 sampler_name /
  // scheduler 以连线传入采样器，采样器输入槽里只能读到 link 数组
  const resolveNodeChoice = (id: unknown, slots: string[], depth = 0): string | null => {
    const node = map[String(id)]
    if (!node || depth > 8) return null
    const inputs = (node.inputs || {}) as NodeInputs
    for (const slot of slots) {
      const direct = asText(inputs[slot])
      if (direct) return direct
    }
    for (const v of Object.values(inputs)) {
      if (isLink(v)) {
        const found = resolveNodeChoice(v[0], slots, depth + 1)
        if (found) return found
      }
    }
    return null
  }

  // 沿 latent 链向上找出图信息：宽高取链上最近显式声明的节点（最终输出由末端缩放节点决定），
  // batch_size 独立就近补齐（LatentUpscale 等节点不声明批量，批量保留自上游 EmptyLatentImage）
  const resolveLatent = (id: unknown, depth = 0): LatentInfo | null => {
    const node = map[String(id)]
    if (!node || depth > 8) return null
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
    if (info.width !== undefined && info.batch !== undefined) return info
    for (const v of Object.values(inputs)) {
      if (!isLink(v)) continue
      const up = resolveLatent(v[0], depth + 1)
      if (!up) continue
      if (info.width === undefined && up.width !== undefined) {
        info.width = up.width
        info.height = up.height
      }
      if (info.batch === undefined && up.batch !== undefined) info.batch = up.batch
      if (info.width !== undefined && info.batch !== undefined) return info
    }
    return info.width !== undefined || info.batch !== undefined ? info : null
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
  // widgets_values 里的 64 位大整数 seed 先转字符串，避免 JSON.parse 丢精度（与 parseWorkflow 同理）
  const safe = text.replace(/("(?:widgets_values)"\s*:\s*\[\s*)(\d{16,})/g, '$1"$2"')
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
      if (fields) drafts.push({ node, info: { nodeId: String(node.id), classType: cls, ...fields } })
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
