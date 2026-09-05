# 03 — 编码规范：模型与代码的编解码规则

*dev-team 种子文档。上位文档：[00-principles.md](00-principles.md)、[02-model.md](02-model.md)。目录与命名见 02 的第二至五节，本文不重复。*

本规范的每一条都必须能被反向解析。凡是解码器读不出来的约定，就不是规范，只是风格。语言：TypeScript。

---

## 一、基础构建块 `src/shared/building-block/`

所有模块共用的技术基座：聚合根、事件、错误等抽象的基类与技术守卫。**不含任何业务概念**——它不是 DDD 战略意义上的「共享内核」（Shared Kernel，两个上下文共享的一块业务模型）；模块之间不共享任何业务模型，跨模块只经端口与事件。

```
src/shared/building-block/
  domain/        AggregateRoot · Entity · ValueObject · DomainEvent · DomainError · ConcurrencyError
  application/   NotFoundError · assertFound · 其它技术守卫的断言
  ports/         EventPublisherInterface · 其它技术端口（如 AccessInterface）
```

```ts
export abstract class AggregateRoot<Id> {
  protected constructor(readonly id: Id, private _version: number) {}
  get version(): number                       // 乐观锁；聚合自己永远不改它
  protected raise(event: DomainEvent): void   // 事件只能由此发出
  pullEvents(): DomainEvent[]                 // 取走并清空
}
export abstract class Entity<Id>   { protected constructor(readonly id: Id) {} }
export abstract class ValueObject  { equals(other: this): boolean }
export abstract class DomainEvent  {
  readonly eventId: string; readonly occurredAt: Date
  abstract readonly aggregateId: string
}
export abstract class DomainError extends Error {}
export class ConcurrencyError extends Error {}   // 基础设施错误，不是领域错误
```

---

## 二、领域层

**import 规则：领域层只能 import 同模块的领域层与 `shared/building-block/domain`。** 不 import 应用层、端口、适配器、任何框架或 ORM。

### 静态工厂

全部大写蛇形，名字说明来源。静态方法一律是工厂，不是行为。

| 工厂 | 用于 | 守卫不变量 |
|---|---|---|
| `CREATE(...)` | 聚合根、实体、值对象的新建 | 是 |
| `FROM_PERSISTENCE(props, version)` | 仓储还原聚合根 | 否 |

### 聚合根

```ts
export class OrderAggregateRoot extends AggregateRoot<OrderId> {
  private constructor(id: OrderId, version: number, private props: OrderProps) { super(id, version) }

  /** @narrative … */
  /** @invariant … */
  static CREATE(input: { customerId: CustomerId }): OrderAggregateRoot { /* 守卫 → new */ }
  static FROM_PERSISTENCE(id: OrderId, props: OrderProps, version: number): OrderAggregateRoot

  /** @trace G-003 R-001
   *  @rule 只有草稿状态可以确认 */
  confirm(at: Date): void {
    if (this.props.status !== 'draft') throw new OrderFailedError('…')   // 守卫在最前
    this.props.status = 'confirmed'
    this.raise(new OrderConfirmedEvent({ orderId: this.id.value }))
  }

  get status(): OrderStatus { return this.props.status }
  get lines(): ReadonlyArray<OrderLineSnapshot> { … }   // 不得返回 Entity 实例
}
```

- 私有构造；状态全部在 `props`，只能由行为修改；没有 setter
- **行为 = 公开的实例方法**（getter 除外）；守卫在方法最前面
- 错误只抛 `DomainError` 子类；事件只经 `this.raise(...)`，永不直接分发
- **实体封装**：公开 getter 不得返回 `Entity` 实例，要暴露成员只能返回值对象、原始类型或只读快照；实体与值对象的行为只在聚合内部被调用

### 实体、值对象

同聚合根的形状，去掉 `version`、`raise`、`FROM_PERSISTENCE`。值对象不可变、无 id、按值相等、`CREATE` 时校验、行为返回新实例。

