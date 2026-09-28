import { DomainError } from '@shared/building-block/domain'

/**
 * @condition 两个不同币种的金额相加
 * @trace R-004
 */
export class CurrencyMismatchError extends DomainError {}
