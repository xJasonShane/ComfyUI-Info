/**
 * 生成浏览器测试用的样例图片（可正常渲染的 PNG + 真实形态的 ComfyUI/A1111 元数据）。
 * 用法：node scripts/make-fixtures.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')
mkdirSync(outDir, { recursive: true })

/* ---------- PNG 编码 ---------- */
let crcTable
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** rgb: (x, y) => [r, g, b]，取值 0-255；textChunks 插在 IHDR 与 IDAT 之间 */
function encodePng(w, h, rgb, textChunks = []) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let off = 0
  for (let y = 0; y < h; y++) {
    raw[off++] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(x, y)
      raw[off++] = r
      raw[off++] = g
      raw[off++] = b
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...textChunks,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const textChunk = (keyword, text) =>
  chunk(
    'tEXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]),
  )

const itxtChunk = (keyword, text) =>
  chunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0, 1, 0, 0, 0]), // \0 + 压缩标志 + 压缩方法 + 空语言标签 + 空翻译关键字
      deflateSync(Buffer.from(text, 'utf8')),
    ]),
  )

function writePng(name, metaChunks, w, h, rgb) {
  const parts = metaChunks.map(([kw, text, zlib]) =>
    zlib ? itxtChunk(kw, text) : textChunk(kw, text),
  )
  writeFileSync(join(outDir, name), encodePng(w, h, rgb, parts))
}

/* ---------- 样例工作流 ---------- */
const basePrompt = {
  3: {
    class_type: 'KSampler',
    inputs: {
      // 刻意超出 2^53 的大数种子，验证前端 64 位 seed 展示；JSON 序列化取最近似值即可
      // eslint-disable-next-line no-loss-of-precision
      seed: 834129057123456789,
      steps: 30,
      cfg: 7.5,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'juggernautXL_v9.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 2 } },
  6: {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: 'a cozy cabin in snowy forest, warm window light, masterpiece, best quality',
      clip: ['4', 1],
    },
  },
  7: {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'lowres, blurry, watermark', clip: ['4', 1] },
  },
}

const hiresPrompt = {
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
  8: {
    class_type: 'LoraLoader',
    inputs: {
      lora_name: 'add_detail.safetensors',
      strength_model: 0.8,
      strength_clip: 0.8,
      model: ['4', 0],
      clip: ['4', 1],
    },
  },
  3: {
    class_type: 'KSampler',
    inputs: {
      seed: 42,
      steps: 28,
      cfg: 6.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['8', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
  6: {
    class_type: 'CLIPTextEncode',
    inputs: { text: '一只戴帽子的橘猫，吉卜力风格，柔和的阳光', clip: ['8', 1] },
  },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '低质量, 模糊, 变形', clip: ['8', 1] } },
  10: {
    class_type: 'LatentUpscale',
    inputs: {
      upscale_method: 'nearest-exact',
      width: 1536,
      height: 2048,
      crop: 'disabled',
      samples: ['3', 0],
    },
  },
  11: {
    class_type: 'KSampler',
    inputs: {
      seed: 99,
      steps: 15,
      cfg: 6.0,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 0.45,
      model: ['8', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['10', 0],
    },
  },
}

const a1111Params =
  'masterpiece, a girl with silver hair, city lights, night\n' +
  'Negative prompt: lowres, bad anatomy\n' +
  'Steps: 25, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 3671090129, Size: 512x768, Model: majicMIX realistic v7'

/* ---------- 写出样例 ---------- */
const W = 320
const H = 240

// 1. ComfyUI · ASCII tEXt · 雪屋（冷色调横图）
writePng(
  'comfy-cabin.png',
  [
    ['prompt', JSON.stringify(basePrompt)],
    ['workflow', JSON.stringify({ last_node_id: 9, nodes: [], version: 0.4 })],
  ],
  W,
  H,
  (x, y) => {
    const t = y / H
    const snow = (x * 7 + y * 13) % 97 > 88 ? 60 : 0
    return [30 + t * 40 + snow, 55 + t * 55 + snow, 90 + t * 80 + snow]
  },
)

// 2. ComfyUI · iTXt zlib 中文 · 高清修复两阶段 + LoRA（竖图）
writePng(
  'comfy-猫娘-两阶段.png',
  [
    ['prompt', JSON.stringify(hiresPrompt), true],
    ['workflow', JSON.stringify({ last_node_id: 12, nodes: [], version: 0.4 }), true],
  ],
  240,
  320,
  (x, y) => [235 - (x / 240) * 60, 150 + ((x + y) / 560) * 60, 60 + (y / 320) * 90],
)

// 3. ComfyUI · 中文 iTXt · 单阶段（横图，暖色）
writePng('comfy-森林小屋.png', [['prompt', JSON.stringify(basePrompt), true]], W, H, (x, y) => [
  190 - (y / H) * 80,
  120 + Math.sin(x / 22) * 30,
  60 + (x / W) * 50,
])

// 4. A1111 parameters 文本
writePng('a1111-girl.png', [['parameters', a1111Params]], 240, 320, (x, y) => [
  40 + (x / 240) * 90,
  60 + (y / 320) * 110,
  120 + Math.cos(x / 18) * 50,
])

// 5. 无元数据普通图
writePng('plain-photo.png', [], W, H, (x, y) => [
  168 + ((x + y) % 3) * 18,
  168,
  162 - ((x * y) % 5) * 6,
])

// 6. 第二张 ComfyUI（同模型不同种子，便于筛选演示）
const prompt2 = JSON.parse(JSON.stringify(basePrompt))
// eslint-disable-next-line no-loss-of-precision
prompt2['3'].inputs.seed = 12345678901234567
prompt2['3'].inputs.steps = 22
prompt2['3'].inputs.cfg = 4.5
writePng('comfy-cabin-v2.png', [['prompt', JSON.stringify(prompt2), true]], W, H, (x, y) => [
  90 + (x / W) * 120,
  70 + (y / H) * 60,
  160 - (x / W) * 80,
])

console.log('fixtures written to', outDir)
