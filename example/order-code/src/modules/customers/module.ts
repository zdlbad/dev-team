import type { EventPublisherInterface } from '@shared/building-block/ports'
import { RenameCustomerCommandHandler } from './application/command-handler.RenameCustomerCommandHandler'
import { InMemoryCustomerRepository } from './adapters/adapter.InMemoryCustomerRepository'

/**
 * @module Customers
 * @responsibility 维护客户的身份
 * @trace G-010
 */
export function buildCustomersModule(events: EventPublisherInterface) {
  // 适配器
  const customers = new InMemoryCustomerRepository()
  // 处理器
  const handlers = {
    renameCustomer: new RenameCustomerCommandHandler(customers, events),
  }
  return { handlers, repositories: { customers } }
}
