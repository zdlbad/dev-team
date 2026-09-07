import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AddOrderLineCommand, AddOrderLineCommandHandler } from '../../../src/Ordering/application/command-handler.AddOrderLineCommandHandler'
import { InMemoryOrderRepository } from '../../../src/Ordering/adapters/adapter.InMemoryOrderRepository'
import { InMemoryEventPublisher } from '../../../src/Ordering/adapters/adapter.InMemoryEventPublisher'
import { OrderAggregateRoot } from '../../../src/Ordering/domain/order/aggregate-root.OrderAggregateRoot'
import { InvalidOrderLineError } from '../../../src/Ordering/domain/order/error.InvalidOrderLineError'
import { OrderFailedError } from '../../../src/Ordering/domain/order/error.OrderFailedError'
import { MoneyValueObject } from '../../../src/Ordering/domain/order/value-object.MoneyValueObject'

async function setup(status: 'draft' | 'confirmed' = 'draft') {
  const orders = new InMemoryOrderRepository()
  const order = OrderAggregateRoot.CREATE({ id: 'o-1', customerId: 'c-1' })
  if (status === 'confirmed') {
    order.addLine('p-0', 1, MoneyValueObject.CREATE(5, 'AUD'))
    order.confirm(new Date('2026-09-05T00:00:00Z'))
  }
  await orders.save(order)
  return { orders, handler: new AddOrderLineCommandHandler(orders, new InMemoryEventPublisher()) }
}

describe('AddOrderLine', () => {
  it('[G-001][U-003] 一次加一行，订单多一行', async () => {
    const { orders, handler } = await setup()
    await handler.execute(new AddOrderLineCommand('o-1', 'p-1', 2, 10, 'AUD'))
    assert.equal((await orders.findById('o-1'))?.lineCount, 1)
  })

  it('[R-002] 数量不是正整数：InvalidOrderLine，订单不变', async () => {
    const { orders, handler } = await setup()
    await assert.rejects(handler.execute(new AddOrderLineCommand('o-1', 'p-1', 0, 10, 'AUD')), InvalidOrderLineError)
    assert.equal((await orders.findById('o-1'))?.lineCount, 0)
  })

  it('[R-001] 已确认的订单不能再加行：OrderFailed', async () => {
    const { handler } = await setup('confirmed')
    await assert.rejects(handler.execute(new AddOrderLineCommand('o-1', 'p-1', 1, 10, 'AUD')), OrderFailedError)
  })
})
