import { describe, expect, it, vi } from 'vitest'
import { deflateSync } from 'node:zlib'
import { readPngTexts, parsePngChunks } from '../src/lib/png'
import {
  extractUserCommentFromTiff,
  decodeUserComment,
  extractJsonSubstring,
  findJpegExifTiff,
  findWebpExifTiff,
  scanJpeg,
  scanWebp,
} from '../src/lib/exif'
import {
  clearInternPool,
  internParseResult,
  readImageMetadata,
  extractParams,
} from '../src/lib/metadata'
import { extractComfyParams } from '../src/lib/comfyExtract'
import { parseA1111Parameters } from '../src/lib/a1111'
import { BROKEN, ParsePool, ParseScheduler } from '../src/lib/parser'
import type { ParseTransport } from '../src/lib/parser'
import type { ParseResult } from '../types'

const PNG_SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  // 解析器不校验 CRC，填零即可
  return out
}

// tEXt 规范上只能存 Latin-1（PIL 遇到非 Latin-1 字符会自动改用 iTTt），只放 ASCII
function textChunkAscii(keyword: string, text: string): Uint8Array {
  const kw = Buffer.from(keyword, 'latin1')
  const body = Buffer.concat([kw, Buffer.from([0]), Buffer.from(text, 'latin1')])
  return pngChunk('tEXt', new Uint8Array(body))
}

/** iTXt + zlib 压缩（ComfyUI 写中文提示词时的实际形态） */
function itxtChunkZlib(keyword: string, text: string): Uint8Array {
  const kw = Buffer.from(keyword, 'latin1')
  const compressed = deflateSync(Buffer.from(text, 'utf8'))
  const body = Buffer.concat([
    kw,
    Buffer.from([0, 1, 0]), // \0 + 压缩标志1 + 压缩方法0
    Buffer.from([0, 0]), // 语言标签、翻译关键字均为空
    compressed,
  ])
  return pngChunk('iTXt', new Uint8Array(body))
}

function buildPng(textChunks: Uint8Array[]): Uint8Array {
  const ihdr = pngChunk('IHDR', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]))
  const end = pngChunk('IEND', new Uint8Array(0))
  const parts = [PNG_SIG, ihdr, ...textChunks, end]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 构造一个含 Exif UserComment 的最小 TIFF（II 小端） */
function buildTiff(userComment: Uint8Array): Uint8Array {
  const ifd0Offset = 8
  const ifd0Size = 2 + 12 + 4
  const exifIfdOffset = ifd0Offset + ifd0Size
  const exifIfdSize = 2 + 12 + 4
  const valueOffset = exifIfdOffset + exifIfdSize

  const buf = new Uint8Array(valueOffset + userComment.length)
  const view = new DataView(buf.buffer)
  buf[0] = 0x49
  buf[1] = 0x49
  view.setUint16(2, 42, true)
  view.setUint32(4, ifd0Offset, true)
  // IFD0：一个条目，指向 ExifIFD
  view.setUint16(ifd0Offset, 1, true)
  view.setUint16(ifd0Offset + 2, 0x8769, true)
  view.setUint16(ifd0Offset + 4, 4, true)
  view.setUint32(ifd0Offset + 6, 1, true)
  view.setUint32(ifd0Offset + 10, exifIfdOffset, true)
  view.setUint32(ifd0Offset + 14, 0, true) // next IFD
  // ExifIFD：一个条目，UserComment
  view.setUint16(exifIfdOffset, 1, true)
  view.setUint16(exifIfdOffset + 2, 0x9286, true)
  view.setUint16(exifIfdOffset + 4, 7, true) // UNDEFINED
  view.setUint32(exifIfdOffset + 6, userComment.length, true)
  view.setUint32(exifIfdOffset + 10, valueOffset, true)
  view.setUint32(exifIfdOffset + 14, 0, true)
  buf.set(userComment, valueOffset)
  return buf
}

