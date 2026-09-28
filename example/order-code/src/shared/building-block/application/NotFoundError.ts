/**
 * 技术守卫的错误：记录不存在。不是领域错误，不进模型。
 */
export class NotFoundError extends Error {
  constructor(readonly kind: string, readonly id: string) {
    super(`${kind}#${id} not found`)
    this.name = 'NotFoundError'
  }
}
