/**
 * 图片元数据读取入口：根据扩展名选择解析路径，并判定图片来源。
 * 只读取文件头部切片即可拿到元数据，避免把整张大图读进内存。
 * 识别不出参数时收集诊断线索（XMP / EXIF 软件字段等），帮助用户判断原因。
 */
import type { ParseResult, ParsedParams, RawMetadata } from '../types'
import { readPngTexts, parsePngChunks, isPng } from './png'
import { extractComfyParams } from './comfyExtract'
import { parseA1111Parameters } from './a1111'
import {
  extractTiffAsciiTag,
  extractUserCommentFromTiff,
  decodeUserComment,
  extractJsonSubstring,
  scanJpeg,
  scanWebp,
} from './exif'

/**
 * 头部切片分级读取：元数据几乎都位于文件最前面（PNG 文本块在 IDAT 之前、JPEG 段在 SOS 之前），
 * 先读小切片，命中即止；未命中逐级放大。批量扫描时绝大多数文件止步于第一级，
 * 避免每张图固定读 4MB 带来的 I/O 与内存放大。
 */
const HEAD_STAGES = [256 * 1024, 4 * 1024 * 1024]

async function readHead(file: File, size: number): Promise<Uint8Array> {
  const buf = await file.slice(0, size).arrayBuffer()
  return new Uint8Array(buf)
}

