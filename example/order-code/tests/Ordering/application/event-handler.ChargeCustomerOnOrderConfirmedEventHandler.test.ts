import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChargeCustomerOnOrderConfirmedEventHandler } from '../../../src/Ordering/application/event-handler.ChargeCustomerOnOrderConfirmedEventHandler'
import { OrderConfirmedEvent } from '../../../src/Ordering/domain/order/event.OrderConfirmedEvent'
import { MoneyValueObject } from '../../../src/Ordering/domain/order/value-object.MoneyValueObject'
import type { PaymentGatewayInterface } from '../../../src/Ordering/ports/port.PaymentGatewayInterface'

/** 记录每次收款的测试替身 */
class RecordingPaymentGateway implements PaymentGatewayInterface {
  private readonly _charges: { amount: MoneyValueObject; customerId: string }[]

  constructor() {
    this._charges = []
  }

  async charge(amount: MoneyValueObject, customerId: string): Promise<string> {
    this._charges.push({ amount, customerId })
    return `receipt-${this._charges.length}`
  }

  get charges(): ReadonlyArray<{ amount: MoneyValueObject; customerId: string }> {
    return this._charges
  }
}

describe('ChargeCustomerOnOrderConfirmed', () => {
  it('[R-007] 订单确认后，按订单总额向该客户收款一次', async () => {
    const gateway = new RecordingPaymentGateway()
    const total = MoneyValueObject.CREATE(45, 'AUD')
    await new ChargeCustomerOnOrderConfirmedEventHandler(gateway).handle(new OrderConfirmedEvent({ orderId: 'o-1', customerId: 'c-1', total }))

    assert.equal(gateway.charges.length, 1)
    assert.equal(gateway.charges[0].customerId, 'c-1')
    assert.equal(gateway.charges[0].amount.amount, 45)
  })
})
