import type { DomainEventHandler } from '@shared/building-block/application'
import type { OrderConfirmedEvent } from '../domain/order/event.OrderConfirmedEvent'
import type { PaymentGatewayInterface } from '../ports/port.PaymentGatewayInterface'

export class ChargeCustomerOnOrderConfirmedEventHandler implements DomainEventHandler<OrderConfirmedEvent> {
  constructor(private payment: PaymentGatewayInterface) {}

  /** @trace R-007 */
  async handle(event: OrderConfirmedEvent): Promise<void> {
    // 通过支付网关收款
    const receipt = await this.payment.charge(event.payload.total, event.payload.customerId)
    void receipt
  }
}
