import { describe, expect, it } from 'vitest'
import { buildExportCsv, buildExportJson } from '../src/lib/export'
import type { ImageItem, ParsedParams } from '../src/types'

function makeItem(over: Partial<ImageItem>): ImageItem {
  return {
    id: 'img-1',
    file: new File(['x'], 'a.png'),
    url: 'blob:mock',
    name: 'a.png',
    size: 1234,
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
        makeItem({ params }),
        makeItem({ name: 'bad.png', status: 'error', source: 'none', error: '读取失败' }),
      ]),
    )
    expect(parsed.count).toBe(2)
    expect(parsed.items[0].file).toBe('a.png')
    expect(parsed.items[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.items[0].models).toEqual(['dreamshaper_8.safetensors'])
    expect(parsed.items[0].loras[0].hash).toBe('aaaabbbb')
    expect(parsed.items[0].samplers).toHaveLength(2)
    expect(parsed.items[1].source).toBe('error')
    expect(parsed.items[1].error).toBe('读取失败')
    expect(parsed.items[1].positive).toBeUndefined()
  })
})

describe('buildExportCsv', () => {
  it('带 BOM 与表头，含逗号/换行的字段按 CSV 规则转义', () => {
    const csv = buildExportCsv([makeItem({ params })])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith('文件名,大小(字节),来源,修改时间,模型,LoRA')).toBe(true)
    expect(lines[1]).toContain('"masterpiece, a cat"') // 含逗号的提示词整体加引号
    expect(lines[1]).toContain('add_detail(m:0.8 c:0.8 #aaaabbbb)')
    expect(lines[1]).toContain('#hires Hires fix, steps=12, denoise=0.7') // 二阶段摘要
    expect(lines[1]).toContain('DPM++ 2M Karras')
  })

  it('无参数项参数列留空，错误项带错误列', () => {
    const csv = buildExportCsv([
      makeItem({ source: 'none', raw: { source: 'none' } }),
      makeItem({ name: 'bad.png', status: 'error', source: 'none', error: 'boom' }),
    ])
    const rows = csv.slice(1).split('\r\n')
    const empty = rows[1].split(',')
    expect(empty).toHaveLength(19)
    expect(empty.slice(0, 3)).toEqual(['a.png', '1234', 'none'])
    expect(empty[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/) // 修改时间（ISO）
    expect(empty.slice(4).every((c) => c === '')).toBe(true)
    const failed = rows[2].split(',')
    expect(failed[2]).toBe('error')
    expect(failed[18]).toBe('boom')
  })
})
