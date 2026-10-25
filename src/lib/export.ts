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
  { label: t('export.imagesZip'), key: 'images' },
  { label: t('export.datasetZip'), key: 'dataset' },
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
  // ZIP 容量超限（B5）：可预期的用户级错误以消息提示，不作为异常冒泡
  try {
    if (format === 'csv')
      downloadText(`${filenameBase}-${stamp}.csv`, buildExportCsv(items), 'text/csv')
    else if (format === 'zip') {
      const zip = await buildWorkflowZip(items)
      if (zip) downloadBinary(`${filenameBase}-workflows-${stamp}.zip`, zip)
    } else if (format === 'images' || format === 'dataset') {
      // 原图打包只算实文件项（存档项无原图本体，参数文件无图片）；全被跳过时明确告知
      const packable = items.filter((i) => i.file && !i.metaOnly)
      if (!packable.length) {
        message.warning(t('msg.noImageFiles'))
        return
      }
      const zip =
        format === 'dataset' ? await buildDatasetZip(packable) : await buildImagesZip(packable)
      if (!zip) {
        message.warning(t('msg.noImageFiles'))
        return
      }
      const kind = format === 'dataset' ? 'dataset' : 'images'
      downloadBinary(`${filenameBase}-${kind}-${stamp}.zip`, zip)
      message.success(t('common.exportedItems', { n: packable.length }))
      return
    } else downloadText(`${filenameBase}-${stamp}.json`, buildExportJson(items))
    message.success(t('common.exportedItems', { n: items.length }))
  } catch (err) {
    if (err instanceof ZipCapacityError) {
      message.warning(err.message)
      return
    }
    throw err
  }
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

/** B5：本实现无 ZIP64——条目数写入 16 位、偏移 / 大小写入 32 位，超限不会报错
 * 而是静默产出损坏文件；导出前显式拒绝并给出可读原因 */
export class ZipCapacityError extends Error {}

function assertZipCapacity(count: number, centralOffset: number, centralSize = 0): void {
  if (count > 0xffff) throw new ZipCapacityError(t('export.zipTooManyEntries', { n: count }))
  if (centralOffset > 0xffffffff || centralSize > 0xffffffff)
    throw new ZipCapacityError(t('export.zipTooLarge'))
}

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
  /**
   * 条目数据：Uint8Array 直接参与打包；Blob（原图 File）由浏览器按引用持有，
   * 打包过程不把整份文件读进内存——此时的 size / crc 由调用方流式预计算后提供
   */
  data: Uint8Array | Blob
  /** data 为 Blob 时必填：字节长度（写入本地头与中央目录） */
  size?: number
  /** data 为 Blob 时必填：内容的 CRC32（分块流式算得） */
  crc?: number
}

async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(new Date())
  const localParts: BlobPart[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const isBlob = typeof entry.data === 'object' && !(entry.data instanceof Uint8Array)
    if (isBlob && (entry.size === undefined || entry.crc === undefined)) {
      throw new Error('Blob zip entry needs precomputed size and crc')
    }
    const size = isBlob ? entry.size! : (entry.data as Uint8Array).length
    const crc = isBlob ? entry.crc! : crc32(entry.data as Uint8Array)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // 文件名为 UTF-8
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    localParts.push(local, entry.data as BlobPart)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true) // UTF-8 名字
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true) // local header 偏移
    central.set(name, 46)
    centralParts.push(central)
    offset += local.length + size
  }
  const centralSize = centralParts.reduce((n, c) => n + c.length, 0)
  assertZipCapacity(entries.length, offset, centralSize)
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
 * ZIP 条目名消毒（C4）：逐段解析路径——剥除控制字符与盘符、折叠分隔符、消解
 * `.` / `..` 段（越出根界直接钳掉），段内 Windows 非法字符替换为下划线。
 * 产出永远是干净的相对路径，杜绝导入数据携带的恶意路径在解压端逃出目标目录（zip-slip）。
 */
