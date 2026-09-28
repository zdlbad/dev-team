/**
 * 乐观锁冲突。基础设施错误，不是领域错误：由仓储适配器在 version 不符时抛出。
 */
export class ConcurrencyError extends Error {
  constructor(
    readonly aggregate: string,
    readonly id: string,
    readonly expectedVersion: number,
  ) {
    super(`${aggregate}#${id}: expected version ${expectedVersion}, but it has changed`)
    this.name = 'ConcurrencyError'
  }
}
