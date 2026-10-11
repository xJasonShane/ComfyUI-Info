import { describe, expect, it } from 'vitest'
import {
  buildDatasetZip,
  buildExportCsv,
  buildExportJson,
  buildImagesZip,
  buildParamsSummary,
  buildWorkflowZip,
  ZipCapacityError,
} from '../src/lib/export'
import type { ImageItem, ParsedParams } from '../src/types'

function makeItem(over: Partial<ImageItem>): ImageItem {
  return {
    id: 'img-1',
    file: new File(['x'], 'a.png'),
    url: 'blob:mock',
    name: 'a.png',
    size: 1234,
    mtime: 1_700_000_000_000,
    status: 'done',
    source: 'comfyui',
    raw: { source: 'comfyui' },
    ...over,
  }
}

const params: ParsedParams = {
  positive: ['masterpiece, a cat'],
  negative: ['blurry'],
  models: ['dreamshaper_8.safetensors'],
  loras: [{ name: 'add_detail', strengthModel: 0.8, strengthClip: 0.8, hash: 'aaaabbbb' }],
  samplers: [
    {
      nodeId: '0',
      classType: 'A1111',
      steps: 20,
      cfg: 7,
      sampler: 'DPM++ 2M Karras',
      scheduler: 'karras',
      seed: '42',
    },
    { nodeId: 'hires', classType: 'Hires fix', steps: 12, denoise: 0.7 },
  ],
  vaes: ['vae-ft-mse'],
  clipSkip: 2,
  upscalers: [],
  controlNets: [],
  width: 1024,
  height: 1536,
  batch: 2,
  nodeCount: 9,
}

describe('buildExportJson', () => {
  it('包含解析参数与来源，解析失败项带错误信息', () => {
    const parsed = JSON.parse(
      buildExportJson([
        makeItem({ params, path: 'sets/v2/a.png' }),
        makeItem({ name: 'bad.png', status: 'error', source: 'none', error: '读取失败' }),
      ]),
    )
    expect(parsed.count).toBe(2)
    expect(parsed.items[0].file).toBe('a.png')
    expect(parsed.items[0].path).toBe('sets/v2/a.png')
    expect(parsed.items[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.items[0].models).toEqual(['dreamshaper_8.safetensors'])
    expect(parsed.items[0].loras[0].hash).toBe('aaaabbbb')
    expect(parsed.items[0].samplers).toHaveLength(2)
    expect(parsed.items[0].vaes).toEqual(['vae-ft-mse'])
    expect(parsed.items[0].clipSkip).toBe(2)
    expect(parsed.items[1].source).toBe('error')
    expect(parsed.items[1].error).toBe('读取失败')
    expect(parsed.items[1].positive).toBeUndefined()
    expect(parsed.items[1].path).toBeUndefined() // 单选文件无目录信息时不输出路径
  })
})

describe('buildExportCsv', () => {
  it('带 BOM 与表头，含逗号/换行的字段按 CSV 规则转义', () => {
    const csv = buildExportCsv([makeItem({ params })])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines).toHaveLength(2)
    expect(
      lines[0].startsWith(
        '文件名,路径,大小(字节),来源,修改时间,模型,模型哈希,LoRA,Clip Skip,VAE,放大模型,ControlNet,采样器',
      ),
    ).toBe(true)
    expect(lines[1].startsWith('a.png,,1234')).toBe(true) // 无路径时路径列留空
    expect(lines[1]).toContain('"masterpiece, a cat"') // 含逗号的提示词整体加引号
    expect(lines[1]).toContain('add_detail(m:0.8 c:0.8 #aaaabbbb)')
    expect(lines[1]).toContain('#hires Hires fix, steps=12, denoise=0.7') // 二阶段摘要
    expect(lines[1]).toContain('DPM++ 2M Karras')
  })

  it('路径列输出相对路径', () => {
    const csv = buildExportCsv([makeItem({ params, path: 'sets/v2/a.png' })])
    const line = csv.slice(1).split('\r\n')[1]
    expect(line.startsWith('a.png,sets/v2/a.png,1234')).toBe(true)
  })

  it('存档项（无 file）导出正常，修改时间取自 mtime', () => {
    const csv = buildExportCsv([makeItem({ file: undefined, detached: true })])
    const row = csv.slice(1).split('\r\n')[1]!.split(',')
    expect(row.slice(0, 5)).toEqual([
      'a.png',
      '',
      '1234',
      'comfyui',
      new Date(1_700_000_000_000).toISOString(),
    ])
  })

  it('公式注入防护：= - 开头的文本列前置单引号，数字列不受影响', () => {
    const csv = buildExportCsv([
      makeItem({
        name: '-canvas.png',
        params: { ...params, positive: ['=1+1 CMD|"calc"'], samplers: [] },
      }),
    ])
    const line = csv.slice(1).split('\r\n')[1]!
    expect(line.startsWith("'-canvas.png,")) // 文件名列同样防护
    expect(line).toContain('\'=1+1 CMD|""calc"""') // 提示词列：先加 ' 防公式，再按含引号规则转义
    expect(line).toContain(',1234,') // 大小为数字：不加前缀
  })

  it('无参数项参数列留空，错误项带错误列', () => {
    const csv = buildExportCsv([
      makeItem({ source: 'none', raw: { source: 'none' } }),
      makeItem({ name: 'bad.png', status: 'error', source: 'none', error: 'boom' }),
    ])
    const rows = csv.slice(1).split('\r\n')
    const empty = rows[1].split(',')
    expect(empty).toHaveLength(25)
    expect(empty.slice(0, 4)).toEqual(['a.png', '', '1234', 'none'])
    expect(empty[4]).toMatch(/^\d{4}-\d{2}-\d{2}T/) // 修改时间（ISO）
    expect(empty.slice(5).every((c) => c === '')).toBe(true)
    const failed = rows[2].split(',')
    expect(failed[3]).toBe('error')
    expect(failed[24]).toBe('boom')
  })

  it('扩展参数列：Clip Skip / VAE / 放大模型 / ControlNet（FEAT-2）', () => {
    const csv = buildExportCsv([
      makeItem({
        params: {
          ...params,
          modelHash: 'abc123def',
          vaes: ['vae-ft-mse'],
          clipSkip: 2,
          upscalers: ['4x-US'],
          controlNets: ['canny'],
        },
      }),
    ])
    const line = csv.slice(1).split('\r\n')[1]!
    expect(line).toContain(',dreamshaper_8.safetensors,abc123def,add_detail(m:0.8 c:0.8 #aaaabbbb)')
    expect(line).toContain(',2,vae-ft-mse,4x-US,canny,DPM++ 2M Karras')
  })
})

