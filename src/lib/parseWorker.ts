/**
 * 解析 Worker：文件元数据读取 + 参数提取全部在后台线程执行，
 * 避免批量扫描时的 JSON.parse / 正则 / 工作流遍历阻塞主线程。
 * 经 ?worker&inline 打进单文件产物；构造失败或无响应时由 parser.ts 整体回退主线程。
 */
import { extractParams, readImageMetadata } from './metadata'
import type { ParsedParams, RawMetadata } from '../types'

export interface ParseWorkerRequest {
  id: number
  file?: File
}

export interface ParseWorkerReply {
  id: number
  raw?: RawMetadata
  params?: ParsedParams
  error?: string
}

const ctx = self as unknown as {
  postMessage: (msg: ParseWorkerReply) => void
  onmessage: ((e: MessageEvent<ParseWorkerRequest>) => void) | null
}

ctx.onmessage = async (e) => {
  const { id, file } = e.data
  if (!file) return
  try {
    const raw = await readImageMetadata(file)
    ctx.postMessage({ id, raw, params: extractParams(raw) })
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
