import type { PromotionAggregateRoot } from './aggregate-root.PromotionAggregateRoot'

export interface PromotionRepositoryInterface {
  findByCode(code: string): Promise<PromotionAggregateRoot | null>
  save(promotion: PromotionAggregateRoot): Promise<void>
}
