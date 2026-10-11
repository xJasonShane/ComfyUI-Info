import { describe, expect, it, vi } from 'vitest'

/**
 * 主题偏好：store 模块在 import 时读 localStorage / matchMedia 并注册系统主题监听，
 * 每个用例重置模块后动态导入，用受控的 matchMedia 假件驱动 prefers-color-scheme 变化。
 */
type Store = typeof import('../src/composables/store')

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

interface FakeMql {
  matches: boolean
  listeners: ((e: { matches: boolean }) => void)[]
}

function stubEnv(opts: { storedTheme?: string; prefersLight: boolean }): FakeMql {
  const storage = makeStorage()
  if (opts.storedTheme) storage.setItem('cii:theme', opts.storedTheme)
  const mql: FakeMql = { matches: opts.prefersLight, listeners: [] }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { hardwareConcurrency: 4 })
  vi.stubGlobal('window', {
    matchMedia: () => ({
      matches: mql.matches,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
        mql.listeners.push(cb),
      removeEventListener: () => {},
    }),
  })
  return mql
}

async function importStore(): Promise<Store> {
  vi.resetModules()
  return import('../src/composables/store')
}

function emit(mql: FakeMql, prefersLight: boolean) {
  mql.matches = prefersLight
  for (const cb of mql.listeners) cb({ matches: prefersLight })
}

describe('主题偏好', () => {
  it('未设置偏好时跟随系统并实时切换，程序驱动的跟随不写入显式偏好', async () => {
    const mql = stubEnv({ prefersLight: false })
    const api = await importStore()
    expect(api.store.dark).toBe(true)

    emit(mql, true) // 系统切到浅色
    expect(api.store.dark).toBe(false)
    // 跟随翻转不落盘：偏好仍未设置，下次系统变化继续跟随
    expect(localStorage.getItem('cii:theme')).toBeNull()
    emit(mql, false)
    expect(api.store.dark).toBe(true)
  })

  it('手动切换写入显式偏好，此后系统变化不再覆盖', async () => {
    const mql = stubEnv({ prefersLight: false })
    const api = await importStore()
    api.toggleDark()
    expect(api.store.dark).toBe(false)
    expect(localStorage.getItem('cii:theme')).toBe('light')

    emit(mql, true) // 系统切浅色：与显式偏好一致
    expect(api.store.dark).toBe(false)
    emit(mql, false)
    expect(api.store.dark).toBe(false) // 显式偏好优先，不跟随
  })

  it('已有显式偏好时不注册跟随、初始值取偏好', async () => {
    const mql = stubEnv({ storedTheme: 'dark', prefersLight: true })
    const api = await importStore()
    expect(api.store.dark).toBe(true)
    emit(mql, false)
    expect(api.store.dark).toBe(true) // 未受系统变化影响（无监听）
  })
})
