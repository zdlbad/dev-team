import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OrderLineEntity } from '../../../../src/Ordering/domain/order/entity.OrderLineEntity'
import { MoneyValueObject } from '../../../../src/Ordering/domain/order/value-object.MoneyValueObject'
import { InvalidOrderLineError } from '../../../../src/Ordering/domain/order/error.InvalidOrderLineError'

const aud = (amount: number) => MoneyValueObject.CREATE(amount, 'AUD')

describe('OrderLine', () => {
  it('[R-002] 数量必须为正整数：0 与小数都不行', () => {
    assert.throws(() => OrderLineEntity.CREATE('l-1', 'p-1', 0, aud(10)), InvalidOrderLineError)
    assert.throws(() => OrderLineEntity.CREATE('l-1', 'p-1', 1.5, aud(10)), InvalidOrderLineError)
  })

  it('[R-003] 小计 = 数量 × 单价', () => {
    const line = OrderLineEntity.CREATE('l-1', 'p-1', 3, aud(10))
    assert.equal(line.subtotal().amount, 30)
    assert.equal(line.subtotal().currency, 'AUD')
  })
})
