/**
 * 实体基类。有 id，按 id 相等。
 * 只在所属聚合内部被创建和调用；聚合根的公开 getter 不得返回实体实例。
 */
export abstract class Entity<Id> {
  protected constructor(readonly id: Id) {}

  equals(other: Entity<Id>): boolean {
    return other instanceof this.constructor && String(other.id) === String(this.id)
  }
}
