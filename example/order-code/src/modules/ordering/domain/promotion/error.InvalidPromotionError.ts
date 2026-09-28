import { DomainError } from '@shared/building-block/domain'

/**
 * @condition 折扣比例不在 0 到 50 之间
 * @trace R-005
 */
export class InvalidPromotionError extends DomainError {}