function buildJpegWithExif(tiff: Uint8Array): Uint8Array {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(tiff)])
  const app1 = new Uint8Array(4 + payload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1[2] = (payload.length + 2) >> 8
  app1[3] = (payload.length + 2) & 0xff
  app1.set(new Uint8Array(payload), 4)
  const out = new Uint8Array(2 + app1.length + 2)
  out[0] = 0xff
  out[1] = 0xd8
  out.set(app1, 2)
  out[out.length - 2] = 0xff
  out[out.length - 1] = 0xd9
  return out
}

// 用于构造「EXIF 位于分级切片之外」的大块图像数据（覆盖逐级放大到整文件的路径）
const HEAD_BYTES = 4 * 1024 * 1024

function webpChunk(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length % 2))
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i)
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  return out
}

function buildWebp(chunks: Uint8Array[]): Uint8Array {
  const payloadLen = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(12 + payloadLen)
  out.set(Buffer.from('RIFF'), 0)
  new DataView(out.buffer).setUint32(4, 4 + payloadLen, true)
  out.set(Buffer.from('WEBP'), 8)
  let off = 12
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** VP8X 标志字节：EXIF 0x08、XMP 0x04（与 exif.ts 的解析一致） */
function buildWebpWithExif(tiff: Uint8Array, imageBytes: number): Uint8Array {
  const vp8x = webpChunk('VP8X', Uint8Array.from([0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  const exif = webpChunk(
    'EXIF',
    new Uint8Array(Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(tiff)])),
  )
  const image = webpChunk('VP8 ', new Uint8Array(imageBytes))
  // EXIF chunk 位于图像数据之后（libwebp mux 的实际布局）
  return buildWebp([vp8x, image, exif])
}

function asciiUserComment(text: string): Uint8Array {
  return Buffer.concat([Buffer.from('ASCII\0\0\0', 'latin1'), Buffer.from(text, 'utf8')])
}

function unicodeUserComment(text: string): Uint8Array {
  // A1111 风格：UNICODE 前缀 + UTF-16LE 无 BOM
  return Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), Buffer.from(text, 'utf16le')])
}

const COMFY_PROMPT = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 1562088014288583000,
      steps: 28,
      cfg: 6.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 1 } },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '一只戴帽子的橘猫，吉卜力风格', clip: ['4', 1] },
  },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '低质量, 模糊', clip: ['4', 1] } },
})

const COMFY_PROMPT_ASCII = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 1562088014288583000,
      steps: 28,
      cfg: 6.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 1 } },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a cat wearing a hat, ghibli style', clip: ['4', 1] },
  },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, blurry', clip: ['4', 1] } },
})

describe('PNG 文本块', () => {
  it('解析 tEXt（ASCII prompt）', async () => {
    const png = buildPng([
      textChunkAscii('prompt', COMFY_PROMPT_ASCII),
      textChunkAscii('workflow', '{"a":1}'),
    ])
    const { texts, complete } = await readPngTexts(png)
    expect(complete).toBe(true)
    expect(texts['prompt']).toBe(COMFY_PROMPT_ASCII)
    expect(texts['workflow']).toBe('{"a":1}')
  })

  it('解析 iTXt + zlib（中文提示词）', async () => {
    const png = buildPng([itxtChunkZlib('prompt', COMFY_PROMPT)])
    const { texts } = await readPngTexts(png)
    expect(texts['prompt']).toBe(COMFY_PROMPT)
  })

  it('截断的切片标记为不完整', async () => {
    const png = buildPng([textChunkAscii('prompt', COMFY_PROMPT_ASCII)])
    const head = png.slice(0, 40)
    const { complete } = parsePngChunks(new Uint8Array(head))
    expect(complete).toBe(false)
  })
})

