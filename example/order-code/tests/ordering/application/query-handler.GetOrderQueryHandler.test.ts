import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NotFoundError } from '@shared/building-block/application'
import { GetOrderQuery, GetOrderQueryHandler } from '../../../src/ordering/application/query-handler.GetOrderQueryHandler'
import { InMemoryOrderRepository } from '../../../src/ordering/adapters/adapter.InMemoryOrderRepository'
import { OrderAggregateRoot } from '../../../src/ordering/domain/order/aggregate-root.OrderAggregateRoot'
import { MoneyValueObject } from '../../../src/ordering/domain/order/value-object.MoneyValueObject'

describe('GetOrder', () => {
  it('[G-002] 返回订单的状态与行数', async () => {
    const orders = new InMemoryOrderRepository()
    const order = OrderAggregateRoot.CREATE({ id: 'o-1', customerId: 'c-1' })
    order.addLine('p-1', 2, MoneyValueObject.CREATE(10, 'AUD'))
    await orders.save(order)

    const result = await new GetOrderQueryHandler(orders).execute(new GetOrderQuery('o-1'))
    assert.equal(result.status, 'draft')
    assert.equal(result.lineCount, 1)
  })

  it('[G-002] 订单不存在：NotFoundError', async () => {
    await assert.rejects(new GetOrderQueryHandler(new InMemoryOrderRepository()).execute(new GetOrderQuery('missing')), NotFoundError)
  })
})
