import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OrderAggregateRoot } from '../../../../src/ordering/domain/order/aggregate-root.OrderAggregateRoot'
import { MoneyValueObject } from '../../../../src/ordering/domain/order/value-object.MoneyValueObject'
import { OrderFailedError } from '../../../../src/ordering/domain/order/error.OrderFailedError'

const aud = (amount: number) => MoneyValueObject.CREATE(amount, 'AUD')
const day = new Date('2026-09-05T00:00:00Z')
function draftWithOneLine(): OrderAggregateRoot {
  const order = OrderAggregateRoot.CREATE({ id: 'o-1', customerId: 'c-1' })
  order.addLine('p-1', 2, aud(10))
  return order
}

describe('Order', () => {
  it('[G-001] 草稿订单可以加订单行', () => {
    const order = draftWithOneLine()
    assert.equal(order.status, 'draft')
    assert.equal(order.lineCount, 1)
  })

  it('[R-001] 确认后的订单不能再加订单行', () => {
    const order = draftWithOneLine()
    order.confirm(day)
    assert.throws(() => order.addLine('p-2', 1, aud(5)), OrderFailedError)
  })

  it('[G-004] 有订单行的草稿确认后为 confirmed，发出 OrderConfirmed', () => {
    const order = draftWithOneLine()
    order.confirm(day)
    assert.equal(order.status, 'confirmed')
    assert.deepEqual(order.pullEvents().map((e) => e.eventName), ['OrderConfirmed'])
  })

  it('[G-004] 没有订单行的订单被拒绝而不是确认，发出 OrderRejected', () => {
    const order = OrderAggregateRoot.CREATE({ id: 'o-2', customerId: 'c-1' })
    order.confirm(day)
    assert.equal(order.status, 'rejected')
    assert.deepEqual(order.pullEvents().map((e) => e.eventName), ['OrderRejected'])
  })

  it('[U-001] 连点两次确认，第二次被挡住', () => {
    const order = draftWithOneLine()
    order.confirm(day)
    assert.throws(() => order.confirm(day), OrderFailedError)
  })

  it('[R-005] 折扣不超过原价的一半', () => {
    assert.throws(() => draftWithOneLine().applyDiscount(51), OrderFailedError)
  })

  it('[R-003] 总额 = 各订单行小计之和，再按折扣比例扣减', () => {
    const order = draftWithOneLine() // 2 × 10 = 20
    order.addLine('p-2', 1, aud(30)) // + 30 = 50
    order.applyDiscount(10) // × 0.9
    assert.equal(order.total().amount, 45)
  })
})
