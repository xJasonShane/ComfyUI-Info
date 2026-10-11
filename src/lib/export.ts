/**
 * 将图片列表的解析结果导出为 JSON / CSV，用于数据集整理与批量分析。
 * CSV 带 UTF-8 BOM 并使用 CRLF 行尾，Excel 直接打开中文不乱码。
 */
import { computed } from 'vue'
import type { ImageItem, LoraInfo, ParsedParams, SamplerInfo } from '../types'
import { downloadBinary, downloadText } from './utils'
import { t } from '../locales'

/**
 * CSV 公式注入防护：以 = + - @ Tab 开头的文本单元格会被 Excel / WPS 当公式执行
 * （提示词等用户可控内容可借此构造恶意公式，而导出文件常被二次分享），
 * 按 OWASP 建议统一前置单引号使其按文本处理；数字列（含负数）不受影响。
 */
function csvCell(value: string | number): string {
  let v = String(value)
  if (typeof value !== 'number' && /^[=+\-@\t]/.test(v)) v = `'${v}`
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function csvRow(cells: (string | number | undefined)[]): string {
  return cells.map((c) => (c === undefined || c === null ? '' : csvCell(c))).join(',')
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
    if (it.status === 'error') rec.error = it.error ?? t('common.unknownError')
    const p = it.params
    if (p) {
      rec.positive = p.positive
      rec.negative = p.negative
      rec.models = p.models
      if (p.modelHash) rec.modelHash = p.modelHash
      rec.loras = p.loras
      rec.samplers = p.samplers
      if (p.vaes.length) rec.vaes = p.vaes
      if (p.clipSkip !== undefined) rec.clipSkip = p.clipSkip
      if (p.upscalers.length) rec.upscalers = p.upscalers
      if (p.controlNets.length) rec.controlNets = p.controlNets
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

/** naive-ui MessageApi 的最小结构：lib 层不依赖 UI 库类型 */
interface ExportMessage {
  warning: (content: string) => unknown
  success: (content: string) => unknown
}

/** 导出下拉选项（响应式，随界面语言切换重渲染）：顶栏「导出当前筛选」与批量条「导出选中」共用同一份 */
export const exportOptions = computed(() => [
  { label: t('export.json'), key: 'json' },
  { label: t('export.csv'), key: 'csv' },
  { label: t('export.zip'), key: 'zip' },
])

/**
 * 导出统一入口（原 TopBar / App 两份相同实现合并）：
 * 只导出已出结果的项（done / error），无可导出项时以消息告知而不是静默无反应；
 * 先等一拍让按钮 loading 渲染出来，再执行同步的打包计算（loading 开关由调用方管理）。
 */
export async function exportItems(
  candidates: ImageItem[],
  format: string | number,
  filenameBase: string,
  message: ExportMessage,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
  const items = candidates.filter((i) => i.status === 'done' || i.status === 'error')
  if (!items.length) {
    message.warning(t('msg.noExportable'))
    return
  }
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === 'csv')
    downloadText(`${filenameBase}-${stamp}.csv`, buildExportCsv(items), 'text/csv')
  else if (format === 'zip') {
    const zip = buildWorkflowZip(items)
    if (zip) downloadBinary(`${filenameBase}-workflows-${stamp}.zip`, zip)
  } else downloadText(`${filenameBase}-${stamp}.json`, buildExportJson(items))
  message.success(t('common.exportedItems', { n: items.length }))
}

export interface StatsSection {
  title: string
  rows: { name: string; count: number }[]
}

/** 统计频次导出（F5）：类别 / 名称 / 次数 三列，按传入区块顺序排列 */
export function buildStatsCsv(sections: StatsSection[]): string {
  const header = [t('csv.category'), t('csv.name'), t('csv.count')]
  const lines = sections.flatMap((sec) => sec.rows.map((r) => csvRow([sec.title, r.name, r.count])))
  return '\uFEFF' + [csvRow(header), ...lines].join('\r\n')
}

/** LoRA → A1111 标签：<lora:name>、<lora:name:0.8>（双强度相同）或 <lora:name:m:c> */
function loraTag(l: LoraInfo): string {
  const { strengthModel: m, strengthClip: c } = l
  if (m === undefined && c === undefined) return `<lora:${l.name}>`
  if (c === undefined || c === m) return `<lora:${l.name}:${m}>`
  return `<lora:${l.name}:${m ?? 1}:${c}>`
}

/**
 * A1111 风格参数摘要：正向（多行，附 LoRA 标签）+ Negative prompt 行 + 尾部键值对，
 * 可直接贴回 A1111 / WebUI 或留作记录。多阶段采样时首阶段为主参数，
 * 其余阶段以单行摘要附在末尾。
 */
export function buildParamsSummary(p: ParsedParams): string {
  const lines: string[] = []
  const positive = [...p.positive]
  if (p.loras.length) positive.push(p.loras.map(loraTag).join(', '))
  lines.push(positive.filter((s) => s.trim() !== '').join('\n'))
  if (p.negative.length) lines.push(`Negative prompt: ${p.negative.join('\n')}`)

  const s = p.samplers[0]
  const kv: string[] = []
  if (s?.steps !== undefined) kv.push(`Steps: ${s.steps}`)
  if (s?.sampler) kv.push(`Sampler: ${s.sampler}`)
  if (s?.scheduler) kv.push(`Schedule type: ${s.scheduler}`)
  if (s?.cfg !== undefined) kv.push(`CFG scale: ${s.cfg}`)
  if (s?.seed) kv.push(`Seed: ${s.seed}`)
  if (p.width !== undefined && p.height !== undefined) kv.push(`Size: ${p.width}x${p.height}`)
  if (p.batch !== undefined && p.batch > 1) kv.push(`Batch size: ${p.batch}`)
  if (p.models.length) kv.push(`Model: ${p.models.join(' + ')}`)
  if (p.modelHash) kv.push(`Model hash: ${p.modelHash}`)
  if (p.clipSkip !== undefined) kv.push(`Clip skip: ${p.clipSkip}`)
  if (p.vaes.length) kv.push(`VAE: ${p.vaes.join(' + ')}`)
  if (p.upscalers.length) kv.push(`Upscaler: ${p.upscalers.join(' + ')}`)
  if (p.controlNets.length) kv.push(`ControlNet: ${p.controlNets.join(' + ')}`)
  if (s?.denoise !== undefined) kv.push(`Denoising strength: ${s.denoise}`)
  if (kv.length) lines.push(kv.join(', '))

  for (const extra of p.samplers.slice(1)) {
    const parts = [
      extra.steps !== undefined ? `steps=${extra.steps}` : '',
      extra.cfg !== undefined ? `cfg=${extra.cfg}` : '',
      extra.seed ? `seed=${extra.seed}` : '',
      extra.denoise !== undefined ? `denoise=${extra.denoise}` : '',
      extra.sampler ? `sampler=${extra.sampler}` : '',
    ].filter(Boolean)
    lines.push(
      `Stage #${extra.nodeId} ${extra.classType}${parts.length ? `: ${parts.join(', ')}` : ''}`,
    )
  }
  return lines.filter((l) => l !== '').join('\n')
}

export function buildExportCsv(items: ImageItem[]): string {
  const header = [
    t('csv.name'),
    t('csv.path'),
    t('csv.size'),
    t('csv.source'),
    t('csv.mtime'),
    t('csv.models'),
    t('csv.modelHash'),
    t('csv.loras'),
    t('csv.clipSkip'),
    t('csv.vae'),
    t('csv.upscalers'),
    t('csv.controlnets'),
    t('csv.sampler'),
    t('csv.scheduler'),
    t('csv.steps'),
    t('csv.cfg'),
    t('csv.seed'),
    t('csv.denoise'),
    t('csv.width'),
    t('csv.height'),
    t('csv.batch'),
    t('csv.stages'),
    t('csv.positive'),
    t('csv.negative'),
    t('csv.error'),
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
      p?.modelHash,
      p?.loras.map(formatLora).join('; ') || undefined,
      p?.clipSkip,
      p?.vaes.join(' + ') || undefined,
      p?.upscalers.join(' + ') || undefined,
      p?.controlNets.join(' + ') || undefined,
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
      it.status === 'error' ? (it.error ?? t('common.unknownError')) : undefined,
    ])
  })
  return '\uFEFF' + [csvRow(header), ...lines].join('\r\n')
}

