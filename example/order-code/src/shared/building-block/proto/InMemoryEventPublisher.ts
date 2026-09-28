import type { DomainEvent } from '../domain/DomainEvent'
import type { DomainEventHandler } from '../application/DomainEventHandler'
import type { EventPublisherInterface } from '../ports/EventPublisherInterface'

/** 谁要把发出的事件记下来：原型宿主（ProtoHost）是一个，HTTP 后端开发口的事件流水是另一个 */
export interface EventRecorder {
  recordEvents(events: DomainEvent[]): void
}

/**
 * 进程内事件总线：按事件名分发给已订阅的处理器；给了记录者，就先把每个事件交给它记下。
 * 不给记录者也能用（生产外壳里数据还在内存时就是这样）。换成真的消息适配器时处理器代码不变。
 */
export class InMemoryEventPublisher implements EventPublisherInterface {
  private handlers = new Map<string, DomainEventHandler<DomainEvent>[]>()

  constructor(private readonly recorder?: EventRecorder) {}

  subscribe<E extends DomainEvent>(eventName: string, handler: DomainEventHandler<E>): void {
    const list = this.handlers.get(eventName) ?? []
    list.push(handler as DomainEventHandler<DomainEvent>)
    this.handlers.set(eventName, list)
  }

  async publish(events: DomainEvent[]): Promise<void> {
    this.recorder?.recordEvents(events)
    for (const event of events) {
      for (const handler of this.handlers.get(event.eventName) ?? []) await handler.handle(event)
    }
  }
}
