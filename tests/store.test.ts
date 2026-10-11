import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseA1111Parameters } from '../src/lib/a1111'
import { deletePersisted, putPersisted, recordKey } from '../src/lib/persist'
import type { ImageItem } from '../src/types'
import type { PersistRecord } from '../src/lib/persist'

// mock 掉解析调度：解析耗时由测试里的 gate 手动控制，用于复现「清空列表时仍有解析在途」的竞态
vi.mock('../src/lib/metadata', () => ({
  // 与真实实现一致：按扩展名放行，无扩展名走嗅探，.json/.txt 为参数文件
  isSupportedImage: (f: File) => /\.(png|jpe?g|webp)$/i.test(f.name),
  isMetaTextFile: (f: File) => /\.(json|txt)$/i.test(f.name),
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
    saveDirBookmark: vi.fn(async () => {}),
    removeDirBookmark: vi.fn(async () => {}),
    clearDirBookmarks: vi.fn(async () => {}),
    loadDirBookmarks: vi.fn(async () => []),
    importPersisted: vi.fn(async () => []),
  }
})
// 目录扫描 mock：自动重扫用例需要可控的枚举与权限，其余用例不触碰目录扫描
vi.mock('../src/lib/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/fs')>()
  return {
    ...actual,
    collectDirectoryFiles: vi.fn(async () => 0),
    ensureReadPermission: vi.fn(async () => true),
  }
})

let api: typeof import('../src/composables/store')
let parser: typeof import('../src/lib/parser')

beforeAll(async () => {
  // store 模块顶层访问 localStorage / navigator / URL.createObjectURL，Node 环境需打桩（U2 需真实读写）
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  })
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
  api.store.autoRescan = false
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

it('批量移除排队项：整体出队、计数同步、指纹可重加', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.mocked(parser.parseImage).mockImplementation(() =>
    gate.then(() => ({ raw: { source: 'none' } })),
  )
  api.addFiles(
    Array.from({ length: 10 }, (_, i) => ({
      file: new File(['x'], `f${i}.png`, { lastModified: 1000 + i }),
    })),
  )
  expect(api.store.batchTotal).toBe(10)

  // 并发上限 8，末尾两个仍在排队：一次 removeItems 出队，不逐条 indexOf
  const queued = api.store.items.slice(8)
  api.removeItems(queued)
  expect(api.store.items.length).toBe(8)
  expect(api.store.batchTotal).toBe(8)

  release()
  await flush()
  expect(api.store.batchDone).toBe(8)
  expect(api.parsing.value).toBe(false)

  // 指纹随移除释放：同一个 File 可重新加入
  api.addFiles(queued.map((it) => ({ file: it.file! })))
  expect(api.store.items.length).toBe(10)
})

