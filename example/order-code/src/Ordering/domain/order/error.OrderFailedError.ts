import { DomainError } from '@shared/building-block/domain'

/**
 * @condition 订单不在草稿状态时尝试修改、打折或确认
 * @trace R-001
 */
export class OrderFailedError extends DomainError {}
