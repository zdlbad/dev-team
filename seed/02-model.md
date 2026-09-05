# 02 — 模型：目录、命名与文件形状

*dev-team 种子文档。上位文档：[00-principles.md](00-principles.md)、[01-phases-and-slices.md](01-phases-and-slices.md)。*

本文七节：项目目录、模型目录、代码目录、命名规则、编解码对应、文件形状、推论出的规则。

---

## 一、项目目录

```
<project>/                    每个项目一个文件夹、一个 git 仓库；变化靠 git 追溯
  raw/                        原料，任意格式，人放入
  business/<topic>.md         业务描述：陈述性语句，按主题分文件
  glossary.json               词汇表
  model/                      设计模型（见「二」）
  model-decoded/<version>/    解码出的实际模型；与 model/ 同结构；临时产物
  slices/<id>.json            切片记录
  reports/                    校验报告，每个方向只留最新一份（临时物）
```

代码库在项目目录之外，其路径记在切片记录里。

### 业务描述的形式

陈述性语句，不写故事、步骤、角色矩阵。两类语句，每条带编号，编号一经分配永不复用：

```markdown
## 目标
- [G-001] 协调员能为参与者制定预算

## 规则
- [R-001] (不变量) 预算总额不得超过参与者的核定额度
- [R-002] (反应)   预算被批准后，通知服务提供方
- [R-003] (推导)   剩余额度 = 核定额度 − 已分配
```

| 语句 | 在模型中的落点 |
|---|---|
| 目标 | 命令或查询 |
| 规则・不变量 | 聚合行为的守卫 + 错误 |
| 规则・反应 | 事件处理 |
| 规则・推导 | 值对象或行为的计算 |

主题在战略设计之前浮现，不必对齐模块；战略设计之后可按模块重新归档，编号不变。

### 解码出的实际模型

`model-decoded/<version>/`，版本 = 代码提交号 + 时间戳。与 `model/` 同结构，由解码器整体生成，**永不手改，随时可删**。校验 ② 读 `model/` 与某一版 `model-decoded/<version>/` 比对。

---

## 二、模型目录

```
model/
  modules.json                          战略：上下文清单与职责
  <module>/
    module.json                         聚合清单与 id 引用
    domain/
      <aggregate>/                      每个聚合一个文件夹（小写业务名词）
        aggregate-root.<Name>AggregateRoot.json     聚合：含实体、值对象、事件、错误、行为、不变量
        repository.<Name>RepositoryInterface.json   仓储接口：读写方法
      service.<Name>Service.json        领域服务
    application/
      command-handler.<Name>CommandHandler.json
      query-handler.<Name>QueryHandler.json
      event-handler.<Name>EventHandler.json
    ports/
      port.<Name>Interface.json         对外依赖：外部系统或其他模块
```

- 六边形核心圈 = `domain` + `application` + `ports`，进模型、可解码。实现圈 = 代码里的 `adapters`，不进模型。
- 仓储是接口，放在领域层；实现在 `adapters`。查询直接调用仓储的读方法，不经过聚合行为，不设独立读模型。
- 事件只在**发出它的聚合**里声明一次；事件处理的 `trigger` 引用事件名。
- `ports/` 只放对外依赖；进入方向不设端口，命令与查询本身就是模块入口。
- **模块之间的关系不手写**，由渲染器与校验器推导：`ports/` 中指向其他模块的条目 = 同步依赖；事件处理触发于其他模块的事件 = 异步依赖。

### 两层模型在目录里的位置

| 层 | 文件 |
|---|---|
| 模块级 | `module.json`、`domain/service.*`、`application/*`、`ports/*` |
| 聚合级 | `domain/<aggregate>/aggregate-root.*` 及其仓储 |

---

## 三、代码目录

```
src/<module>/
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
```

应用层不分子目录，靠文件前缀区分种类。

---

## 四、命名规则

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

### 模型名与类名

**模型里的名字 = 类名去掉种类后缀。** 模型与词汇表用 `Order`、`Money`、`OrderCreated`、`CreateOrder`、`NotifySupplierOnOrderCreated`、`PaymentGateway`、`OrderRepository`；代码用带后缀的类名。编码时加后缀，解码时去后缀。词汇表只收模型名。

---

## 五、编解码对应

| 代码 | 模型 |
|---|---|
| `domain/<aggregate>/aggregate-root.*`、`entity.*`、`value-object.*`、`event.*`、`error.*` | **折叠**为一个 `aggregate-root.<Name>AggregateRoot.json` |
| `domain/<aggregate>/repository.*` | `repository.*.json` 一对一 |
| `domain/service.*` | `service.*.json` 一对一 |
| `application/*` | 一对一 |
| `ports/*` | 一对一 |
| `adapters/*` | 不解码 |

路径本身就是对应关系；解码器按文件前缀判定种类，不做推断。

---

## 六、文件形状

### 通用约定

