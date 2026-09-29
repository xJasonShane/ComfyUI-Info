import { describe, expect, it } from 'vitest'
import { baseName, humanBytes, shortModel } from '../src/lib/utils'

describe('humanBytes', () => {
  it('各量级格式化', () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(1024)).toBe('1.0 KB')
    expect(humanBytes(1536)).toBe('1.5 KB')
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(humanBytes(3.5 * 1024 ** 3)).toBe('3.50 GB')
  })
})

describe('baseName / shortModel', () => {
  it('剥离目录与扩展名，超长截断', () => {
    expect(baseName('model.safetensors')).toBe('model')
    expect(baseName('no-ext')).toBe('no-ext')
    expect(shortModel('models/checkpoints/v1-5-pruned-emaonly.safetensors')).toBe(
      'v1-5-pruned-emaonly',
    )
    expect(shortModel('models\\checkpoints\\sdxl.safetensors')).toBe('sdxl') // Windows 路径分隔符
    const long = 'a'.repeat(30)
    expect(shortModel(long)).toBe(`${'a'.repeat(21)}…`)
    expect(shortModel('')).toBe('')
  })
})
