import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PricingService } from '../../../src/ordering/domain/service.PricingService'
import { OrderAggregateRoot } from '../../../src/ordering/domain/order/aggregate-root.OrderAggregateRoot'
import { PromotionAggregateRoot } from '../../../src/ordering/domain/promotion/aggregate-root.PromotionAggregateRoot'
import { MoneyValueObject } from '../../../src/ordering/domain/order/value-object.MoneyValueObject'

const aud = (amount: number) => MoneyValueObject.CREATE(amount, 'AUD')
function orderOf20(): OrderAggregateRoot {
  const order = OrderAggregateRoot.CREATE({ id: 'o-1', customerId: 'c-1' })
  order.addLine('p-1', 2, aud(10))
  return order
}

describe('Pricing', () => {
  it('[R-005] 促销适用时按促销的折扣比例定价', () => {
    const promo = PromotionAggregateRoot.CREATE({ id: 'promo-1', code: 'SAVE10', threshold: aud(15), discountPercent: 10 })
    assert.deepEqual(new PricingService().evaluate(orderOf20(), promo), { kind: 'discounted', percent: 10 })
  })

  it('[R-005] 总额没到门槛按原价', () => {
    const promo = PromotionAggregateRoot.CREATE({ id: 'promo-2', code: 'BIG', threshold: aud(50), discountPercent: 10 })
    assert.deepEqual(new PricingService().evaluate(orderOf20(), promo), { kind: 'full-price' })
  })
})
