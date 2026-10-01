import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseA1111Parameters } from '../src/lib/a1111'
import { deletePersisted, putPersisted, recordKey } from '../src/lib/persist'
import type { ImageItem } from '../src/types'

// mock 掉解析调度：解析耗时由测试里的 gate 手动控制，用于复现「清空列表时仍有解析在途」的竞态
vi.mock('../src/lib/metadata', () => ({
  // 与真实实现一致：按扩展名放行，无扩展名走嗅探
  isSupportedImage: (f: File) => /\.(png|jpe?g|webp)$/i.test(f.name),
  hasSupportedSignature: async () => true,
  clearInternPool: () => {},
}))
vi.mock('../src/lib/parser', () => ({
  parseImage: vi.fn(),
}))
// 持久化 mock 为「探测可用」：让 markDirty → flush → 写库链路真实运转，以便断言写库行为
vi.mock('../src/lib/persist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/persist')>()
  return {
    ...actual,
    probePersistence: vi.fn(async () => true),
    loadPersisted: vi.fn(async () => []),
    loadHandle: vi.fn(async () => null),
    putPersisted: vi.fn(async () => {}),
    deletePersisted: vi.fn(async () => {}),
    clearPersisted: vi.fn(async () => {}),
    saveHandle: vi.fn(async () => {}),
    clearHandle: vi.fn(async () => {}),
  }
})

let api: typeof import('../src/composables/store')
let parser: typeof import('../src/lib/parser')

beforeAll(async () => {
  // store 模块顶层访问 localStorage / navigator / URL.createObjectURL，Node 环境需打桩
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('navigator', { hardwareConcurrency: 4 })
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:mock'
      static revokeObjectURL = () => {}
    },
  )
  parser = await import('../src/lib/parser')
  api = await import('../src/composables/store')
})

beforeEach(() => {
  api.clearAll()
  api.store.search = ''
  api.store.sourceFilter = 'comfyui'
  api.store.modelFilter = null
  vi.mocked(parser.parseImage).mockReset()
})

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const file = (name: string) => ({ file: new File(['x'], name) })

it('清空后旧批次的在途解析不污染新批次进度', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.mocked(parser.parseImage).mockImplementation(() =>
    gate.then(() => ({ raw: { source: 'none' } })),
  )

  api.addFiles([file('a.png')])
  expect(api.store.batchTotal).toBe(1)
  expect(api.parsing.value).toBe(true)

  api.clearAll() // 清空时 a 的解析仍在途
  expect(api.store.batchTotal).toBe(0)
  expect(api.store.batchDone).toBe(0)
  expect(api.parsing.value).toBe(false)

  api.addFiles([file('b.png'), file('c.png')])
  expect(api.store.batchTotal).toBe(2)

  release() // a、b、c 相继完成
  await flush()
  // 旧批次 a 的完成不计入，新批次恰好 2 项；无代际号时 batchDone 会变成 3
  expect(api.store.batchDone).toBe(2)
  expect(api.parsing.value).toBe(false)
  expect(api.scanProgress.value).toBe(100)
})

it('失败的项可重试并正确计入当前批次', async () => {
  vi.mocked(parser.parseImage).mockRejectedValueOnce(new Error('boom'))
  api.addFiles([file('a.png')])
  await flush()
  const item = api.store.items[0]
  expect(item.status).toBe('error')
  expect(api.stats.value.error).toBe(1)

  vi.mocked(parser.parseImage).mockResolvedValueOnce({ raw: { source: 'none' } })
  api.retryItem(item)
  expect(api.parsing.value).toBe(true)
  await flush()
  expect(item.status).toBe('done')
  expect(api.store.batchTotal).toBe(2) // addFiles 1 + retry 1
  expect(api.store.batchDone).toBe(2)
  expect(api.stats.value.error).toBe(0)
})

it('指纹相同的文件只计入一次（含批内重复）', () => {
  const f1 = new File(['x'], 'dup.png', { lastModified: 1000 })
  const f2 = new File(['x'], 'dup.png', { lastModified: 1000 })
  const other = new File(['x'], 'other.png', { lastModified: 1000 })
  api.addFiles([{ file: f1 }, { file: f2 }, { file: f1 }, { file: other }])
  expect(api.store.items.length).toBe(2)
  expect(api.store.batchTotal).toBe(2)
})

