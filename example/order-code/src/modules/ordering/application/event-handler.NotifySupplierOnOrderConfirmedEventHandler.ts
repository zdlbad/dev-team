import type { DomainEventHandler } from '@shared/building-block/application'
import type { OrderConfirmedEvent } from '../domain/order/event.OrderConfirmedEvent'
import type { SupplierNotificationInterface } from '../ports/port.SupplierNotificationInterface'

export class NotifySupplierOnOrderConfirmedEventHandler implements DomainEventHandler<OrderConfirmedEvent> {
  constructor(private supplier: SupplierNotificationInterface) {}

  /** @trace R-006 */
  async handle(event: OrderConfirmedEvent): Promise<void> {
    // 通知供应商备货
    await this.supplier.notify(event.payload.orderId)
  }
}