describe('EXIF UserComment', () => {
  it('JPEG ASCII 前缀', () => {
    const tiff = buildTiff(new Uint8Array(asciiUserComment(COMFY_PROMPT)))
    const jpeg = buildJpegWithExif(tiff)
    const found = findJpegExifTiff(jpeg)
    expect(found).not.toBeNull()
    const raw = extractUserCommentFromTiff(found!)
    expect(raw).not.toBeNull()
    expect(decodeUserComment(raw!)).toBe(COMFY_PROMPT)
  })

  it('JPEG UNICODE 前缀（UTF-16LE 中文）', () => {
    const text = 'parameters: 步数28'
    const tiff = buildTiff(new Uint8Array(unicodeUserComment(text)))
    const raw = extractUserCommentFromTiff(tiff)!
    expect(decodeUserComment(raw)).toBe(text)
  })

  it('WebP RIFF EXIF chunk', () => {
    const tiff = buildTiff(new Uint8Array(asciiUserComment('hello')))
    const header = Buffer.from('RIFF\0\0\0\0WEBPVP8 \0\0\0\0', 'latin1')
    const exifChunkSize = tiff.length + (tiff.length % 2)
    const riffSize = 4 + 8 + exifChunkSize
    const buf = Buffer.concat([header, Buffer.from(tiff), Buffer.alloc(tiff.length % 2)])
    buf.writeUInt32LE(riffSize, 4)
    const webp = new Uint8Array(buf)
    // 修正 RIFF 大小后还需写入 EXIF chunk 头
    const chunkHeader = new Uint8Array(8)
    new DataView(chunkHeader.buffer).setUint32(4, tiff.length, true)
    chunkHeader[0] = 0x45 // E
    chunkHeader[1] = 0x58 // X
    chunkHeader[2] = 0x49 // I
    chunkHeader[3] = 0x46 // F
    const full = new Uint8Array(12 + 8 + exifChunkSize)
    full.set(webp.subarray(0, 12))
    full.set(chunkHeader, 12)
    full.set(tiff, 20)
    new DataView(full.buffer).setUint32(4, riffSize, true)
    const found = findWebpExifTiff(full)
    expect(found).not.toBeNull()
    expect(decodeUserComment(extractUserCommentFromTiff(found!)!)).toBe('hello')
  })

  it('WebP VP8X 声明 EXIF 但头部切片截断时提示整文件重扫', () => {
    const tiff = buildTiff(new Uint8Array(asciiUserComment('hello')))
    // 4MB 的图像块把 EXIF chunk 推到头部切片之外（大图 WebP 的实际形态）
    const webp = buildWebpWithExif(tiff, HEAD_BYTES)

    const headScan = scanWebp(webp.slice(0, HEAD_BYTES))
    expect(headScan.exifTiff).toBeNull()
    expect(headScan.needsFullScan).toBe(true)

    const fullScan = scanWebp(webp)
    expect(fullScan.needsFullScan).toBe(false)
    expect(decodeUserComment(extractUserCommentFromTiff(fullScan.exifTiff!)!)).toBe('hello')
  })

  it('JPEG 段区在切片中间被截断时提示需要更多数据', () => {
    const tiff = buildTiff(new Uint8Array(asciiUserComment('hello')))
    const jpeg = buildJpegWithExif(tiff)
    expect(scanJpeg(jpeg).needsFullScan).toBe(false) // 完整文件以 EOI 结束段区
    // 截掉 EOI 与 APP1 尾部：循环耗尽仍未到 SOS / EOI，必须放大切片重扫
    expect(scanJpeg(jpeg.slice(0, jpeg.length - 6)).needsFullScan).toBe(true)
  })

  it('extractJsonSubstring 截取 JSON', () => {
    expect(extractJsonSubstring('前缀 {"a":1} 后缀')).toBe('{"a":1}')
    expect(extractJsonSubstring('no json')).toBeNull()
  })

  it('extractJsonSubstring 括号配平：提示词含 {} 模板时仍取到内嵌工作流', () => {
    const workflow = '{"3": {"class_type": "KSampler", "inputs": {"text": "a {blue} house"}}}'
    const text = `{best quality}, masterpiece\nSteps: 20, ComfyUI Workflow: ${workflow}`
    expect(extractJsonSubstring(text)).toBe(workflow)
  })

  it('extractJsonSubstring 取最后闭合的合法对象（跳过前部 Hashes JSON）', () => {
    const text =
      'Steps: 20, Hashes: {"model": "abc"}, ComfyUI Workflow: {"3": {"class_type": "KSampler"}}'
    expect(extractJsonSubstring(text)).toBe('{"3": {"class_type": "KSampler"}}')
  })

  it('extractJsonSubstring 配平扫描跳过字符串值内的花括号，忽略其后非法段', () => {
    const workflow = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { text: '}} 不配平 { 重新' } },
    })
    expect(extractJsonSubstring(`prefix ${workflow} 模板 {a|b}`)).toBe(workflow)
    expect(extractJsonSubstring('只有 { 未配平的花括号')).toBeNull()
  })
})

