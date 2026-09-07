import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NotFoundError } from '@shared/building-block/application'
import { CreateOrderCommand, CreateOrderCommandHandler } from '../../../src/Ordering/application/command-handler.CreateOrderCommandHandler'
import { InMemoryOrderRepository } from '../../../src/Ordering/adapters/adapter.InMemoryOrderRepository'
import { StaticCustomerLookup } from '../../../src/Ordering/adapters/adapter.StaticCustomerLookup'
import { InMemoryEventPublisher } from '../../../src/Ordering/adapters/adapter.InMemoryEventPublisher'

// 内存仓储没有公开的行数；测试只看它存了几行
const rowCount = (repo: InMemoryOrderRepository) => (repo as unknown as { rows: Map<string, unknown> }).rows.size

function setup() {
  const orders = new InMemoryOrderRepository()
  const handler = new CreateOrderCommandHandler(new StaticCustomerLookup(new Map([['c-1', '陈太太']])), orders, new InMemoryEventPublisher())
  return { orders, handler }
}

describe('CreateOrder', () => {
  it('[G-001] 客户存在：创建草稿订单并保存', async () => {
    const { orders, handler } = setup()
    await handler.execute(new CreateOrderCommand('c-1'))
    assert.equal(rowCount(orders), 1)
  })

  it('[G-001] 客户不存在：NotFoundError，不保存', async () => {
    const { orders, handler } = setup()
    await assert.rejects(handler.execute(new CreateOrderCommand('nobody')), NotFoundError)
    assert.equal(rowCount(orders), 0)
  })
})
