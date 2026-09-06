import type { DomainEvent } from '../domain/DomainEvent'
import type { DomainEventHandler } from '../application/DomainEventHandler'
import type { EventPublisherInterface } from '../ports/EventPublisherInterface'
import type { ProtoHost } from './ProtoHost'

/**
 * 进程内事件总线（原型用）：按事件名分发给已订阅的处理器，并把每个事件记到原型宿主的流水里。
 * 生产环境换成真的消息适配器；处理器代码不变。
 */
export class InMemoryEventPublisher implements EventPublisherInterface {
  private handlers = new Map<string, DomainEventHandler<DomainEvent>[]>()

  constructor(private readonly host?: ProtoHost) {}

  subscribe<E extends DomainEvent>(eventName: string, handler: DomainEventHandler<E>): void {
    const list = this.handlers.get(eventName) ?? []
    list.push(handler as DomainEventHandler<DomainEvent>)
    this.handlers.set(eventName, list)
  }

  async publish(events: DomainEvent[]): Promise<void> {
    this.host?.recordEvents(events)
    for (const event of events) {
      for (const handler of this.handlers.get(event.eventName) ?? []) await handler.handle(event)
    }
  }
}