describe('readImageMetadata 端到端', () => {
  it('PNG（tEXt）识别为 ComfyUI', async () => {
    const png = buildPng([textChunkAscii('prompt', COMFY_PROMPT_ASCII)])
    const file = new File([png], 'comfy.png', { type: 'image/png' })
    const meta = await readImageMetadata(file)
    expect(meta.source).toBe('comfyui')
    expect(meta.prompt).toBe(COMFY_PROMPT_ASCII)
  })

  it('PNG（iTXt zlib 中文）识别为 ComfyUI', async () => {
    const png = buildPng([itxtChunkZlib('prompt', COMFY_PROMPT)])
    const meta = await readImageMetadata(new File([png], 'comfy2.png'))
    expect(meta.source).toBe('comfyui')
  })

  it('PNG（parameters）识别为 A1111', async () => {
    const params =
      'a cat\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x768, Model: v1-5'
    const png = buildPng([textChunkAscii('parameters', params)])
    const meta = await readImageMetadata(new File([png], 'a.png'))
    expect(meta.source).toBe('a1111')
    expect(meta.parameters).toBe(params)
  })

  it('A1111 参数文本内嵌 workflow JSON 时升级为 ComfyUI', async () => {
    const wf = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, cfg: 7 } },
    })
    const params = `masterpiece\nNegative prompt: bad\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 5\nComfyUI Workflow: ${wf}`
    const png = buildPng([textChunkAscii('parameters', params)])
    const meta = await readImageMetadata(new File([png], 'hybrid.png'))
    expect(meta.source).toBe('comfyui')
    expect(meta.prompt).toBe(wf)
    expect(meta.parameters).toBe(params) // 升级后原始参数文本保留，供排查对照
  })

  it('prompt JSON 损坏：来源仍为 ComfyUI 但参数提取失败（UI 据此提示「元数据存在但解析失败」）', async () => {
    const broken = '{"3": {"class_type": "KSampler", "inputs": {' // 截断的工作流 JSON
    const png = buildPng([textChunkAscii('prompt', broken)])
    const meta = await readImageMetadata(new File([png], 'broken.png'))
    expect(meta.source).toBe('comfyui')
    expect(meta.prompt).toBe(broken)
    expect(extractParams(meta)).toBeUndefined()
  })

  it('A1111 文本含模板花括号与 Hashes JSON 时仍能升级为 ComfyUI', async () => {
    const wf = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, cfg: 7 } },
    })
    const params = `{best quality}, masterpiece\nNegative prompt: {bad}\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 5, Hashes: {"model": "abc"}, ComfyUI Workflow: ${wf}`
    const png = buildPng([textChunkAscii('parameters', params)])
    const meta = await readImageMetadata(new File([png], 'hybrid2.png'))
    expect(meta.source).toBe('comfyui')
    expect(meta.prompt).toBe(wf)
  })

  it('A1111 文本仅含 Hashes JSON（无工作流）时不误判为 ComfyUI', async () => {
    const params =
      'a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Hashes: {"model": "abc"}'
    const tiff = buildTiff(new Uint8Array(asciiUserComment(params)))
    const jpeg = buildJpegWithExif(tiff)
    const meta = await readImageMetadata(new File([jpeg], 'hashes.jpg'))
    expect(meta.source).toBe('a1111')
  })

  it('JPEG（UserComment JSON）识别为 ComfyUI', async () => {
    const tiff = buildTiff(new Uint8Array(asciiUserComment(COMFY_PROMPT)))
    const jpeg = buildJpegWithExif(tiff)
    const meta = await readImageMetadata(new File([jpeg], 'c.jpg'))
    expect(meta.source).toBe('comfyui')
    expect(meta.prompt).toBe(COMFY_PROMPT)
  })

  it('JPEG（UNICODE A1111 文本）识别为 A1111', async () => {
    const text = 'a cat\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a, CFG scale: 7'
    const tiff = buildTiff(new Uint8Array(unicodeUserComment(text)))
    const jpeg = buildJpegWithExif(tiff)
    const meta = await readImageMetadata(new File([jpeg], 'a.jpg'))
    expect(meta.source).toBe('a1111')
  })

  it('WebP 元数据位于图像数据之后（大文件）仍可识别', async () => {
    const tiff = buildTiff(new Uint8Array(asciiUserComment('hello')))
    const webp = buildWebpWithExif(tiff, HEAD_BYTES)
    const meta = await readImageMetadata(new File([webp], 'big.webp'))
    expect(meta.source).toBe('a1111')
  })

  it('PNG 元数据区超过一级切片（256KB）时分级放大重读仍可识别', async () => {
    // 前置一个 300KB 的占位文本块，把 prompt 块推到一级切片之外
    const pad = 'A'.repeat(300 * 1024)
    const png = buildPng([textChunkAscii('pad', pad), textChunkAscii('prompt', COMFY_PROMPT_ASCII)])
    const meta = await readImageMetadata(new File([png], 'big-text.png'))
    expect(meta.source).toBe('comfyui')
    expect(meta.prompt).toBe(COMFY_PROMPT_ASCII)
  })

  it('无元数据图片', async () => {
    const png = buildPng([])
    const meta = await readImageMetadata(new File([png], 'plain.png'))
    expect(meta.source).toBe('none')
  })
})

