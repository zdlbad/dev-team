type CustomerRef = { id: string; name: string }

/**
 * @module Customers
 * @trace G-001
 */
export interface CustomerLookupInterface {
  findById(id: string): Promise<CustomerRef | null>
}
