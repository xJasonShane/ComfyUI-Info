/**
 * 解析调度：把「读元数据 + 提取参数」派发到 Worker 池，批量扫描时主线程只等结果。
 * 传输（真实 Worker）通过工厂注入、延迟到首次解析时动态加载——无 Worker 环境导入本模块零副作用，
 * 池与回退编排可独立单测。构造失败、健康探测超时（如部分 file:// 环境限制 Blob Worker）
 * 或 Worker 中途失效时，自动整体回退主线程解析，行为与纯主线程版本一致。
 */
import { extractParams, internParseResult, readImageMetadata } from './metadata'
import type { ParseResult } from '../types'
import type { ParseWorkerReply, ParseWorkerRequest } from './parseWorker'

/** 传输已失效的哨兵：与真实解析失败区分开，触发池终止 + 永久回退主线程 */
export const BROKEN = Symbol('parse-worker-broken')

/** 单个解析通道：真实实现为包着 Worker 的 WorkerEntry */
export interface ParseTransport {
  /** 已失效：后续 post 一律以 BROKEN 拒绝 */
  broken: boolean
  post(file: File): Promise<ParseResult>
  terminate(): void
}

interface Job {
  resolve: (r: ParseResult) => void
  reject: (e: unknown) => void
}

class WorkerEntry implements ParseTransport {
  broken = false
  private jobs = new Map<number, Job>()
  private seq = 0
  private worker: Worker

  constructor(workerCtor: new () => Worker) {
    this.worker = new workerCtor()
    this.worker.onmessage = (e: MessageEvent<ParseWorkerReply>) => {
      const job = this.jobs.get(e.data.id)
      if (!job) return
      this.jobs.delete(e.data.id)
      if (e.data.error !== undefined || !e.data.raw) {
        job.reject(new Error(e.data.error ?? 'Worker 返回了无效结果'))
      } else {
        job.resolve({ raw: e.data.raw, params: e.data.params })
      }
    }
    this.worker.onerror = () => this.fail()
    this.worker.onmessageerror = () => this.fail()
  }

  post(file: File): Promise<ParseResult> {
    if (this.broken) return Promise.reject(BROKEN)
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject })
      this.worker.postMessage({ id, file } satisfies ParseWorkerRequest)
    })
  }

  private fail() {
    this.broken = true
    for (const job of this.jobs.values()) job.reject(BROKEN)
    this.jobs.clear()
  }

  terminate() {
    this.worker.terminate()
  }
}

/**
 * 传输池：构造全部通道并做健康探测（空文件走一遍完整解析链路，
 * 部分环境里 Blob Worker 会静默无响应），任一环节不可用即返回 null，
 * 由 ParseScheduler 整体回退主线程。
 */
export class ParsePool {
  private entries: ParseTransport[] = []
  private rr = 0

  constructor(
    private factory: () => ParseTransport,
    private count: number,
    private probeTimeoutMs = 5000,
  ) {}

  async create(): Promise<ParsePool | null> {
    try {
      for (let i = 0; i < this.count; i++) this.entries.push(this.factory())
    } catch {
      this.dispose()
      return null // Worker 构造不可用
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(this.entries.map((e) => e.post(new File([new Uint8Array(0)], 'probe.png')))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('worker probe timeout')), this.probeTimeoutMs)
        }),
      ])
    } catch {
      this.dispose()
      return null
    } finally {
      clearTimeout(timer) // 探测通过后清掉定时器，避免悬挂的 unhandled rejection
    }
    return this
  }

  parse(file: File): Promise<ParseResult> {
    this.rr = (this.rr + 1) % this.entries.length
    return this.entries[this.rr].post(file)
  }

  dispose() {
    for (const e of this.entries) e.terminate()
    this.entries = []
  }
}

/** 回退编排：池可用走池（单次失效即永久降级），否则主线程兜底 */
export class ParseScheduler {
  private poolPromise: Promise<ParsePool | null> | null = null

  constructor(private createPool: () => Promise<ParsePool | null>) {}

  parse(file: File): Promise<ParseResult> {
    if (this.poolPromise === null) this.poolPromise = this.createPool()
    return this.poolPromise.then((pool) => {
      if (!pool) return parseOnMainThread(file)
      return pool
        .parse(file)
        .then(internParseResult)
        .catch((err) => {
          if (err !== BROKEN) throw err
          // Worker 中途失效：终止并永久回退主线程
          pool.dispose()
          this.poolPromise = Promise.resolve(null)
          return parseOnMainThread(file)
        })
    })
  }
}

/** 主线程兜底：与 Worker 内完全相同的解析流程 */
async function parseOnMainThread(file: File): Promise<ParseResult> {
  const raw = await readImageMetadata(file)
  return { raw, params: extractParams(raw) }
}

async function createDefaultPool(): Promise<ParsePool | null> {
  // Worker 模块动态加载：首次解析才触发；模块加载或构造失败都视为环境不可用
  const count = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
  try {
    const { default: ParseWorker } = await import('./parseWorker?worker&inline')
    return await new ParsePool(() => new WorkerEntry(ParseWorker), count).create()
  } catch {
    return null
  }
}

const scheduler = new ParseScheduler(createDefaultPool)

export function parseImage(file: File): Promise<ParseResult> {
  return scheduler.parse(file)
}
