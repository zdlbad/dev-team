import { assertFound } from '@shared/building-block/application'
import type { EventPublisherInterface } from '@shared/building-block/ports'
import type { OrderRepositoryInterface } from '../domain/order/repository.OrderRepositoryInterface'
import type { PromotionRepositoryInterface } from '../domain/promotion/repository.PromotionRepositoryInterface'
import { PricingService } from '../domain/service.PricingService'

export class ConfirmOrderCommand {
  constructor(
    readonly orderId: string,
    readonly promotionCode: string,
  ) {}
}

/** @actor Customer */
export class ConfirmOrderCommandHandler {
  private readonly pricing = new PricingService()

  constructor(
    private orders: OrderRepositoryInterface,
    private promotions: PromotionRepositoryInterface,
    private events: EventPublisherInterface,
  ) {}

  /** @trace G-004 */
  async execute(command: ConfirmOrderCommand): Promise<void> {
    // 读取订单
    const order = assertFound(await this.orders.findById(command.orderId), 'Order', command.orderId)
    // 读取促销
    const promotion = assertFound(await this.promotions.findByCode(command.promotionCode), 'Promotion', command.promotionCode)
    // 评估定价
    const decision = this.pricing.evaluate(order, promotion)
    // decision 为 discounted
    if (decision.kind === 'discounted') {
      // 应用折扣
      order.applyDiscount(decision.percent)
    }
    // 确认订单
    order.confirm(new Date())
    // 保存订单
    await this.orders.save(order)
    // 发布事件
    await this.events.publish(order.pullEvents())
  }
}
