/**
 * 值对象基类。不可变、无 id、按值相等；CREATE 时校验；行为返回新实例。
 * 子类用 readonly 字段承载值；equals 按字段深比较。
 */
export abstract class ValueObject {
  equals(other: ValueObject): boolean {
    if (!(other instanceof this.constructor)) return false
    return deepEqual(this, other)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
