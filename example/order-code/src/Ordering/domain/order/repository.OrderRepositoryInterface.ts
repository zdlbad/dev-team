import type { OrderAggregateRoot } from './aggregate-root.OrderAggregateRoot'

export interface OrderRepositoryInterface {
  findById(id: string): Promise<OrderAggregateRoot | null>
  save(order: OrderAggregateRoot): Promise<void>
}