- **类型词汇**：标量只用 `string | number | boolean | date`；其它类型写模型内的名字（`Money`、`OrderLine[]`）。解码时 TypeScript 类型映射回这四个标量。
- **跨模块引用**：`<模块>.<名字>`，如 `Billing.Invoice`、`Ordering.OrderCreated`。同模块内直接写名字。
- **追溯**：`traces: ["G-001", "R-002"]`，指向业务描述的编号。
- **问题**：`questions: [{ question, answer: "", applied: false }]`，每个文件一个数组。
- **无确认状态字段**：一个切片的模型改动由人整体确认，确认记在切片记录里，改动本身由 git 记录。
- **无可视化状态**：模型文件永远不含注解、布局等可视化状态；它们放在项目的 `.viewer/` 旁路目录，按模型文件路径索引。
- **裁决**：`decisions: [{ target, check, verdict: "accepted" | "dismissed", note, at }]`，每个模型文件一个数组；记录人对校验项的裁决（驳回的警告、接受的多聚合写入、边界信号的裁定）。校验器读它，未变化的项不再提出。
- 所有 `name` 都是模型名（无种类后缀）。`?` 表示可选字段。

### glossary.json

```jsonc
{ "terms": [ { "name": "Order", "definition": "客户提交的一次购买请求", "aliases": ["订单"] } ] }
```

与模型无关，只是业务的语言。模型的名字必须是词汇表里的词——这是校验项，不是词汇表的字段。

### model/modules.json

```jsonc
{ "system": "…",
  "modules": [ { "name": "Ordering", "responsibility": "一句话", "traces": [] } ],
  "questions": [] }
```

模块关系不写，由 ports 与事件推导。

### model/&lt;module&gt;/module.json

```jsonc
{ "module": "Ordering",
  "aggregates": [
    { "name": "Order", "members": ["OrderLine", "Money"],
      "idRefs": [ { "field": "customerId", "to": "Customers.Customer" } ],
      "traces": [] } ],
  "denylist": [ { "noun": "购物车", "reason": "UI 概念，不是领域实体" } ],
  "questions": [] }
```

### 领域对象：聚合根、实体、值对象

三者共用一副形状（字段、不变量、行为）；聚合根文件多两个聚合级字段。

```jsonc
// aggregate-root.OrderAggregateRoot.json
{ "name": "Order", "module": "Ordering",
  "aggregateNarrative": "整个聚合是什么 → 拥有什么 → 生命周期",
  "aggregateInvariants": [ { "text": "跨成员始终成立的条件", "traces": [] } ],
  "fields": [ { "name": "status", "type": "OrderStatus", "nullable?": false, "note?": "" } ],
  "invariants": [ { "text": "根对象自身始终成立的条件", "traces": [] } ],
  "behaviors": [ /* 见下 */ ],
  "traces": [], "questions": [] }

// entity.OrderLineEntity.json
{ "name": "OrderLine", "aggregate": "Order",
  "fields": [], "invariants": [], "behaviors": [], "traces": [] }

// value-object.MoneyValueObject.json
{ "name": "Money", "aggregate": "Order",
  "fields": [], "invariants": [], "behaviors": [], "traces": [] }
```

**行为**（三者共用）：

```jsonc
{ "name": "confirm",
  "input": [ { "name": "at", "type": "date" } ], "output?": "…",
  "rules": [ "这个行为做判断时依据的规则" ],
  "raises": [ "OrderConfirmed", { "event": "OrderRejected", "when": "…" } ],
  "throws": [ "OrderFailed" ],
  "traces": [] }
```

`invariants` 是对象状态**始终成立**的条件；`rules` 是某个行为**做决定时**依据的逻辑。值对象的推导规则就是它的行为上的 `rules`。

### 事件与错误

```jsonc
// event.OrderConfirmedEvent.json
{ "name": "OrderConfirmed", "aggregate": "Order", "payload": [ { "name": "orderId", "type": "string" } ], "traces": [] }

// error.OrderFailedError.json
{ "name": "OrderFailed", "aggregate": "Order", "condition": "何时抛出", "traces": [] }
```

不记发布方。谁发谁记（行为的 `raises` / `throws`）；校验反向核对每个事件、每个错误至少有一个发布方。

### repository.&lt;Name&gt;RepositoryInterface.json

```jsonc
{ "name": "OrderRepository", "aggregate": "Order",
  "methods": [ { "name": "findById", "kind": "read",  "input": [ { "name": "id", "type": "string" } ], "output": "Order" },
               { "name": "save",     "kind": "write", "input": [ { "name": "order", "type": "Order" } ] } ] }
```

### service.&lt;Name&gt;Service.json

```jsonc
{ "name": "Pricing", "module": "Ordering",
  "coordinates": ["Order", "Promotion"],
  "operations": [
    { "name": "price", "input": [], "output": "Money",
      "reads": ["Order", "Promotion"], "writes": [],
      "steps": [ /* 步骤语法 */ ],
      "rules": [], "raises": [], "throws": [], "traces": [] } ],
  "questions": [] }
```

