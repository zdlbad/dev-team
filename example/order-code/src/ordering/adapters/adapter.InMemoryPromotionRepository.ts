import { ConcurrencyError } from '@shared/building-block/domain'
import { PromotionAggregateRoot } from '../domain/promotion/aggregate-root.PromotionAggregateRoot'
import type { PromotionRepositoryInterface } from '../domain/promotion/repository.PromotionRepositoryInterface'

type Row = { id: string; props: Parameters<typeof PromotionAggregateRoot.FROM_PERSISTENCE>[1]; version: number }

export class InMemoryPromotionRepository implements PromotionRepositoryInterface {
  private rows = new Map<string, Row>()

  async findByCode(code: string): Promise<PromotionAggregateRoot | null> {
    const row = this.rows.get(code)
    return row ? PromotionAggregateRoot.FROM_PERSISTENCE(row.id, row.props, row.version) : null
  }

  async save(promotion: PromotionAggregateRoot): Promise<void> {
    const props = (promotion as unknown as { props: Row['props'] }).props
    const current = this.rows.get(props.code)
    if (current && current.version !== promotion.version) throw new ConcurrencyError('Promotion', promotion.id, promotion.version)
    this.rows.set(props.code, { id: promotion.id, props, version: promotion.version + 1 })
  }
}