describe('buildParamsSummary', () => {
  it('A1111 风格摘要：正向 + LoRA 标签 + Negative prompt 行 + 尾部键值与多阶段摘要', () => {
    const text = buildParamsSummary(params)
    expect(text.startsWith('masterpiece, a cat\n<lora:add_detail:0.8>')).toBe(true)
    expect(text).toContain('Negative prompt: blurry')
    expect(text).toContain(
      'Steps: 20, Sampler: DPM++ 2M Karras, Schedule type: karras, CFG scale: 7, Seed: 42',
    )
    expect(text).toContain('Size: 1024x1536, Batch size: 2, Model: dreamshaper_8.safetensors')
    expect(text).toContain('Clip skip: 2, VAE: vae-ft-mse')
    // 二阶段不并入主键值，以单行摘要附后
    expect(text).toContain('Stage #hires Hires fix: steps=12, denoise=0.7')
  })

  it('双强度 LoRA 标签、无强度标签与 Model hash', () => {
    const text = buildParamsSummary({
      ...params,
      modelHash: 'abc123def',
      loras: [
        { name: 'a', strengthModel: 0.7, strengthClip: 0.9 },
        { name: 'b', strengthModel: 0.8, strengthClip: 0.8 },
        { name: 'c' },
      ],
      samplers: [],
      vaes: [],
      batch: 1,
      clipSkip: undefined,
    })
    expect(text).toContain('<lora:a:0.7:0.9>, <lora:b:0.8>, <lora:c>')
    expect(text).toContain('Model hash: abc123def')
    expect(text).not.toContain('Steps:') // 无采样阶段时不虚构键值
  })
})

