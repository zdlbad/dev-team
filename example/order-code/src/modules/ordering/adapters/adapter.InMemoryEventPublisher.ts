import type { DomainEvent } from '@shared/building-block/domain'
import type { DomainEventHandler } from '@shared/building-block/application'
import type { EventPublisherInterface } from '@shared/building-block/ports'

/** 进程内事件总线：按事件名分发给已订阅的处理器。 */
export class InMemoryEventPublisher implements EventPublisherInterface {
  private handlers = new Map<string, DomainEventHandler<DomainEvent>[]>()

  subscribe<E extends DomainEvent>(eventName: string, handler: DomainEventHandler<E>): void {
    const list = this.handlers.get(eventName) ?? []
    list.push(handler as DomainEventHandler<DomainEvent>)
    this.handlers.set(eventName, list)
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of this.handlers.get(event.eventName) ?? []) await handler.handle(event)
    }
  }
}
