import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MoneyValueObject } from '../../../../src/Ordering/domain/order/value-object.MoneyValueObject'
import { InvalidMoneyError } from '../../../../src/Ordering/domain/order/error.InvalidMoneyError'
import { CurrencyMismatchError } from '../../../../src/Ordering/domain/order/error.CurrencyMismatchError'

describe('Money', () => {
  it('[R-004] 金额不为负', () => {
    assert.throws(() => MoneyValueObject.CREATE(-1, 'AUD'), InvalidMoneyError)
  })

  it('[R-004] 不同币种的金额不能相加', () => {
    const aud = MoneyValueObject.CREATE(10, 'AUD')
    const usd = MoneyValueObject.CREATE(10, 'USD')
    assert.throws(() => aud.add(usd), CurrencyMismatchError)
  })

  it('[R-004] 同币种相加得到新金额，原值不变', () => {
    const a = MoneyValueObject.CREATE(10, 'AUD')
    const sum = a.add(MoneyValueObject.CREATE(5, 'AUD'))
    assert.equal(sum.amount, 15)
    assert.equal(a.amount, 10)
  })
})
