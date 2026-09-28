import { DomainEvent } from '@shared/building-block/domain'

/** @trace G-004 */
export class OrderRejectedEvent extends DomainEvent {
  constructor(readonly payload: { orderId: string; reason: string }) {
    super()
  }

  get aggregateId(): string {
    return this.payload.orderId
  }
}
