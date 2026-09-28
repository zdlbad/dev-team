/**
 * @external-system SupplierPortal
 * @trace R-006
 */
export interface SupplierNotificationInterface {
  notify(orderId: string): Promise<void>
}
