import { CreateOrderCommandHandler } from './application/command-handler.CreateOrderCommandHandler'
import { AddOrderLineCommandHandler } from './application/command-handler.AddOrderLineCommandHandler'
import { ConfirmOrderCommandHandler } from './application/command-handler.ConfirmOrderCommandHandler'
import { GetOrderQueryHandler } from './application/query-handler.GetOrderQueryHandler'
import { NotifySupplierOnOrderConfirmedEventHandler } from './application/event-handler.NotifySupplierOnOrderConfirmedEventHandler'
import { ChargeCustomerOnOrderConfirmedEventHandler } from './application/event-handler.ChargeCustomerOnOrderConfirmedEventHandler'
import { InMemoryOrderRepository } from './adapters/adapter.InMemoryOrderRepository'
import { InMemoryPromotionRepository } from './adapters/adapter.InMemoryPromotionRepository'
import { StaticCustomerLookup } from './adapters/adapter.StaticCustomerLookup'
import { ConsoleSupplierNotification } from './adapters/adapter.ConsoleSupplierNotification'
import { FakePaymentGateway } from './adapters/adapter.FakePaymentGateway'
import { InMemoryEventPublisher } from './adapters/adapter.InMemoryEventPublisher'

/**
 * @module Ordering
 * @responsibility 接收、定价并确认客户的购买请求
 * @trace G-001 G-004
 */
export function buildOrderingModule(customers: ReadonlyMap<string, string>) {
  // 适配器
  const orders = new InMemoryOrderRepository()
  const promotions = new InMemoryPromotionRepository()
  const customerLookup = new StaticCustomerLookup(customers)
  const supplier = new ConsoleSupplierNotification()
  const payment = new FakePaymentGateway()
  const events = new InMemoryEventPublisher()
  // 处理器
  const handlers = {
    createOrder: new CreateOrderCommandHandler(customerLookup, orders, events),
    addOrderLine: new AddOrderLineCommandHandler(orders, events),
    confirmOrder: new ConfirmOrderCommandHandler(orders, promotions, events),
    getOrder: new GetOrderQueryHandler(orders),
  }
  // 事件订阅
  events.subscribe('OrderConfirmed', new NotifySupplierOnOrderConfirmedEventHandler(supplier))
  events.subscribe('OrderConfirmed', new ChargeCustomerOnOrderConfirmedEventHandler(payment))
  return { handlers, repositories: { orders, promotions } }
}
