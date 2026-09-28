import { randomUUID } from 'node:crypto'

/**
 * 领域事件基类。子类是纯数据类：构造参数即 payload，并给出 aggregateId。
 * 事件只能由聚合根的 raise() 发出，由应用层在 save 之后发布。
 */
export abstract class DomainEvent {
  readonly eventId: string = randomUUID()
  readonly occurredAt: Date = new Date()

  /** 发出该事件的聚合实例 id */
  abstract readonly aggregateId: string

  /** 事件名 = 类名去掉 Event 后缀（模型名） */
  get eventName(): string {
    return this.constructor.name.replace(/Event$/, '')
  }
}
