import { ConcurrencyError } from '@shared/building-block/domain'
import { CustomerAggregateRoot } from '../domain/customer/aggregate-root.CustomerAggregateRoot'
import type { CustomerRepositoryInterface } from '../domain/customer/repository.CustomerRepositoryInterface'

type Row = { props: Parameters<typeof CustomerAggregateRoot.FROM_PERSISTENCE>[1]; version: number }

export class InMemoryCustomerRepository implements CustomerRepositoryInterface {
  private rows = new Map<string, Row>()

  async findById(id: string): Promise<CustomerAggregateRoot | null> {
    const row = this.rows.get(id)
    return row ? CustomerAggregateRoot.FROM_PERSISTENCE(id, { ...row.props }, row.version) : null
  }

  async save(customer: CustomerAggregateRoot): Promise<void> {
    const current = this.rows.get(customer.id)
    if (current && current.version !== customer.version) throw new ConcurrencyError('Customer', customer.id, customer.version)
    this.rows.set(customer.id, { props: { name: customer.name }, version: customer.version + 1 })
  }
}
