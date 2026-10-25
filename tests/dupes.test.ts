/**
 * 字节级完全重复检测（FEAT-2）：同内容分组、同尺寸不同内容、抽样相同但中间不同
 * （必须经全文件确认排除）、无文件条目跳过、按 mtime 新→旧编号。
 */
import { describe, expect, it } from 'vitest'
import { scanDuplicateFiles } from '../src/lib/dupes'
import type { ImageItem } from '../src/types'

function item(id: string, name: string, bytes: Uint8Array, mtime: number): ImageItem {
  const file = new File([bytes], name)
  return {
    id,
    file,
    url: '',
    name,
    size: file.size,
    mtime,
    status: 'done',
    source: 'none',
    raw: { source: 'none' },
  }
}

function bytes(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill)
}

describe('scanDuplicateFiles', () => {
  it('字节完全相同才归组，并按 mtime 新→旧排序', async () => {
    const content = bytes(4096, 7)
    const result = await scanDuplicateFiles([
      item('old', 'old.png', content, 1000),
      item('new', 'new.png', content, 3000),
      item('other', 'other.png', bytes(4096, 8), 2000),
    ])
    expect(result.groups).toEqual([['new', 'old']])
    expect(result.scanned).toBe(3)
    expect(result.total).toBe(3)
  })

  it('抽样头尾相同但中间不同：全文件确认不误判', async () => {
    const size = 200 * 1024
    const head = bytes(64 * 1024, 1)
    const tail = bytes(64 * 1024, 3)
    const middleA = bytes(size - head.length - tail.length, 2)
    const middleB = bytes(size - head.length - tail.length, 9)
    const a = new Uint8Array([...head, ...middleA, ...tail])
    const b = new Uint8Array([...head, ...middleB, ...tail])

    const result = await scanDuplicateFiles([
      item('a', 'a.png', a, 1000),
      item('b', 'b.png', b, 2000),
    ])
    expect(result.groups).toEqual([])
  })

  it('存档项（无原文件）与纯参数文件不参与扫描', async () => {
    const archived: ImageItem = {
      id: 'arch',
      url: '',
      name: 'arch.png',
      size: 3,
      mtime: 1,
      status: 'done',
      source: 'comfyui',
      raw: { source: 'comfyui' },
      detached: true,
    }
    const metaOnly: ImageItem = {
      ...item('meta', 'meta.json', bytes(10, 1), 1),
      metaOnly: true,
    }
    const content = bytes(10, 2)
    const result = await scanDuplicateFiles([
      archived,
      metaOnly,
      item('a', 'a.png', content, 2),
      item('b', 'b.png', content, 3),
    ])
    expect(result.groups).toEqual([['b', 'a']])
    expect(result.total).toBe(2)
  })

  it('cancelled 立即返回空结果', async () => {
    const content = bytes(1024, 1)
    const result = await scanDuplicateFiles(
      [item('a', 'a.png', content, 1), item('b', 'b.png', content, 2)],
      {
        cancelled: () => true,
      },
    )
    expect(result.groups).toEqual([])
  })
})
