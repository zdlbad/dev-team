import { DomainEvent } from './DomainEvent'

/**
 * 聚合根基类。
 * - 私有构造 + 静态工厂 CREATE（守卫）/ FROM_PERSISTENCE（不守卫）
 * - 状态全部在 props，只能由行为修改
 * - version 供乐观锁使用：由 FROM_PERSISTENCE 带入，聚合自己永不修改
 * - 事件只经 raise() 发出；应用层在 save 之后 pullEvents() 并发布
 */
export abstract class AggregateRoot<Id> {
  private readonly _version: number
  private _events: DomainEvent[] = []

  protected constructor(readonly id: Id, version: number) {
    this._version = version
  }

  get version(): number {
    return this._version
  }

  protected raise(event: DomainEvent): void {
    this._events.push(event)
  }

  /** 取走并清空未发布的事件 */
  pullEvents(): DomainEvent[] {
    const events = this._events
    this._events = []
    return events
  }
}
