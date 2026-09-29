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

function buildZip(entries: ZipEntry[]): Uint8Array {
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
  const out = new Uint8Array(offset + centralSize + 22)
  let pos = 0
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}

/**
 * 把选中 / 筛选结果的工作流打包为 ZIP：
 * 每张图按相对路径展开 prompt.json / workflow.json（A1111 项为 parameters.txt），
 * 附 manifest.json（与 JSON 导出同构）。条目名为空时返回 null。
 * 路径即去重键，天然无重名；Windows 非法字符统一替换为下划线。
 */
export function buildWorkflowZip(items: ImageItem[]): Uint8Array | null {
  if (!items.length) return null
  const encoder = new TextEncoder()
  const entries: ZipEntry[] = []
  const safe = (s: string) => s.replace(/[:*?"<>|\\]/g, '_')
  for (const it of items) {
    const stem = safe((it.path ?? it.name).replace(/\.[^./\\]+$/, ''))
    if (it.raw.prompt) {
      entries.push({ name: `${stem}.prompt.json`, data: encoder.encode(it.raw.prompt) })
    }
    if (it.raw.workflow) {
      entries.push({ name: `${stem}.workflow.json`, data: encoder.encode(it.raw.workflow) })
    }
    if (it.source === 'a1111' && it.raw.parameters) {
      entries.push({ name: `${stem}.parameters.txt`, data: encoder.encode(it.raw.parameters) })
    }
  }
  entries.push({ name: 'manifest.json', data: encoder.encode(buildExportJson(items)) })
  return buildZip(entries)
}