it('批量移除已完成项：两本账同步减少（与单条移除语义一致）', async () => {
  vi.mocked(parser.parseImage).mockResolvedValue({ raw: { source: 'none' } })
  api.addFiles(Array.from({ length: 5 }, (_, i) => file(`g${i}.png`)))
  await flush()
  expect(api.store.batchDone).toBe(5)

  api.removeItems(api.store.items.slice(1, 4))
  expect(api.store.items.length).toBe(2)
  expect(api.store.batchTotal).toBe(2)
  expect(api.store.batchDone).toBe(2)
  expect(api.parsing.value).toBe(false)
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

it('flushPersist 向写库传递批次取消检查，清空列表即在途写库作废（复活竞态防护）', async () => {
  await new Promise((r) => setTimeout(r, 510)) // 清空前序用例遗留的 500ms flush 防抖定时器
  vi.mocked(putPersisted).mockClear()
  vi.useFakeTimers()
  try {
    vi.mocked(parser.parseImage).mockResolvedValue({ raw: { source: 'comfyui' } })
    api.addFiles([file('a.png')])
    await vi.advanceTimersByTimeAsync(0) // 解析完成 → 应用 → markDirty → 500ms 写库防抖

    let guard: (() => boolean) | undefined
    vi.mocked(putPersisted).mockImplementationOnce(async (_records, cancelled) => {
      guard = cancelled
    })
    await vi.advanceTimersByTimeAsync(500) // flush 定时器触发，写库捕获取消检查
    expect(typeof guard).toBe('function')
    expect(guard!()).toBe(false) // 批次仍有效，写库放行
    api.clearAll()
    expect(guard!()).toBe(true) // 清空作废本轮写库，getDb 之后的写入必须放弃
  } finally {
    vi.useRealTimers()
  }
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
    expect(deletePersisted).toHaveBeenCalled()
    // 第二个参数是 flushPersist 传入的批次取消检查函数，这里只断言键列表
    expect(vi.mocked(deletePersisted).mock.calls[0]![0]).toEqual([recordKey(item)])

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

it('工作流 JSON / 参数文本文件直接入列解析，无预览 URL（F1）', async () => {
  vi.mocked(parser.parseImage).mockResolvedValue({ raw: { source: 'comfyui' } })
  api.addFiles([
    { file: new File(['{"3":{"class_type":"KSampler"}}'], 'wf.json', { lastModified: 1 }) },
  ])
  expect(api.store.items.length).toBe(1)
  expect(api.store.items[0].metaOnly).toBe(true)
  expect(api.store.items[0].url).toBe('')
  api.addFiles([{ file: new File(['Steps: 20'], 'params.txt', { lastModified: 2 }) }])
  expect(api.store.items.length).toBe(2)
  await flush()
  expect(api.store.items.every((i) => i.status === 'done')).toBe(true)
  // 指纹去重对参数文件同样生效
  api.addFiles([
    { file: new File(['{"3":{"class_type":"KSampler"}}'], 'wf.json', { lastModified: 1 }) },
  ])
  expect(api.store.items.length).toBe(2)
})

it('retryAllFailed 批量重试有文件的失败项，存档失败项跳过（O4）', async () => {
  vi.mocked(parser.parseImage)
    .mockRejectedValueOnce(new Error('boom'))
    .mockRejectedValueOnce(new Error('boom2'))
  api.addFiles([file('a.png'), file('b.png')])
  await flush()
  expect(api.stats.value.error).toBe(2)
  // 存档失败项没有文件，不可重试
  api.restoreArchived([
    {
      key: 'c.png|1|7',
      name: 'c.png',
      size: 1,
      mtime: 7,
      status: 'error',
      source: 'none',
      raw: { source: 'none' },
      error: 'x',
      savedAt: 0,
    },
  ])
  vi.mocked(parser.parseImage).mockResolvedValue({ raw: { source: 'comfyui' } })
  expect(api.retryAllFailed()).toBe(2)
  expect(api.store.batchTotal).toBe(4) // 首轮 2 + 重试 2
  await flush()
  expect(api.stats.value).toEqual({ comfyui: 2, a1111: 0, none: 0, error: 1 })
})

it('筛选与搜索状态写入 localStorage（U2）', async () => {
  api.store.sourceFilter = 'a1111'
  api.store.modelFilter = 'm.safetensors'
  api.store.search = 'seed:1'
  await flush() // pre-flush watcher 落盘
  const saved = JSON.parse(localStorage.getItem('cii:filters') ?? '{}') as {
    search: string
    model: string | null
    source: string
  }
  expect(saved).toEqual({ search: 'seed:1', model: 'm.safetensors', source: 'a1111' })
  api.store.sourceFilter = 'comfyui'
  api.store.modelFilter = null
  api.store.search = ''
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

it('modelOptions 从解析结果聚合去重并按使用频次排序', async () => {
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
  // 高频模型排前（beta 用了 2 次），同频次按名排序
  expect(api.modelOptions.value).toEqual([
    { label: 'beta', value: 'beta' },
    { label: 'alpha', value: 'alpha' },
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

it('移除存档项不动批次计数（从未计入 batchTotal 的项不得减成负数）', () => {
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
  api.removeItem(api.store.items[0]!)
  expect(api.store.items.length).toBe(0)
  expect(api.store.batchTotal).toBe(0)
  expect(api.store.batchDone).toBe(0)
  expect(api.parsing.value).toBe(false)
})

it('存档 v3：大文本拆分去重与物化往返（OPT-5）', async () => {
  const { splitPersistRecord, materializeRecord } = await import('../src/lib/persist')
  const prompt = '{"3":{"class_type":"KSampler"}}'
  const rec: PersistRecord = {
    key: 'v1/a.png|1|1000',
    name: 'a.png',
    path: 'v1/a.png',
    size: 1,
    mtime: 1000,
    status: 'done',
    source: 'comfyui',
    raw: { source: 'comfyui', prompt, hints: ['线索'] },
    params: {
      positive: ['cat'],
      negative: [],
      models: ['m'],
      loras: [],
      samplers: [],
      vaes: [],
      upscalers: [],
      controlNets: [],
      width: 512,
      height: 512,
      nodeCount: 1,
      rawText: 'Steps: 20',
    },
    savedAt: 42,
  }
  const { stored, blobs } = splitPersistRecord(rec)
  expect(stored.v).toBe(3)
  expect(blobs).toHaveLength(2) // prompt 与 rawText 是不同内容 → 2 份
  const back = materializeRecord(stored, new Map(blobs.map((b) => [b.hash, b.text])))!
  expect(back).toEqual(rec)

  // A1111 场景：parameters 与 params.rawText 同内容，全库只存一份
  const a1111: PersistRecord = {
    key: 'b.png|1|1',
    name: 'b.png',
    size: 1,
    mtime: 1,
    status: 'done',
    source: 'a1111',
    raw: { source: 'a1111', parameters: 'Steps: 20' },
    params: {
      positive: [],
      negative: [],
      models: [],
      loras: [],
      samplers: [],
      vaes: [],
      upscalers: [],
      controlNets: [],
      nodeCount: 0,
      rawText: 'Steps: 20',
    },
    savedAt: 0,
  }
  const split2 = splitPersistRecord(a1111)
  expect(split2.blobs).toHaveLength(1)
  expect(split2.stored.parameters).toBe(split2.stored.rawText)

  // 引用悬空（blob 缺失）按记录损坏剔除
  expect(materializeRecord(stored, new Map())).toBeNull()
})

it('存档备份：序列化与解析往返，非法结构抛错（FEAT-6）', async () => {
  const { serializeArchive, parseArchive } = await import('../src/lib/persist')
  const rec: PersistRecord = {
    key: 'a.png|1|1',
    name: 'a.png',
    size: 1,
    mtime: 1,
    status: 'done',
    source: 'comfyui',
    raw: { source: 'comfyui' },
    savedAt: 0,
  }
  const text = serializeArchive([rec])
  expect(parseArchive(text)).toEqual([rec])
  expect(() => parseArchive('{"items":[]}')).toThrow()
  expect(() => parseArchive('not json')).toThrow()
  // 无法识别的条目剔除，不中断导入
  expect(parseArchive(JSON.stringify({ records: [rec, { junk: true }] }))).toEqual([rec])
})

it('存档导入：同指纹跳过，恢复为可搜索的存档项（FEAT-6）', async () => {
  const { importPersisted } = await import('../src/lib/persist')
  const rec: PersistRecord = {
    key: 'v2/b.png|1|5',
    name: 'b.png',
    path: 'v2/b.png',
    size: 1,
    mtime: 5,
    status: 'done',
    source: 'a1111',
    raw: { source: 'a1111', parameters: 'cat\nSteps: 20' },
    params: {
      positive: ['cat'],
      negative: [],
      models: [],
      loras: [],
      samplers: [],
      vaes: [],
      upscalers: [],
      controlNets: [],
      nodeCount: 0,
      rawText: 'cat\nSteps: 20',
    },
    savedAt: 0,
  }
  vi.mocked(importPersisted).mockResolvedValueOnce([rec])
  const n = await api.importArchive(JSON.stringify({ version: 3, records: [rec] }))
  expect(n).toBe(1)
  expect(api.store.items.length).toBe(1)
  expect(api.store.items[0].detached).toBe(true)
  // 惰性搜索串按需构建：存档项按参数可搜索（OPT-6）
  api.store.sourceFilter = 'all'
  api.store.search = 'cat'
  expect(api.filteredItems.value.length).toBe(1)
  api.store.search = ''

  // 库中已存在的指纹全部跳过
  vi.mocked(importPersisted).mockResolvedValueOnce([])
  expect(await api.importArchive(JSON.stringify({ version: 3, records: [rec] }))).toBe(0)
  expect(api.store.items.length).toBe(1)
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

  expect(toRecord({ ...item, status: 'pending' })).toBeNull() // 解析中的项不入库
})

it('无扩展名文件经嗅探确认后异步入列', async () => {
  api.addFiles([{ file: new File([new Uint8Array([1, 2, 3])], 'noext', { lastModified: 1 }) }])
  expect(api.store.items.length).toBe(0) // 同步阶段不加入
  await new Promise((r) => setTimeout(r, 5))
  expect(api.store.items.length).toBe(1) // 嗅探通过后入列（hasSupportedSignature mock 为 true）
})

it('自动重扫：周期增量触发、解析中跳过、句柄丢失后停表（FEAT-1）', async () => {
  const fsMod = await import('../src/lib/fs')
  vi.useFakeTimers()
  try {
    let scans = 0
    vi.mocked(fsMod.collectDirectoryFiles).mockImplementation(async (_handle, onBatch) => {
      scans++
      // 首轮扫描“发现”一个新文件，验证周期触发走完整的增量入列链路
      if (scans === 1) onBatch([{ file: new File(['x'], 'new-1.png', { lastModified: 7 }) }])
      return 1
    })

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.mocked(parser.parseImage).mockImplementation(() =>
      gate.then(() => ({ raw: { source: 'none' } })),
    )

    await api.setRescanHandle({ name: 'out' } as unknown as FileSystemDirectoryHandle)
    api.store.autoRescan = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scans).toBe(1)
    expect(api.store.items.length).toBe(1)
    expect(api.parsing.value).toBe(true) // 新文件解析中

    // 下一拍：解析未完成，跳过不并发重扫
    await vi.advanceTimersByTimeAsync(20_000)
    expect(scans).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.parsing.value).toBe(false)

    // 解析完成后的下一拍恢复扫描（本轮无新文件）
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scans).toBe(2)

    // 句柄被忘记：定时器停表不再扫描；偏好保留，下次记住目录时自动恢复
    api.forgetRescanHandle()
    const stopped = scans
    await vi.advanceTimersByTimeAsync(30_000)
    expect(scans).toBe(stopped)
    expect(api.store.autoRescan).toBe(true)
  } finally {
    vi.useRealTimers()
    api.store.autoRescan = false
  }
})

it('重扫目录枚举失败（目录被删 / 拔盘）返回 null，不抛未捕获异常', async () => {
  const fsMod = await import('../src/lib/fs')
  vi.mocked(fsMod.collectDirectoryFiles).mockRejectedValueOnce(new Error('NotFoundError'))
  await api.setRescanHandle({ name: 'gone' } as unknown as FileSystemDirectoryHandle)
  try {
    await expect(api.rescanDirectory()).resolves.toBe(null)
  } finally {
    api.forgetRescanHandle()
  }
})

it('parseQuery 拆分字段限定与普通关键词', () => {
  const empty = { terms: [], model: [], lora: [], seed: [], path: [], date: [], num: [] }
  expect(api.parseQuery('cat MODEL:majic seed:123')).toEqual({
    all: { terms: ['cat'], model: ['majic'], lora: [], seed: ['123'], path: [], date: [], num: [] },
    none: empty,
  })
  expect(api.parseQuery('   ')).toEqual({ all: empty, none: empty })
  // 引号 + 否定组合：修复前分词正则先于 `-` 剥离执行，会在空格处被拆坏
  expect(api.parseQuery('-"model:a b"')).toEqual({
    all: empty,
    none: { terms: [], model: ['a b'], lora: [], seed: [], path: [], date: [], num: [] },
  })
  // 冒号后带引号的字段值：`model:"a b"` 整体成一个 token，值剥离引号后入桶
  expect(api.parseQuery('model:"a b"')).toEqual({
    all: { terms: [], model: ['a b'], lora: [], seed: [], path: [], date: [], num: [] },
    none: empty,
  })
  expect(api.parseQuery('-model:"a b c"').none.model).toEqual(['a b c'])
  // date 字段：非法格式照常入桶，由 hitDate 匹配时判否
  expect(api.parseQuery('date:2026-01-31 -date:2025-12')).toEqual({
    all: { terms: [], model: [], lora: [], seed: [], path: [], date: ['2026-01-31'], num: [] },
    none: { terms: [], model: [], lora: [], seed: [], path: [], date: ['2025-12'], num: [] },
  })
  // seed 条件须为「可选比较符 + 数字」：残缺条件（如 `seed:>=`）忽略而非恒真
  expect(api.parseQuery('seed:>=').all.seed).toEqual([])
  expect(api.parseQuery('seed:>abc').all.seed).toEqual([])
  expect(api.parseQuery('seed:>=123').all.seed).toEqual(['>=123'])
  // 数值范围条件（FEAT-3）：w/h 是别名，无操作符为精确相等，非法值忽略
  expect(
    api.parseQuery('steps:>30 w:>=1024 cfg:7.5 h:<768 batch:2 clip:>1 steps:abc steps:'),
  ).toEqual({
    all: {
      terms: [],
      model: [],
      lora: [],
      seed: [],
      path: [],
      date: [],
      num: [
        { field: 'steps', op: '>', value: 30 },
        { field: 'width', op: '>=', value: 1024 },
        { field: 'cfg', op: undefined, value: 7.5 },
        { field: 'height', op: '<', value: 768 },
        { field: 'batch', op: undefined, value: 2 },
        { field: 'clip', op: '>', value: 1 },
      ],
    },
    none: empty,
  })
})

it('搜索语法增强：排除 / 引号含空格值 / 种子范围（O1）', async () => {
  const add = (name: string, parameters: string, path: string) => {
    vi.mocked(parser.parseImage).mockResolvedValueOnce({
      raw: { source: 'a1111', parameters },
      params: parseA1111Parameters(parameters),
    })
    api.addFiles([{ file: new File(['x'], name, { lastModified: 1 }), path }])
  }
  add(
    'a.png',
    'two words cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 111222333, Model: majicMIX',
    'v1/a.png',
  )
  add('b.png', 'dog\nSteps: 30, Sampler: DPM++ 2M, Seed: 444555616, Model: dreamshaper', 'v2/b.png')
  await flush()
  api.store.sourceFilter = 'all'
  api.store.sortMode = 'default'

  const names = (q: string) => {
    api.store.search = q
    return api.filteredItems.value.map((i) => i.name)
  }
  // 排除条件
  expect(names('cat -dog')).toEqual(['a.png'])
  expect(names('-model:majic')).toEqual(['b.png'])
  // 引号包裹：含空格的普通词
  expect(names('"two words"')).toEqual(['a.png'])
  // 冒号后带引号：字段值含空格（两种引号位置等价）
  expect(names('model:"majicMIX"')).toEqual(['a.png'])
  expect(names('-model:"majicMIX"')).toEqual(['b.png'])
  // 引号 + 否定组合：含空格的字段值 / 普通词都能排除
  expect(names('-"two words"')).toEqual(['b.png'])
  // 种子范围（数字字符串比较，不丢精度）
  expect(names('seed:>200000000')).toEqual(['b.png'])
  expect(names('seed:<=111222333')).toEqual(['a.png'])
  expect(names('seed:>=111222333')).toEqual(['a.png', 'b.png'])
  expect(names('seed:<5')).toEqual([])
  api.store.search = ''
})

it('数值范围搜索：steps / cfg / 尺寸 / 批量 / Clip Skip（FEAT-3）', async () => {
  const add = (name: string, parameters: string) => {
    vi.mocked(parser.parseImage).mockResolvedValueOnce({
      raw: { source: 'a1111', parameters },
      params: parseA1111Parameters(parameters),
    })
    api.addFiles([{ file: new File(['x'], name, { lastModified: 1 }) }])
  }
  add(
    'a.png',
    'cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 5, Size: 512x768, Clip skip: 2, VAE: vae-ft-mse',
  )
  add(
    'b.png',
    'dog\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 5.5, Seed: 6, Size: 1024x1024, Batch size: 2',
  )
  await flush()
  api.store.sourceFilter = 'all'

  const names = (q: string) => {
    api.store.search = q
    return api.filteredItems.value.map((i) => i.name)
  }
  expect(names('steps:>25')).toEqual(['b.png'])
  expect(names('cfg:<6')).toEqual(['b.png'])
  expect(names('w:>=1024')).toEqual(['b.png'])
  expect(names('h:<=768')).toEqual(['a.png'])
  expect(names('batch:>=2')).toEqual(['b.png'])
  expect(names('clip:>1')).toEqual(['a.png'])
  // 多条件 AND + 排除组合
  expect(names('steps:>25 cfg:<6')).toEqual(['b.png'])
  expect(names('steps:>25 cfg:<6 -batch:>=2')).toEqual([])
  // VAE 名称走普通关键词搜索域
  expect(names('vae-ft-mse')).toEqual(['a.png'])
  api.store.search = ''
})

it('date: 按本地时区日期筛选，支持年 / 月前缀与排除（FEAT-2）', async () => {
  const add = (name: string, mtime: number) => {
    const parameters = 'cat\nSteps: 20, Sampler: Euler a, CFG scale: 7'
    vi.mocked(parser.parseImage).mockResolvedValueOnce({
      raw: { source: 'a1111', parameters },
      params: parseA1111Parameters(parameters),
    })
    api.addFiles([{ file: new File(['x'], name, { lastModified: mtime }) }])
  }
  const dayKey = (t: number) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
  }
  const t1 = new Date(2025, 0, 15, 10, 30).getTime()
  const t2 = new Date(2026, 4, 2, 8, 0).getTime()
  add('a.png', t1)
  add('b.png', t2)
  await flush()
  api.store.sourceFilter = 'all'

  const names = (q: string) => {
    api.store.search = q
    return api.filteredItems.value.map((i) => i.name)
  }
  expect(names(`date:${dayKey(t1)}`)).toEqual(['a.png'])
  expect(names(`date:${dayKey(t2)}`)).toEqual(['b.png'])
  expect(names('date:2025-01')).toEqual(['a.png']) // 月份前缀
  expect(names('date:2025')).toEqual(['a.png']) // 年份前缀
  expect(names('date:2025-02')).toEqual([])
  expect(names('date:abc')).toEqual([]) // 非法格式恒不命中
  // 排除条件组合
  expect(names(`date:${dayKey(t1)} -date:2026`)).toEqual(['a.png'])
  expect(names(`date:${dayKey(t1)} -date:2025`)).toEqual([])
  api.store.search = ''
})

it('按工作流聚类排序：同工作流相邻成组，组内新→旧（F3）', async () => {
  const promptA = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: 5 } } })
  const promptB = JSON.stringify({ '7': { class_type: 'KSampler', inputs: { seed: 9 } } })
  vi.mocked(parser.parseImage).mockImplementation((f: File) =>
    Promise.resolve({
      raw: { source: 'comfyui', prompt: f.name.startsWith('a') ? promptA : promptB },
    }),
  )
  const t0 = 1_700_000_000_000
  api.addFiles([
    { file: new File(['x'], 'a1.png', { lastModified: t0 }) },
    { file: new File(['x'], 'b1.png', { lastModified: t0 + 1000 }) },
    { file: new File(['x'], 'a2.png', { lastModified: t0 + 2000 }) },
  ])
  await flush()
  api.store.sourceFilter = 'all'
  api.store.sortMode = 'workflow'
  // A 组（最新 t0+2000）排前，组内 a2 → a1；随后 B 组
  expect(api.filteredItems.value.map((i) => i.name)).toEqual(['a2.png', 'a1.png', 'b1.png'])
  const c = api.workflowClusters.value
  const byName = (n: string) => api.store.items.find((i) => i.name === n)!.id
  expect(c.get(byName('a2.png'))).toEqual({ group: 0, seq: 1, total: 2 })
  expect(c.get(byName('a1.png'))).toEqual({ group: 0, seq: 2, total: 2 })
  expect(c.get(byName('b1.png'))).toEqual({ group: 1, seq: 1, total: 1 })
  api.store.sortMode = 'default'
})

it('聚类指纹缓存随解析结果失效：结果应用前后分组正确更新', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const promptA = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: 5 } } })
  vi.mocked(parser.parseImage).mockImplementation(() =>
    gate.then(() => ({ raw: { source: 'comfyui', prompt: promptA } })),
  )
  api.addFiles([file('a1.png'), file('a2.png')])
  api.store.sourceFilter = 'all'
  api.store.sortMode = 'workflow'
  // 结果应用前无 raw：各自成组（指纹缓存住 id 键）
  expect(api.workflowClusters.value.get(api.store.items[0]!.id)).toEqual({
    group: 0,
    seq: 1,
    total: 1,
  })
  expect(api.workflowClusters.value.get(api.store.items[1]!.id)).toEqual({
    group: 1,
    seq: 1,
    total: 1,
  })

  release()
  await flush()
  // 应用后 raw 引用变化：缓存失效重新哈希，同工作流归入同组
  const c = api.workflowClusters.value
  expect(c.get(api.store.items[0]!.id)).toEqual({ group: 0, seq: 1, total: 2 })
  expect(c.get(api.store.items[1]!.id)).toEqual({ group: 0, seq: 2, total: 2 })
  api.store.sortMode = 'default'
})

