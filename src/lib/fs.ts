/**
 * File System Access API 封装：目录选择、句柄权限、递归枚举。
 * 仅 Chromium 系浏览器支持——不支持时 showDirectoryPicker 不存在，
 * 调用方据 supportsDirectoryPicker() 回退到 webkitdirectory 输入框。
 */
import type { IncomingFile } from '../types'

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: string
    }) => Promise<FileSystemDirectoryHandle>
  }
}

type PermissionAwareHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** 打开系统目录选择器；用户取消返回 null */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await window.showDirectoryPicker!({ id: 'comfyui-info', mode: 'read' })) ?? null
  } catch {
    return null
  }
}

/** 读取权限检查 + 请求（requestPermission 需在用户手势内调用，按钮点击满足） */
export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as PermissionAwareHandle
  try {
    if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) === 'granted') return true
    if (h.requestPermission && (await h.requestPermission({ mode: 'read' })) === 'granted') {
      return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * 递归枚举目录下全部文件（含子目录），相对路径以目录名为根（如 root/sub/a.png）。
 * 不做格式过滤——入列前的扩展名 / 魔数过滤由 addFiles 统一处理。
 * 单个文件读取失败（如悬空符号链接）跳过，不影响其余。
 */
export async function collectDirectoryFiles(
  handle: FileSystemDirectoryHandle,
): Promise<IncomingFile[]> {
  const out: IncomingFile[] = []
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'file') {
        try {
          const file = await (entry as FileSystemFileHandle).getFile()
          out.push({ file, path: `${prefix}${name}` })
        } catch {
          // 单个文件不可读时跳过
        }
      } else {
        await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`)
      }
    }
  }
  await walk(handle, `${handle.name}/`)
  return out
}