describe('extractComfyParams', () => {
  const params = extractComfyParams(COMFY_PROMPT)!

  it('提取采样参数', () => {
    expect(params.samplers).toHaveLength(1)
    const s = params.samplers[0]
    expect(s.steps).toBe(28)
    expect(s.cfg).toBe(6.5)
    expect(s.sampler).toBe('dpmpp_2m')
    expect(s.scheduler).toBe('karras')
    expect(s.denoise).toBe(1)
  })

  it('大数 seed 不丢精度', () => {
    expect(params.samplers[0].seed).toBe('1562088014288583000')
  })

  it('提取正负提示词和模型、尺寸', () => {
    expect(params.positive).toEqual(['一只戴帽子的橘猫，吉卜力风格'])
    expect(params.negative).toEqual(['低质量, 模糊'])
    expect(params.models).toEqual(['dreamshaper_8.safetensors'])
    expect(params.width).toBe(1024)
    expect(params.height).toBe(768)
  })

  it('多阶段采样（高清修复）按节点顺序排列', () => {
    const wf = JSON.stringify({
      '10': { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 2, denoise: 0.5 } },
      '3': { class_type: 'KSampler', inputs: { seed: 2, steps: 28, cfg: 7 } },
    })
    const p = extractComfyParams(wf)!
    expect(p.samplers.map((s) => s.nodeId)).toEqual(['3', '10'])
    expect(p.samplers[1].denoise).toBe(0.5)
  })

  it('出图尺寸沿 latent 链回溯：两阶段工作流取末端缩放后的尺寸', () => {
    const wf = JSON.stringify({
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 2 } },
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 1, steps: 20, cfg: 7, latent_image: ['5', 0] },
      },
      '10': {
        class_type: 'LatentUpscale',
        inputs: { samples: ['3', 0], width: 1024, height: 1536, upscale_method: 'nearest-exact' },
      },
      '20': {
        class_type: 'KSampler',
        inputs: { seed: 2, steps: 8, cfg: 7, denoise: 0.5, latent_image: ['10', 0] },
      },
    })
    const p = extractComfyParams(wf)!
    expect(p.width).toBe(1024)
    expect(p.height).toBe(1536)
    expect(p.batch).toBe(2) // 批量从链上游的 EmptyLatentImage 就近补齐
    expect(p.samplers).toHaveLength(2)
  })

  it('img2img：latent 链上无显式尺寸时不误报画布上无关节点的尺寸', () => {
    const wf = JSON.stringify({
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
      '2': { class_type: 'LoadImage', inputs: { image: 'in.png' } },
      '4': { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 1, steps: 20, cfg: 7, latent_image: ['4', 0], model: ['1', 0] },
      },
      // 画布上遗留、未接入采样链的 EmptyLatentImage——旧启发式会误报它的 999×999
      '9': { class_type: 'EmptyLatentImage', inputs: { width: 999, height: 999, batch_size: 1 } },
    })
    const p = extractComfyParams(wf)!
    expect(p.width).toBeUndefined()
    expect(p.height).toBeUndefined()
    expect(p.models).toEqual(['m.safetensors'])
  })

  it('提示词经字符串原语节点连线时仍可回溯（PrimitiveString）', () => {
    const wf = JSON.stringify({
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: 5,
          steps: 20,
          cfg: 7,
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['5', 0],
        },
      },
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'dreamshaper_8.safetensors' },
      },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: ['8', 0], clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: ['9', 0], clip: ['4', 1] } },
      '8': { class_type: 'PrimitiveString', inputs: { string: 'a cat, ghibli style' } },
      '9': { class_type: 'PrimitiveStringMultiline', inputs: { string: 'low quality, blurry' } },
    })
    const p = extractComfyParams(wf)!
    expect(p.positive).toEqual(['a cat, ghibli style'])
    expect(p.negative).toEqual(['low quality, blurry'])
    // loader 的 ckpt_name 等字符串输入不得被误当提示词
    expect(p.models).toEqual(['dreamshaper_8.safetensors'])
  })

  it('损坏 JSON 返回 null', () => {
    expect(extractComfyParams('not json')).toBeNull()
  })
})

