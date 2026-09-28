/**
 * PNG 文本块解析：tEXt（Latin-1）、zTXt（zlib）、iTXt（UTF-8，可选 zlib 压缩）。
 * ComfyUI 把 prompt / workflow 写在这几类块里。
 */

export interface PngChunk {
  type: string
  data: Uint8Array
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false
  }
  return true
}

export interface PngChunks {
  chunks: PngChunk[]
  /** 是否在给定字节范围内读到了结构结束（IDAT / IEND 或切片截断） */
  complete: boolean
}

export function parsePngChunks(bytes: Uint8Array): PngChunks {
  const chunks: PngChunk[] = []
  let complete = false
  if (!isPng(bytes)) return { chunks, complete }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    if (pos + 12 + len > bytes.length) break
    chunks.push({ type, data: bytes.subarray(pos + 8, pos + 8 + len) })
    pos += 12 + len
    if (type === 'IDAT' || type === 'IEND') {
      // PIL 保存的文本块都位于 IDAT 之前，读到图像数据即可停止
      complete = true
      break
    }
  }
  return { chunks, complete }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder('utf-8')

export interface PngTexts {
  texts: Record<string, string>
  chunks: PngChunk[]
  complete: boolean
}

export async function readPngTexts(bytes: Uint8Array): Promise<PngTexts> {
  const { chunks, complete } = parsePngChunks(bytes)
  const texts: Record<string, string> = {}
  for (const c of chunks) {
    try {
      if (c.type === 'tEXt') {
        const nul = c.data.indexOf(0)
        if (nul < 0) continue
        texts[latin1.decode(c.data.subarray(0, nul))] = latin1.decode(c.data.subarray(nul + 1))
      } else if (c.type === 'zTXt') {
        const nul = c.data.indexOf(0)
        if (nul < 0 || nul + 2 > c.data.length) continue
        const raw = await inflate(c.data.subarray(nul + 2))
        texts[latin1.decode(c.data.subarray(0, nul))] = latin1.decode(raw)
      } else if (c.type === 'iTXt') {
        const nul = c.data.indexOf(0)
        if (nul < 0) continue
        const keyword = latin1.decode(c.data.subarray(0, nul))
        let pos = nul + 1
        if (pos + 2 > c.data.length) continue
        const compFlag = c.data[pos]
        pos += 2 // 压缩标志 + 压缩方法
        const langEnd = c.data.indexOf(0, pos)
        if (langEnd < 0) continue
        pos = langEnd + 1
        const transEnd = c.data.indexOf(0, pos)
        if (transEnd < 0) continue
        pos = transEnd + 1
        let payload = c.data.subarray(pos)
        if (compFlag === 1) payload = await inflate(payload)
        texts[keyword] = utf8.decode(payload)
      }
    } catch {
      // 单个块损坏时忽略，不影响其余块
    }
  }
  return { texts, chunks, complete }
}
