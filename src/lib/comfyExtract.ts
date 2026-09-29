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
        sampler: asText(inputs.sampler_name) ?? undefined,
        scheduler: asText(inputs.scheduler) ?? undefined,
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

    if (
      typeof inputs.width === 'number' &&
      typeof inputs.height === 'number' &&
      /latent/i.test(cls) &&
      out.width === undefined
    ) {
      out.width = inputs.width
      out.height = inputs.height
      out.batch = asNum(inputs.batch_size)
    }
  }

  out.samplers.sort((a, b) => (Number(a.nodeId) || 0) - (Number(b.nodeId) || 0))
  return out
}