it('路径参与去重：不同目录的同名同指纹文件都保留，同路径只计一次', async () => {
  vi.mocked(parser.parseImage).mockResolvedValue({ raw: { source: 'none' } })
  const f = new File(['x'], 'dup.png', { lastModified: 1000 })
  api.addFiles([
    { file: f, path: 'v1/dup.png' },
    { file: f, path: 'v1/dup.png' },
    { file: f, path: 'v2/dup.png' },
  ])
  await flush()
  expect(api.store.items.length).toBe(2)
  expect(api.store.items.map((i) => i.path)).toEqual(['v1/dup.png', 'v2/dup.png'])
  // 路径同时进入搜索域：可按目录定位
  api.store.sourceFilter = 'all'
  api.store.search = 'v2/'
  expect(api.filteredItems.value.map((i) => i.path)).toEqual(['v2/dup.png'])
})

it('清空列表后指纹去重随之失效，可重新添加同名文件', () => {
  api.addFiles([file('a.png')])
  api.clearAll()
  api.addFiles([file('a.png')])
  expect(api.store.items.length).toBe(1)
})

it('搜索覆盖模型 / LoRA（含哈希）/ 采样参数字段', async () => {
  const parameters =
    '<lora:add_detail:0.8>, masterpiece\nSteps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1, Model: majicMIX, Lora hashes: "add_detail: aaaabbbb"'
  vi.mocked(parser.parseImage).mockResolvedValue({
    raw: { source: 'a1111', parameters },
    params: parseA1111Parameters(parameters),
  })
  api.addFiles([file('a.png')])
  await flush()
  api.store.sourceFilter = 'all'

  const matchCount = (q: string) => {
    api.store.search = q
    return api.filteredItems.value.length
  }
  expect(matchCount('majicmix')).toBe(1) // 模型名（大小写不敏感）
  expect(matchCount('add_detail')).toBe(1) // LoRA 名称
  expect(matchCount('aaaabbbb')).toBe(1) // LoRA 哈希
  expect(matchCount('karras')).toBe(1) // 采样器
  expect(matchCount('20')).toBe(0) // 步数等数值不在搜索域内
  expect(matchCount('masterpiece')).toBe(1) // 提示词（原有范围）
  expect(matchCount('zzz-no-hit')).toBe(0)
})

it('移除已完成条目：列表 / 指纹 / 计数同步，同名可重加', async () => {
  vi.mocked(parser.parseImage).mockResolvedValue({ raw: { source: 'none' } })
  api.addFiles([file('a.png'), file('b.png'), file('c.png')])
  await flush()
  expect(api.store.batchTotal).toBe(3)

  api.removeItem(api.store.items[1])
  expect(api.store.items.length).toBe(2)
  expect(api.store.batchTotal).toBe(2)
  expect(api.store.batchDone).toBe(2)
  expect(api.parsing.value).toBe(false)

  api.addFiles([file('b.png')]) // 指纹已随移除删除，可重新加入
  expect(api.store.items.length).toBe(3)
})

it('移除排队中的条目：出队且总数递减', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.mocked(parser.parseImage).mockImplementation(() =>
    gate.then(() => ({ raw: { source: 'none' } })),
  )
  api.addFiles(Array.from({ length: 10 }, (_, i) => file(`f${i}.png`)))

  // 并发上限 8，末尾的仍在排队（P1 后在途项 status 也保持 pending，只能按入队顺序区分）
  const queued = api.store.items[api.store.items.length - 1]!
  expect(queued).toBeDefined()
  api.removeItem(queued)
  expect(api.store.items.length).toBe(9)
  expect(api.store.batchTotal).toBe(9)

  release()
  await flush()
  expect(api.store.batchDone).toBe(9)
  expect(api.store.batchTotal).toBe(9)
  expect(api.parsing.value).toBe(false)
})

it('移除在途条目：计数保留，解析完成后自动对账', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.mocked(parser.parseImage).mockImplementation(() =>
    gate.then(() => ({ raw: { source: 'none' } })),
  )
  api.addFiles(Array.from({ length: 10 }, (_, i) => file(`f${i}.png`)))

  // 并发上限 8，先入队的必在途；P1 后 status 在结果应用前保持 pending，用入队顺序定位
  const inflight = api.store.items[0]
  expect(inflight).toBeDefined()
  api.removeItem(inflight)
  expect(api.store.items.length).toBe(9)
  expect(api.store.batchTotal).toBe(10) // 在途项计数保留

  release()
  await flush()
  // 被移除项完成时的 batchDone++ 与保留的 batchTotal 对齐，不出现永久“扫描中”
  expect(api.store.batchDone).toBe(10)
  expect(api.store.batchTotal).toBe(10)
  expect(api.parsing.value).toBe(false)
})

