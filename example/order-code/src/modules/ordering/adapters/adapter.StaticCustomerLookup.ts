import type { CustomerLookupInterface } from '../ports/port.CustomerLookupInterface'

/** 样例用：固定的客户表。真实实现会调用 Customers 模块的查询。 */
export class StaticCustomerLookup implements CustomerLookupInterface {
  constructor(private readonly customers: ReadonlyMap<string, string>) {}

  async findById(id: string): Promise<{ id: string; name: string } | null> {
    const name = this.customers.get(id)
    return name === undefined ? null : { id, name }
  }
}
