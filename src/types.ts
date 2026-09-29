export type ImageSource = 'comfyui' | 'a1111' | 'none'

export interface RawMetadata {
  source: ImageSource
  /** ComfyUI API 格式工作流 JSON 文本 */
  prompt?: string
  /** ComfyUI UI 格式工作流 JSON 文本（可拖回 ComfyUI 画布） */
  workflow?: string
  /** A1111 / WebUI 格式参数文本 */
  parameters?: string
  /** 未识别出参数时给出检测线索，帮助用户判断原因 */
  hints?: string[]
}

export interface SamplerInfo {
  nodeId: string
  classType: string
  steps?: number
  cfg?: number
  sampler?: string
  scheduler?: string
  seed?: string
  denoise?: number
}

export interface LoraInfo {
  name: string
  strengthModel?: number
  strengthClip?: number
  /** A1111 "Lora hashes" 行提供的识别哈希（ComfyUI 工作流里没有） */
  hash?: string
}

export interface ParsedParams {
  positive: string[]
  negative: string[]
  models: string[]
  loras: LoraInfo[]
  samplers: SamplerInfo[]
  width?: number
  height?: number
  batch?: number
  nodeCount: number
  /** A1111 原始参数文本 */
  rawText?: string
}

/** 一次完整解析的结果：原始元数据 + 提取出的结构化参数 */
export interface ParseResult {
  raw: RawMetadata
  params?: ParsedParams
}

export interface ImageItem {
  id: string
  file: File
  url: string
  name: string
  /** 相对路径（含文件名）：目录选择来自 webkitRelativePath，拖拽目录来自 entry.fullPath；单选文件无目录信息时缺省 */
  path?: string
  size: number
  status: 'pending' | 'parsing' | 'done' | 'error'
  source: ImageSource
  params?: ParsedParams
  raw: RawMetadata
  error?: string
  /** 预构建的小写搜索串（解析完成时生成一次），供筛选热路径直接 includes */
  searchText?: string
}

/** 添加图片的入参：path 为相对路径（含文件名），仅目录选择 / 拖拽目录时存在 */
export interface IncomingFile {
  file: File
  path?: string
}