describe('buildWorkflowZip', () => {
  it('store 模式 ZIP：本地头、条目数据与 EOCD 可直接解出', async () => {
    const blob = await buildWorkflowZip([
      makeItem({
        params,
        raw: { source: 'comfyui', prompt: '{"a":1}', workflow: '{"b":2}' },
        path: 'sets/v1/a.png',
      }),
    ])!
    expect(blob.type).toBe('application/zip')
    const zip = new Uint8Array(await blob.arrayBuffer())
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(dv.getUint32(0, true)).toBe(0x04034b50) // local file header
    const nameLen = dv.getUint16(26, true)
    const size = dv.getUint32(18, true)
    const name = new TextDecoder().decode(zip.subarray(30, 30 + nameLen))
    expect(name).toBe('sets/v1/a.prompt.json')
    const data = new TextDecoder().decode(zip.subarray(30 + nameLen, 30 + nameLen + size))
    expect(data).toBe('{"a":1}')

    const eocd = zip.length - 22
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
    expect(dv.getUint16(eocd + 10, true)).toBe(3) // prompt + workflow + manifest
  })

  it('A1111 项打包为 parameters.txt，条目含 manifest；空列表返回 null', async () => {
    const blob = await buildWorkflowZip([
      makeItem({ source: 'a1111', raw: { source: 'a1111', parameters: 'Steps: 20' } }),
    ])!
    const zip = new Uint8Array(await blob.arrayBuffer())
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('a.parameters.txt')
    expect(text).toContain('Steps: 20')
    expect(text).toContain('manifest.json')
    expect(await buildWorkflowZip([])).toBeNull()
  })

  it('同工作流批量出图：相同内容的条目数据逐字节一致（编码缓存不串内容）', async () => {
    const blob = await buildWorkflowZip([
      makeItem({ raw: { source: 'comfyui', prompt: '{"a":1}' }, name: 'a.png' }),
      makeItem({ raw: { source: 'comfyui', prompt: '{"a":1}' }, name: 'b.png' }),
      makeItem({ raw: { source: 'comfyui', prompt: '{"other":2}' }, name: 'c.png' }),
    ])!
    const zip = new Uint8Array(await blob.arrayBuffer())
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('a.prompt.json')
    expect(text).toContain('b.prompt.json')
    expect(text).toContain('c.prompt.json')
    // 三份 prompt 条目 + manifest：数据区各条目内容与来源串一致
    expect(text).toContain('{"a":1}')
    expect(text).toContain('{"other":2}')
    expect(dv_entryCount(zip)).toBe(4) // 3 × prompt.json + manifest.json
  })
})

describe('buildImagesZip', () => {
  it('按相对路径打包原图字节，跳过存档 / 参数文件项，空列表返回 null', async () => {
    const blob = await buildImagesZip([
      makeItem({ path: 'sets/v1/a.png', file: new File([new Uint8Array([1, 2, 3])], 'a.png') }),
      makeItem({ name: 'b.png', file: new File([new Uint8Array([4])], 'b.png'), path: undefined }),
      // 存档项（无文件）与参数文件（无图片本体）都不打包
      makeItem({ name: 'c.png', file: undefined, detached: true }),
      makeItem({ name: 'p.json', metaOnly: true, file: new File(['{}'], 'p.json') }),
    ])!
    expect(blob.type).toBe('application/zip')
    const zip = new Uint8Array(await blob.arrayBuffer())
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
    const nameLen = dv.getUint16(26, true)
    const size = dv.getUint32(18, true)
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe('sets/v1/a.png')
    expect(size).toBe(3)
    expect(dv_entryCount(zip)).toBe(2)
    expect(await buildImagesZip([makeItem({ file: undefined, detached: true })])).toBeNull()
  })

  it('无路径同名文件（不同指纹项）条目名追加序号，ZIP 内不重名', async () => {
    const blob = await buildImagesZip([
      makeItem({ name: 'a.png', file: new File([new Uint8Array([1])], 'a.png'), size: 1 }),
      makeItem({ name: 'a.png', file: new File([new Uint8Array([2])], 'a.png'), size: 2 }),
    ])!
    const zip = new Uint8Array(await blob.arrayBuffer())
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('a.png')
    expect(text).toContain('a (2).png')
    expect(dv_entryCount(zip)).toBe(2)
  })

  it('Blob 条目的 CRC 与文件内容一致（解包工具可校验）', async () => {
    // CRC32("hello") = 0x3610a686
    const blob = await buildImagesZip([
      makeItem({ name: 'a.png', file: new File(['hello'], 'a.png') }),
    ])!
    const zip = new Uint8Array(await blob.arrayBuffer())
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(dv.getUint32(14, true)).toBe(0x3610a686 >>> 0)
  })
})

