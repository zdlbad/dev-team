import { AggregateRoot } from '@shared/building-block/domain'
import { MoneyValueObject } from '../order/value-object.MoneyValueObject'
import { InvalidPromotionError } from './error.InvalidPromotionError'

type PromotionProps = {
  code: string
  threshold: MoneyValueObject
  discountPercent: number
  active: boolean
}

/**
 * @narrative 促销是一条降价规则：有代码、门槛金额与折扣比例，可启用或停用。
 * @invariant [R-005] 折扣比例在 0 到 50 之间 {InvalidPromotion}
 * @trace R-005
 */
export class PromotionAggregateRoot extends AggregateRoot<string> {
  private constructor(id: string, version: number, private props: PromotionProps) {
    super(id, version)
  }

  static CREATE(input: { id: string; code: string; threshold: MoneyValueObject; discountPercent: number }): PromotionAggregateRoot {
    if (input.discountPercent < 0 || input.discountPercent > 50) throw new InvalidPromotionError(`discount out of range: ${input.discountPercent}`)
    return new PromotionAggregateRoot(input.id, 0, { code: input.code, threshold: input.threshold, discountPercent: input.discountPercent, active: true })
  }

  static FROM_PERSISTENCE(id: string, props: PromotionProps, version: number): PromotionAggregateRoot {
    return new PromotionAggregateRoot(id, version, props)
  }

  /**
   * @trace R-005
   * @rule 促销启用且总额达到门槛才适用
   */
  appliesTo(total: MoneyValueObject): boolean {
    return this.props.active && total.currency === this.props.threshold.currency && total.amount >= this.props.threshold.amount
  }

  get discountPercent(): number {
    return this.props.discountPercent
  }
}
