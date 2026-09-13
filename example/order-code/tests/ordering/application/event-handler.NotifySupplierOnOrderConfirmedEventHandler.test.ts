import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NotifySupplierOnOrderConfirmedEventHandler } from '../../../src/ordering/application/event-handler.NotifySupplierOnOrderConfirmedEventHandler'
import { OrderConfirmedEvent } from '../../../src/ordering/domain/order/event.OrderConfirmedEvent'
import { MoneyValueObject } from '../../../src/ordering/domain/order/value-object.MoneyValueObject'
import type { SupplierNotificationInterface } from '../../../src/ordering/ports/port.SupplierNotificationInterface'

/** 记录每次通知的测试替身 */
class RecordingSupplierNotification implements SupplierNotificationInterface {
  private readonly _orderIds: string[]

  constructor() {
    this._orderIds = []
  }

  async notify(orderId: string): Promise<void> {
    this._orderIds.push(orderId)
  }

  get orderIds(): ReadonlyArray<string> {
    return this._orderIds
  }
}

describe('NotifySupplierOnOrderConfirmed', () => {
  it('[R-006] 订单确认后，通知供应商备货，带订单号', async () => {
    const supplier = new RecordingSupplierNotification()
    await new NotifySupplierOnOrderConfirmedEventHandler(supplier).handle(new OrderConfirmedEvent({ orderId: 'o-1', customerId: 'c-1', total: MoneyValueObject.CREATE(45, 'AUD') }))

    assert.deepEqual([...supplier.orderIds], ['o-1'])
  })
})