function safeZipPath(s: string): string {
  // 本正则的目的就是剥除控制字符——no-control-regex 在此属于误报
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, '').replace(/^[a-zA-Z]:/, '')
  const stack: string[] = []
  for (const part of cleaned.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part.replace(/[:*?"<>|]/g, '_'))
  }
  return stack.join('/')
}

/**
 * 把选中 / 筛选结果的工作流打包为 ZIP：
 * 每张图按相对路径展开 prompt.json / workflow.json（A1111 项为 parameters.txt），
 * 附 manifest.json（与 JSON 导出同构）。条目名为空时返回 null。
 * 路径即去重键，天然无重名；Windows 非法字符统一替换为下划线。
 */
export async function buildWorkflowZip(items: ImageItem[]): Promise<Blob | null> {
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
  for (const it of items) {
    const stem = safeZipPath((it.path ?? it.name).replace(/\.[^./\\]+$/, ''))
    if (it.raw.prompt) {
      entries.push({ name: `${stem}.prompt.json`, data: encode(it.raw.prompt) })
    }
    if (it.raw.workflow) {
      entries.push({ name: `${stem}.workflow.json`, data: encode(it.raw.workflow) })
    }
    if (it.source === 'a1111' && it.raw.parameters) {
      entries.push({ name: `${stem}.parameters.txt`, data: encode(it.raw.parameters) })
    }
    if (it.source === 'fooocus' && it.raw.parameters) {
      entries.push({ name: `${stem}.fooocus.json`, data: encode(it.raw.parameters) })
    }
  }
  entries.push({ name: 'manifest.json', data: encoder.encode(buildExportJson(items)) })
  return buildZip(entries)
}

/** 分块流式计算 Blob 内容的 CRC32：大原图不整载进内存，峰值只有一个分块 */
async function streamCrc32(blob: Blob): Promise<number> {
  let c = 0xffffffff
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let i = 0; i < value.length; i++) c = CRC_TABLE[(c ^ value[i]!) & 0xff]! ^ (c >>> 8)
    }
  } finally {
    reader.releaseLock()
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 把选中 / 筛选结果的原图打包为 ZIP：条目按相对路径存放（与工作流打包同一套
 * 目录结构），便于数据集搬运。条目数据直接引用原 File（Blob part），打包全程
 * 不把任何一份图片整载进内存。存档项 / 参数文件没有原图本体，由调用方先行过滤。
 * 条目名为空返回 null；recordKey 允许同名不同内容（无路径的单选添加），
 * ZIP 内条目名必须唯一，冲突时追加「 (n)」序号。
 */
export async function buildImagesZip(items: ImageItem[]): Promise<Blob | null> {
  const files = items.filter((it) => it.file && !it.metaOnly)
  if (!files.length) return null
  // 容量校验前置（B5）：流式 CRC 要完整读一遍每个文件，超限不应在算完全部 CRC 后才失败
  assertZipCapacity(
    files.length,
    files.reduce((n, it) => n + (it.file?.size ?? 0), 0),
  )
  const used = new Set<string>()
  const entries: ZipEntry[] = []
  for (const it of files) {
    const rawName = safeZipPath(it.path ?? it.name)
    let name = rawName
    for (let n = 2; used.has(name); n++) {
      const dot = rawName.lastIndexOf('.')
      name = dot > 0 ? `${rawName.slice(0, dot)} (${n})${rawName.slice(dot)}` : `${rawName} (${n})`
    }
    used.add(name)
    const file = it.file!
    entries.push({ name, data: file, size: file.size, crc: await streamCrc32(file) })
  }
  return buildZip(entries)
}

/**
 * 训练集打包（原图 + 同名 .txt 标注文件）：每张图附带一个正向提示词作 caption 的
 * sidecar 文本，可直接投喂 kohya 等训练管线（无参数的图片给空标注占位，便于人工补写）。
 * 标注名跟随其图片的去重名（同名冲突序号一致），目录结构与原图打包相同。
 * 存档项 / 参数文件没有原图本体，由调用方先行过滤。
 */
export async function buildDatasetZip(items: ImageItem[]): Promise<Blob | null> {
  const files = items.filter((it) => it.file && !it.metaOnly)
  if (!files.length) return null
  // 容量校验前置（B5）：每张图产出原图 + 标注两个条目
  assertZipCapacity(
    files.length * 2,
    files.reduce((n, it) => n + (it.file?.size ?? 0), 0),
  )
  const encoder = new TextEncoder()
  const used = new Set<string>()
  const entries: ZipEntry[] = []
  for (const it of files) {
    const rawName = safeZipPath(it.path ?? it.name)
    let name = rawName
    for (let n = 2; used.has(name); n++) {
      const dot = rawName.lastIndexOf('.')
      name = dot > 0 ? `${rawName.slice(0, dot)} (${n})${rawName.slice(dot)}` : `${rawName} (${n})`
    }
    used.add(name)
    const file = it.file!
    entries.push({ name, data: file, size: file.size, crc: await streamCrc32(file) })
    // 标注 = 正向提示词（多行原样）；无参数 / 无提示词时空内容占位
    const caption = (it.params?.positive ?? []).filter((s) => s.trim() !== '').join('\n')
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    entries.push({ name: `${stem}.txt`, data: encoder.encode(caption) })
  }
  return buildZip(entries)
}
