import { NotFoundError } from './NotFoundError'

/**
 * 「找不到就抛」写成调用，不写成裸 if。处理器体里唯一允许的技术守卫形态之一。
 * 用法：const order = assertFound(await this.orders.findById(id), 'Order', id)
 */
export function assertFound<T>(value: T | null | undefined, kind: string, id: string): T {
  if (value === null || value === undefined) throw new NotFoundError(kind, id)
  return value
}
