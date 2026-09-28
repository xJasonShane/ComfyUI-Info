/**
 * JPEG APP1 / WebP RIFF 中的 EXIF TIFF 结构解析，目标只有一个：
 * 取出 ExifIFD 里的 UserComment（0x9286）——ComfyUI / A1111 把生成参数写在这里。
 */

function byteSizeOfType(type: number): number {
  switch (type) {
    case 1: // BYTE
    case 2: // ASCII
    case 6: // SBYTE
    case 7: // UNDEFINED
      return 1
    case 3: // SHORT
    case 8: // SSHORT
      return 2
    case 4: // LONG
    case 9: // SLONG
    case 11: // FLOAT
      return 4
    case 5: // RATIONAL
    case 10: // SRATIONAL
    case 12: // DOUBLE
      return 8
    default:
      return 1
  }
}

interface IfdWalkResult {
  userComment?: Uint8Array
  exifPointer?: number
}

function readEntryValue(tiff: Uint8Array, view: DataView, entry: number, little: boolean): Uint8Array | null {
  const type = view.getUint16(entry + 2, little)
  const count = view.getUint32(entry + 4, little)
  const total = count * byteSizeOfType(type)
  let dataOffset = entry + 8
  if (total > 4) dataOffset = view.getUint32(entry + 8, little)
  if (dataOffset < 0 || dataOffset + count > tiff.byteLength) return null
  return tiff.subarray(dataOffset, dataOffset + count)
}

function walkIfd(tiff: Uint8Array, view: DataView, offset: number, little: boolean): IfdWalkResult {
  const out: IfdWalkResult = {}
  if (offset <= 0 || offset + 2 > tiff.byteLength) return out
  const count = view.getUint16(offset, little)
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12
    if (entry + 12 > tiff.byteLength) break
    const tag = view.getUint16(entry, little)
    if (tag === 0x8769) {
      out.exifPointer = view.getUint32(entry + 8, little)
    } else if (tag === 0x9286) {
      const v = readEntryValue(tiff, view, entry, little)
      if (v) out.userComment = v
    }
  }
  return out
}

export function extractUserCommentFromTiff(tiff: Uint8Array): Uint8Array | null {
  if (tiff.length < 8) return null
  const order = String.fromCharCode(tiff[0], tiff[1])
  const little = order === 'II'
  if (!little && order !== 'MM') return null
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  if (view.getUint16(2, little) !== 42) return null
  const ifd0 = view.getUint32(4, little)
  const first = walkIfd(tiff, view, ifd0, little)
  if (first.userComment) return first.userComment
  if (first.exifPointer) {
    const second = walkIfd(tiff, view, first.exifPointer, little)
    if (second.userComment) return second.userComment
  }
  return null
}

/** 从 JPEG 字节中找到 Exif APP1 段内的 TIFF 数据 */
export function findJpegExifTiff(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null
    const marker = bytes[pos + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xda) return null // 扫描数据开始，之后不会再有 EXIF
    if (pos + 4 > bytes.length) return null
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3]
    if (segLen < 2) return null
    if (marker === 0xe1) {
      const seg = bytes.subarray(pos + 4, pos + 2 + segLen)
      if (
        seg.length > 6 &&
        seg[0] === 0x45 /* E */ &&
        seg[1] === 0x78 /* x */ &&
        seg[2] === 0x69 /* i */ &&
        seg[3] === 0x66 /* f */ &&
        seg[4] === 0 &&
        seg[5] === 0
      ) {
        return seg.subarray(6)
      }
    }
    pos += 2 + segLen
  }
  return null
}

/** 从 WebP（RIFF 容器）字节中找到 EXIF chunk 内的 TIFF 数据 */
export function findWebpExifTiff(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null
  const fourcc = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WEBP') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = fourcc(pos)
    const size = view.getUint32(pos + 4, true)
    if (id === 'EXIF') {
      if (pos + 8 + size > bytes.length) return null
      return bytes.subarray(pos + 8, pos + 8 + size)
    }
    pos += 8 + size + (size % 2)
  }
  return null
}

function decodeUtf16Heuristic(body: Uint8Array): string {
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(body.subarray(2))
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(body.subarray(2))
  }
  // 无 BOM：两种字节序各解一次，取控制字符 / 乱码更少的那个（x86 写入端通常是小端）
  const le = new TextDecoder('utf-16le').decode(body)
  let be = le
  try {
    be = new TextDecoder('utf-16be').decode(body)
  } catch {
    be = le
  }
  const badness = (s: string) => {
    let n = 0
    for (const ch of s) {
      const c = ch.codePointAt(0) ?? 0
      if (c === 0xfffd || (c < 9 && c !== 0) || (c > 13 && c < 32)) n++
    }
    return n
  }
  return badness(le) <= badness(be) ? le : be
}

export function decodeUserComment(raw: Uint8Array): string | null {
  if (raw.length === 0) return null
  if (raw.length >= 8) {
    let head = ''
    for (let i = 0; i < 8; i++) head += String.fromCharCode(raw[i])
    if (head === 'ASCII\u0000\u0000\u0000') {
      return new TextDecoder('utf-8').decode(raw.subarray(8))
    }
    if (head.startsWith('UNICODE')) {
      return decodeUtf16Heuristic(raw.subarray(8))
    }
  }
  // 无标准前缀：按 UTF-8 处理并去掉结尾空字节
  return new TextDecoder('utf-8').decode(raw).replace(/\u0000+$/, '')
}

/** 从混合文本中截取 JSON 对象部分 */
export function extractJsonSubstring(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}
