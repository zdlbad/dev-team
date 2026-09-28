import { randomUUID } from 'node:crypto'
import { assertFound } from '@shared/building-block/application'
import type { EventPublisherInterface } from '@shared/building-block/ports'
import { OrderAggregateRoot } from '../domain/order/aggregate-root.OrderAggregateRoot'
import type { OrderRepositoryInterface } from '../domain/order/repository.OrderRepositoryInterface'
import type { CustomerLookupInterface } from '../ports/port.CustomerLookupInterface'

export class CreateOrderCommand {
  constructor(readonly customerId: string) {}
}

/** @actor Customer */
export class CreateOrderCommandHandler {
  constructor(
    private customers: CustomerLookupInterface,
    private orders: OrderRepositoryInterface,
    private events: EventPublisherInterface,
  ) {}

  /** @trace G-001 */
  async execute(command: CreateOrderCommand): Promise<void> {
    // 确认客户存在
    const customer = assertFound(await this.customers.findById(command.customerId), 'Customer', command.customerId)
    // 创建订单
    const order = OrderAggregateRoot.CREATE({ id: randomUUID(), customerId: customer.id })
    // 保存订单
    await this.orders.save(order)
    // 发布事件
    await this.events.publish(order.pullEvents())
  }
}
