import type { MoneyValueObject } from '../domain/order/value-object.MoneyValueObject'
import type { PaymentGatewayInterface } from '../ports/port.PaymentGatewayInterface'

export class FakePaymentGateway implements PaymentGatewayInterface {
  async charge(amount: MoneyValueObject, customerId: string): Promise<string> {
    return `receipt:${customerId}:${amount.amount}${amount.currency}`
  }
}
