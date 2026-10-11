/**
 * localStorage 安全读写（D4）：隐私模式 / 配额 / 环境限制下 setItem 会抛 SecurityError，
 * 偏好写入失败只影响下次刷新的还原，统一吞掉；读取统一容错返回 null。
 * 环境探测用 typeof 而非直接引用：Node 测试环境可能只有 stub，缺失时不抛错。
 */

export function safeGetItem(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // 配额 / 环境限制时忽略：仅影响下次刷新的还原
  }
}

export function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    // 同上
  }
}

/** 读取并解析 JSON；缺失 / 解析失败返回 null（由调用方做形状校验） */
export function readJSON(key: string): unknown {
  const raw = safeGetItem(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 序列化写入（序列化不可序列化值时同样吞错） */
export function writeJSON(key: string, value: unknown): void {
  try {
    safeSetItem(key, JSON.stringify(value))
  } catch {
    // 循环引用等序列化失败：同偏好写入语义，忽略
  }
}
