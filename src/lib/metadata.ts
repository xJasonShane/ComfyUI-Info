/**
 * 图片元数据读取入口：根据扩展名选择解析路径，并判定图片来源。
 * 只读取文件头部切片即可拿到元数据，避免把整张大图读进内存。
 */
import type { RawMetadata } from '../types'
import { readPngTexts } from './png'
import {
  extractUserCommentFromTiff,
  decodeUserComment,
  extractJsonSubstring,
  findJpegExifTiff,
  findWebpExifTiff,
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

async function readUserCommentText(file: File, ext: string): Promise<string | null> {
  const head = await readHead(file, HEAD_BYTES)
  const tiff = ext === 'webp' ? findWebpExifTiff(head) : findJpegExifTiff(head)
  if (!tiff) return null
  const raw = extractUserCommentFromTiff(tiff)
  if (!raw) return null
  return decodeUserComment(raw)
}

export async function readImageMetadata(file: File): Promise<RawMetadata> {
  const ext = extOf(file.name)

  if (ext === 'png') {
    let { texts, complete } = await readPngTexts(await readHead(file, HEAD_BYTES))
    if (!complete && file.size > HEAD_BYTES) {
      // 头部切片恰好截断在文本块区域，整文件重读一次
      ;({ texts, complete } = await readPngTexts(await readHead(file, file.size)))
    }
    if (texts['prompt'] || texts['workflow']) {
      return { source: 'comfyui', prompt: texts['prompt'], workflow: texts['workflow'] }
    }
    if (texts['parameters']) {
      return { source: 'a1111', parameters: texts['parameters'] }
    }
    return { source: 'none' }
  }

  if (ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
    const text = await readUserCommentText(file, ext)
    if (text) {
      const json = extractJsonSubstring(text)
      if (json) {
        try {
          const obj: unknown = JSON.parse(json)
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            return { source: 'comfyui', prompt: json }
          }
        } catch {
          // 含花括号但不是 JSON，按 A1111 参数文本处理
        }
      }
      return { source: 'a1111', parameters: text }
    }
    return { source: 'none' }
  }

  return { source: 'none' }
}
