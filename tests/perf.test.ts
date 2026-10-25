/**
 * 万级列表派生数据基线（OPT-5）：不设易抖动的硬阈值，输出各场景耗时供对比，
 * 同时断言筛选 / 聚合结果正确。手动运行：`npm run perf`；CI 中随 `npm test` 执行。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PersistRecord } from '../src/lib/persist'

const TOTAL = 10_000

const records: PersistRecord[] = Array.from({ length: TOTAL }, (_, i) => ({
  key: `bench/dir-${i % 20}/${i}.png|1|${i}`,
  name: `${i}.png`,
  path: `bench/dir-${i % 20}/${i}.png`,
  size: 1024 + i,
  mtime: 1_700_000_000_000 + i * 1000,
  status: 'done',
  source: 'comfyui',
  raw: { source: 'comfyui', prompt: `{"${i}":{"class_type":"KSampler"}}` },
  params: {
    positive: [`a photo of subject ${i % 100}, detailed, cinematic`],
    negative: ['blurry, low quality'],
    models: [`model_${i % 10}`],
    loras: [{ name: `lora_${i % 5}`, strengthModel: 0.8, strengthClip: 0.8 }],
    samplers: [
      {
        nodeId: '3',
        classType: 'KSampler',
        steps: 20,
        cfg: 7,
        sampler: 'euler',
        scheduler: 'normal',
        seed: String(i),
        denoise: 1,
      },
    ],
    vaes: [],
    upscalers: [],
    controlNets: [],
    nodeCount: 5,
    width: 1024,
    height: 1024,
    batch: 1,
  },
  savedAt: 1,
}))

let api!: typeof import('../src/composables/store')

beforeAll(async () => {
  // store 模块顶层读取浏览器全局；Node 环境先打桩再动态导入
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  })
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 })
  api = await import('../src/composables/store')
  api.restoreArchived(records)
}, 30_000)

function timed(label: string, fn: () => void): number {
  const start = performance.now()
  fn()
  const ms = performance.now() - start
  console.info(`[perf] ${label}: ${ms.toFixed(1)} ms`)
  return ms
}

describe('10k 条画廊派生数据基线', () => {
  it('关键词搜索、结构化条件、工作流聚类与统计聚合', () => {
    // 预热：首次筛选会惰性构建 10k 条 searchText / 查询缓存，计入耗时会掩盖热路径差异
    api.store.search = 'pos:"subject 0"'
    void api.filteredItems.value

    timed('关键词搜索（裸词 AND）', () => {
      // 用 pos: 限定提示词，避免裸词 "42" 同时命中文件名 / 种子等搜索域
      api.store.search = 'pos:"subject 42" cinematic'
      expect(api.filteredItems.value).toHaveLength(100)
    })

    timed('结构化条件（model + steps + has:lora + w）', () => {
      api.store.search = 'model:"model_3" steps:>10 has:lora w:1024'
      expect(api.filteredItems.value).toHaveLength(1000)
    })

    timed('按工作流聚类排序', () => {
      api.store.search = ''
      api.store.sortMode = 'workflow'
      expect(api.filteredItems.value).toHaveLength(TOTAL)
    })

    timed('统计聚合（usageStats + stats + tagCounts）', () => {
      expect(api.usageStats.value.models).toHaveLength(10)
      expect(api.stats.value.comfyui).toBe(TOTAL)
      expect(api.tagCounts.value).toHaveLength(0)
    })

    api.store.sortMode = 'default'
  })
})
