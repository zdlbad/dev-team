# proto/ — 原型宿主与进程内事件

草稿原型要的两样东西。领域层与应用层的代码在原型和生产之间**一行不变**，变的只是外面那一圈。

```
InMemoryEventPublisher   进程内事件总线；构造时给了记录者（任何带 recordEvents 的东西，如后端的事件流水、原型宿主）就顺手把事件记下，不给也能用
ProtoHost                原型宿主：登记命令 / 查询 / 内存仓储，开一个传命令名的通用口；只给没有前端工程的项目用
```

## 草稿原型怎么跑，看有没有前端工程

- **有前端工程**（代码库旁边的 `frontend/`，或 `project.json` 的 `"frontend"`）：后端照最终版写——契约、按业务分的 HTTP 路由、组合根，数据先存内存；前端工程调这些口。这时不用 `ProtoHost`，只用 `InMemoryEventPublisher`（把事件记进后端的事件流水，开发口 `/api/_dev/events` 读它）。放法见 dev-team 的 `agents/code/coding-standard.md` 第十三节，dev-team 的 `tools/proto.js` 起后端与前端开发服务。
- **没有前端工程**（dev-team 的样例 `example/order-code`）：用下面的原型宿主，产品页面是 `src/proto/web/` 里的静态页面。

## 原型宿主：编码要写的三样东西

1. **内存仓储适配器**（`src/<module-folder>/adapters/adapter.InMemory<Aggregate>Repository.ts`）：实现仓储接口，另加一个 `all(): unknown[]`，返回全部行的纯数据（`{ id, version, ...props }`），原型页面用它显示聚合的状态。两种做法都要它。
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
