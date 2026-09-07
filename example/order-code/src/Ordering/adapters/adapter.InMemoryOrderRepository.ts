import { ConcurrencyError } from '@shared/building-block/domain'
import { OrderAggregateRoot } from '../domain/order/aggregate-root.OrderAggregateRoot'
import type { OrderRepositoryInterface } from '../domain/order/repository.OrderRepositoryInterface'

type Row = { props: Parameters<typeof OrderAggregateRoot.FROM_PERSISTENCE>[1]; version: number }

export class InMemoryOrderRepository implements OrderRepositoryInterface {
  private rows = new Map<string, Row>()

  // 不用 structuredClone：它会把 OrderLineEntity / MoneyValueObject 变成没有原型的普通对象，subtotal() 就没了。
  // 内存仓储不隔离实例；版本号照常比对，所以两次 save 同一份旧实例仍会抛 ConcurrencyError。
  async findById(id: string): Promise<OrderAggregateRoot | null> {
    const row = this.rows.get(id)
    return row ? OrderAggregateRoot.FROM_PERSISTENCE(id, row.props, row.version) : null
  }

  async save(order: OrderAggregateRoot): Promise<void> {
    const current = this.rows.get(order.id)
    if (current && current.version !== order.version) throw new ConcurrencyError('Order', order.id, order.version)
    this.rows.set(order.id, { props: (order as unknown as { props: Row['props'] }).props, version: order.version + 1 })
  }
}
