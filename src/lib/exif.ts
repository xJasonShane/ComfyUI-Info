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

const XMP_JPEG_PREFIX = 'http://ns.adobe.com/xap/1.0/\u0000'

interface MetadataScan {
  exifTiff: Uint8Array | null
  hasXmp: boolean
  /**
   * 扫描的切片未覆盖容器声明的全部元数据区，调用方应整文件重扫。
   * JPEG 的 APPn 段全部位于扫描数据（SOS）之前，头部切片总是足够，恒为 false；
   * WebP 的元数据块在图像数据之后，依 VP8X 标志判定。
   */
  needsFullScan: boolean
}

/** JPEG 段扫描：EXIF TIFF 数据 + 是否含 Adobe XMP（用于诊断） */
export function scanJpeg(bytes: Uint8Array): MetadataScan {
  const out: MetadataScan = { exifTiff: null, hasXmp: false, needsFullScan: false }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return out
  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return out
    const marker = bytes[pos + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xda) return out // 扫描数据开始，之后不会再有元数据
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3]
    if (segLen < 2) return out
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
        if (!out.exifTiff) out.exifTiff = seg.subarray(6)
      } else if (seg.length > XMP_JPEG_PREFIX.length) {
        let isXmp = true
        for (let i = 0; i < XMP_JPEG_PREFIX.length; i++) {
          if (seg[i] !== XMP_JPEG_PREFIX.charCodeAt(i)) {
            isXmp = false
            break
          }
        }
        if (isXmp) out.hasXmp = true
      }
    }
    pos += 2 + segLen
  }
  return out
}

export function findJpegExifTiff(bytes: Uint8Array): Uint8Array | null {
  return scanJpeg(bytes).exifTiff
}

/**
 * WebP（RIFF 容器）扫描：EXIF chunk（剥离 APP1 风格前缀）+ XMP chunk 检测。
 * EXIF / XMP 块位于图像数据之后，头部切片可能扫不到——VP8X 标志声明了
 * 切片中未出现的元数据时置 needsFullScan，调用方应整文件重扫。
 */
export function scanWebp(bytes: Uint8Array): MetadataScan {
  const out: MetadataScan = { exifTiff: null, hasXmp: false, needsFullScan: false }
  if (bytes.length < 12) return out
  const fourcc = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WEBP') return out
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 12
  let declaresExif = false
  let declaresXmp = false
  const rescan = () => {
    out.needsFullScan = (declaresExif && !out.exifTiff) || (declaresXmp && !out.hasXmp)
  }
  while (pos + 8 <= bytes.length) {
    const id = fourcc(pos)
    const size = view.getUint32(pos + 4, true)
    if (pos + 8 + size > bytes.length) {
      rescan()
      return out
    }
    if (id === 'VP8X') {
      // VP8X 载荷首字节的标志位：ICC 0x20 / Alpha 0x10 / EXIF 0x08 / XMP 0x04
      const flags = bytes[pos + 8]
      declaresExif = (flags & 0x08) !== 0
      declaresXmp = (flags & 0x04) !== 0
    } else if (id === 'EXIF' && !out.exifTiff) {
      let data = bytes.subarray(pos + 8, pos + 8 + size)
      // 部分写入端在 EXIF chunk 里保留 APP1 风格的 "Exif\0\0" 前缀
      if (
        data.length > 6 &&
        data[0] === 0x45 &&
        data[1] === 0x78 &&
        data[2] === 0x69 &&
        data[3] === 0x66 &&
        data[4] === 0 &&
        data[5] === 0
      ) {
        data = data.subarray(6)
      }
      out.exifTiff = data
    } else if (id === 'XMP ') {
      out.hasXmp = true
    }
    pos += 8 + size + (size % 2)
  }
  rescan()
  return out
}

export function findWebpExifTiff(bytes: Uint8Array): Uint8Array | null {
  return scanWebp(bytes).exifTiff
}

/** 读取 TIFF IFD0 中的 ASCII 字符串标签（如 Software 0x0131），用于诊断提示 */
export function extractTiffAsciiTag(tiff: Uint8Array, wantTag: number): string | null {
  if (tiff.length < 8) return null
  const order = String.fromCharCode(tiff[0], tiff[1])
  const little = order === 'II'
  if (!little && order !== 'MM') return null
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  if (view.getUint16(2, little) !== 42) return null
  const ifd0 = view.getUint32(4, little)
  if (ifd0 + 2 > tiff.byteLength) return null
  const count = view.getUint16(ifd0, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > tiff.byteLength) break
    const tag = view.getUint16(entry, little)
    if (tag !== wantTag) continue
    const type = view.getUint16(entry + 2, little)
    const cnt = view.getUint32(entry + 4, little)
    let off = entry + 8
    if (cnt > 4) off = view.getUint32(entry + 8, little)
    if (type !== 2 || off + cnt > tiff.byteLength) return null
    return new TextDecoder('latin1').decode(tiff.subarray(off, off + cnt)).replace(/\0.*$/, '')
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

/** 从 start（指向 {）做配平扫描，返回配平的 } 下标；扫描中跳过 "字符串"（含转义），未配平返回 -1 */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

/**
 * 从混合文本中截取内嵌的 JSON 对象，返回其中最后闭合的合法者。
 * 提示词常含 {}（模板语法、A1111 的 Hashes 值等），不能简单取首个 { 到末个 }：
 * 逐个 { 起点做配平扫描并 JSON.parse 校验，只有合法的 JSON 对象才参与选取——
 * 内嵌工作流 JSON 总在参数文本末尾，最后闭合者即它。找不到时返回 null。
 */
export function extractJsonSubstring(text: string): string | null {
  let found: string | null = null
  let foundEnd = -1
  let attempts = 0
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    // 上限防止「大量未配平花括号」的病态文本触发平方级扫描
    if (++attempts > 64) break
    const end = findBalancedEnd(text, start)
    if (end < 0 || end <= foundEnd) continue
    const candidate = text.slice(start, end + 1)
    try {
      const obj: unknown = JSON.parse(candidate)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        found = candidate
        foundEnd = end
      }
    } catch {
      // 配平成功但不是合法 JSON（如提示词模板段），尝试下一个起点
    }
  }
  return found
}