it('同源出图检测：同工作流同种子分组，只看重复筛选（FEAT-4）', async () => {
  const { extractComfyParams } = await import('../src/lib/comfyExtract')
  const promptA = JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20 } },
  })
  const promptB = JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: 9, steps: 20 } },
  })
  vi.mocked(parser.parseImage).mockImplementation((f: File) => {
    const prompt = f.name.startsWith('a') ? promptA : promptB
    return Promise.resolve({
      raw: { source: 'comfyui', prompt },
      params: extractComfyParams(prompt) ?? undefined,
    })
  })
  api.addFiles([
    { file: new File(['x'], 'a1.png', { lastModified: 1000 }) },
    { file: new File(['x'], 'a2.png', { lastModified: 2000 }) },
    { file: new File(['x'], 'b1.png', { lastModified: 3000 }) },
  ])
  await flush()
  api.store.sourceFilter = 'all'

  const idOf = (n: string) => api.store.items.find((i) => i.name === n)!.id
  const groups = api.sameSourceGroups.value
  expect(groups.get(idOf('a1.png'))!.total).toBe(2) // a1 / a2 同工作流同种子
  expect(groups.get(idOf('b1.png'))!.total).toBe(1) // 不同种子自成一组
  expect(api.dupeCount.value).toBe(2)

  // 只看重复：b1（非重复）被隐藏
  api.store.dupeOnly = true
  expect(api.filteredItems.value.map((i) => i.name).sort()).toEqual(['a1.png', 'a2.png'])
  api.store.dupeOnly = false
  expect(api.filteredItems.value).toHaveLength(3)
})