it('移除 / 清空的在途项解析完成后不写库存档（不「复活」到存档）', async () => {
  // 先真实等待前序用例遗留的 500ms 写库防抖定时器清空：flushTimer 是模块级单例，
  // 未清空会阻断本用例在假时钟上调度新写入；随后清掉遗留 flush 产生的调用记录
  await new Promise((r) => setTimeout(r, 510))
  vi.mocked(putPersisted).mockClear()
  vi.mocked(deletePersisted).mockClear()
  vi.useFakeTimers()
  try {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.mocked(parser.parseImage).mockImplementation(() =>
      gate.then(() => ({ raw: { source: 'none' } })),
    )

    // 场景一：解析在途时单张移除 → 删除事务照常执行，孤儿结果不得写库
    api.addFiles([file('a.png')])
    const item = api.store.items[0]
    api.removeItem(item)
    release()
    await vi.advanceTimersByTimeAsync(600) // 解析完成 + 500ms 写库防抖
    expect(putPersisted).not.toHaveBeenCalled()
    expect(deletePersisted).toHaveBeenCalledWith([recordKey(item)])

    // 场景二：清空列表时仍有在途解析 → 完成后不得把孤儿记录写回已清空的存档
    vi.mocked(putPersisted).mockClear()
    vi.mocked(deletePersisted).mockClear()
    let release2!: () => void
    const gate2 = new Promise<void>((r) => (release2 = r))
    vi.mocked(parser.parseImage).mockImplementation(() =>
      gate2.then(() => ({ raw: { source: 'comfyui' } })),
    )
    api.addFiles([file('b.png')])
    api.clearAll()
    release2()
    await vi.advanceTimersByTimeAsync(600)
    expect(putPersisted).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('解析中的项不计入来源统计，也不冒充「无元数据」', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.mocked(parser.parseImage).mockImplementation(() =>
    gate.then(() => ({ raw: { source: 'comfyui' } })),
  )
  api.addFiles([file('a.png'), file('b.png')])

  // 解析中：占位 source:'none' 不参与计数，也不出现在「无元数据」筛选下
  expect(api.stats.value).toEqual({ comfyui: 0, a1111: 0, none: 0, error: 0 })
  api.store.sourceFilter = 'none'
  expect(api.filteredItems.value).toHaveLength(0)
  api.store.sourceFilter = 'all'
  expect(api.filteredItems.value).toHaveLength(2)

  release()
  await flush()
  expect(api.stats.value.comfyui).toBe(2)
  api.store.sourceFilter = 'none'
  expect(api.filteredItems.value).toHaveLength(0)
  api.store.sourceFilter = 'comfyui'
  expect(api.filteredItems.value).toHaveLength(2)
})

it('扫描进行中解析结果按节拍批量应用，全部完成后立即应用（P1 聚合去抖）', async () => {
  vi.useFakeTimers()
  try {
    const gates = [0, 1, 2].map(() => {
      let r!: () => void
      return { gate: new Promise<void>((res) => (r = res)), release: r }
    })
    vi.mocked(parser.parseImage).mockImplementation((f: File) =>
      gates[Number(f.name[1])].gate.then(() => ({ raw: { source: 'comfyui' } })),
    )
    api.addFiles([file('a0.png'), file('a1.png'), file('a2.png')])
    await vi.advanceTimersByTimeAsync(0) // 三个任务全部启动
    expect(api.store.items.every((i) => i.status === 'pending')).toBe(true)

    gates[0].release() // 仅 a0 完成，其余仍在途
    await vi.advanceTimersByTimeAsync(0)
    // 扫描进行中：结果挂起不写响应式字段，不触发 stats / filteredItems 全量重算
    expect(api.store.items[0].status).toBe('pending')
    expect(api.stats.value).toEqual({ comfyui: 0, a1111: 0, none: 0, error: 0 })

    await vi.advanceTimersByTimeAsync(250) // 节拍（200ms）到点批量应用
    expect(api.store.items[0].status).toBe('done')
    expect(api.stats.value.comfyui).toBe(1)

    gates[1].release()
    gates[2].release()
    await vi.advanceTimersByTimeAsync(0) // 全部完成 → 立即收尾应用，不等下一拍
    expect(api.store.items.map((i) => i.status)).toEqual(['done', 'done', 'done'])
    expect(api.stats.value.comfyui).toBe(3)
    expect(api.parsing.value).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('modelOptions 从解析结果聚合去重并排序', async () => {
  const addWithModel = (name: string, model: string) => {
    const parameters = `x\nSteps: 20, Model: ${model}`
    vi.mocked(parser.parseImage).mockResolvedValueOnce({
      raw: { source: 'a1111', parameters },
      params: parseA1111Parameters(parameters),
    })
    api.addFiles([{ file: new File(['x'], name, { lastModified: 1 }) }])
  }
  addWithModel('a.png', 'beta')
  addWithModel('b.png', 'alpha')
  addWithModel('c.png', 'beta')
  await flush()
  expect(api.modelOptions.value).toEqual([
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' },
  ])
})

it('rangeIds 区间选择：锚点到目标的有序区间，锚点失效退化为仅目标', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  expect(api.rangeIds(list, 'a', 'c')).toEqual(['a', 'b', 'c'])
  expect(api.rangeIds(list, 'c', 'a')).toEqual(['a', 'b', 'c']) // 反向点击同样取完整区间
  expect(api.rangeIds(list, null, 'b')).toEqual(['b'])
  expect(api.rangeIds(list, 'zz', 'b')).toEqual(['b']) // 锚点不在列表中
  expect(api.rangeIds(list, 'a', 'zz')).toEqual([])
})

it('重新拖入与存档项同指纹的文件时自动回挂，不重新解析', () => {
  api.restoreArchived([
    {
      key: 'v1/a.png|1|1000',
      name: 'a.png',
      path: 'v1/a.png',
      size: 1,
      mtime: 1000,
      status: 'done',
      source: 'comfyui',
      raw: { source: 'comfyui' },
      savedAt: 0,
    },
  ])
  expect(api.store.items.length).toBe(1)
  expect(api.store.items[0].detached).toBe(true)

  api.addFiles([{ file: new File(['x'], 'a.png', { lastModified: 1000 }), path: 'v1/a.png' }])
  expect(api.store.items.length).toBe(1)
  const item = api.store.items[0]
  expect(item.detached).toBe(false)
  expect(item.url).toBe('blob:mock')
  expect(api.store.batchTotal).toBe(0) // 元数据已在库中，不重新排队解析
})

it('toRecord / fromRecord：列表项与存档记录往返', async () => {
  const { toRecord, fromRecord } = await import('../src/lib/persist')
  const parameters = 'x\nSteps: 20, Model: m1'
  const item: ImageItem = {
    id: 'img-1',
    file: new File(['x'], 'a.png'),
    url: 'blob:x',
    name: 'a.png',
    path: 'v1/a.png',
    size: 5,
    mtime: 1234,
    status: 'done',
    source: 'a1111',
    raw: { source: 'a1111', parameters },
    params: parseA1111Parameters(parameters),
  }
  const rec = toRecord(item)!
  expect(rec.key).toBe('v1/a.png|5|1234')
  expect(rec.source).toBe('a1111')

  const restored = fromRecord(rec)
  expect(restored.detached).toBe(true)
  expect(restored.url).toBe('')
  expect(restored.file).toBeUndefined()
  expect(restored.mtime).toBe(1234)
  expect(restored.status).toBe('done')
  expect(restored.params?.models).toEqual(['m1'])

  expect(toRecord({ ...item, status: 'parsing' })).toBeNull() // 解析中的项不入库
})

it('无扩展名文件经嗅探确认后异步入列', async () => {
  api.addFiles([{ file: new File([new Uint8Array([1, 2, 3])], 'noext', { lastModified: 1 }) }])
  expect(api.store.items.length).toBe(0) // 同步阶段不加入
  await new Promise((r) => setTimeout(r, 5))
  expect(api.store.items.length).toBe(1) // 嗅探通过后入列（hasSupportedSignature mock 为 true）
})

it('parseQuery 拆分字段限定与普通关键词', () => {
  expect(api.parseQuery('cat MODEL:majic seed:123')).toEqual({
    terms: ['cat'],
    model: ['majic'],
    lora: [],
    seed: ['123'],
    path: [],
  })
  expect(api.parseQuery('   ')).toEqual({ terms: [], model: [], lora: [], seed: [], path: [] })
})

it('结构化搜索：字段限定与多条件 AND', async () => {
  const add = (name: string, parameters: string, path?: string) => {
    vi.mocked(parser.parseImage).mockResolvedValueOnce({
      raw: { source: 'a1111', parameters },
      params: parseA1111Parameters(parameters),
    })
    api.addFiles([{ file: new File(['x'], name, { lastModified: 1 }), path }])
  }
  add(
    'a.png',
    'cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 111222333, Model: majicMIX',
    'v1/a.png',
  )
  add('b.png', 'dog\nSteps: 30, Sampler: DPM++ 2M, Seed: 444555616, Model: dreamshaper', 'v2/b.png')
  await flush()
  api.store.sourceFilter = 'all'

  const names = (q: string) => {
    api.store.search = q
    return api.filteredItems.value.map((i) => i.name)
  }
  expect(names('seed:111222')).toEqual(['a.png'])
  expect(names('seed:1')).toEqual(['a.png', 'b.png']) // 种子按子串部分匹配
  expect(names('model:majic')).toEqual(['a.png'])
  expect(names('path:v2')).toEqual(['b.png'])
  expect(names('model:dreamshaper seed:444555616')).toEqual(['b.png']) // 字段之间 AND
  expect(names('cat model:majic')).toEqual(['a.png']) // 普通词 + 字段
  expect(names('cat seed:444555666')).toEqual([]) // 条件不相交
  expect(names('lora:nothing')).toEqual([]) // 无 LoRA 不命中
  api.store.search = ''
})

it('排序模式：按文件时间新旧排列，失败项始终靠后', async () => {
  vi.mocked(parser.parseImage).mockImplementation((f: File) =>
    f.name === 'e.png'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ raw: { source: 'comfyui' } }),
  )
  const t0 = 1_700_000_000_000
  api.addFiles([
    { file: new File(['x'], 'a.png', { lastModified: t0 + 2000 }) },
    { file: new File(['x'], 'b.png', { lastModified: t0 }) },
    { file: new File(['x'], 'c.png', { lastModified: t0 + 1000 }) },
    { file: new File(['x'], 'e.png', { lastModified: t0 + 3000 }) }, // 时间最新但解析失败
  ])
  await flush()
  api.store.sourceFilter = 'all'
  const names = () => api.filteredItems.value.map((i) => i.name)

  api.store.sortMode = 'time-asc'
  expect(names()).toEqual(['b.png', 'c.png', 'a.png', 'e.png'])
  api.store.sortMode = 'time-desc'
  expect(names()).toEqual(['a.png', 'c.png', 'b.png', 'e.png']) // 失败项脱离时间线靠后
  api.store.sortMode = 'default'
  expect(names()).toEqual(['a.png', 'b.png', 'c.png', 'e.png']) // 来源 + 文件名，失败项垫底
})

describe('usageStats', () => {
  const mk = (
    id: string,
    models: string[],
    loras: { name: string }[],
    samplers: { nodeId: string; classType: string; sampler?: string }[],
  ) => ({
    id,
    url: '',
    name: `${id}.png`,
    size: 1,
    mtime: 1,
    status: 'done' as const,
    source: 'comfyui' as const,
    raw: { source: 'comfyui' as const },
    params: { positive: [], negative: [], models, loras, samplers, nodeCount: 1 },
  })

  it('按已解析项聚合模型 / LoRA / 采样器频次（次数降序，同次数按名排序）', () => {
    api.store.items.push(
      mk('1', ['b.safetensors'], [{ name: 'l1' }], [
        { nodeId: '3', classType: 'KSampler', sampler: 'euler' },
      ]),
      mk('2', ['a.safetensors'], [{ name: 'l1' }, { name: 'l2' }], [
        { nodeId: '3', classType: 'KSampler', sampler: 'dpmpp_2m' },
        { nodeId: '9', classType: 'KSampler', sampler: 'euler' },
      ]),
      // 无参数项（解析中 / 无元数据）不参与统计
      { id: '3', url: '', name: '3.png', size: 1, mtime: 1, status: 'done', source: 'none', raw: { source: 'none' } },
    )
    const s = api.usageStats.value
    expect(s.models).toEqual([
      { name: 'a.safetensors', count: 1 },
      { name: 'b.safetensors', count: 1 },
    ])
    expect(s.loras).toEqual([
      { name: 'l1', count: 2 },
      { name: 'l2', count: 1 },
    ])
    expect(s.samplers).toEqual([
      { name: 'euler', count: 2 },
      { name: 'dpmpp_2m', count: 1 },
    ])
  })
})