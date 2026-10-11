import { describe, expect, it, vi } from 'vitest'
import { locale } from '../src/locales'

describe('locale', () => {
  it('setup 固定语言为中文，测试不随宿主系统语言漂移', () => {
    expect(locale.value).toBe('zh')
  })

  it('Node 环境（有 navigator 无 window）即使语言是 en-US 也回退中文', async () => {
    vi.resetModules()
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    try {
      const { locale: fresh } = await import('../src/locales')
      expect(fresh.value).toBe('zh')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
