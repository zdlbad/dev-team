import { ProtoHost } from '@shared/building-block/proto'
import { buildOrderingModule } from '../ordering/module'
import { buildCustomersModule } from '../customers/module'
import { AddOrderLineCommand } from '../ordering/application/command-handler.AddOrderLineCommandHandler'
import { ConfirmOrderCommand } from '../ordering/application/command-handler.ConfirmOrderCommandHandler'
import { CreateOrderCommand } from '../ordering/application/command-handler.CreateOrderCommandHandler'
import { GetOrderQuery } from '../ordering/application/query-handler.GetOrderQueryHandler'
import { RenameCustomerCommand } from '../customers/application/command-handler.RenameCustomerCommandHandler'
import { InMemoryEventPublisher } from '../ordering/adapters/adapter.InMemoryEventPublisher'
import { PromotionAggregateRoot } from '../ordering/domain/promotion/aggregate-root.PromotionAggregateRoot'
import { MoneyValueObject } from '../ordering/domain/order/value-object.MoneyValueObject'

/**
 * 原型入口（示例）。组合根不带宿主参数时，在这里把处理器与仓储登记进去。
 * 内存仓储没有 all() 的，用一个读它 rows 的包装。
 */
const rowsOf = (repo: unknown) => ({ all: () => [...((repo as { rows: Map<string, { props: object; version: number }> }).rows)].map(([id, r]) => ({ id, version: r.version, ...r.props })) })

const host = new ProtoHost((h) => {
  const customers = new Map([['c-1', '陈太太'], ['c-2', '李先生']])
  const ordering = buildOrderingModule(customers)
  const custs = buildCustomersModule(new InMemoryEventPublisher())
  // 草稿原型的起始数据：一条满 50 澳元打九折的促销，确认订单时才找得到优惠码
  void ordering.repositories.promotions.save(PromotionAggregateRoot.CREATE({ id: 'promo-1', code: 'SAVE10', threshold: MoneyValueObject.CREATE(50, 'AUD'), discountPercent: 10 }))
  h.repository('Ordering.Order', rowsOf(ordering.repositories.orders))
  h.repository('Ordering.Promotion', rowsOf(ordering.repositories.promotions))
  h.repository('Customers.Customer', rowsOf(custs.repositories.customers))
  h.command('Ordering.CreateOrder', (i) => new CreateOrderCommand(String(i.customerId)), ordering.handlers.createOrder)
  h.command('Ordering.AddOrderLine', (i) => new AddOrderLineCommand(String(i.orderId), String(i.productId), Number(i.quantity), Number(i.unitPriceAmount), String(i.currency)), ordering.handlers.addOrderLine)
  h.command('Ordering.ConfirmOrder', (i) => new ConfirmOrderCommand(String(i.orderId), String(i.promotionCode ?? '')), ordering.handlers.confirmOrder)
  h.query('Ordering.GetOrder', (i) => new GetOrderQuery(String(i.orderId)), ordering.handlers.getOrder)
  h.command('Customers.RenameCustomer', (i) => new RenameCustomerCommand(String(i.customerId), String(i.name)), custs.handlers.renameCustomer)
})
host.serve(Number(process.env.PROTO_PORT ?? 4873))