describe('buildDatasetZip', () => {
  it('原图 + 同名 .txt 标注（正向提示词），按相对路径成对打包', async () => {
    const blob = await buildDatasetZip([
      makeItem({
        params,
        path: 'sets/v1/a.png',
        file: new File([new Uint8Array([1, 2, 3])], 'a.png'),
      }),
    ])!
    expect(blob.type).toBe('application/zip')
    const zip = new Uint8Array(await blob.arrayBuffer())
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
    const nameLen = dv.getUint16(26, true)
    const size = dv.getUint32(18, true)
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe('sets/v1/a.png')
    expect(size).toBe(3)
    // 第二条目是同名 .txt 标注，内容为正向提示词
    const second = 30 + nameLen + size
    const name2Len = dv.getUint16(second + 26, true)
    const size2 = dv.getUint32(second + 18, true)
    expect(new TextDecoder().decode(zip.subarray(second + 30, second + 30 + name2Len))).toBe(
      'sets/v1/a.txt',
    )
    expect(
      new TextDecoder().decode(
        zip.subarray(second + 30 + name2Len, second + 30 + name2Len + size2),
      ),
    ).toBe('masterpiece, a cat')
    expect(dv_entryCount(zip)).toBe(2)
    expect(await buildDatasetZip([])).toBeNull()
  })

  it('同名冲突：标注名跟随图片的去重序号，不串对', async () => {
    const blob = await buildDatasetZip([
      makeItem({ name: 'a.png', params, file: new File([new Uint8Array([1])], 'a.png') }),
      makeItem({ name: 'a.png', file: new File([new Uint8Array([2])], 'a.png') }),
    ])!
    const zip = new Uint8Array(await blob.arrayBuffer())
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('a.txt')
    expect(text).toContain('a (2).png')
    expect(text).toContain('a (2).txt')
    expect(dv_entryCount(zip)).toBe(4)
  })

  it('无参数 / 无正向提示词的图片给空标注占位', async () => {
    const blob = await buildDatasetZip([
      makeItem({ name: 'b.png', file: new File([new Uint8Array([9])], 'b.png') }),
      makeItem({
        name: 'c.png',
        params: { ...params, positive: ['', '  '] },
        file: new File([new Uint8Array([8])], 'c.png'),
      }),
    ])!
    const zip = new Uint8Array(await blob.arrayBuffer())
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    // b.png 的标注 b.txt 是第二条目，内容为空（大小 0）
    const nameLen = dv.getUint16(26, true)
    const second = 30 + nameLen + dv.getUint32(18, true)
    expect(
      new TextDecoder().decode(
        zip.subarray(second + 30, second + 30 + dv.getUint16(second + 26, true)),
      ),
    ).toBe('b.txt')
    expect(dv.getUint32(second + 18, true)).toBe(0)
    expect(dv_entryCount(zip)).toBe(4)
  })
})

/** 读 EOCD 的条目总数（测试辅助） */
function dv_entryCount(zip: Uint8Array): number {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  return dv.getUint16(zip.length - 22 + 10, true)
}

describe('ZIP 容量校验（B5）', () => {
  it('条目数超 65535 时拒绝导出并给出可读错误（无 ZIP64，静默损坏不如显式报错）', async () => {
    const items = Array.from({ length: 65_536 }, (_, i) =>
      makeItem({
        id: `i${i}`,
        name: `f${i}.png`,
        path: `d/f${i}.png`,
        raw: { source: 'comfyui', prompt: 'w' },
      }),
    )
    const err = await buildWorkflowZip(items).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ZipCapacityError)
    expect((err as Error).message).toContain('65537')
  })

  it('总大小超 4GB 时在流式 CRC 之前前置拒绝', async () => {
    // size 造假即可：校验先于任何对 Blob 内容的读取
    const big = { size: 4 * 1024 ** 3 + 1 } as unknown as File
    const items = [makeItem({ file: big })]
    await expect(buildImagesZip(items)).rejects.toBeInstanceOf(ZipCapacityError)
    await expect(buildDatasetZip(items)).rejects.toBeInstanceOf(ZipCapacityError)
  })
})
