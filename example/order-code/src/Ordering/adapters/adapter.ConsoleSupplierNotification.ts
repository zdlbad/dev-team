import type { SupplierNotificationInterface } from '../ports/port.SupplierNotificationInterface'

export class ConsoleSupplierNotification implements SupplierNotificationInterface {
  async notify(orderId: string): Promise<void> {
    console.log(`[supplier] please prepare order ${orderId}`)
  }
}