/** 按 HEAD_STAGES 逐级放大读取，直到 enough 判定通过或已读整文件 */
async function readHeadUntil(
  file: File,
  enough: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array> {
  for (let stage = 0; ; stage++) {
    const size = Math.min(
      stage < HEAD_STAGES.length ? HEAD_STAGES[stage] : file.size,
      file.size,
    )
    const bytes = await readHead(file, size)
    if (enough(bytes) || size >= file.size) return bytes
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isSupportedImage(file: File): boolean {
  return ['png', 'jpg', 'jpeg', 'webp'].includes(extOf(file.name))
}

/** UserComment 文本 → 来源判定：内嵌 ComfyUI 工作流 JSON 则升级，否则按 A1111 参数文本处理 */
function judgeUserCommentText(text: string): RawMetadata | null {
  const json = extractJsonSubstring(text)
  // JSON 必须像 ComfyUI 工作流（节点带 class_type）——
  // 排除 A1111 参数行里 Hashes 这类普通 JSON 值把整张图误判成 ComfyUI
  if (json && /"class_type"\s*:/.test(json)) {
    return { source: 'comfyui', prompt: json }
  }
  return judgeParametersText(text)
}

/**
 * A1111 参数文本判定。部分 ComfyUI 生态的保存节点（Civitai 兼容模式）会把
 * workflow JSON 内嵌在参数文本尾部——检测到节点结构关键字时升级为 ComfyUI 解析。
 * extractJsonSubstring 返回值保证可解析为 JSON 对象。
 * 升级时保留原始 parameters 文本：结构化参数来自工作流 JSON，原文另有排查价值。
 */
function judgeParametersText(text: string): RawMetadata {
  if (/"(?:class_type|nodes)"\s*:/.test(text)) {
    const json = extractJsonSubstring(text)
    if (json) {
      return { source: 'comfyui', prompt: json, parameters: text }
    }
  }
  return { source: 'a1111', parameters: text }
}

/** PNG / JPEG / WebP 均无生成参数时，给出诊断线索 */
function diagnoseNone(scan: {
  hasExif: boolean
  hasXmp: boolean
  textKeys: string[]
}): RawMetadata {
  const hints: string[] = []
  if (scan.hasXmp) {
    hints.push(
      '图片包含 Adobe XMP 编辑信息（Photoshop / Lightroom 处理痕迹），生成参数在处理或转存时被清除',
    )
  }
  if (scan.textKeys.length) {
    hints.push(`检测到 PNG 文本块: ${scan.textKeys.join('、')}`)
  }
  if (scan.hasExif) {
    hints.push('检测到 EXIF 元数据，但没有生成参数（UserComment）')
  }
  if (!hints.length) {
    hints.push('图片不含任何生成参数元数据')
  }
  hints.push(
    '请使用 ComfyUI output 目录中直接生成的原图测试（未经 Photoshop / 网络转存的版本才保留参数）',
  )
  return { source: 'none', hints }
}

/** 按来源把原始元数据提取为结构化参数（Worker 与主线程兜底共用的入口） */
export function extractParams(raw: RawMetadata): ParsedParams | undefined {
  if (raw.source === 'comfyui' && raw.prompt) return extractComfyParams(raw.prompt) ?? undefined
  if (raw.source === 'a1111' && raw.parameters) return parseA1111Parameters(raw.parameters)
  return undefined
}

/* ---------- 主线程侧字符串去重（interning） ---------- */
const internPool = new Map<string, string>()

function intern(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  const hit = internPool.get(s)
  if (hit !== undefined) return hit
  internPool.set(s, s)
  return s
}

/**
 * 同一工作流批量出图时，prompt / workflow JSON 会随 Worker 消息逐份克隆成独立字符串；
 * 在主线程接收处把相同内容合并为同一引用，长列表常驻内存可降一个量级。
 * 池只在 clearAll（清空列表）时整体清空——单张移除留下的孤儿串以「不同工作流的数量」为上界。
 */
export function internParseResult(result: ParseResult): ParseResult {
  result.raw.prompt = intern(result.raw.prompt)
  result.raw.workflow = intern(result.raw.workflow)
  result.raw.parameters = intern(result.raw.parameters)
  if (result.params) result.params.rawText = intern(result.params.rawText)
  return result
}

/** 清空 intern 池：列表整体清空后所有结果串都不再被引用，池同步释放 */
export function clearInternPool() {
  internPool.clear()
}

export type ImageKind = 'png' | 'jpeg' | 'webp'

const SIGNATURE_BYTES = 16

/** 读文件头魔数判定真实格式：PNG 签名 / JPEG(FF D8 FF) / WebP(RIFF…WEBP) */
export async function sniffKind(file: File): Promise<ImageKind | null> {
  const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer())
  if (isPng(head)) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (
    head.length >= 12 &&
    head[0] === 0x52 /* R */ &&
    head[1] === 0x49 /* I */ &&
    head[2] === 0x46 /* F */ &&
    head[3] === 0x46 /* F */ &&
    head[8] === 0x57 /* W */ &&
    head[9] === 0x45 /* E */ &&
    head[10] === 0x42 /* B */ &&
    head[11] === 0x50 /* P */
  ) {
    return 'webp'
  }
  return null
}

/** 内容嗅探是否为受支持图片（无扩展名文件入列前的把关） */
export async function hasSupportedSignature(file: File): Promise<boolean> {
  return (await sniffKind(file)) !== null
}

/** 扩展名优先，扩展名缺失 / 生僻时回退文件头嗅探 */
async function detectKind(file: File): Promise<ImageKind | null> {
  const ext = extOf(file.name)
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'webp') return 'webp'
  return sniffKind(file)
}

export async function readImageMetadata(file: File): Promise<RawMetadata> {
  const kind = await detectKind(file)

  if (kind === 'png') {
    // PNG：文本块 / eXIf 都在 IDAT 之前，读到 IDAT 即为完整；切片截断在文本块区则逐级放大
    const bytes = await readHeadUntil(file, (b) => parsePngChunks(b).complete)
    const { texts, chunks } = await readPngTexts(bytes)
    if (texts['prompt'] || texts['workflow']) {
      return { source: 'comfyui', prompt: texts['prompt'], workflow: texts['workflow'] }
    }
    if (texts['parameters']) {
      return judgeParametersText(texts['parameters'])
    }
    // PNG eXIf 块（部分工具把 EXIF 存在独立块里）
    const exifChunk = chunks.find((c) => c.type === 'eXIf')
    if (exifChunk) {
      const raw = extractUserCommentFromTiff(exifChunk.data)
      const text = raw ? decodeUserComment(raw) : null
      if (text) {
        const m = judgeUserCommentText(text)
        if (m) return m
      }
      const software = extractTiffAsciiTag(exifChunk.data, 0x0131)
      return diagnoseNone({
        hasExif: true,
        hasXmp: /xmp/i.test(Object.keys(texts).join(' ')),
        textKeys: Object.keys(texts).concat(software ? [`EXIF 软件: ${software}`] : []),
      })
    }
    return diagnoseNone({
      hasExif: false,
      hasXmp: Object.keys(texts).some((k) => /xmp/i.test(k)),
      textKeys: Object.keys(texts),
    })
  }

  if (kind === 'jpeg' || kind === 'webp') {
    const isWebp = kind === 'webp'
    // JPEG：段区截断（未到 SOS / EOI）时逐级放大；WebP：VP8X 声明的 EXIF / XMP 未扫到时逐级放大
    const bytes = await readHeadUntil(file, (b) => !(isWebp ? scanWebp(b) : scanJpeg(b)).needsFullScan)
    const scan = isWebp ? scanWebp(bytes) : scanJpeg(bytes)
    if (scan.exifTiff) {
      const raw = extractUserCommentFromTiff(scan.exifTiff)
      const text = raw ? decodeUserComment(raw) : null
      if (text) {
        const m = judgeUserCommentText(text)
        if (m) return m
      }
      const software = extractTiffAsciiTag(scan.exifTiff, 0x0131)
      return diagnoseNone({
        hasExif: true,
        hasXmp: scan.hasXmp,
        textKeys: software ? [`EXIF 软件: ${software}`] : [],
      })
    }
    return diagnoseNone({ hasExif: false, hasXmp: scan.hasXmp, textKeys: [] })
  }

  return { source: 'none', hints: ['不支持的图片格式，请使用 PNG / JPEG / WebP'] }
}
