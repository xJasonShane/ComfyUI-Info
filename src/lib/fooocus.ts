/**
 * Fooocus 元数据解析（FEAT-4 首个新格式）：
 * Fooocus 在 PNG `parameters` 中写入 JSON（`fooocus_scheme=fooocus`），
 * 旧版 v2.1 使用 Title Case 键，v2.3+ 使用 snake_case 键；两套键都在此兼容。
 * 另支持从纯文本 / EXIF UserComment 中识别 JSON 内容。
 */
import type { LoraInfo, ParsedParams } from '../types'
import { parseJsonPreservingBigInts } from './jsonBigInt'

type Json = Record<string, unknown>

const PERFORMANCE_STEPS: Record<string, number> = {
  quality: 60,
  speed: 30,
  'extreme speed': 8,
  lightning: 4,
  'hyper-sd': 4,
}

function pick(obj: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

/** Resolution 是 Python tuple 字符串，如 "(1024, 1024)" 或 "[1024, 1024]" */
function parseResolution(value: unknown): { width: number; height: number } | undefined {
  const text = asText(value)
  if (!text) return undefined
  const nums = text.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return undefined
  const width = Number(nums[0])
  const height = Number(nums[1])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : undefined
}

/** 单个 LoRA 值：对象 {name, weight}、数组 [name, weight] 或 "name : weight" */
function parseLora(value: unknown): LoraInfo | null {
  if (typeof value === 'string') {
    const parts = value.split(' : ')
    const name = parts[0]?.trim()
    if (!name || name === 'None') return null
    const weight = parts.length > 1 ? Number(parts[1]) : undefined
    return {
      name,
      strengthModel: Number.isFinite(weight) ? (weight as number) : undefined,
      strengthClip: Number.isFinite(weight) ? (weight as number) : undefined,
    }
  }
  if (Array.isArray(value)) {
    const name = asText(value[0])
    const weight = asNumber(value[1])
    return name ? { name, strengthModel: weight, strengthClip: weight } : null
  }
  if (value && typeof value === 'object') {
    const obj = value as Json
    const name = asText(obj.name) ?? asText(obj.lora_name)
    if (!name) return null
    const weight = asNumber(obj.weight) ?? asNumber(obj.strength)
    return {
      name,
      strengthModel: weight,
      strengthClip: weight,
      ...(asText(obj.hash) ? { hash: asText(obj.hash) } : {}),
    }
  }
  return null
}

function collectLoras(obj: Json): LoraInfo[] {
  const out: LoraInfo[] = []
  const seen = new Set<string>()
  const push = (lora: LoraInfo | null) => {
    if (!lora || seen.has(lora.name)) return
    seen.add(lora.name)
    out.push(lora)
  }
  const modern = pick(obj, 'loras')
  if (Array.isArray(modern)) modern.forEach((value) => push(parseLora(value)))
  for (let i = 1; i <= 6; i++) push(parseLora(pick(obj, `lora_combined_${i}`, `LoRA ${i}`)))
  return out
}

function isFooocusJson(obj: Json): boolean {
  const hasPrompt = asText(pick(obj, 'prompt', 'Prompt')) !== undefined
  const hasNegative = asText(pick(obj, 'negative_prompt', 'Negative Prompt')) !== undefined
  const hasModel = asText(pick(obj, 'base_model', 'Base Model')) !== undefined
  const hasPerf = asText(pick(obj, 'performance', 'Performance')) !== undefined
  const hasSampler = asText(pick(obj, 'sampler', 'Sampler')) !== undefined
  const hasCfg = asNumber(pick(obj, 'guidance_scale', 'Guidance Scale')) !== undefined
  const hasSteps = asNumber(pick(obj, 'steps', 'Steps')) !== undefined
  // 仅「Prompt + Fooocus 特色键」同时存在才判定，避免普通 JSON 被误认
  return hasPrompt && (hasNegative || hasModel || hasPerf || hasSampler || hasCfg || hasSteps)
}

/** 文本内容是否像 Fooocus JSON（用于 PNG / EXIF / 文本文件的来源判定） */
export function looksLikeFooocusJson(text: string): boolean {
  const obj = parseJsonPreservingBigInts(text)
  return !!obj && isFooocusJson(obj)
}

export function parseFooocusParameters(text: string): ParsedParams | null {
  const obj = parseJsonPreservingBigInts(text)
  if (!obj || !isFooocusJson(obj)) return null

  const positive = asText(pick(obj, 'prompt', 'Prompt'))
  const negative = asText(pick(obj, 'negative_prompt', 'Negative Prompt'))
  const baseModel = asText(pick(obj, 'base_model', 'Base Model'))
  const refiner = asText(pick(obj, 'refiner_model', 'Refiner Model'))
  const modelHash = asText(pick(obj, 'base_model_hash'))
  const resolution = parseResolution(pick(obj, 'resolution', 'Resolution'))
  const performance = asText(pick(obj, 'performance', 'Performance'))
  const steps =
    asNumber(pick(obj, 'steps', 'Steps')) ??
    (performance ? PERFORMANCE_STEPS[performance.toLowerCase()] : undefined)
  const cfg = asNumber(pick(obj, 'guidance_scale', 'Guidance Scale', 'adaptive_cfg'))
  const sampler = asText(pick(obj, 'sampler', 'Sampler'))
  const scheduler = asText(pick(obj, 'scheduler', 'Scheduler'))
  const seedRaw = pick(obj, 'seed', 'Seed')
  const seed =
    typeof seedRaw === 'number' && Number.isFinite(seedRaw)
      ? String(seedRaw)
      : typeof seedRaw === 'string' && seedRaw.trim() !== ''
        ? seedRaw.trim()
        : undefined
  const clipSkip = asNumber(pick(obj, 'clip_skip', 'Clip Skip', 'CLIP Skip'))
  const vae = asText(pick(obj, 'vae', 'VAE'))

  const out: ParsedParams = {
    positive: positive ? [positive] : [],
    negative: negative ? [negative] : [],
    models: [],
    loras: collectLoras(obj),
    samplers: [],
    vaes: [],
    upscalers: [],
    controlNets: [],
    nodeCount: 0,
  }
  if (baseModel) out.models.push(baseModel)
  if (refiner && !/^(none|default)$/i.test(refiner) && !out.models.includes(refiner)) {
    out.models.push(refiner)
  }
  if (modelHash) out.modelHash = modelHash
  if (steps !== undefined || cfg !== undefined || sampler || scheduler || seed) {
    out.samplers.push({
      nodeId: '0',
      classType: 'Fooocus',
      steps,
      cfg,
      sampler,
      scheduler,
      seed,
    })
  }
  if (resolution) {
    out.width = resolution.width
    out.height = resolution.height
  }
  if (clipSkip !== undefined && clipSkip >= 2) out.clipSkip = clipSkip
  if (vae && !/^(default|none)$/i.test(vae)) out.vaes.push(vae)

  const hasAny =
    out.positive.length > 0 ||
    out.negative.length > 0 ||
    out.models.length > 0 ||
    out.loras.length > 0 ||
    out.samplers.length > 0
  return hasAny ? out : null
}
