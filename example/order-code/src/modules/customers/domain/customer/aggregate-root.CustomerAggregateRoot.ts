import { AggregateRoot } from '@shared/building-block/domain'
import { InvalidCustomerNameError } from './error.InvalidCustomerNameError'

type CustomerProps = {
  name: string
}

/**
 * @narrative 客户是下单的人或组织，有一个可修改的名字。
 * @invariant [R-010] 名字不能为空 {InvalidCustomerName}
 * @trace G-010
 */
export class CustomerAggregateRoot extends AggregateRoot<string> {
  private constructor(id: string, version: number, private props: CustomerProps) {
    super(id, version)
  }

  static CREATE(input: { id: string; name: string }): CustomerAggregateRoot {
    if (input.name.trim() === '') throw new InvalidCustomerNameError('name must not be empty')
    return new CustomerAggregateRoot(input.id, 0, { name: input.name })
  }

  static FROM_PERSISTENCE(id: string, props: CustomerProps, version: number): CustomerAggregateRoot {
    return new CustomerAggregateRoot(id, version, props)
  }

  /**
   * @trace G-010 R-010
   * @rule 新名字不能为空
   */
  rename(name: string): void {
    if (name.trim() === '') throw new InvalidCustomerNameError('name must not be empty')
    this.props.name = name
  }

  get name(): string {
    return this.props.name
  }
}
