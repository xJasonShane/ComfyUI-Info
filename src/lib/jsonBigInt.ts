/**
 * 保精度 JSON 解析：ComfyUI / Fooocus 等生成器的 seed 是 64 位整数，
 * 直接 JSON.parse 会丢精度。解析前把裸大整数替换成字符串（字符串字面量内部跳过），
 * 不改变对象形状，只保证大整数按原文保留。ComfyUI 与 Fooocus 解析器共用。
 */
const UNSAFE_INT_MIN_DIGITS = 16

export function quoteUnsafeBigInts(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (ch === '"') {
      // 字符串字面量（含转义）原样复制
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') j += 2
        else if (text[j] === '"') {
          j++
          break
        } else j++
      }
      out += text.slice(i, j)
      i = j
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < n && text[j]! >= '0' && text[j]! <= '9') j++
      const digits = text.slice(i, j)
      const prev = out.charAt(out.length - 1)
      const next = j < n ? text[j]! : ''
      // 前邻小数点 / 指数符或后接小数点 / 指数符：是小数或科学计数法的片段，不是独立整数
      const standalone =
        prev !== '.' && prev !== 'e' && prev !== 'E' && next !== '.' && next !== 'e' && next !== 'E'
      if (digits.length >= UNSAFE_INT_MIN_DIGITS && standalone) {
        // 负号留在引号外会产生非法 JSON：一并移进引号（seed 恒为非负，防御性处理）
        if (prev === '-') out = `${out.slice(0, -1)}"-${digits}"`
        else out += `"${digits}"`
      } else {
        out += digits
      }
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 解析 JSON 并把 ≥2^53 的裸整数保留为字符串；非法 JSON / 非对象返回 null */
export function parseJsonPreservingBigInts(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(quoteUnsafeBigInts(text))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