it('统计增强：按天出图量与提示词高频词（FEAT-5）', async () => {
  const parameters = 'masterpiece, a cat, masterpiece\nSteps: 20'
  vi.mocked(parser.parseImage).mockResolvedValue({
    raw: { source: 'a1111', parameters },
    params: parseA1111Parameters(parameters),
  })
  const day = new Date(2026, 9, 11).getTime() // 本地时区 2026-10-11
  api.addFiles([
    { file: new File(['x'], 'a.png', { lastModified: day }) },
    { file: new File(['x'], 'b.png', { lastModified: day + 1 }) },
  ])
  await flush()
  api.store.sourceFilter = 'all'

  expect(api.dailyCounts.value).toEqual([{ day: '2026-10-11', count: 2 }])
  // masterpiece 每条提示词出现 2 次 × 2 张 = 4；单字符 / 纯数字噪声被过滤
  expect(api.keywordStats.value[0]).toEqual({ name: 'masterpiece', count: 4 })
  expect(api.keywordStats.value.some((w) => w.name === 'cat')).toBe(true)
})

it('多目录书签：记住多个目录、切换目标、忘记仅当前（FEAT-7）', async () => {
  await api.setRescanHandle({ name: 'out-a' } as unknown as FileSystemDirectoryHandle)
  await api.setRescanHandle({ name: 'out-b' } as unknown as FileSystemDirectoryHandle)
  expect([...api.store.dirBookmarks].sort()).toEqual(['out-a', 'out-b'])
  expect(api.store.rescanName).toBe('out-b') // 最近记住的为当前目标

  expect(api.switchRescanTarget('out-a')).toBe(true)
  expect(api.store.rescanName).toBe('out-a')
  expect(api.switchRescanTarget('nope')).toBe(false)
  expect(api.store.rescanName).toBe('out-a')

  // 忘记仅移除当前书签，其余保留
  api.forgetRescanHandle()
  expect(api.store.rescanName).toBeNull()
  expect(api.store.dirBookmarks).toEqual(['out-b'])

  api.clearAllDirBookmarks()
  expect(api.store.dirBookmarks).toEqual([])
})

it('预览 URL 惰性创建：入列为空，渲染时才生成（P2）', () => {
  api.addFiles([file('a.png')])
  const item = api.store.items[0]
  expect(item.url).toBe('')
  api.ensureItemUrl(item)
  expect(item.url).toBe('blob:mock')
  api.ensureItemUrl(item)
  expect(item.url).toBe('blob:mock')
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
      mk(
        '1',
        ['b.safetensors'],
        [{ name: 'l1' }],
        [{ nodeId: '3', classType: 'KSampler', sampler: 'euler' }],
      ),
      mk(
        '2',
        ['a.safetensors'],
        [{ name: 'l1' }, { name: 'l2' }],
        [
          { nodeId: '3', classType: 'KSampler', sampler: 'dpmpp_2m' },
          { nodeId: '9', classType: 'KSampler', sampler: 'euler' },
        ],
      ),
      // 无参数项（解析中 / 无元数据）不参与统计
      {
        id: '3',
        url: '',
        name: '3.png',
        size: 1,
        mtime: 1,
        status: 'done',
        source: 'none',
        raw: { source: 'none' },
      },
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
