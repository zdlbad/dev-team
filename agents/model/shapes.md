# 模型：目录、命名与文件形状

*模型师、审查读它。思想在 [seed/principles.md](../../seed/principles.md)；项目目录与写入权在 [common/project-layout.md](../common/project-layout.md)；代码那边的目录、命名、编解码对应在 [code/coding-standard.md](../code/coding-standard.md)。*

本文四节：模型目录、模型名与类名、文件形状、由形状推论出的规则。

---

## 一、模型目录

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
- 模型文字一事一处（见 [common/wording.md](../common/wording.md)）：同一件事只在它归属的元素上写全，别处至多指一句「住在 X 上」。
- 不变量是聚合**随时能拿自己的状态核对**的一句话（五项参与者信息齐全、出生日期不晚于今天）；核对不了的（别人的流程、事情的先后）不是不变量，是叙述或别处的规则。
- **要看别的实例或别的模块才能判的规则，不是聚合的不变量，归领域服务**。「标识唯一」「同一位老人只有一笔持续服务拨款」「出处那份文档得是她名下真有的」都是全部档案、全部拨款这个集合上的约束，一份档案自己核对不了；从库里读回来走 FROM_PERSISTENCE 也不经过创建方法，说明它本来就不是对象自己的状态。形状：处理器先查仓储、问端口，把查到的已有档案、已有拨款、端口答复当参数递给**纯函数式领域服务**（第 12 条不变），服务比对后抛错或调聚合的 CREATE；聚合的创建方法只查自己这一份填得对不对。把「已有档案」塞给 CREATE 让静态方法比对是名不副实：聚合只能信处理器给的参数全不全，而处理器又不该做业务判断。唯一性的真保证在仓储存的那一刻（数据库唯一约束，外壳阶段加），领域服务里的比对是给人一句像样的错误，挡不住两个人同一秒各建一份。
- 给人看的页面上不变量叫「规则」。规则句、字段说明、错误说明怎么写（骨架、只说规则、边界说明放 `aggregateNarrative` 或字段 `note`）见 [common/wording.md](../common/wording.md)「规则句怎么写」。
- `ports/` 只放对外依赖；进入方向不设端口，命令与查询本身就是模块入口。
- 描述我方系统之外的业务流程的事实（「老人选定提供方后，提供方在政府门户上收到她的转介」）落在端口的操作上，不落聚合：聚合无从核对别人的流程，写成不变量只是给编号凑落点。端口标的是边界，本轮适配器是人照抄也照建。
- **模块之间的关系不手写**，由渲染器与校验器推导：`ports/` 中指向其他模块的条目 = 同步依赖；事件处理触发于其他模块的事件 = 异步依赖。

### 两层模型在目录里的位置

| 层 | 文件 |
|---|---|
| 模块级 | `module.json`、`domain/service.*`、`application/*`、`ports/*` |
| 聚合级 | `domain/<aggregate>/aggregate-root.*` 及其仓储 |

---

## 二、模型名与类名

**模型里的名字 = 类名去掉种类后缀。** 模型与词汇表用 `Order`、`Money`、`OrderCreated`、`CreateOrder`、`NotifySupplierOnOrderCreated`、`PaymentGateway`、`OrderRepository`；代码用带后缀的类名。编码时加后缀，解码时去后缀。词汇表只收模型名。

---

## 三、文件形状

### 通用约定

- **类型词汇**：标量只用 `string | number | boolean | date`；其它类型写模型内的名字（`Money`、`OrderLine[]`）。解码时 TypeScript 类型映射回这四个标量。
- **跨模块引用**：`<模块>.<名字>`，如 `Billing.Invoice`、`Ordering.OrderCreated`。同模块内直接写名字。
- **追溯**：`traces: ["G-001", "R-002"]`，指向业务描述的编号。
- **问题**：`questions: [{ question, answer: "", applied: false }]`，每个文件一个数组。
- **无确认状态字段**：一个切片的模型改动由人整体确认，确认记在切片记录里，改动本身由 git 记录。
- **无可视化状态**：模型文件永远不含注解、布局等可视化状态；它们放在项目的 `.viewer/` 旁路目录，按模型文件路径索引。
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
  "relations": [ { "from": "Customers", "to": "Ordering", "what": "谁在下单" } ],
  "groups": [ { "name": "卖东西那一侧", "modules": ["Ordering"] } ],
  "questions": [] }
```

`relations` 写谁把什么事实给谁，模型图的「模块图」照它画；不写时从模块端口推导。划模块时还没有端口，所以要写。`groups` 可选，模块图按它分列。

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
  "create?": { /* 创建：与行为同一套七段，见下 */ },
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
  "purpose?": { "text": "作用：调用它做了什么、改了什么", "traces": [] },
  "input": [ { "name": "at", "type": "date", "note?": "这个参数是什么" } ], "output?": "…",
  "steps?": [ { "text": "做法的一步", "changes": ["status", "confirmedAt"], "throws?": [], "traces?": [] } ],
  "rules": [ "规则：这个方法自己检查什么、怎么算，不成立抛什么" ],
  "raises": [ "OrderConfirmed", { "event": "OrderRejected", "when": "…" } ],
  "throws": [ "OrderFailed" ],
  "traces": [] }
```

`invariants` 是对象状态**始终成立**的条件；`rules` 是某个行为**做决定时**依据的逻辑。**不写进方法的**：调用方负责的前提、方法不做的事、设计思路（放聚合或字段的 `note`）、字段为什么存在（放那个字段的 `note`）。

