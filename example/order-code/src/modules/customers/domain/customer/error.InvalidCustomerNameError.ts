import { DomainError } from '@shared/building-block/domain'

/**
 * @condition 客户名字为空
 * @trace R-010
 */
export class InvalidCustomerNameError extends DomainError {}
