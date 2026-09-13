import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DomainEventHandler } from '@shared/building-block/application'
import { NotFoundError } from '@shared/building-block/application'
import { ConfirmOrderCommand, ConfirmOrderCommandHandler } from '../../../src/ordering/application/command-handler.ConfirmOrderCommandHandler'
import { InMemoryOrderRepository } from '../../../src/ordering/adapters/adapter.InMemoryOrderRepository'
import { InMemoryPromotionRepository } from '../../../src/ordering/adapters/adapter.InMemoryPromotionRepository'
import { InMemoryEventPublisher } from '../../../src/ordering/adapters/adapter.InMemoryEventPublisher'
import { OrderAggregateRoot } from '../../../src/ordering/domain/order/aggregate-root.OrderAggregateRoot'
import { PromotionAggregateRoot } from '../../../src/ordering/domain/promotion/aggregate-root.PromotionAggregateRoot'
import { MoneyValueObject } from '../../../src/ordering/domain/order/value-object.MoneyValueObject'
import { OrderConfirmedEvent } from '../../../src/ordering/domain/order/event.OrderConfirmedEvent'
import { OrderFailedError } from '../../../src/ordering/domain/order/error.OrderFailedError'

const aud = (amount: number) => MoneyValueObject.CREATE(amount, 'AUD')

/** 记录收到的 OrderConfirmed 事件 */
class RecordingConfirmedHandler implements DomainEventHandler<OrderConfirmedEvent> {
  private readonly _events: OrderConfirmedEvent[]

  constructor() {
    this._events = []
  }

  async handle(event: OrderConfirmedEvent): Promise<void> {
    this._events.push(event)
  }

  get events(): ReadonlyArray<OrderConfirmedEvent> {
    return this._events
  }
}

async function setup(threshold: number) {
  const orders = new InMemoryOrderRepository()
  const promotions = new InMemoryPromotionRepository()
  const order = OrderAggregateRoot.CREATE({ id: 'o-1', customerId: 'c-1' })
  order.addLine('p-1', 2, aud(10)) // 总额 20
  await orders.save(order)
  await promotions.save(PromotionAggregateRoot.CREATE({ id: 'promo-1', code: 'SAVE10', threshold: aud(threshold), discountPercent: 10 }))
  const events = new InMemoryEventPublisher()
  const confirmed = new RecordingConfirmedHandler()
  events.subscribe('OrderConfirmed', confirmed)
  return { orders, confirmed, handler: new ConfirmOrderCommandHandler(orders, promotions, events) }
}

describe('ConfirmOrder', () => {
  it('[G-004][R-005] 促销适用：按折扣价确认，OrderConfirmed 带折后总额', async () => {
    const { orders, confirmed, handler } = await setup(15)
    await handler.execute(new ConfirmOrderCommand('o-1', 'SAVE10'))
    assert.equal((await orders.findById('o-1'))?.status, 'confirmed')
    assert.equal(confirmed.events.length, 1)
    assert.equal(confirmed.events[0].payload.total.amount, 18)
  })

  it('[R-005] 总额没到门槛：按原价确认', async () => {
    const { confirmed, handler } = await setup(50)
    await handler.execute(new ConfirmOrderCommand('o-1', 'SAVE10'))
    assert.equal(confirmed.events[0].payload.total.amount, 20)
  })

  it('[U-001] 连点两次确认：第二次 OrderFailed，事件只发一次', async () => {
    const { confirmed, handler } = await setup(15)
    await handler.execute(new ConfirmOrderCommand('o-1', 'SAVE10'))
    await assert.rejects(handler.execute(new ConfirmOrderCommand('o-1', 'SAVE10')), OrderFailedError)
    assert.equal(confirmed.events.length, 1)
  })

  it('[G-004] 促销码不存在：NotFoundError，订单仍是草稿', async () => {
    const { orders, handler } = await setup(15)
    await assert.rejects(handler.execute(new ConfirmOrderCommand('o-1', 'NOPE')), NotFoundError)
    assert.equal((await orders.findById('o-1'))?.status, 'draft')
  })
})