### 事件、错误

纯数据类，构造参数即 payload。

```ts
export class OrderConfirmedEvent extends DomainEvent {
  constructor(readonly payload: { orderId: string }) { super() }
  get aggregateId() { return this.payload.orderId }
}
export class OrderFailedError extends DomainError {}
```

### 仓储接口

只出现领域类型。读写靠方法名前缀：**`find*` / `exists*` / `count*` 为读，其余为写**。

```ts
export interface OrderRepositoryInterface {
  findById(id: OrderId): Promise<OrderAggregateRoot | null>
  save(order: OrderAggregateRoot): Promise<void>     // 实现负责 version 比对与 +1，不符抛 ConcurrencyError
}
```

### 领域服务

**纯函数式。** 类，无构造注入；每个公开方法 = 一个操作；聚合与值作为参数传入，返回值或修改传入的聚合。

```ts
export class PricingService {
  /** @trace R-005 */
  price(order: OrderAggregateRoot, promotion: PromotionAggregateRoot): MoneyValueObject
}
```

---

## 三、应用层

**import 规则：应用层可 import 同模块领域层、同模块端口、`shared/building-block/*`。** 不 import 适配器。

### 处理器的形状

```ts
export class CreateOrderCommand { constructor(readonly customerId: string, readonly actor: ActorRef) {} }

export class CreateOrderCommandHandler {
  constructor(
    private customers: CustomerRepositoryInterface,
    private orders: OrderRepositoryInterface,
    private events: EventPublisherInterface,
  ) {}

  /** @trace G-001 */
  async execute(command: CreateOrderCommand): Promise<void> {
    // 读取客户
    const customer = assertFound(await this.customers.findById(command.customerId), 'Customer', command.customerId)
    // 创建订单
    const order = OrderAggregateRoot.CREATE({ customerId: customer.id })
    // 保存
    await this.orders.save(order)
    // 发布事件
    await this.events.publish(order.pullEvents())
  }
}
```

- 命令处理器：唯一入口 `execute(command)`，返回 `void`
- 查询处理器：`execute(query)` 返回 `Result` 类；只注入仓储接口；只调 `find*`
- 事件处理器：`implements DomainEventHandler<E>`，入口 `handle(event)`；`E` 必须与类名中的 `On<E>` 一致
- 构造注入，参数全部是接口

### 处理器体的语法：直线 + 按领域结果分流 + 作为调用的守卫

**直线**：每一步是一次调用；上方一行 `//` 注释是模型里的步骤 `text`。处理器不做任何计算。

**按领域结果分流**：允许 `if` / `switch`，但条件必须是**某次领域调用返回值的判别属性**（枚举、判别联合的 `kind`、布尔）。分支每一侧仍是直线。条件里出现对命令输入、聚合字段、原始值的比较或计算 → 业务判断泄漏，违规。

```ts
    // 评估定价
    const decision = this.pricing.evaluate(order, promotion)
    if (decision.kind === 'discounted') {
      // 应用折扣
      order.applyDiscount(decision.amount)
    } else {
      // 原价确认
      order.confirm(now)
    }
```

**作为调用的守卫**：找不到、无权限、幂等等技术守卫，一律写成 `shared/building-block/application` 的断言或 `shared/building-block/ports` 的端口调用，不写成裸 `if`。判断守卫是否「技术的」：业务专家不关心它。业务专家关心的（「协调员才能批准」）是领域规则，作为行为的守卫住在聚合里，行为签名带操作者。

### 事件分发

由应用层显式分发：凡调用了写方法的处理器，**最后一步必须是 `this.events.publish(x.pullEvents())`**。`EventPublisherInterface` 是每个写处理器都注入的端口。

### 应用层守卫的错误

`NotFoundError` 等技术错误来自 `shared/building-block/application`，不是领域错误，不进模型。

---

## 四、端口与适配器

