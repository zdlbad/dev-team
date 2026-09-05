/**
 * 领域错误基类。行为的守卫只抛它的子类；子类名即错误类名（<Name>Error）。
 */
export abstract class DomainError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = new.target.name
  }

  /** 错误名 = 类名去掉 Error 后缀（模型名） */
  get errorName(): string {
    return this.name.replace(/Error$/, '')
  }
}
