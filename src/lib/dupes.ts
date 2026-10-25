/**
 * 字节级完全重复检测（FEAT-2 纯函数模块）：先按文件大小分组，再对同尺寸文件
 * 计算「头尾抽样指纹」，最后对指纹相同的候选做全文件分块比较，确认字节完全一致。
 * 抽样只用于缩小候选，任何清理动作都必须经过全文件确认，避免误删。
 * 不依赖 Vue / IndexedDB，可在单测中直接用 File 对象驱动。
 */
import type { ImageItem } from '../types'

/** 抽样块大小：头 64KB + 尾 64KB；同尺寸的大文件先靠它快速分组 */
const SAMPLE_BYTES = 64 * 1024
/** 全文件确认的分块大小：不把整份原图读进内存 */
const CHUNK_BYTES = 1024 * 1024

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export interface FileDupeScanOptions {
  onProgress?: (done: number, total: number) => void
  cancelled?: () => boolean
}

export interface FileDupeScanResult {
  /** 每个元素是一组字节完全相同的条目 id（按 mtime 新→旧） */
  groups: string[][]
  scanned: number
  total: number
}

function feedHash(bytes: Uint8Array, state: { h1: number; h2: number }) {
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!
    state.h1 = Math.imul(state.h1 ^ c, 0x01000193)
    state.h2 = Math.imul(state.h2 ^ c, 0x85ebca6b)
  }
}

async function sampleKey(file: File): Promise<string> {
  const state = { h1: 0x811c9dc5, h2: 0x01000193 }
  const headSize = Math.min(SAMPLE_BYTES, file.size)
  feedHash(new Uint8Array(await file.slice(0, headSize).arrayBuffer()), state)
  if (file.size > SAMPLE_BYTES) {
    // 与头部区间不重叠，避免小文件重复计入同一段
    const tailStart = Math.max(SAMPLE_BYTES, file.size - SAMPLE_BYTES)
    feedHash(new Uint8Array(await file.slice(tailStart).arrayBuffer()), state)
  }
  return `${file.size}:${(state.h1 >>> 0).toString(36)}:${(state.h2 >>> 0).toString(36)}`
}

/** 全文件逐块比较：命中候选后确认字节完全一致，流式读取，内存峰值为两个分块 */
async function filesEqual(a: File, b: File): Promise<boolean> {
  if (a.size !== b.size) return false
  for (let offset = 0; offset < a.size; offset += CHUNK_BYTES) {
    const end = Math.min(a.size, offset + CHUNK_BYTES)
    const [left, right] = await Promise.all([
      a.slice(offset, end).arrayBuffer(),
      b.slice(offset, end).arrayBuffer(),
    ])
    if (left.byteLength !== right.byteLength) return false
    const x = new Uint8Array(left)
    const y = new Uint8Array(right)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  }
  return true
}

/**
 * 扫描完全重复文件：
 * 1. 文件大小不同不可能字节相同，直接跳过；
 * 2. 同尺寸文件计算头尾抽样指纹，缩小候选；
 * 3. 同指纹候选做全文件确认，再按内容分区（抽样碰撞不会误合并）。
 */
export async function scanDuplicateFiles(
  items: ImageItem[],
  options: FileDupeScanOptions = {},
): Promise<FileDupeScanResult> {
  const bySize = new Map<number, ImageItem[]>()
  for (const item of items) {
    if (!item.file || item.metaOnly) continue
    const group = bySize.get(item.file.size)
    if (group) group.push(item)
    else bySize.set(item.file.size, [item])
  }

  const candidates = [...bySize.values()].filter((group) => group.length > 1)
  const total = candidates.reduce((n, group) => n + group.length, 0)
  let done = 0
  const exactGroups: ImageItem[][] = []

  for (const sizeGroup of candidates) {
    const bySample = new Map<string, ImageItem[]>()
    for (const item of sizeGroup) {
      if (options.cancelled?.()) return { groups: [], scanned: done, total }
      try {
        const key = await sampleKey(item.file!)
        const group = bySample.get(key)
        if (group) group.push(item)
        else bySample.set(key, [item])
      } catch {
        // 单个文件读取失败按「不重复」处理，不影响其余文件
      }
      done++
      options.onProgress?.(done, total)
      if (done % 20 === 0) await yieldToMain()
    }

    for (const sampleGroup of bySample.values()) {
      if (sampleGroup.length < 2) continue
      const partitions: ImageItem[][] = []
      for (const item of sampleGroup) {
        if (options.cancelled?.()) return { groups: [], scanned: done, total }
        let placed = false
        for (const partition of partitions) {
          try {
            if (await filesEqual(partition[0]!.file!, item.file!)) {
              partition.push(item)
              placed = true
              break
            }
          } catch {
            // 读取失败时不让该文件并入任何组
          }
        }
        if (!placed) partitions.push([item])
        await yieldToMain()
      }
      for (const partition of partitions) {
        if (partition.length > 1) exactGroups.push(partition)
      }
    }
  }

  const groups = exactGroups.map((group) =>
    group.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).map((item) => item.id),
  )
  return { groups, scanned: done, total }
}
