export type ImageSource = 'comfyui' | 'a1111' | 'fooocus' | 'none'

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
  /** A1111 "Model hash" 键：识别同名模型的具体版本；ComfyUI 工作流不提供 */
  modelHash?: string
  loras: LoraInfo[]
  samplers: SamplerInfo[]
  width?: number
  height?: number
  batch?: number
  nodeCount: number
  /** A1111 原始参数文本 */
  rawText?: string
  /** VAE 模型名（VAELoader / A1111 "VAE" 键） */
  vaes: string[]
  /** Clip Skip（CLIPSetLastLayer / A1111 "Clip skip"；默认 1 不记录，只存 ≥2） */
  clipSkip?: number
  /** 放大模型（UpscaleModelLoader） */
  upscalers: string[]
  /** ControlNet 模型（ControlNetLoader） */
  controlNets: string[]
}

/** 一次完整解析的结果：原始元数据 + 提取出的结构化参数；F2 附带 EXIF 内嵌缩略图（如存在） */
export interface ParseResult {
  raw: RawMetadata
  params?: ParsedParams
  thumb?: Uint8Array
}

export interface ImageItem {
  id: string
  /** 原文件；存档项（detached，由持久化恢复）在重新拖入原文件前没有文件 */
  file?: File
  url: string
  name: string
  /** 相对路径（含文件名）：目录选择来自 webkitRelativePath，拖拽目录来自 entry.fullPath；单选文件无目录信息时缺省 */
  path?: string
  /** 目录来源的稳定标识（File System Access API）；区分同名目录中的同路径文件 */
  sourceId?: string
  size: number
  /** 文件修改时间（毫秒）：新添加取自 file.lastModified，存档项来自持久化记录 */
  mtime: number
  status: 'pending' | 'done' | 'error'
  source: ImageSource
  params?: ParsedParams
  raw: RawMetadata
  error?: string
  /** F2：存档项缩略图（base64 JPEG，来自 blobs store）；转成 objectURL 后即弃用 */
  thumbB64?: string
  /** F2：缩略图预览 objectURL（存档卡片无原文件时的预览来源） */
  thumb?: string
  /** true = 存档项：历史记录恢复、尚无原文件（无预览），重新拖入同指纹文件即自动回挂 */
  detached?: boolean
  /** true = 纯参数文件（工作流 JSON / 参数文本，F1）：无图片本体，只有解析出的参数 */
  metaOnly?: boolean
  /** 预构建的小写搜索串（解析完成时生成一次），供筛选热路径直接 includes */
  searchText?: string
}

/** 添加图片的入参：path 为相对路径（含文件名），仅目录选择 / 拖拽目录时存在 */
export interface IncomingFile {
  file: File
  path?: string
  /** 目录来源 ID；目录句柄重扫时保持不变 */
  sourceId?: string
}
