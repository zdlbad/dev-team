# 02 — 模型：目录、命名与文件形状

*dev-team 种子文档。上位文档：[00-principles.md](00-principles.md)、[01-phases-and-slices.md](01-phases-and-slices.md)。*

本文七节：项目目录、模型目录、代码目录、命名规则、编解码对应、文件形状、推论出的规则。

---

## 一、项目目录

```
<project>/                    每个项目一个文件夹、一个 git 仓库；变化靠 git 追溯
  raw/                        原料，任意格式，人放入；暗的，按段落点亮（07）
  business/00-overview.md         粗读的产物：这门生意、钱的路径、模块候选；给人读，不进解析
  business/<Module>/abstraction.md   第一层：手册层面的抽象业务（按段落点亮）
  business/<Module>/practice.md   第二层：这家公司的做法，含五问问出来的情形
  glossary.json               词汇表
  stories/                    故事线索引：段落先后、一句衔接、每段到第几轮（开发指挥写）
  model/                      设计模型（见「二」）
  model-decoded/<version>/    解码出的实际模型；与 model/ 同结构；临时产物
  slices/<id>.json            切片记录；<id>.story.json 故事
  plans/<id>.json             编码计划：这次要动哪些代码文件、按什么顺序、每步守什么（开发指挥算骨架，写码角色补关键逻辑，人确认）
  contracts/                  生产外壳的契约：http.<UseCase> / table.<Aggregate> / errors.<Module>（接口角色写，人确认）
  reports/                    校验与审查报告，每种只留最新一份；json 进 git（审到一半的裁决、现场看板要随人换机器），md / html 重算得出、不进
```

代码库在项目目录之外，其路径记在切片记录里。计划与契约的形状见 `schema/plan.schema.json`、`schema/contract.schema.json`。

### 业务描述的形式

分几层、怎么判、怎么写、怎么点亮，全在 [07-business-layers.md](07-business-layers.md)。这里只记形状：陈述性语句，不写故事、步骤、角色矩阵。两类编号（能力 G、规则 R），每条带编号与 `(层-种类)` 标签，编号按点亮顺序发、永不复用。`abstraction.md` 与 `practice.md` 都按能力 / 规则分节：

```markdown
## 能力
- [G-001] (业务抽象-能力) 协调员能为参与者制定预算

## 规则
- [R-001] (业务抽象-约束) 预算总额在参与者的核定额度之内
- [R-003] (业务抽象-公式) 剩余额度 = 核定额度 − 已分配
- [R-002] (业务落地-触发) 预算被批准后，服务提供方收到通知
- [R-004] (业务落地-情形) 同一份预算可能由两位协调员先后经手
```

校验器只认以 `- [G-`、`- [R-` 开头的行（`- [U-` 是老项目里已停发的使用语句，只认不发）；语句下面缩进的依据子项（出处、批次）不是语句。种类七种：能力、事实、约束、公式、触发、流程、情形（定义与判据见 07 第三节）。

五问（会不会同时、会不会重复、一次几条与部分失败、失败了业务上怎么处置、谁在什么时候能看见）问出来的是可能碰上的情形，通常不在原料里，要业务分析主动问出来、写成普通的业务落地语句（种类「情形」）；模型师照它们定第三层的回应（同时改 → 版本号或状态守卫；重复 → 状态守卫或幂等；一次几条 → 命令的输入形状与部分失败的语义；失败处置 → 事件或错误；可见性 → 查询的范围），写在元素规则里，校验 ① 会要求每条语句都有落点。

| 种类 | 在模型中的落点 |
|---|---|
| 能力 | 命令或查询 |
| 事实 | 字段，或结构性的不变量 |
| 约束 | 不变量（行为的守卫 + 错误） |
| 公式 | 值对象或行为的计算、领域服务 |
| 触发 | 事件处理 |
| 流程 | 后一个动作的状态守卫 + 错误；用例的先后 |
| 情形 | 行为的规则：状态守卫、幂等、错误 |