`coordinates` **只能是本模块的聚合**。跨模块的数据只能通过端口（同步）或事件（异步）进来。领域服务跨的是逻辑，不是事务；事务边界属于命令。

### 步骤语法（用例与领域服务操作共用）

```jsonc
{ "text": "读起来通顺的一句话",
  "call?": { "kind": "behavior",        // behavior | service | repository | port | command
             "target": "Order",         // 聚合名 / 服务名 / 仓储名 / 端口名 / 命令名
             "method": "confirm" },
  "when?": "decision 为 discounted",   // 分流：条件只能是某次领域调用返回值的判别属性；"否则" 表示 else
  "input?": "…", "output?": "…",
  "raises?": [], "throws?": [] }
```

没有 `call` 的步骤只能是纯粹的数据搬运（组装输入、返回结果）。`kind` 为 `behavior` 时：在处理器的步骤里 `target` **只能是聚合根**；在领域服务操作的步骤里可以是聚合根、实体或值对象。技术守卫（找不到、无权限）与事件发布是机械动作，不进模型。

### command-handler.&lt;Name&gt;CommandHandler.json

```jsonc
{ "name": "CreateOrder", "module": "Ordering", "actor": "Coordinator",
  "input": [ { "name": "customerId", "type": "string" } ],
  "writes": ["Order"], "writesNote?": "长度大于 1 时必填：为什么必须在一个事务里写多个",
  "steps": [], "raises": [], "throws": [],
  "traces": ["G-001"], "questions": [] }
```

`writes` = 直接调用的写行为所属聚合 + 所调用服务操作的 `writes` 之并集。长度 1 为常态；大于 1 校验列为「需人确认」并附四条出路（合并 / 抽第三个聚合 / 最终一致 / 承认例外）。`raises` / `throws` 镜像自被调用的行为与服务。

### query-handler.&lt;Name&gt;QueryHandler.json

```jsonc
{ "name": "GetOrder", "module": "Ordering", "actor": "Coordinator",
  "input": [ { "name": "id", "type": "string" } ],
  "result": [ { "name": "status", "type": "OrderStatus" } ],
  "steps": [ /* call.kind 只允许 repository，且所调方法 kind 为 read */ ],
  "traces": ["G-002"], "questions": [] }
```

### event-handler.&lt;Name&gt;EventHandler.json

```jsonc
{ "name": "NotifySupplierOnOrderCreated", "module": "Fulfilment",
  "trigger": "Ordering.OrderCreated",
  "writes": [], "writesNote?": "",
  "steps": [], "raises": [], "throws": [],
  "traces": ["R-002"], "questions": [] }
```

事件处理是跨聚合、跨模块协作的正当途径；`writes` 规则同命令。

### port.&lt;Name&gt;Interface.json

```jsonc
{ "name": "PaymentGateway", "module": "Ordering",
  "kind": "external-system",               // external-system | module
  "target": "Stripe",                      // 外部系统名，或模块名
  "operations": [ { "name": "charge", "input": [], "output": "…", "note?": "" } ],
  "traces": [] }
```

### slices/&lt;id&gt;.json

```jsonc
{ "id": "s-001", "title": "…", "kind": "initial",          // initial | increment
  "codebase": "../order-service",
  "scope": { "modules": ["Ordering"], "aggregates": ["Order"], "useCases": ["CreateOrder", "GetOrder"] },
  "traces": ["G-001", "G-002", "R-001"],
  "stages": {
    "model":    { "status": "pending", "confirmedAt": null },      // pending | in-progress | done
    "code":     { "status": "pending", "at": null },
    "validate": { "status": "pending", "decodedVersion": null, "reportAt": null } },
  "log": [ { "ts": "2026-09-05", "stage": "slice", "text": "范围定稿" } ] }
```

日志只追加，不改写。

---

## 七、由形状推论出的规则（供 03 编码规范与 04 校验引用）

1. 模型中的每个名字必须是词汇表中的词。
2. 领域服务只协调本模块的聚合；跨模块只经端口或事件。
3. 查询的步骤只允许调用仓储的 `read` 方法。
4. 命令与事件处理的 `writes` 大于 1 必须有 `writesNote`，校验列为需人确认。
5. 每个事件、每个错误至少有一个发布方（某个行为的 `raises` / `throws`）。
6. 用例的 `raises` / `throws` 必须等于其步骤所调用的行为与服务的 `raises` / `throws` 之并集。
7. 每个步骤的 `call` 必须解析到存在的目标与方法。
8. 每条业务目标至少被一个命令或查询追溯；每条业务规则至少被一个行为、不变量、错误或事件处理追溯；反之每个模型元素的 `traces` 非空。
9. 模型文件不含可视化状态。
10. 处理器步骤中 `call.kind: behavior` 的 `target` 只能是聚合根；实体与值对象的行为只在聚合内部被调用。
11. 步骤的 `when` 只能引用某次领域调用的返回值；处理器不做业务判断。
12. 领域服务纯函数式：操作的 `reads` 即其参数所含的聚合。
