import { DomainError } from '@shared/building-block/domain'

/**
 * @condition 订单行的数量不是正整数
 * @trace R-002
 */
export class InvalidOrderLineError extends DomainError {}
