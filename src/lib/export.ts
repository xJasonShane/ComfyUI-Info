/**
 * 将图片列表的解析结果导出为 JSON / CSV，用于数据集整理与批量分析。
 * CSV 带 UTF-8 BOM 并使用 CRLF 行尾，Excel 直接打开中文不乱码。
 */
import type { ImageItem, LoraInfo, SamplerInfo } from '../types'

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(cells: (string | number | undefined)[]): string {
  return cells.map((c) => (c === undefined || c === null ? '' : csvCell(String(c)))).join(',')
}

function formatLora(l: LoraInfo): string {
  const hash = l.hash ? ` #${l.hash}` : ''
  return `${l.name}(m:${l.strengthModel ?? '-'} c:${l.strengthClip ?? '-'}${hash})`
}

function formatStage(s: SamplerInfo): string {
  return [
    `#${s.nodeId} ${s.classType}`,
    s.steps != null ? `steps=${s.steps}` : '',
    s.cfg != null ? `cfg=${s.cfg}` : '',
    s.seed ? `seed=${s.seed}` : '',
    s.denoise != null ? `denoise=${s.denoise}` : '',
    s.sampler ? `sampler=${s.sampler}` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

export function buildExportJson(items: ImageItem[]): string {
  const records = items.map((it) => {
    const rec: Record<string, unknown> = {
      file: it.name,
      size: it.size,
      source: it.status === 'error' ? 'error' : it.source,
      mtime: new Date(it.mtime).toISOString(),
    }
    if (it.path) rec.path = it.path
    if (it.status === 'error') rec.error = it.error ?? '未知错误'
    const p = it.params
    if (p) {
      rec.positive = p.positive
      rec.negative = p.negative
      rec.models = p.models
      rec.loras = p.loras
      rec.samplers = p.samplers
      if (p.width !== undefined) rec.width = p.width
      if (p.height !== undefined) rec.height = p.height
      if (p.batch !== undefined) rec.batch = p.batch
      if (p.nodeCount) rec.nodeCount = p.nodeCount
    }
    return rec
  })
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), count: records.length, items: records },
    null,
    2,
  )
}

export function buildExportCsv(items: ImageItem[]): string {
  const header = [
    '文件名',
    '路径',
    '大小(字节)',
    '来源',
    '修改时间',
    '模型',
    'LoRA',
    '采样器',
    '调度器',
    '步数',
    'CFG',
    '种子',
    '重绘幅度',
    '宽',
    '高',
    '批量',
    '多阶段',
    '正向提示词',
    '负向提示词',
    '错误',
  ]
  const lines = items.map((it) => {
    const p = it.params
    const s = p?.samplers[0]
    const stages =
      p && p.samplers.length > 1 ? p.samplers.slice(1).map(formatStage).join(' || ') : undefined
    return csvRow([
      it.name,
      it.path,
      it.size,
      it.status === 'error' ? 'error' : it.source,
      new Date(it.mtime).toISOString(),
      p?.models.join(' + ') || undefined,
      p?.loras.map(formatLora).join('; ') || undefined,
      s?.sampler,
      s?.scheduler,
      s?.steps,
      s?.cfg,
      s?.seed,
      s?.denoise,
      p?.width,
      p?.height,
      p?.batch,
      stages,
      p?.positive.join('\n'),
      p?.negative.join('\n'),
      it.status === 'error' ? (it.error ?? '未知错误') : undefined,
    ])
  })
  return '\uFEFF' + [csvRow(header), ...lines].join('\r\n')
}
