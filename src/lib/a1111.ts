/**
 * A1111 / WebUI "parameters" 文本解析（顺手支持，便于区分图片来源）。
 * 格式：正向提示词（多行）+ "Negative prompt: ..." + 末尾 "Key: value" 参数行。
 * 额外识别 <lora:…>/<lyco:…> 标签、Lora hashes 行与高清修复（Hires fix）二阶段。
 */
import type { LoraInfo, ParsedParams } from '../types'

/** 提示词中的网络标签：<lora:name:0.8>、<lora:name:0.8:1.2>、<lyco:…> */
const LORA_TAG = /<(lora|lyco):([^<>]+)>/gi

/**
 * 标签内容 → LoRA 信息。A1111 的 <lora:name:0.8> 把模型/文本强度设为同值，
 * <lora:name:0.8:1.2> 分别指定；末尾至多两个数字段是强度，其余整体作为名称（名称可能含冒号）。
 */
function parseLoraTag(content: string): LoraInfo | null {
  const parts = content.split(':')
  const strengths: number[] = []
  while (parts.length > 1 && strengths.length < 2) {
    const last = parts[parts.length - 1].trim()
    if (last === '' || !Number.isFinite(Number(last))) break
    strengths.unshift(Number(last))
    parts.pop()
  }
  const name = parts.join(':').trim()
  if (!name) return null
  if (strengths.length === 0) return { name }
  if (strengths.length === 1)
    return { name, strengthModel: strengths[0], strengthClip: strengths[0] }
  return { name, strengthModel: strengths[0], strengthClip: strengths[1] }
}

function collectLoraTags(text: string, seen: Set<string>, out: LoraInfo[]) {
  for (const m of text.matchAll(LORA_TAG)) {
    const lora = parseLoraTag(m[2])
    if (lora && !seen.has(lora.name)) {
      seen.add(lora.name)
      out.push(lora)
    }
  }
}

export function parseA1111Parameters(text: string): ParsedParams {
  const out: ParsedParams = {
    positive: [],
    negative: [],
    models: [],
    loras: [],
    samplers: [],
    nodeCount: 0,
    rawText: text,
  }

  const lines = text.split('\n')
  const tailStart = lines.findIndex((l) => /^Steps:\s*\d/.test(l.trim()))
  const headLines = tailStart >= 0 ? lines.slice(0, tailStart) : lines
  const tailText = tailStart >= 0 ? lines.slice(tailStart).join(' ') : ''

  const negIndex = headLines.findIndex((l) => /^Negative prompt:/i.test(l.trim()))
  let positive: string
  let negative = ''
  if (negIndex >= 0) {
    positive = headLines.slice(0, negIndex).join('\n')
    negative = headLines
      .slice(negIndex)
      .join('\n')
      .replace(/^Negative prompt:\s*/i, '')
  } else {
    positive = headLines.join('\n')
  }

  out.positive = positive.trim() ? [positive.trim()] : []
  out.negative = negative.trim() ? [negative.trim()] : []

  // LoRA / LyCORIS 标签主要写在正向提示词里，负向偶尔也有
  const seenLora = new Set<string>()
  collectLoraTags(out.positive.join('\n'), seenLora, out.loras)
  collectLoraTags(out.negative.join('\n'), seenLora, out.loras)

  const pairs: Record<string, string> = {}
  // Lora hashes 的值内部含逗号/冒号，先摘出单独解析，避免破坏通用参数切分
  const hashesMatch = tailText.match(/\bLora hashes:\s*"([^"]*)"/)
  const tailForPairs = hashesMatch ? tailText.replace(hashesMatch[0], 'Lora hashes:') : tailText
  for (const part of tailForPairs.split(/,\s*(?=[A-Za-z][A-Za-z0-9 _]*:)/)) {
    const m = part.match(/^([^:]+):\s*([\s\S]*)$/)
    if (m) pairs[m[1].trim()] = m[2].trim()
  }
  if (hashesMatch) {
    for (const seg of hashesMatch[1].split(',')) {
      const i = seg.indexOf(':')
      if (i <= 0) continue
      const name = seg.slice(0, i).trim()
      const hash = seg.slice(i + 1).trim()
      const lora = out.loras.find((l) => l.name === name)
      if (lora && hash) lora.hash = hash
    }
  }

  const steps = Number(pairs['Steps'])
  const cfg = Number(pairs['CFG scale'])
  const seed = Number(pairs['Seed'])
  const denoise = Number(pairs['Denoising strength'])
  if (pairs['Steps'] !== undefined || pairs['Sampler'] !== undefined) {
    // 出现 Hires* 键说明启用了高清修复：第二阶段按 img2img 重绘，未单独提供的参数继承一阶段
    const hires =
      pairs['Hires upscale'] !== undefined ||
      pairs['Hires upscaler'] !== undefined ||
      pairs['Hires steps'] !== undefined ||
      pairs['Hires denoising strength'] !== undefined
    out.samplers.push({
      nodeId: '0',
      classType: 'A1111',
      steps: Number.isFinite(steps) ? steps : undefined,
      cfg: Number.isFinite(cfg) ? cfg : undefined,
      sampler: pairs['Sampler'] || undefined,
      scheduler: pairs['Schedule type'] || undefined,
      seed: Number.isFinite(seed) ? String(seed) : undefined,
      // Denoising strength 属于 img2img / 高清修复二阶段，txt2img 一阶段没有重绘幅度
      denoise: !hires && Number.isFinite(denoise) ? denoise : undefined,
    })

    if (hires) {
      const hSteps = Number(pairs['Hires steps'] ?? pairs['Steps'])
      const hCfg = Number(pairs['Hires cfg'] ?? pairs['CFG scale'])
      const hDenoise = Number(pairs['Hires denoising strength'])
      out.samplers.push({
        nodeId: 'hires',
        classType: 'Hires fix',
        steps: Number.isFinite(hSteps) ? hSteps : undefined,
        cfg: Number.isFinite(hCfg) ? hCfg : undefined,
        sampler: pairs['Hires sampler'] || pairs['Sampler'] || undefined,
        scheduler: undefined,
        seed: Number.isFinite(seed) ? String(seed) : undefined,
        denoise: Number.isFinite(hDenoise)
          ? hDenoise
          : Number.isFinite(denoise)
            ? denoise
            : undefined,
      })
    }
  }

  const size = pairs['Size']?.match(/(\d+)\s*[x×]\s*(\d+)/)
  if (size) {
    out.width = Number(size[1])
    out.height = Number(size[2])
  }
  if (pairs['Model']) out.models.push(pairs['Model'])

  return out
}
