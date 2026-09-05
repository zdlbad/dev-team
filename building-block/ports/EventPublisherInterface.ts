import type { DomainEvent } from '../domain/DomainEvent'

/**
 * 事件发布端口。每个写处理器都注入它，并在 save 之后作为最后一步调用：
 *   await this.events.publish(order.pullEvents())
 * 实现在适配器层（进程内总线、消息队列等）。
 */
export interface EventPublisherInterface {
  publish(events: DomainEvent[]): Promise<void>
}
