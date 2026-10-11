/** prefs.ts（D4）安全读写直测 */
import { describe, expect, it, vi } from 'vitest'
import { readJSON, safeGetItem, safeRemoveItem, safeSetItem, writeJSON } from '../src/lib/prefs'

describe('prefs 安全读写', () => {
  it('正常路径读写与 JSON 往返（Node 环境自行打桩 localStorage）', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    })
    try {
      safeSetItem('k1', 'v1')
      expect(safeGetItem('k1')).toBe('v1')
      writeJSON('k2', { a: 1 })
      expect(readJSON('k2')).toEqual({ a: 1 })
      safeRemoveItem('k1')
      expect(safeGetItem('k1')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('环境无 localStorage 时静默降级（Node 缺省即无）', () => {
    vi.stubGlobal('localStorage', undefined)
    try {
      expect(safeGetItem('k')).toBeNull()
      expect(() => safeSetItem('k', 'v')).not.toThrow()
      expect(() => safeRemoveItem('k')).not.toThrow()
      expect(readJSON('k')).toBeNull()
      expect(() => writeJSON('k', { a: 1 })).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('损坏 JSON 返回 null 而非抛错', () => {
    safeSetItem('bad', '{not json')
    expect(readJSON('bad')).toBeNull()
  })
})
