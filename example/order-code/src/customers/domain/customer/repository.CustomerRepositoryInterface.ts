import type { CustomerAggregateRoot } from './aggregate-root.CustomerAggregateRoot'

export interface CustomerRepositoryInterface {
  findById(id: string): Promise<CustomerAggregateRoot | null>
  save(customer: CustomerAggregateRoot): Promise<void>
}
