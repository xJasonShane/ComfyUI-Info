/**
 * 解析 Worker：文件元数据读取 + 参数提取全部在后台线程执行，
 * 避免批量扫描时的 JSON.parse / 正则 / 工作流遍历阻塞主线程。
 * 经 ?worker&inline 打进单文件产物；构造失败或无响应时由 parser.ts 整体回退主线程。
 */
import { extractParams, readImageMetadataWithThumb } from './metadata'
import type { ParsedParams, RawMetadata } from '../types'

export interface ParseWorkerRequest {
  id: number
  file?: File
}

export interface ParseWorkerReply {
  id: number
  raw?: RawMetadata
  params?: ParsedParams
  /** F2：EXIF 内嵌缩略图（结构化克隆只拷贝视图覆盖的字节） */
  thumb?: Uint8Array
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
    const { raw, thumb } = await readImageMetadataWithThumb(file)
    ctx.postMessage({ id, raw, params: extractParams(raw), thumb })
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
