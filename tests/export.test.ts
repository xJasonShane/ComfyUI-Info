import { describe, expect, it } from 'vitest'
import { buildExportCsv, buildExportJson, buildWorkflowZip } from '../src/lib/export'
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
    expect(lines[0].startsWith('文件名,路径,大小(字节),来源,修改时间,模型,LoRA')).toBe(true)
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

  it('无参数项参数列留空，错误项带错误列', () => {
    const csv = buildExportCsv([
      makeItem({ source: 'none', raw: { source: 'none' } }),
      makeItem({ name: 'bad.png', status: 'error', source: 'none', error: 'boom' }),
    ])
    const rows = csv.slice(1).split('\r\n')
    const empty = rows[1].split(',')
    expect(empty).toHaveLength(20)
    expect(empty.slice(0, 4)).toEqual(['a.png', '', '1234', 'none'])
    expect(empty[4]).toMatch(/^\d{4}-\d{2}-\d{2}T/) // 修改时间（ISO）
    expect(empty.slice(5).every((c) => c === '')).toBe(true)
    const failed = rows[2].split(',')
    expect(failed[3]).toBe('error')
    expect(failed[19]).toBe('boom')
  })
})

describe('buildWorkflowZip', () => {
  it('store 模式 ZIP：本地头、条目数据与 EOCD 可直接解出', () => {
    const zip = buildWorkflowZip([
      makeItem({
        params,
        raw: { source: 'comfyui', prompt: '{"a":1}', workflow: '{"b":2}' },
        path: 'sets/v1/a.png',
      }),
    ])!
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

  it('A1111 项打包为 parameters.txt，条目含 manifest；空列表返回 null', () => {
    const zip = buildWorkflowZip([
      makeItem({ source: 'a1111', raw: { source: 'a1111', parameters: 'Steps: 20' } }),
    ])!
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('a.parameters.txt')
    expect(text).toContain('Steps: 20')
    expect(text).toContain('manifest.json')
    expect(buildWorkflowZip([])).toBeNull()
  })
})
