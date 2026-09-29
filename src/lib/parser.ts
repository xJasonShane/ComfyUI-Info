/**
 * 解析调度：把「读元数据 + 提取参数」派发到 Worker 池，批量扫描时主线程只等结果。
 * Worker 构造失败或健康探测超时（如部分 file:// 环境限制 Blob Worker）时，
 * 自动整体回退到主线程解析，行为与纯主线程版本一致。
 */
import ParseWorker from './parseWorker?worker&inline'
import { extractParams, internParseResult, readImageMetadata } from './metadata'
import type { ParseResult } from '../types'
import type { ParseWorkerReply, ParseWorkerRequest } from './parseWorker'

/** Worker 不可用的哨兵：触发整体回退主线程（与真实解析失败区分开） */
const BROKEN = Symbol('parse-worker-broken')

interface Job {
  resolve: (r: ParseResult) => void
  reject: (e: unknown) => void
}

class WorkerEntry {
  readonly worker: Worker
  private jobs = new Map<number, Job>()
  private seq = 0
  broken = false

  constructor() {
    this.worker = new ParseWorker()
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
}

class ParsePool {
  private entries: WorkerEntry[] = []
  private rr = 0

  static async create(): Promise<ParsePool | null> {
    const pool = new ParsePool()
    const count = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
    try {
      for (let i = 0; i < count; i++) pool.entries.push(new WorkerEntry())
    } catch {
      pool.dispose()
      return null // Worker 构造不可用
    }
    try {
      // 健康探测：用空文件走一遍完整解析链路，部分环境里 Blob Worker 会静默无响应，超时即整体回退
      await Promise.race([
        Promise.all(pool.entries.map((e) => e.post(new File([new Uint8Array(0)], 'probe.png')))),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('worker probe timeout')), 5000),
        ),
      ])
    } catch {
      pool.dispose()
      return null
    }
    return pool
  }

  parse(file: File): Promise<ParseResult> {
    this.rr = (this.rr + 1) % this.entries.length
    return this.entries[this.rr].post(file)
  }

  dispose() {
    for (const e of this.entries) e.worker.terminate()
    this.entries = []
  }
}

let poolPromise: Promise<ParsePool | null> | null = null

/** 主线程兜底：与 Worker 内完全相同的解析流程 */
async function parseOnMainThread(file: File): Promise<ParseResult> {
  const raw = await readImageMetadata(file)
  return { raw, params: extractParams(raw) }
}

export function parseImage(file: File): Promise<ParseResult> {
  if (poolPromise === null) poolPromise = ParsePool.create()
  return poolPromise.then((pool) => {
    if (!pool) return parseOnMainThread(file).then(internParseResult)
    return pool
      .parse(file)
      .then(internParseResult)
      .catch((err) => {
        if (err !== BROKEN) throw err
        // Worker 中途失效：终止并永久回退主线程
        pool.dispose()
        poolPromise = Promise.resolve(null)
        return parseOnMainThread(file).then(internParseResult)
      })
  })
}
