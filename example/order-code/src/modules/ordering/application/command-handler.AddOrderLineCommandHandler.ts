import { assertFound } from '@shared/building-block/application'
import type { EventPublisherInterface } from '@shared/building-block/ports'
import type { OrderRepositoryInterface } from '../domain/order/repository.OrderRepositoryInterface'
import { MoneyValueObject } from '../domain/order/value-object.MoneyValueObject'

export class AddOrderLineCommand {
  constructor(
    readonly orderId: string,
    readonly productId: string,
    readonly quantity: number,
    readonly unitPriceAmount: number,
    readonly currency: string,
  ) {}
}

/** @actor Customer */
export class AddOrderLineCommandHandler {
  constructor(
    private orders: OrderRepositoryInterface,
    private events: EventPublisherInterface,
  ) {}

  /** @trace G-001 R-013 */
  async execute(command: AddOrderLineCommand): Promise<void> {
    // 读取订单
    const order = assertFound(await this.orders.findById(command.orderId), 'Order', command.orderId)
    // 构造单价
    const unitPrice = MoneyValueObject.CREATE(command.unitPriceAmount, command.currency)
    // 添加订单行
    order.addLine(command.productId, command.quantity, unitPrice)
    // 保存订单
    await this.orders.save(order)
    // 发布事件
    await this.events.publish(order.pullEvents())
  }
}