describe('extractParams', () => {
  it('按来源分派参数提取', () => {
    expect(extractParams({ source: 'comfyui', prompt: COMFY_PROMPT })?.models).toEqual([
      'dreamshaper_8.safetensors',
    ])
    expect(
      extractParams({ source: 'a1111', parameters: 'a cat\nSteps: 20, Sampler: Euler a' })
        ?.samplers[0]?.sampler,
    ).toBe('Euler a')
    expect(extractParams({ source: 'none', hints: [] })).toBeUndefined()
  })
})

describe('parseA1111Parameters', () => {
  const text =
    'masterpiece, a cat\nNegative prompt: blurry, bad hands\nSteps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 42, Size: 512x768, Model: majicMIX'
  const p = parseA1111Parameters(text)

  it('提取提示词与参数', () => {
    expect(p.positive).toEqual(['masterpiece, a cat'])
    expect(p.negative).toEqual(['blurry, bad hands'])
    expect(p.samplers[0].steps).toBe(20)
    expect(p.samplers[0].cfg).toBe(7)
    expect(p.samplers[0].sampler).toBe('DPM++ 2M Karras')
    expect(p.samplers[0].seed).toBe('42')
    expect(p.width).toBe(512)
    expect(p.height).toBe(768)
    expect(p.models).toEqual(['majicMIX'])
  })

  it('解析 LoRA 标签、Lora hashes 与高清修复二阶段', () => {
    const text = [
      '<lora:add_detail:0.8>, <lora:style_v2:0.7:0.9>, masterpiece',
      'Negative prompt: blurry, <lyco:bad:0.5>',
      'Steps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 42, Size: 1024x1536, Model: majicMIX, Denoising strength: 0.7, Hires upscale: 2, Hires upscaler: Latent, Hires steps: 12, Lora hashes: "add_detail: aaaabbbb, style_v2: ccccdddd"',
    ].join('\n')
    const p = parseA1111Parameters(text)
    expect(p.loras.map((l) => [l.name, l.strengthModel, l.strengthClip, l.hash ?? null])).toEqual([
      ['add_detail', 0.8, 0.8, 'aaaabbbb'],
      ['style_v2', 0.7, 0.9, 'ccccdddd'],
      ['bad', 0.5, 0.5, null],
    ])
    expect(p.samplers).toHaveLength(2)
    const [s1, s2] = p.samplers
    expect(s1.denoise).toBeUndefined() // 一阶段（txt2img）没有重绘幅度
    expect(s2.classType).toBe('Hires fix')
    expect(s2.steps).toBe(12) // Hires steps 覆盖
    expect(s2.cfg).toBe(7) // 未提供 Hires cfg 时继承一阶段
    expect(s2.seed).toBe('42')
    expect(s2.sampler).toBe('DPM++ 2M Karras') // 未提供 Hires sampler 时继承一阶段
    expect(s2.denoise).toBe(0.7) // 来自 Denoising strength
  })

  it('img2img（无 Hires 键）的 Denoising strength 保留在单阶段', () => {
    const p = parseA1111Parameters(
      'a cat\nNegative prompt: x\nSteps: 15, Sampler: Euler a, CFG scale: 6, Seed: 1, Denoising strength: 0.45, Size: 512x512',
    )
    expect(p.samplers).toHaveLength(1)
    expect(p.samplers[0].denoise).toBe(0.45)
  })
})

