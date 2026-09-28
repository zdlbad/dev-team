import type { DomainEvent } from '../domain/DomainEvent'

/**
 * 事件处理器接口。类名 = <动作>On<事件类名>EventHandler；handle 的参数类型必须与类名中的事件一致。
 */
export interface DomainEventHandler<E extends DomainEvent> {
  handle(event: E): Promise<void>
}
