import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromotionAggregateRoot } from '../../../../src/ordering/domain/promotion/aggregate-root.PromotionAggregateRoot'
import { MoneyValueObject } from '../../../../src/ordering/domain/order/value-object.MoneyValueObject'
import { InvalidPromotionError } from '../../../../src/ordering/domain/promotion/error.InvalidPromotionError'

const aud = (amount: number) => MoneyValueObject.CREATE(amount, 'AUD')
const save10 = () => PromotionAggregateRoot.CREATE({ id: 'promo-1', code: 'SAVE10', threshold: aud(15), discountPercent: 10 })

describe('Promotion', () => {
  it('[R-005] 折扣比例在 0 到 50 之间', () => {
    assert.throws(() => PromotionAggregateRoot.CREATE({ id: 'promo-x', code: 'BAD', threshold: aud(1), discountPercent: 51 }), InvalidPromotionError)
  })

  it('[R-005] 启用且总额达到门槛才适用', () => {
    assert.equal(save10().appliesTo(aud(20)), true)
    assert.equal(save10().appliesTo(aud(10)), false)
  })

  it('[R-005] 币种不同不适用', () => {
    assert.equal(save10().appliesTo(MoneyValueObject.CREATE(20, 'USD')), false)
  })

  it('[R-012] 已停用的促销不适用，哪怕总额够', () => {
    const stopped = PromotionAggregateRoot.FROM_PERSISTENCE('promo-2', { code: 'OLD', threshold: aud(1), discountPercent: 10, active: false }, 0)
    assert.equal(stopped.appliesTo(aud(100)), false)
  })
})