describe('internParseResult', () => {
  it('相同内容合并为同一引用值，undefined 透传，rawText 与原文归并', () => {
    clearInternPool()
    const a = internParseResult({ raw: { source: 'comfyui', prompt: '{"a":1}' } })
    const b = internParseResult({ raw: { source: 'a1111', parameters: '{"a":1}' } })
    expect(b.raw.parameters).toBe(a.raw.prompt)
    expect(a.raw.workflow).toBeUndefined()

    const params = parseA1111Parameters('Steps: 20')
    const c = internParseResult({ raw: { source: 'a1111', parameters: 'Steps: 20' }, params })
    expect(c.params?.rawText).toBe(c.raw.parameters)
    expect(internParseResult({ raw: { source: 'none' } }).raw.prompt).toBeUndefined()
    clearInternPool()
  })
})

/* ---------- Worker 池与回退编排（传输注入的假实现，不触碰真实 Worker） ---------- */

/** 可控假传输：post 返回的 promise 由测试手动 resolve / reject */
function makeFakeTransport() {
  const jobs: { file: File; resolve: (r: ParseResult) => void; reject: (e: unknown) => void }[] = []
  const transport: ParseTransport = {
    broken: false,
    terminated: false,
    terminate() {
      transport.terminated = true
    },
    post(file: File) {
      if (transport.broken) return Promise.reject(BROKEN)
      return new Promise((resolve, reject) => jobs.push({ file, resolve, reject }))
    },
  }
  return { transport, jobs }
}

/** 依次吐出给定传输的工厂（闭包内复用同一队列，避免每次调用重建数组） */
function factoryOf(...transports: ParseTransport[]) {
  const queue = [...transports]
  return () => queue.shift()!
}

