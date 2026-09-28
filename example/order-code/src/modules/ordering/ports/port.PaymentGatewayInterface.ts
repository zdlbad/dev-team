import type { MoneyValueObject } from '../domain/order/value-object.MoneyValueObject'

/**
 * @external-system Stripe
 * @trace R-007
 */
export interface PaymentGatewayInterface {
  charge(amount: MoneyValueObject, customerId: string): Promise<string>
}
