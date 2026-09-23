# proto/ — 原型宿主

草稿原型的壳：领域代码不用数据库就能跑起来，产品页面通过它被人操作。生产环境不用它；领域层与应用层的代码在原型和生产之间**一行不变**，变的只是适配器。

```
ProtoHost                原型宿主：登记命令 / 查询 / 内存仓储，开 HTTP 口；tools/proto.js 把产品页面里的 /api/… 转给它
InMemoryEventPublisher   进程内事件总线，顺手把事件记进宿主的流水
```

## 编码起草稿原型要写的三样东西

1. **内存仓储适配器**（`src/<module-folder>/adapters/adapter.InMemory<Aggregate>Repository.ts`）：实现仓储接口，另加一个 `all(): unknown[]`，返回全部行的纯数据（`{ id, version, ...props }`），原型页面用它显示聚合的状态。
2. **组合根**（`src/<module-folder>/module.ts`）：`build<Module>Module(host, deps)`，实例化适配器 → 领域服务 → 处理器 → 事件订阅，并把每个处理器与仓储登记到宿主：
   - `host.command('<Module>.<CommandName>', (input) => new XxxCommand(…), handler)`
   - `host.query('<Module>.<QueryName>', (input) => new XxxQuery(…), handler)`
   - `host.repository('<Module>.<Aggregate>', repo)`
   登记名 = 模型里的限定名（模块.名字）。`build` 只做输入的类型转换（字符串 → 日期、数字），**不做判断**。
3. **入口**（`src/proto/main.ts`）：
   ```ts
   import { ProtoHost } from '@shared/building-block/proto'
   import { buildFundingModule } from '../Funding/module'
   const host = new ProtoHost((h) => { buildFundingModule(h) /* … 其它模块 */ })
   host.serve(Number(process.env.PROTO_PORT ?? 4873))
   ```

跨模块的端口在原型里用**直连适配器**：实现端口接口，内部调用对方模块的仓储或查询处理器（不含判断）。

## 协议（页面与宿主之间）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/manifest` | 登记了哪些命令、查询、仓储 |
| POST | `/run` `{ kind: 'command'｜'query', name, input }` | 跑一个；返回 `{ ok, result?, error?: { name, message }, events }` |
| GET | `/state` | 每个仓储的全部行 |
| GET | `/events` | 事件流水 |
| POST | `/reset` | 清空并重新装配 |

领域错误按类名原样返回（`InvalidExpenseError`，比模型里的错误名多一个 `Error` 后缀），产品页面照模型里那个错误的说明翻成人话。

产品页面放在 `src/proto/web/`（`index.html` 起头的静态页面），页面里调 `/api/manifest`、`/api/run`、`/api/state`、`/api/events`、`/api/reset`。
