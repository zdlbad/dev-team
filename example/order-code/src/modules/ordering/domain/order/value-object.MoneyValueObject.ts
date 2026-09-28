import { ValueObject } from '@shared/building-block/domain'
import { CurrencyMismatchError } from './error.CurrencyMismatchError'
import { InvalidMoneyError } from './error.InvalidMoneyError'

/**
 * @invariant [R-004] 金额不为负 {InvalidMoney}
 * @trace R-004
 */
export class MoneyValueObject extends ValueObject {
  private constructor(readonly amount: number, readonly currency: string) {
    super()
  }

  static CREATE(amount: number, currency: string): MoneyValueObject {
    if (amount < 0) throw new InvalidMoneyError(`amount must not be negative: ${amount}`)
    return new MoneyValueObject(amount, currency)
  }

  /**
   * @trace R-004
   * @rule 币种必须相同
   */
  add(other: MoneyValueObject): MoneyValueObject {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(`${this.currency} vs ${other.currency}`)
    return MoneyValueObject.CREATE(this.amount + other.amount, this.currency)
  }

  /** @trace R-003 */
  times(factor: number): MoneyValueObject {
    return MoneyValueObject.CREATE(this.amount * factor, this.currency)
  }
}