**创建**（`create`）：`{ "purpose", "input?", "steps", "rules", "raises?", "throws", "traces" }`，与行为同一套。一件东西怎么被建出来写在这里；时时都要成立的约束留在 `invariants`。老模型没有 `create`、只有不变量的照样认。

**方法的入参是纯数据**。聚合里的实体只由聚合自己建，不外露：Invoice 的创建收每一行的数据（行号、金额、税额……），在里面一行一行建出 InvoiceLine，不收建好的 `InvoiceLine[]`。值对象也收它的数据、在里面建；要是调用方手上已经有一个值对象、直接递了进来，方法先复制一份再用，不和外面共用同一个。入参类型起一个数据的名字（`InvoiceLineData[]`），这一样有哪几栏写在入参的 `note` 里；不写实体名。领域服务的操作收整个聚合根不算在内——那是它要协调的对象。

**字段**可以带 `carries`（一条语句落在好几栏时，这一栏承担哪一半）。值对象的推导规则就是它的行为上的 `rules`。不变量的 `throws` 记录**创建时**（静态工厂）违反它所抛出的错误——工厂不是行为，这是错误在创建路径上唯一的归属。

**`raises` / `throws` 是传递闭包。** 一个行为调用了另一个行为或工厂，被调者可能发出的事件与错误也算作它的：`Order.total()` 调了 `Money.add()`，后者抛 `CurrencyMismatch`，则 `total` 的 `throws` 含 `CurrencyMismatch`；用例再向上继承。解码器机械地计算这个闭包，模型按此书写。

### 事件与错误

```jsonc
// event.OrderConfirmedEvent.json
{ "name": "OrderConfirmed", "aggregate": "Order", "payload": [ { "name": "orderId", "type": "string" } ], "traces": [] }

// error.OrderFailedError.json
{ "name": "OrderFailed", "aggregate": "Order", "condition": "这张订单的内容不成立：缺了该有的一项，或者某一项填得不对", "traces": [] }
```

错误的 `condition` 一句话说它表示什么，不写在哪里、什么时候抛，`traces` 留空——抛它的方法的规则里已经写了查什么、不成立抛它，语句挂在那条规则上。

不记发布方。谁发谁记（行为、创建 `create`、领域服务操作的 `raises` / `throws`）；校验反向核对每个事件、每个错误至少有一个发布方。

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
    { "name": "price", "purpose?": { "text": "作用", "traces": [] }, "input": [], "output": "Money", "note?": "给人读的边界说明：为什么住这儿、管不了什么、真保证在哪儿",
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
  "changes?": ["Order.status"],        // 这一步改了哪几栏：行为里写字段名，领域服务里写「聚合.字段」
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
{ "id": "s-001", "kind": "scene", "title": "老人交凭据、案例经理录花费",
  "scene": "黄太太把一张 $120 的清洁发票传上来；李明照着录一笔花费",
  "modules": ["Expenses"],
  "traces": ["G-001", "R-001"],                       // 这一段立了、挂上了哪几条语句
  "stages": {                                          // 每关 { status: pending | in-progress | done, at?, note? }
    "scene": { "status": "done" }, "model": { "status": "done" },
    "draft": { "status": "done" }, "walk": { "status": "pending" } },
  "log": [ { "at": "2026-09-24", "text": "开场景" } ] }
```

正式化切片 `f-xxx`：`kind: "formalize"`，`covers` 列这一批装哪几个场景，三关 `code`、`check`、`accept`。日志只追加，不改写。

---

## 四、由形状推论出的规则（供编码规范与校验引用）

1. 模型中的每个名字必须是词汇表中的词。
2. 领域服务只协调本模块的聚合；跨模块只经端口或事件。
3. 查询的步骤只允许调用仓储的 `read` 方法。
4. 命令与事件处理的 `writes` 大于 1 必须有 `writesNote`，校验列为需人确认。
5. 每个事件、每个错误至少有一个发布方（某个行为、创建或领域服务操作的 `raises` / `throws`，或不变量的 `throws`）。
6. 用例的 `raises` / `throws` 必须等于其步骤所调用的行为与服务的 `raises` / `throws` 之并集。
7. 每个步骤的 `call` 必须解析到存在的目标与方法。
8. 每条业务目标至少被一个命令或查询追溯；每条业务规则至少被一个行为、不变量、错误或事件处理追溯；反之每个模型元素的 `traces` 非空。
9. 模型文件不含可视化状态。
10. 处理器步骤中 `call.kind: behavior` 的 `target` 只能是聚合根；实体与值对象的行为只在聚合内部被调用。
11. 步骤的 `when` 只能引用某次领域调用的返回值；处理器不做业务判断。
12. 领域服务纯函数式：操作的 `reads` 即其参数所含的聚合。
13. 行为、服务操作、用例的 `raises` / `throws` 是经由调用关系（含工厂）的传递闭包。
14. `module.json` 中聚合的 `traces` 等于其聚合根文件的 `traces`。
15. **用例的追溯只挂它自己的事。** 命令、查询、事件处理及其步骤的 `traces` 只挂能力（G）与这条用例自己承担的流程、触发、情形语句（执行者是谁、先后怎么走）；聚合守的事实、约束、公式挂在聚合的字段、不变量、行为、错误上，**不复制到用例与步骤上**。人点开一条命令看到的编号，应当就是这条命令自己的事。
