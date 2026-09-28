import { assertFound } from '@shared/building-block/application'
import type { OrderRepositoryInterface } from '../domain/order/repository.OrderRepositoryInterface'

export class GetOrderQuery {
  constructor(readonly orderId: string) {}
}

export class GetOrderResult {
  constructor(
    readonly status: string,
    readonly lineCount: number,
  ) {}
}

/** @actor Customer */
export class GetOrderQueryHandler {
  constructor(private orders: OrderRepositoryInterface) {}

  /** @trace G-002 */
  async execute(query: GetOrderQuery): Promise<GetOrderResult> {
    // 读取订单
    const order = assertFound(await this.orders.findById(query.orderId), 'Order', query.orderId)
    return new GetOrderResult(order.status, order.lineCount)
  }
}