describe('ParsePool（传输池）', () => {
  it('构造任一传输抛错时返回 null，已构造的传输被终止', async () => {
    const first = makeFakeTransport()
    let calls = 0
    const pool = new ParsePool(
      () => {
        calls++
        if (calls === 2) throw new Error('构造失败')
        return first.transport
      },
      2,
    )
    expect(await pool.create()).toBeNull()
    expect(first.transport.terminated).toBe(true)
  })

  it('健康探测超时返回 null 并终止全部传输', async () => {
    const a = makeFakeTransport()
    const b = makeFakeTransport()
    const pool = new ParsePool(factoryOf(a.transport, b.transport), 2, 20)
    expect(await pool.create()).toBeNull()
    expect(a.transport.terminated).toBe(true)
    expect(b.transport.terminated).toBe(true)
  })

  it('健康探测被拒绝时返回 null 并终止全部传输', async () => {
    const a = makeFakeTransport()
    const b = makeFakeTransport()
    const pool = new ParsePool(factoryOf(a.transport, b.transport), 2, 100)
    const creating = pool.create()
    a.jobs[0]!.reject(new Error('probe boom'))
    expect(await creating).toBeNull()
    expect(a.transport.terminated).toBe(true)
    expect(b.transport.terminated).toBe(true)
  })

  it('探测通过后按 round-robin 依次派发', async () => {
    const a = makeFakeTransport()
    const b = makeFakeTransport()
    const pool = new ParsePool(factoryOf(a.transport, b.transport), 2, 100)
    const creating = pool.create()
    a.jobs[0]!.resolve({ raw: { source: 'none' } })
    b.jobs[0]!.resolve({ raw: { source: 'none' } })
    const ok = await creating
    expect(ok).not.toBeNull()

    void ok!.parse(new File(['x'], '1.png'))
    void ok!.parse(new File(['x'], '2.png'))
    void ok!.parse(new File(['x'], '3.png'))
    expect(b.jobs.map((j) => j.file.name)).toEqual(['probe.png', '1.png', '3.png'])
    expect(a.jobs.map((j) => j.file.name)).toEqual(['probe.png', '2.png'])
  })
})

describe('ParseScheduler（回退编排）', () => {
  it('池不可用时整体回退主线程解析', async () => {
    const scheduler = new ParseScheduler(async () => null)
    const png = buildPng([textChunkAscii('prompt', COMFY_PROMPT_ASCII)])
    const result = await scheduler.parse(new File([png], 'c.png'))
    expect(result.raw.source).toBe('comfyui')
  })

  it('Worker 中途失效：该次解析回退主线程，池被终止且永久不再复用', async () => {
    const fake = makeFakeTransport()
    let createCalls = 0
    const scheduler = new ParseScheduler(() => {
      createCalls++
      const pool = new ParsePool(() => fake.transport, 1, 100)
      const creating = pool.create()
      // 探测任务在 create() 的同步段已入队，这里直接放行，探测随即通过
      fake.jobs[0]!.resolve({ raw: { source: 'none' } })
      return creating
    })
    const png = buildPng([textChunkAscii('prompt', COMFY_PROMPT_ASCII)])
    const file = new File([png], 'c.png')

    const pending = scheduler.parse(file)
    await vi.waitFor(() => {
      if (fake.jobs.length < 2) throw new Error('等待解析任务派发')
    })
    fake.jobs[1]!.reject(BROKEN) // Worker 解析途中整体失效
    const result = await pending
    expect(result.raw.source).toBe('comfyui') // 主线程兜底重新解析了同一文件
    expect(fake.transport.terminated).toBe(true)
    expect(createCalls).toBe(1)

    // 后续解析直接走主线程：不再建池，也不再入队新任务（探测 + 首次失败的尝试共 2 条）
    const again = await scheduler.parse(new File([png], 'c2.png'))
    expect(again.raw.source).toBe('comfyui')
    expect(createCalls).toBe(1)
    expect(fake.jobs).toHaveLength(2)
  })

  it('非 BROKEN 的解析错误原样向上抛出', async () => {
    const fake = makeFakeTransport()
    const scheduler = new ParseScheduler(() => {
      const pool = new ParsePool(() => fake.transport, 1, 100)
      const creating = pool.create()
      fake.jobs[0]!.resolve({ raw: { source: 'none' } })
      return creating
    })
    const pending = scheduler.parse(new File(['x'], 'a.png'))
    await vi.waitFor(() => {
      if (fake.jobs.length < 2) throw new Error('等待解析任务派发')
    })
    fake.jobs[1]!.reject(new Error('boom'))
    await expect(pending).rejects.toThrow('boom')
  })
})
