import type { DomainEvent } from '../domain/DomainEvent'
import type { DomainEventHandler } from '../application/DomainEventHandler'
import type { EventPublisherInterface } from './EventPublisherInterface'

/**
 * 事件总线端口：能发布，也能订阅。要接别处事件的模块在装配时认它，把事件处理器按事件名订阅上：
 *   deps.events.subscribe('CareManagementShareAllocated', handlers.recordShareInPool)
 * 只发布不订阅的写处理器仍只认 EventPublisherInterface。实现在项目的 infras（进程内总线、消息队列等）。
 */
export interface EventBusInterface extends EventPublisherInterface {
  subscribe<E extends DomainEvent>(eventName: string, handler: DomainEventHandler<E>): void
}
