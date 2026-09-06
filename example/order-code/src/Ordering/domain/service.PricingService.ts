import type { OrderAggregateRoot } from './order/aggregate-root.OrderAggregateRoot'
import type { PromotionAggregateRoot } from './promotion/aggregate-root.PromotionAggregateRoot'

type PricingDecision = { kind: 'discounted'; percent: number } | { kind: 'full-price' }

export class PricingService {
  /**
   * @trace R-005
   * @rule 促销适用时按促销的折扣比例定价，否则按原价
   */
  evaluate(order: OrderAggregateRoot, promotion: PromotionAggregateRoot): PricingDecision {
    // 计算订单原价
    const total = order.total()
    // 判断促销是否适用
    const applies = promotion.appliesTo(total)
    return applies ? { kind: 'discounted', percent: promotion.discountPercent } : { kind: 'full-price' }
  }
}
