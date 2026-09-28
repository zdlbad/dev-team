import { DomainError } from '@shared/building-block/domain'

/**
 * @condition 金额为负
 * @trace R-004
 */
export class InvalidMoneyError extends DomainError {}
