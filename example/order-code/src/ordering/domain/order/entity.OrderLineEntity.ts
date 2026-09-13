import { Entity } from '@shared/building-block/domain'
import { MoneyValueObject } from './value-object.MoneyValueObject'
import { InvalidOrderLineError } from './error.InvalidOrderLineError'

type OrderLineProps = {
  productId: string
  quantity: number
  unitPrice: MoneyValueObject
}

/**
 * @invariant [R-002] 数量必须为正整数 {InvalidOrderLine}
 * @trace G-001
 */
export class OrderLineEntity extends Entity<string> {
  private constructor(id: string, private props: OrderLineProps) {
    super(id)
  }

  static CREATE(id: string, productId: string, quantity: number, unitPrice: MoneyValueObject): OrderLineEntity {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new InvalidOrderLineError(`quantity must be a positive integer: ${quantity}`)
    return new OrderLineEntity(id, { productId, quantity, unitPrice })
  }

  /**
   * @trace R-003
   * @rule 小计 = 数量 × 单价
   */
  subtotal(): MoneyValueObject {
    return this.props.unitPrice.times(this.props.quantity)
  }

  get productId(): string {
    return this.props.productId
  }
}
