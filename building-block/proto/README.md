# proto/ — 原型宿主

一次性的壳，让领域代码不用数据库、不用界面就能被人操作。生产环境不用它；领域层与应用层的代码在原型和生产之间**一行不变**，变的只是适配器。

```
ProtoHost                原型宿主：登记命令 / 查询 / 内存仓储，开 HTTP 口给 tools/proto.js 的页面
InMemoryEventPublisher   进程内事件总线，顺手把事件记进宿主的流水
```

## 原型角色要写的三样东西

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

领域错误按类名原样返回（`InvalidExpense`），页面对照模型里错误的 `condition` 翻成人话。

## 走故事时输入里的 id 引用

故事每一步 `walk.input` 的值若写成 `"@<模块>.<聚合>"`（如 `"@Participants.Document 第 2 步存下的那份通知书"`），试原型页跑到这一步时先取 `/state`，拿那个聚合最新一条记录的 `id` 填进去（`#2` 取第二条）；那个聚合还一条都没有就不跑、页面上说「先走存它的那一步」。跑完把带了哪些 id 印在这一步的结果上。命令的组合根与领域层看到的永远是真 id，不再有占位文字混进去。
