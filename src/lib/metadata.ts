/**
 * 图片元数据读取入口：根据扩展名选择解析路径，并判定图片来源。
 * 只读取文件头部切片即可拿到元数据，避免把整张大图读进内存。
 * 识别不出参数时收集诊断线索（XMP / EXIF 软件字段等），帮助用户判断原因。
 */
import type { RawMetadata } from '../types'
import { readPngTexts } from './png'
import {
  extractTiffAsciiTag,
  extractUserCommentFromTiff,
  decodeUserComment,
  extractJsonSubstring,
  scanJpeg,
  scanWebp,
} from './exif'

const HEAD_BYTES = 4 * 1024 * 1024

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isSupportedImage(file: File): boolean {
  return ['png', 'jpg', 'jpeg', 'webp'].includes(extOf(file.name))
}

async function readHead(file: File, size: number): Promise<Uint8Array> {
  const buf = await file.slice(0, size).arrayBuffer()
  return new Uint8Array(buf)
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
 */
function judgeParametersText(text: string): RawMetadata {
  if (/"(?:class_type|nodes)"\s*:/.test(text)) {
    const json = extractJsonSubstring(text)
    if (json) {
      return { source: 'comfyui', prompt: json }
    }
  }
  return { source: 'a1111', parameters: text }
}

/** PNG / JPEG / WebP 均无生成参数时，给出诊断线索 */
function diagnoseNone(scan: { hasExif: boolean; hasXmp: boolean; textKeys: string[] }): RawMetadata {
  const hints: string[] = []
  if (scan.hasXmp) {
    hints.push('图片包含 Adobe XMP 编辑信息（Photoshop / Lightroom 处理痕迹），生成参数在处理或转存时被清除')
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
  hints.push('请使用 ComfyUI output 目录中直接生成的原图测试（未经 Photoshop / 网络转存的版本才保留参数）')
  return { source: 'none', hints }
}

export async function readImageMetadata(file: File): Promise<RawMetadata> {
  const ext = extOf(file.name)

  if (ext === 'png') {
    let r = await readPngTexts(await readHead(file, HEAD_BYTES))
    if (!r.complete && file.size > HEAD_BYTES) {
      // 头部切片恰好截断在文本块区域，整文件重读一次
      r = await readPngTexts(await readHead(file, file.size))
    }
    const { texts, chunks } = r
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
      return diagnoseNone({ hasExif: true, hasXmp: /xmp/i.test(Object.keys(texts).join(' ')), textKeys: Object.keys(texts).concat(software ? [`EXIF 软件: ${software}`] : []) })
    }
    return diagnoseNone({ hasExif: false, hasXmp: Object.keys(texts).some((k) => /xmp/i.test(k)), textKeys: Object.keys(texts) })
  }

  if (ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
    const head = await readHead(file, HEAD_BYTES)
    let scan = ext === 'webp' ? scanWebp(head) : scanJpeg(head)
    if (ext === 'webp' && scan.needsFullScan && file.size > HEAD_BYTES) {
      // WebP 的 EXIF / XMP 块位于图像数据之后，头部切片没扫到时整文件重扫一次
      scan = scanWebp(await readHead(file, file.size))
    }
    if (scan.exifTiff) {
      const raw = extractUserCommentFromTiff(scan.exifTiff)
      const text = raw ? decodeUserComment(raw) : null
      if (text) {
        const m = judgeUserCommentText(text)
        if (m) return m
      }
      const software = extractTiffAsciiTag(scan.exifTiff, 0x0131)
      return diagnoseNone({ hasExif: true, hasXmp: scan.hasXmp, textKeys: software ? [`EXIF 软件: ${software}`] : [] })
    }
    return diagnoseNone({ hasExif: false, hasXmp: scan.hasXmp, textKeys: [] })
  }

  return { source: 'none', hints: ['不支持的图片格式，请使用 PNG / JPEG / WebP'] }
}
