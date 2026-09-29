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
