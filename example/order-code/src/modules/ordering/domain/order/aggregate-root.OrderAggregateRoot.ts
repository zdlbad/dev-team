import { AggregateRoot } from '@shared/building-block/domain'
import { OrderLineEntity } from './entity.OrderLineEntity'
import { MoneyValueObject } from './value-object.MoneyValueObject'
import { OrderConfirmedEvent } from './event.OrderConfirmedEvent'
import { OrderRejectedEvent } from './event.OrderRejectedEvent'
import { OrderFailedError } from './error.OrderFailedError'

type OrderStatus = 'draft' | 'confirmed' | 'rejected'

type OrderProps = {
  /** @ref Customers.Customer */
  customerId: string
  status: OrderStatus
  lines: OrderLineEntity[]
  discountPercent: number
}

/**
 * @narrative 订单是客户一次购买请求的全部内容：它拥有若干订单行，从草稿开始，确认后不可再改行，最终完成或取消。
 * @aggregate-invariant [R-003] 订单总额等于各订单行小计之和
 * @invariant [R-001] 确认后的订单不能再增删订单行
 * @trace G-001 G-004
 */
export class OrderAggregateRoot extends AggregateRoot<string> {
  private constructor(id: string, version: number, private props: OrderProps) {
    super(id, version)
  }

  static CREATE(input: { id: string; customerId: string }): OrderAggregateRoot {
    return new OrderAggregateRoot(input.id, 0, { customerId: input.customerId, status: 'draft', lines: [], discountPercent: 0 })
  }

  static FROM_PERSISTENCE(id: string, props: OrderProps, version: number): OrderAggregateRoot {
    return new OrderAggregateRoot(id, version, props)
  }

  /**
   * @trace G-001 R-001
   * @rule 只有草稿状态可以增加订单行
   */
  addLine(productId: string, quantity: number, unitPrice: MoneyValueObject): void {
    if (this.props.status !== 'draft') throw new OrderFailedError('only a draft order can take new lines')
    const lineId = `${this.id}-${this.props.lines.length + 1}`
    this.props.lines.push(OrderLineEntity.CREATE(lineId, productId, quantity, unitPrice))
  }

  /**
   * @trace G-004 R-005
   * @rule 只有草稿状态可以应用折扣
   * @rule 折扣不超过原价的一半
   */
  applyDiscount(percent: number): void {
    if (this.props.status !== 'draft') throw new OrderFailedError('only a draft order can be discounted')
    if (percent < 0 || percent > 50) throw new OrderFailedError(`discount out of range: ${percent}`)
    this.props.discountPercent = percent
  }

  /**
   * @trace G-004 R-001 R-011
   * @rule 只有草稿状态可以确认
   * @rule 没有订单行的订单被拒绝而不是确认
   */
  confirm(at: Date): void {
    if (this.props.status !== 'draft') throw new OrderFailedError('only a draft order can be confirmed')
    // 没有订单行
    if (this.props.lines.length === 0) {
      this.props.status = 'rejected'
      this.raise(new OrderRejectedEvent({ orderId: this.id, reason: `no lines at ${at.toISOString()}` }))
      return
    }
    this.props.status = 'confirmed'
    this.raise(new OrderConfirmedEvent({ orderId: this.id, customerId: this.props.customerId, total: this.total() }))
  }

  /**
   * @trace R-003
   * @rule 总额 = 各订单行小计之和，再按折扣比例扣减
   */
  total(): MoneyValueObject {
    const gross = this.props.lines.map((line) => line.subtotal()).reduce((sum, item) => sum.add(item))
    return gross.times((100 - this.props.discountPercent) / 100)
  }

  get status(): OrderStatus {
    return this.props.status
  }

  get lineCount(): number {
    return this.props.lines.length
  }
}
