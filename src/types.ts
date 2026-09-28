export type ImageSource = 'comfyui' | 'a1111' | 'none'

export interface RawMetadata {
  source: ImageSource
  /** ComfyUI API 格式工作流 JSON 文本 */
  prompt?: string
  /** ComfyUI UI 格式工作流 JSON 文本（可拖回 ComfyUI 画布） */
  workflow?: string
  /** A1111 / WebUI 格式参数文本 */
  parameters?: string
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

export interface ImageItem {
  id: string
  file: File
  url: string
  name: string
  size: number
  status: 'pending' | 'parsing' | 'done' | 'error'
  source: ImageSource
  params?: ParsedParams
  raw: RawMetadata
  error?: string
}
