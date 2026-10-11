/**
 * fs.ts 直测（E2）：目录递归枚举此前只被 store 测试 mock，
 * 这里以假句柄树验证递归 / 相对路径 / 分批交付 / 单文件失败跳过与权限检查分支。
 */
import { describe, expect, it } from 'vitest'
import { collectDirectoryFiles, ensureReadPermission } from '../src/lib/fs'
import type { IncomingFile } from '../src/types'

function fileHandle(name: string): FileSystemFileHandle {
  const file = new File(['x'], name)
  return {
    kind: 'file',
    name,
    getFile: async () => file,
  } as unknown as FileSystemFileHandle
}

function dirHandle(name: string, children: FileSystemHandle[]): FileSystemDirectoryHandle {
  const map = new Map(children.map((c) => [c.name, c]))
  return {
    kind: 'directory',
    name,
    // 协议返回 AsyncIterable<[name, handle]>；假实现按插入序枚举
    async *entries() {
      for (const [n, h] of map) yield [n, h] as [string, FileSystemHandle]
    },
  } as unknown as FileSystemDirectoryHandle
}

describe('collectDirectoryFiles', () => {
  it('递归枚举并保留相对路径（以根目录名为前缀）', async () => {
    const tree = dirHandle('root', [
      fileHandle('a.png'),
      dirHandle('sub', [fileHandle('b.png'), dirHandle('deep', [fileHandle('c.jpg')])]),
    ])
    const batches: IncomingFile[][] = []
    const total = await collectDirectoryFiles(tree, (files) => batches.push(files))
    const paths = batches.flat().map((f) => f.path)
    expect(total).toBe(3)
    expect(paths).toEqual(['root/a.png', 'root/sub/b.png', 'root/sub/deep/c.jpg'])
  })

  it('攒批交付：超过批大小时分批回调，末尾不足一批也交付', async () => {
    const files = Array.from({ length: 450 }, (_, i) => fileHandle(`f${i}.png`))
    const tree = dirHandle('root', files)
    const sizes: number[] = []
    const total = await collectDirectoryFiles(tree, (batch) => sizes.push(batch.length))
    expect(total).toBe(450)
    expect(sizes).toEqual([200, 200, 50])
  })

  it('单个文件 getFile 失败时跳过，不影响其余', async () => {
    const broken = {
      kind: 'file',
      name: 'broken.png',
      getFile: async () => {
        throw new Error('dangling')
      },
    } as unknown as FileSystemFileHandle
    const tree = dirHandle('root', [fileHandle('ok.png'), broken])
    const paths: string[] = []
    const total = await collectDirectoryFiles(tree, (files) =>
      paths.push(...files.map((f) => f.path!)),
    )
    expect(total).toBe(1)
    expect(paths).toEqual(['root/ok.png'])
  })
})

describe('ensureReadPermission', () => {
  const withPerms = (
    query: PermissionState | 'throw',
    request?: PermissionState | 'throw',
  ): FileSystemDirectoryHandle =>
    ({
      name: 'h',
      queryPermission: async () => {
        if (query === 'throw') throw new Error('SecurityError')
        return query
      },
      requestPermission:
        request === undefined
          ? undefined
          : async () => {
              if (request === 'throw') throw new Error('SecurityError')
              return request
            },
    }) as unknown as FileSystemDirectoryHandle

  it('已授权（granted）直接放行，不再请求', async () => {
    const h = withPerms('granted', 'denied')
    expect(await ensureReadPermission(h)).toBe(true)
  })

  it('prompt 状态下请求授权：授予放行、拒绝不放行', async () => {
    expect(await ensureReadPermission(withPerms('prompt', 'granted'))).toBe(true)
    expect(await ensureReadPermission(withPerms('prompt', 'denied'))).toBe(false)
  })

  it('无 queryPermission 能力的环境直接走请求', async () => {
    const h = {
      name: 'h',
      requestPermission: async () => 'granted',
    } as unknown as FileSystemDirectoryHandle
    expect(await ensureReadPermission(h)).toBe(true)
  })

  it('权限 API 抛错（安全软件拦截等）按未授权处理，不抛异常', async () => {
    expect(await ensureReadPermission(withPerms('throw'))).toBe(false)
    expect(await ensureReadPermission(withPerms('prompt', 'throw'))).toBe(false)
  })
})