- **端口** = 接口，方法只用领域类型或标量。
- **适配器** = 类，`implements` 一个仓储接口或端口接口；内部只做线格式转换；**不含分支业务逻辑**。
- 仓储适配器的 `save`：持久化 + 乐观锁（`where version = ?`，成功后 `+1`，不符抛 `ConcurrencyError`）。不分发事件。
- **组合根**：每模块一个 `module.ts`，实例化顺序：适配器 → 领域服务 → 处理器 → 事件订阅。是唯一允许 `new` 适配器的地方。

---

## 五、结构化注释

类型表达不了的模型信息，用固定的 JSDoc 标签承载。解码器只认这几个。

| 标签 | 放在 | 对应模型字段 |
|---|---|---|
| `@trace G-001 R-002` | 领域类、行为、领域服务操作、处理器的 `execute` / `handle` | `traces` |
| `@narrative 文本` | 聚合根类 | `aggregateNarrative` |
| `@invariant 文本` | 聚合根类（聚合级）、实体 / 值对象类（对象级） | `aggregateInvariants` / `invariants` |
| `@rule 文本` | 行为方法、领域服务操作 | `rules` |
| `// 文本` | 处理器体内每步上方 | 步骤 `text` |

缺少 `@trace` 的类、行为、处理器是违规。

---

## 六、解码规则汇总

| 代码 | 模型 |
|---|---|
| 文件前缀 + 基类 / 接口 | 种类（两者必须一致） |
| 类名去种类后缀 | `name` |
| `props` 的类型 | `fields` |
| 公开实例方法（getter 除外） | `behaviors`；签名 → `input` / `output` |
| 静态方法 | 工厂，不解码 |
| 方法体内 `this.raise(new XEvent)` / `throw new XError` | `raises` / `throws`（在 `if` 内 → 带 `when`） |
| 事件构造参数 | `payload` |
| 仓储方法名前缀 | `methods[].kind` |
| 领域服务操作的参数类型 | `reads`；操作内对参数聚合调用写行为 → `writes` |
| 处理器 `execute` / `handle` 的语句序列 | `steps`；被调对象的类型 → `call.kind` / `target` / `method` |
| 分支条件（领域调用结果的判别属性） | 分支内步骤的 `when` |
| `shared/building-block/application` 断言、`shared/building-block/ports` 调用、`publish` | 不解码 |
| 调用了写方法的仓储所属聚合 + 所调服务操作的 `writes` | `writes` |
| `Command` / `Query` / `Result` 类的字段 | `input` / `result` |
| `handle` 的参数类型 | `trigger` |
| 端口接口的方法签名 | `operations` |
| JSDoc 标签 | 见第五节 |
| 错误的 `condition` | 无法解码，留空；比对只比名字 |

---

## 七、禁止项（校验直接报告）

1. 领域层 import 同模块领域层与 `shared/building-block/domain` 以外的任何东西
2. 应用层 import 适配器
3. 处理器体内的业务判断（条件涉及输入、字段、原始值的比较或计算）
4. 处理器体内的裸 `if` 守卫（守卫必须是调用）
5. 组合根以外 `new` 适配器
6. 聚合上有 setter，或 `props` 被外部修改
7. 聚合根的公开 getter 返回 `Entity` 实例
8. 应用层调用实体或值对象的行为（只能调聚合根）
9. 抛出非 `DomainError` 的错误、`raise` 非 `DomainEvent` 的事件
10. 一个文件的导出超出命名规则允许的范围
11. 查询处理器调用非 `find*` / `exists*` / `count*` 方法
12. 写处理器最后一步不是 `publish`
13. 仓储适配器分发事件
14. 适配器中出现分支业务逻辑
15. 缺少 `@trace` 的领域类、行为、处理器
16. 领域服务有构造注入

---

## 八、未定

- 测试的位置与命名（`*.spec.ts` 与实现并列？）及领域测试的纯度要求
- 目标架构是否只支持六边形（v4 曾支持传统 MVC 作为第二目标；本规范只写六边形）
