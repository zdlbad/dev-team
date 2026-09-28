# 编码规范：模型与代码的编解码规则

*编码读全文，审查判代码时读「解码规则汇总」、审代码时读全文。模型文件的形状在 [model/shapes.md](../model/shapes.md)。*

本规范的每一条都必须能被反向解析。凡是解码器读不出来的约定，就不是规范，只是风格。语言：TypeScript。基础构建块以路径别名 `@shared/building-block/*` 引入（tsconfig `paths` 映射到代码库自己的 `src/shared/building-block/*`，不指到 dev-team）。

---

## 一、代码目录

```
src/
  modules/                  模块都在这里，一个模块一个文件夹
    <module-folder>/
      module.ts             组合根（第八节）
      domain/
        <aggregate>/
          aggregate-root.OrderAggregateRoot.ts
          entity.OrderLineEntity.ts
          value-object.MoneyValueObject.ts
          event.OrderCreatedEvent.ts
          error.OrderFailedError.ts
          repository.OrderRepositoryInterface.ts
        service.PricingService.ts
      application/
        command-handler.CreateOrderCommandHandler.ts
        query-handler.GetOrderQueryHandler.ts
        event-handler.NotifySupplierOnOrderCreatedEventHandler.ts
      ports/
        port.PaymentGatewayInterface.ts
      adapters/
        adapter.PrismaOrderRepository.ts
        adapter.StripePaymentGateway.ts
  bootstrap/                整个后端的组合根、起服务、示例数据（第八节「HTTP 入口的文件位置与命名」）；没有谁 import 它
  infras/                   技术件，不含业务：http/（Express 应用、路由、入参转换）、events/（进程内事件总线、事件流水），以后数据库连接、登录
  shared/building-block/    基础构建块（第五节），只放抽象
  proto/                    原型宿主入口，没有前端工程的项目用（样例）
```

应用层不分子目录，靠文件前缀区分种类。

**模块只放在 `src/modules/` 底下**：解码器只把 `src/modules/` 里的文件夹当模块读；`src/bootstrap/`、`src/infras/`、`src/shared/`、`src/proto/` 不是模块，不解码。`src/` 底下出现别的文件夹，解码器报它该挪进 `src/modules/`。

**文件夹名全小写、多词用连字符，模块名 PascalCase**（`common/project-layout.md`「名字的两套写法」）：`Participants` → `src/modules/participants/`，聚合文件夹同理（`domain/service-agreement/`），测试镜像 `tests/modules/<module-folder>/`。解码器先看组合根 `module.ts` 里 `build<Module>Module` 的真名，没有才按词换算。

### 前端工程的放法（React + TypeScript + Vite，界面用 Ant Design）

放在代码库旁边的 `frontend/`（或 `project.json` 的 `"frontend"` 指的目录，见 `common/project-layout.md`），自成一个工程、有自己的 `package.json`。解码器不读它；校验只读它上面的 `@trace`，只认应用行为那一层的编号。

- `src/api/<module-folder>.ts`：一个模块一份接口客户端，一个口一个函数，请求与返回的类型照 `contracts/<Module>.md` 写。发请求与错误的样子放 `src/api/http.ts` 一处：后端地址读 `VITE_API_BASE`（开发时空着，`/api` 由开发服务转给 `BACKEND_URL`；前后端两个网址时出站点前写上后端网址），后端回的 `{ error: { name, message } }` 变成带错误类名的异常。
- `src/pages/<业务>/`：按左栏的业务分文件夹（如 `onboarding`、`quarter`），一个细业务一个组件。只管页面怎么排的应用行为挂在组件上：组件前的 `/** … */` 注释里写一行 `@trace R-105 R-106`，跟后端同一种写法。
- `src/session/`：切身份只在这一处——现在是谁、他看得见哪些业务。页面只问这里，以后换成登录只改这一处。
- `src/lib/errors.ts`：错误类名 → 人话，一张表，照模型里那个错误的说明写；同一个错误在不同按钮上该说的不一样，按按钮另给一张。
- `src/dev/`：开发角落（重置、看状态、看事件、看登记，调后端的 `/api/_dev/…`），只在开发服务里（`import.meta.env.DEV`）或出站点时设了 `VITE_DEV_TOOLS=true` 才出现，不混进产品页面。
- `package.json` 脚本：`dev` 就是 `vite`（口读 `PORT`，`/api` 转给 `BACKEND_URL`，都在 `vite.config.ts` 里读）；`proto.js` 起它时在后面加 `--port <口> --strictPort`；人从工作台点「草稿原型」在新标签页直接打开这个口，页面挂在根路径上。另有 `build`（出静态站点）、`typecheck`。

