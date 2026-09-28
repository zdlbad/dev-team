import { assertFound } from '@shared/building-block/application'
import type { EventPublisherInterface } from '@shared/building-block/ports'
import type { CustomerRepositoryInterface } from '../domain/customer/repository.CustomerRepositoryInterface'

export class RenameCustomerCommand {
  constructor(
    readonly customerId: string,
    readonly name: string,
  ) {}
}

/** @actor Customer */
export class RenameCustomerCommandHandler {
  constructor(
    private customers: CustomerRepositoryInterface,
    private events: EventPublisherInterface,
  ) {}

  /** @trace G-010 */
  async execute(command: RenameCustomerCommand): Promise<void> {
    // 读取客户
    const customer = assertFound(await this.customers.findById(command.customerId), 'Customer', command.customerId)
    // 改名
    customer.rename(command.name)
    // 保存客户
    await this.customers.save(customer)
    // 发布事件
    await this.events.publish(customer.pullEvents())
  }
}
