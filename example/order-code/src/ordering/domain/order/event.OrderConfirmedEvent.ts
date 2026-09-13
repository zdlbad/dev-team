import { DomainEvent } from '@shared/building-block/domain'
import { MoneyValueObject } from './value-object.MoneyValueObject'

/** @trace G-004 */
export class OrderConfirmedEvent extends DomainEvent {
  constructor(readonly payload: { orderId: string; customerId: string; total: MoneyValueObject }) {
    super()
  }

  get aggregateId(): string {
    return this.payload.orderId
  }
}