## 二、依赖方向

```
bootstrap/  组合根、起服务、示例数据              谁都不依赖它
   │ 装配模块                         │ 装配技术件
   ▼                                  ▼
modules/<模块>/  ◄──────────────────  infras/  技术件，不含业务（HTTP、事件总线，以后数据库、登录）
  module.ts  装配本模块               ▲
  adapters/ → application/ → ports/   │
    └─────────────────────────────────┘  模块里只有 adapters 可以用 infras（以后的数据库连接、登录）
                  ↓
               domain/  聚合、领域服务、仓储接口
   │                                  │
   ▼                                  ▼
shared/building-block/   聚合根、实体、领域错误、事件、端口接口；不含业务
```

箭头从依赖的一方指向被依赖的一方。一条一条：

- **domain/** 只依赖本模块的 `domain/` 与 `shared/building-block/domain`（生成编号也从那里拿 `newId`），不 import 外部包。
- **application/** 依赖本模块的 `domain/`、`ports/`（同一层的处理器之间可以互相引类型），与 `shared/building-block` 的 `application`、`ports`。
- **ports/** 只用领域类型或标量：依赖本模块的 `domain/` 与 shared。
- **adapters/** 实现本模块的仓储接口（`domain/` 里的）与端口（`ports/` 里的）。**模块里只有 adapters 可以 import `infras/`**：以后的数据库仓储要用 infras 里的数据库连接、登录这些技术件。
- **module.ts** 装配本模块：new 本模块的适配器、处理器，订阅事件。外面给的东西（事件总线、别的模块的查询）只认 shared 里的端口接口或本模块 `ports/` 里的接口，具体实现由 bootstrap new 出来递进来：只发布事件的认 `EventPublisherInterface`，还要订阅的认 `EventBusInterface`（带 `subscribe`）。
- **模块（包括 module.ts）不 import bootstrap，模块之间不互相 import**；domain、application、ports、module.ts 不 import infras。跨模块走端口：本模块在 `ports/` 里写接口，`adapters/` 里的直连适配器收一个形状对得上的函数或对象（不 import 对方的类），由 bootstrap 把对方的处理器递进来。
- **infras/** 不含业务：可以 import 各模块 `application/` 里的处理器与命令、查询类型（路由要用）和 shared；不 import 各模块的 `domain/`、`adapters/`、`module.ts`，不 import bootstrap。HTTP 入口要的那一份应用（各模块的处理器）在 `infras/http` 里按处理器类写一份，组合根交来的东西照它对得上就行。
- **shared/building-block/** 不含业务，不认模块、infras、bootstrap，外部包只用 node 自带的（`node:crypto`）；里面 `domain` ← `application` ← `ports`。
- **bootstrap/** 依赖所有（各模块的 `module.ts`、infras、示例数据），没有谁 import 它。

样例 `example/order-code` 没有前端工程，也就没有 bootstrap、infras：入口 `src/proto/main.ts` 装配，原型宿主与进程内事件总线在构建块的 `proto/` 里（第五节）。`src/proto/` 跟 bootstrap 一样是外壳，构建块的 `proto/` 只给外壳用。

`validate` 带 `--code` 时查这几条：`src` 下每一条 import 照文件位置（相对路径）或 tsconfig 的 paths（别名）解析到文件，越界的报错误（`deps.direction`），找不到文件的报 `deps.unresolved`，`src` 底下不认得的文件夹报 `deps.unknown-folder`；外部包只查 domain 与构建块。

---

## 三、命名规则

**文件名 = `<种类前缀>.<类名>.<扩展名>`；主导出的类名与文件名中的类名一字不差；类名以种类后缀结尾。**

| 前缀 | 类名后缀 | 示例文件 | 主导出 | 伴随导出 |
|---|---|---|---|---|
| `aggregate-root.` | `AggregateRoot` | `aggregate-root.OrderAggregateRoot.ts` | `OrderAggregateRoot` | |
| `entity.` | `Entity` | `entity.OrderLineEntity.ts` | `OrderLineEntity` | |
| `value-object.` | `ValueObject` | `value-object.MoneyValueObject.ts` | `MoneyValueObject` | |
| `event.` | `Event` | `event.OrderCreatedEvent.ts` | `OrderCreatedEvent` | |
| `error.` | `Error` | `error.OrderFailedError.ts` | `OrderFailedError` | |
| `service.` | `Service` | `service.PricingService.ts` | `PricingService` | |
| `repository.` | `RepositoryInterface` | `repository.OrderRepositoryInterface.ts` | `OrderRepositoryInterface` | |
| `command-handler.` | `CommandHandler` | `command-handler.CreateOrderCommandHandler.ts` | `CreateOrderCommandHandler` | `CreateOrderCommand` |
| `query-handler.` | `QueryHandler` | `query-handler.GetOrderQueryHandler.ts` | `GetOrderQueryHandler` | `GetOrderQuery`、`GetOrderResult` |
| `event-handler.` | `EventHandler` | `event-handler.NotifySupplierOnOrderCreatedEventHandler.ts` | `NotifySupplierOnOrderCreatedEventHandler` | |
| `port.` | `Interface` | `port.PaymentGatewayInterface.ts` | `PaymentGatewayInterface` | |
| `adapter.` | 无；以技术名开头 | `adapter.PrismaOrderRepository.ts` | `PrismaOrderRepository` | |

补充：
- 事件处理的类名 = `<动作>On<事件类名>EventHandler`。解码器从类名读出触发事件，与代码中实际订阅的事件核对。
- 适配器类名 = `<技术><被实现的接口名去掉 Interface>`。解码器从类名推出它实现哪个接口，与 `implements` 子句核对。适配器不进模型，但命名规则同样适用。
- 伴随导出只允许表中列出的；其它导出即违规。

## 四、编解码对应

代码一栏的路径都相对模块目录 `src/modules/<module-folder>/`。

| 代码 | 模型 |
|---|---|
| `domain/<aggregate>/aggregate-root.*`、`entity.*`、`value-object.*`、`event.*`、`error.*` | **折叠**为一个 `aggregate-root.<Name>AggregateRoot.json` |
| `domain/<aggregate>/repository.*` | `repository.*.json` 一对一 |
| `domain/service.*` | `service.*.json` 一对一 |
| `application/*` | 一对一 |
| `ports/*` | 一对一 |
| `adapters/*` | 不解码 |
| `src/bootstrap/`、`src/infras/`、`src/shared/`、`src/proto/`（在 `src/modules/` 之外） | 不解码，不是模块 |

路径本身就是对应关系；解码器按文件前缀判定种类，不做推断。

---

## 五、基础构建块 `src/shared/building-block/`

所有模块共用的技术基座：聚合根、事件、错误等抽象的基类与技术守卫。它是代码库的一部分，跟代码一起提交、在代码库里改；dev-team 只在样例 `example/order-code/src/shared/building-block/` 里留一份，新项目由 `tools/new-project.js --codebase` 从那里拷一份起步。**不含任何业务概念**——它不是 DDD 战略意义上的「共享内核」（Shared Kernel，两个上下文共享的一块业务模型）；模块之间不共享任何业务模型，跨模块只经端口与事件。

```
src/shared/building-block/
  domain/        AggregateRoot · Entity · ValueObject · DomainEvent · DomainError · ConcurrencyError · newId（领域层生成 id 只从这里拿，不直接 import node:crypto）
  application/   NotFoundError · assertFound · 其它技术守卫的断言
  ports/         EventPublisherInterface · EventBusInterface（带 subscribe，要订阅事件的模块认它）· 其它技术端口（如 AccessInterface）
  proto/         ProtoHost（原型宿主）· InMemoryEventPublisher（进程内事件总线）：只在没有前端工程、用原型宿主的代码库里有
```

构建块里只放抽象。**端口的具体实现不放构建块**：有前端工程的项目没有 `proto/`，进程内事件总线 `InMemoryEventPublisher` 这类具体实现放项目的 `src/infras/`（第八节），由 `src/bootstrap/` new 出来递给模块。样例 `example/order-code` 没有 infras，照旧用构建块里的 `proto/`。

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

## 六、领域层

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

## 七、应用层

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
- 查询处理器：`execute(query)` 返回 `Result` 类；只注入仓储接口；仓储只调 `find*`；要算的，调不写聚合、不发事件的领域服务操作
- 事件处理器：`implements DomainEventHandler<E>`，入口 `handle(event)`；`E` 必须与类名中的 `On<E>` 一致
- 构造注入，参数全部是接口
- 领域服务是纯函数式的，**不注入**：处理器以字段初始化持有它（`private readonly pricing = new PricingService()`）
- 创建聚合或值对象是一步，调用静态工厂：`const order = OrderAggregateRoot.CREATE({ … })`（模型里 `call.kind: factory`）

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

## 八、端口与适配器

- **端口** = 接口，方法只用领域类型或标量。
- **适配器** = 类，`implements` 一个仓储接口或端口接口；内部只做线格式转换；**不含分支业务逻辑**。
- 仓储适配器的 `save`：持久化 + 乐观锁（`where version = ?`，成功后 `+1`，不符抛 `ConcurrencyError`）。不分发事件。
- **组合根**：每模块一个 `src/modules/<module-folder>/module.ts`，实例化顺序：适配器 → 领域服务 → 处理器 → 事件订阅。是唯一允许 `new` 本模块适配器的地方。模块外的具体实现（事件总线等 infras 里的技术件）由 `src/bootstrap/` new 出来递进来，`module.ts` 只认端口接口（第二节）。

### HTTP 入口的文件位置与命名（Express）

整个后端的组合根放 `src/bootstrap/`，HTTP 入口、事件总线这些技术件放 `src/infras/`；两样都是外壳、不是模块，解码器跳过（与 `shared`、`proto` 同）。谁能 import 谁见第二节。

- `src/bootstrap/composition-root.ts`：`composeApplication()` new 出 infras 里的具体实现（事件总线 `InMemoryEventPublisher`），调各模块的 `build<Module>Module(deps)` 递进去，交出各模块的处理器与按「模块.聚合」起名的仓储；示例数据放旁边的 `src/bootstrap/sample-data.ts` 等文件。各模块的 `module.ts` 不收宿主、不认 HTTP、不认具体实现，只装配、交出 `{ handlers, repositories }`。
- `src/bootstrap/server.ts`：读 `PORT`、`HOST` 起服务，把 `compose`（调组合根装一套应用）递给 HTTP 应用。
- `src/infras/http/app.ts`：Express 应用 `createHttpApp({ compose, devRoutes, frontendOrigins })`，按路由表挂口、错误对状态码（领域错误 422、找不到 404、版本冲突 409、格式不对 400），开发口 `/api/_dev/…` 只在非生产挂。它不 import 组合根，开发口重置时再调一次递进来的 `compose`。
- `src/infras/http/application.ts`：HTTP 入口要的那一份应用 `HttpApplication`——各模块的处理器（按处理器类写）与仓储；组合根交出的东西照它对得上就行。
- `src/infras/http/routes/<module-folder>.ts`：每个模块一个路由文件，一个口一行：`command('<Module>.<Name>', <路径>, 入参 → 命令对象, 应用 → 处理器)` / `query(…)`（两个都在 `src/infras/http/endpoint.ts`），名字照模型的限定名，路径与字段照 `contracts/<Module>.md`；`routes/index.ts` 合在一起；入参转换用 `src/infras/http/wire.ts`，只转格式、不做判断。
- `src/infras/events/in-memory-event-publisher.ts`：进程内事件总线，实现 shared 的 `EventBusInterface`，构造时给了记录者就先把事件交给它记下；`src/infras/events/event-log.ts` 是开发口看的事件流水（那个记录者），`/api/_dev/events` 读它。
- 开发用的口 `/api/_dev/manifest`（登记了哪些命令、查询、仓储，名字照模型的 `模块.名字`；`proto.js check` 拿它对模型）、`state`（各内存仓储的全部行）、`events`（事件流水）、`reset`（回到示例数据）。
- 代码库的 `package.json` 脚本：`dev`（入口 `src/bootstrap/server.ts`，改了代码自己重启，口读 `PORT`；`proto.js` 起后端就是在代码库里 `npm run dev`）、`build`（同一个入口打包）、`start`、`typecheck`（`proto.js check` 先跑它）。

---

## 九、结构化注释

类型表达不了的模型信息，用固定的 JSDoc 标签承载。解码器只认这几个。

| 标签 | 放在 | 对应模型字段 |
|---|---|---|
| `@trace G-001 R-002` | 领域类、行为、领域服务操作、处理器的 `execute` / `handle`、端口接口、`module.ts`、**`props` 字段** | `traces` |
| `@narrative 文本` | 聚合根类 | `aggregateNarrative` |
| `@aggregate-invariant [R-001] 文本` | 聚合根类 | `aggregateInvariants` |
| `@invariant [R-001 R-002] 文本 {ErrA ErrB}` | 聚合根类（根自身）、实体 / 值对象类 | `invariants`；方括号内是 traces，花括号内是创建时违反抛出的错误（`throws`），两者可省 |
| `@rule 文本` | 行为方法、领域服务操作 | `rules` |
| `@condition 文本` | 错误类 | `condition` |
| `@actor 名字` | 处理器类 | `actor` |
| `@ref Module.Aggregate` | `props` 类型中持有其它聚合 id 的字段 | `module.json` 的 `idRefs` |
| `@external-system 名字` / `@module 名字` | 端口接口 | 端口的 `kind` 与 `target` |
| `@module 名字` + `@responsibility 文本` | `module.ts` 的组合根函数 | `modules.json` |
| `@note 文本` | `props` 字段、端口方法 | `note` |
| `// 文本` | 处理器体内每步上方 | 步骤 `text` |
| `// 文本` | `if` 语句上方（处理器体内，或行为体内包住 `raise` 的 `if`） | 分支内步骤的 `when`；条件 raise 的 `when`。无注释时用条件源码；`else` 分支为「否则」 |

缺少 `@trace` 的类、行为、处理器是违规。

字段上的 `@trace` 是**选填**：`id`、创建时间这类没有业务出处的字段不必写，缺了不算违规。一条业务语句要求「必须记着某样东西」「这一栏照抄纸上印的字、供人查」时，它的落点就是那个字段——写上 `@trace`，校验才指得出它落在哪儿。

---

## 十、注释写什么

- **注释讲代码的行为和原因**：这个方法做什么、为什么这么做（为什么不用那个显而易见的做法、给下一个改代码的人的提醒）。
- **不写代码不负责的事**：类上的注释只说这个类守的规则；要提示别处守的，最多一句「唯一性不由这里守」，不加也行。
- **上下文不必写全，能不写就不写**：并发洞、真保证在哪一层、为什么住在这里——那是模型说明文字（`note`）的事，给人读模型用的。代码不照抄；模型有 `note` 而代码没写，校验 ② 不算差异。
- 第九节的结构化注释照旧：它们是模型的一部分，不是叙述。

---

## 十一、解码规则汇总

| 代码 | 模型 |
|---|---|
| 文件前缀 + 基类 / 接口 | 种类（两者必须一致） |
| 类名去种类后缀 | `name` |
| `props` 的类型 | `fields` |
| 公开实例方法（getter 除外） | `behaviors`；签名 → `input` / `output` |
| 静态方法 | 工厂：不作为行为解码；处理器中对它的调用解码为 `call.kind: factory`；它抛出的错误参与传递闭包 |
| 方法体内 `this.raise(new XEvent)` / `throw new XError` | `raises` / `throws`（在 `if` 内 → 带 `when`） |
| 事件构造参数 | `payload` |
| 仓储方法名前缀 | `methods[].kind` |
| 领域服务操作的参数类型 | `reads`；操作内对参数聚合调用写行为 → `writes` |
| 处理器 `execute` / `handle` 的语句序列 | `steps`；被调对象的类型 → `call.kind` / `target` / `method`。一条语句成为一步的条件：上方有 `//` 注释，或它的主调用能解析到核心圈里的对象。`await`、`assertFound(...)` 等构建块包装被剥掉后再看主调用；`return new Result(...)` 这类纯数据组装不解码 |
| 变量声明 `const x = …` | 步骤 `output` = 变量名 |
| 分支条件（领域调用结果的判别属性） | 分支内步骤的 `when` |
| `shared/building-block/application` 断言、`shared/building-block/ports` 调用、`publish` | 不解码 |
| 调用了写方法的仓储所属聚合 + 调用了会修改状态的聚合根行为 + 所调服务操作的 `writes` | `writes`。「修改状态」= 行为体内对 `this.props…` 赋值、对 `this.props…` 调用修改型方法（push、splice 等）、或 `this.raise`，并沿同类方法的调用传播 |
| 已解析的调用关系（行为 → 行为 / 工厂 / 服务操作；处理器 → 行为 / 工厂 / 服务操作 / 命令） | `raises` / `throws` 的传递闭包 |
| `Command` / `Query` / `Result` 类的字段 | `input` / `result` |
| `handle` 的参数类型 | `trigger` |
| 端口接口的方法签名 | `operations` |
| JSDoc 标签 | 见第九节 |
| 错误的 `condition` | 无法解码，留空；比对只比名字 |

---

## 十二、禁止项（校验直接报告）

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
11. 查询处理器调用仓储的非 `find*` / `exists*` / `count*` 方法，或调用会写聚合、会发事件的领域服务操作
12. 写处理器最后一步不是 `publish`
13. 仓储适配器分发事件
14. 适配器中出现分支业务逻辑
15. 缺少 `@trace` 的领域类、行为、处理器
16. 领域服务有构造注入
17. 处理器体内的 `if` 条件未引用某次领域调用（行为 / 工厂 / 服务）的返回值
18. 处理器体内直接 `throw`
19. 静态工厂内 `raise` 事件

---

## 十三、测试

测试不进模型、不被解码（解码器跳过 `*.test.ts`，且 `tests/` 不在 `src/` 下）。它是代码对自己的承诺，审查从角度 B、D 读它。

**位置与命名**：`tests/modules/` 镜像 `src/modules/`（文件夹同样全小写连字符，见第一节），文件名 = 源文件名 + `.test.ts`。

```
tests/modules/<module-folder>/domain/<aggregate>/aggregate-root.OrderAggregateRoot.test.ts
tests/modules/<module-folder>/domain/<aggregate>/value-object.MoneyValueObject.test.ts
tests/modules/<module-folder>/domain/service.PricingService.test.ts
tests/modules/<module-folder>/application/command-handler.ConfirmOrderCommandHandler.test.ts
tests/modules/<module-folder>/adapters/adapter.PrismaOrderRepository.test.ts
```

**框架**：`node:test` + `node:assert/strict`，不引第三方。`tsconfig` 的 `include` 含 `tests/**/*.ts`；运行用 `node $DEV_TEAM/tools/test.js <代码库> [<片段>…]`——一次只跑一小批，不整套跑。

**粒度（每条模型语句至少一个用例）**：

| 被测 | 用例 |
|---|---|
| 聚合根 / 实体 / 值对象 | 每条 `rule` 一个；每个 `throws` 一个（走到那个错误）；每个 `raises` 一个（事件发出、payload 对）；每条不变量的创建守卫一个 |
| 领域服务 | 每条 `rule` 一个；每个分流结果一个 |
| 命令 / 查询 / 事件处理 | 用内存适配器走 `steps` 主线一个；每个 `when` 分流一个；每个 `throws` 一个。断言**结果**（存了什么、发了什么、抛了什么），不断言「某个依赖被调了几次」 |
| 外壳（正式化） | 仓储：save / find 往返 + 版本冲突抛 `ConcurrencyError`；HTTP 入口：按契约的字段发请求，核对响应与错误 → 状态码；推迟的项没有实现 |

**用例名带编号**：`it('[R-001] 确认后的订单不能再加订单行', …)`。审查的角度 D 靠它把测试对回模型；没有编号的用例视为在测实现。

**纯度**：领域测试只 `import` 同模块领域层与 `shared/building-block/domain`——不 import 适配器、不起数据库、不 mock。用例测试用内存适配器（草稿原型用的那几个），不 mock 仓储接口。测试替身（记录调用的端口实现）写成小类，不用匿名对象拼。

**什么时候写**：草稿原型不写测试；人说「够了」之后正式化那一趟，编码把这一批场景的领域、用例、外壳测试一起补齐。

---

## 十四、未定

- 目标架构是否只支持六边形（v4 曾支持传统 MVC 作为第二目标；本规范只写六边形）