层决定倾向：业务抽象多半落聚合（字段、不变量、推导），业务落地多半落用例（命令、执行者、编排先后）。事实归模块存放。粗读时的主题是模块候选；战略设计定稿后 `business/` 的文件夹跟着模块走，编号不变。

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
- 模型文字一事一处：同一件事只在它归属的元素上写全，别处至多指一句「住在 X 上」；叙述、字段说明、不变量、端口说明、用例步骤之间不互相重抄（验收项目 2026-09-12 点名）。
- 不变量是聚合**随时能拿自己的状态核对**的一句话（五项参与者信息齐全、出生日期不晚于今天）；核对不了的（别人的流程、事情的先后）不是不变量，是叙述或别处的规则。
- **要看别的实例或别的模块才能判的规则，不是聚合的不变量，归领域服务**（第八十五批）。「标识唯一」「同一位老人只有一笔持续服务拨款」「出处那份文档得是她名下真有的」都是全部档案、全部拨款这个集合上的约束，一份档案自己核对不了；从库里读回来走 FROM_PERSISTENCE 也不经过创建方法，说明它本来就不是对象自己的状态。形状：处理器先查仓储、问端口，把查到的已有档案、已有拨款、端口答复当参数递给**纯函数式领域服务**（第 12 条不变），服务比对后抛错或调聚合的 CREATE；聚合的创建方法只查自己这一份填得对不对。把「已有档案」塞给 CREATE 让静态方法比对是名不副实：聚合只能信处理器给的参数全不全，而处理器又不该做业务判断。唯一性的真保证在仓储存的那一刻（数据库唯一约束，外壳阶段加），领域服务里的比对是给人一句像样的错误，挡不住两个人同一秒各建一份。
- **规则句怎么写**（第八十四批，与 seed/07 第三节同一条规矩）：给人看的页面上不变量叫「规则」。一条规则有骨架——**谁的哪个方法检查什么；不成立时抛出哪个错误**——骨架帮人不漏，填进去的仍然是通顺的话，不是变量替换。例：「FundingAllocation 的创建方法会检查分类季度金额与分类年度金额；缺一项或不是一个数，就抛出 InvalidFundingAllocation」。业务上的事先一句说清（「一位老人名下只能有一笔持续服务拨款」），再说方法怎么查、抛什么，再说边界；一句缠三件事、用冒号分号串起来，读到末尾已经忘了主语。**规则句只说规则**：「金额是不是正数，业务没说，本段不管」「换不换人，本段不管」这类边界说明不写在规则里，聚合整体的写进 `aggregateNarrative`，某一项的写进那个字段的 `note`。
- `ports/` 只放对外依赖；进入方向不设端口，命令与查询本身就是模块入口。
- 描述我方系统之外的业务流程的事实（「老人选定提供方后，提供方在政府门户上收到她的转介」）落在端口的操作上，不落聚合：聚合无从核对别人的流程，写成不变量只是给编号凑落点。端口标的是边界，本轮适配器是人照抄也照建（验收项目所有者 2026-09-12 第六十八批）。
- **模块之间的关系不手写**，由渲染器与校验器推导：`ports/` 中指向其他模块的条目 = 同步依赖；事件处理触发于其他模块的事件 = 异步依赖。

### 两层模型在目录里的位置

| 层 | 文件 |
|---|---|
| 模块级 | `module.json`、`domain/service.*`、`application/*`、`ports/*` |
| 聚合级 | `domain/<aggregate>/aggregate-root.*` 及其仓储 |

---

## 三、代码目录