/* ---------- 工作流打包（无依赖 ZIP：store 模式不压缩，UTF-8 文件名） ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

interface ZipEntry {
  name: string
  data: Uint8Array
}

function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(new Date())
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // 文件名为 UTF-8
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, entry.data.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    localParts.push(local, entry.data)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true) // UTF-8 名字
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, entry.data.length, true)
    cv.setUint32(24, entry.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true) // local header 偏移
    central.set(name, 46)
    centralParts.push(central)
    offset += local.length + entry.data.length
  }
  const centralSize = centralParts.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  // Blob 分片组装：数据由浏览器按分片持有，免去最终一次性等大拷贝
  // （万级工作流导出的内存峰值近似减半，后续写入下载也不再多复制一份）
  return new Blob([...localParts, ...centralParts, eocd] as BlobPart[], {
    type: 'application/zip',
  })
}

/**
 * 把选中 / 筛选结果的工作流打包为 ZIP：
 * 每张图按相对路径展开 prompt.json / workflow.json（A1111 项为 parameters.txt），
 * 附 manifest.json（与 JSON 导出同构）。条目名为空时返回 null。
 * 路径即去重键，天然无重名；Windows 非法字符统一替换为下划线。
 */
export function buildWorkflowZip(items: ImageItem[]): Blob | null {
  if (!items.length) return null
  const encoder = new TextEncoder()
  // 同内容只编码一次：同工作流批量出图的 prompt / workflow JSON 内容逐条重复，
  // 按内容缓存编码结果，万级列表导出不再为每条重复编码整份 JSON
  const encodeCache = new Map<string, Uint8Array>()
  const encode = (s: string): Uint8Array => {
    let bytes = encodeCache.get(s)
    if (!bytes) {
      bytes = encoder.encode(s)
      encodeCache.set(s, bytes)
    }
    return bytes
  }
  const entries: ZipEntry[] = []
  const safe = (s: string) => s.replace(/[:*?"<>|\\]/g, '_')
  for (const it of items) {
    const stem = safe((it.path ?? it.name).replace(/\.[^./\\]+$/, ''))
    if (it.raw.prompt) {
      entries.push({ name: `${stem}.prompt.json`, data: encode(it.raw.prompt) })
    }
    if (it.raw.workflow) {
      entries.push({ name: `${stem}.workflow.json`, data: encode(it.raw.workflow) })
    }
    if (it.source === 'a1111' && it.raw.parameters) {
      entries.push({ name: `${stem}.parameters.txt`, data: encode(it.raw.parameters) })
    }
  }
  entries.push({ name: 'manifest.json', data: encoder.encode(buildExportJson(items)) })
  return buildZip(entries)
}
