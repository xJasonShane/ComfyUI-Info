/**
 * A1111 / WebUI "parameters" 文本解析（顺手支持，便于区分图片来源）。
 * 格式：正向提示词（多行）+ "Negative prompt: ..." + 末尾 "Key: value" 参数行。
 */
import type { ParsedParams } from '../types'

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

  const pairs: Record<string, string> = {}
  for (const part of tailText.split(/,\s*(?=[A-Za-z][A-Za-z0-9 _]*:)/)) {
    const m = part.match(/^([^:]+):\s*([\s\S]*)$/)
    if (m) pairs[m[1].trim()] = m[2].trim()
  }

  const steps = Number(pairs['Steps'])
  const cfg = Number(pairs['CFG scale'])
  const seed = Number(pairs['Seed'])
  const denoise = Number(pairs['Denoising strength'])
  if (pairs['Steps'] !== undefined || pairs['Sampler'] !== undefined) {
    out.samplers.push({
      nodeId: '0',
      classType: 'A1111',
      steps: Number.isFinite(steps) ? steps : undefined,
      cfg: Number.isFinite(cfg) ? cfg : undefined,
      sampler: pairs['Sampler'] || undefined,
      scheduler: pairs['Schedule type'] || undefined,
      seed: Number.isFinite(seed) ? String(seed) : undefined,
      denoise: Number.isFinite(denoise) ? denoise : undefined,
    })
  }

  const size = pairs['Size']?.match(/(\d+)\s*[x×]\s*(\d+)/)
  if (size) {
    out.width = Number(size[1])
    out.height = Number(size[2])
  }
  if (pairs['Model']) out.models.push(pairs['Model'])

  return out
}