```
src/<module-folder>/
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

**文件夹名全小写、多词用连字符**（2026-09-13 第七十二批）：模块 `Participants` 的代码在 `src/participants/`，模块 `ServiceAgreements` 在 `src/service-agreements/`；聚合文件夹同理（`domain/order/`、`domain/service-agreement/`）；测试镜像 `tests/<module-folder>/`。模块名本身（`modules.json`、`module.json`、模型文件里的 `module` 字段、类名、模型目录 `model/<Module>/`）仍是 PascalCase，不改。两者靠换算来回对应，所以模块名只许「每个词首字母大写、其余小写」，不许 `HCPBilling` 这种整段大写的缩写（会换不回来）；解码器先看组合根 `module.ts` 里 `build<Module>Module` 的真名，没有才按词换算。

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
- **裁决**：`decisions: [{ target, check, verdict: "accepted" | "dismissed", note, at, on? }]`，每个模型文件一个数组；记录人对校验项的裁决（驳回的警告、接受的多聚合写入、边界信号的裁定、判断通过且人已同意）。`on` 是裁决时对象文字的短哈希：校验器读它，文字未变的项不再提出；文字变了裁决即过期，项目重新浮出并标注上次的裁决。业务语句类判断（目标是 G / R 编号）写进它落点的每一个模型文件。
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
      "traces": [] } ],                    // traces 与该聚合根文件的 traces 相同
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
  "invariants": [ { "text": "根对象自身始终成立的条件", "traces": [], "throws?": ["InvalidOrder"] } ],   // throws = 创建时违反该不变量抛出的错误
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

`invariants` 是对象状态**始终成立**的条件；`rules` 是某个行为**做决定时**依据的逻辑。值对象的推导规则就是它的行为上的 `rules`。不变量的 `throws` 记录**创建时**（静态工厂）违反它所抛出的错误——工厂不是行为，这是错误在创建路径上唯一的归属。

**`raises` / `throws` 是传递闭包。** 一个行为调用了另一个行为或工厂，被调者可能发出的事件与错误也算作它的：`Order.total()` 调了 `Money.add()`，后者抛 `CurrencyMismatch`，则 `total` 的 `throws` 含 `CurrencyMismatch`；用例再向上继承。解码器机械地计算这个闭包，模型按此书写。

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
    { "name": "price", "input": [], "output": "Money", "note?": "给人读的边界说明：为什么住这儿、管不了什么、真保证在哪儿",
      "reads": ["Order", "Promotion"], "writes": [],
      "steps": [ /* 步骤语法 */ ],
      "rules": [], "raises": [], "throws": [], "traces": [] } ],
  "questions": [] }
```

`coordinates` **只能是本模块的聚合**。跨模块的数据只能通过端口（同步）或事件（异步）进来。领域服务跨的是逻辑，不是事务；事务边界属于命令。

### 步骤语法（用例与领域服务操作共用）

```jsonc
{ "text": "读起来通顺、自己站得住的一句话（不写「同上一步」「见第 3 步」）",
  "call?": { "kind": "behavior",        // behavior | factory | service | repository | port | command
             "target": "Order",         // 聚合名 / 服务名 / 仓储名 / 端口名 / 命令名
             "method": "confirm" },     // factory 时为大写蛇形工厂名，如 CREATE
  "when?": "decision 为 discounted",   // 分流：条件只能是某次领域调用返回值的判别属性；"否则" 表示 else
  "input?": "…", "output?": "…",
  "raises?": [], "throws?": [] }
```

`factory` 是静态工厂调用（`Order.CREATE`）：工厂不是行为，但处理器里创建聚合或值对象这一步要能表示。没有 `call` 的步骤只能是纯粹的数据搬运（组装输入、返回结果）。`kind` 为 `behavior` 时：在处理器的步骤里 `target` **只能是聚合根**；在领域服务操作的步骤里可以是聚合根、实体或值对象。技术守卫（找不到、无权限）与事件发布是机械动作，不进模型。

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
13. 行为、服务操作、用例的 `raises` / `throws` 是经由调用关系（含工厂）的传递闭包。
14. `module.json` 中聚合的 `traces` 等于其聚合根文件的 `traces`。
15. **用例的追溯只挂它自己的事。** 命令、查询、事件处理及其步骤的 `traces` 只挂能力（G）与这条用例自己承担的流程、触发、情形语句（执行者是谁、先后怎么走）；聚合守的事实、约束、公式挂在聚合的字段、不变量、行为、错误上，**不复制到用例与步骤上**。人点开一条命令看到的编号，应当就是这条命令自己的事（由来：2026-09-12 项目所有者看到 RecordSupplierInvoice 顶上 43 个编号，问「涉及的规则有那么多吗、都该归它做吗」——42 个其实住在聚合里）。
