# 写代码的角色共守的 — 原型与编码

规范在 [coding-standard.md](coding-standard.md)（能不能解码，硬）与 [style.md](style.md)（读着顺不顺，软；冲突时编码规范为准）。本文是两个写码角色共用的做法。

## 先补关键逻辑，等人确认，再写

读 `plans/<id>.md`。每个标「待补」的步骤，在 `keyLogic` 里写这一步守哪条规则、哪条不变量在这里生效、`when` 分流怎么走、哪条五问的回应在这里落地（「连点两次确认，第二次在 status 守卫处抛 OrderFailed」）；外壳步骤写事务边界在哪、乐观锁怎么落（`where version = ?`）、哪个错误映射哪个状态码。**补完停下**，等人 `plan confirm`。开写前读计划里「人在步骤上留的话」（`plans/<id>.md` 那一节，或步骤的 `humanNotes`）：人对哪一步有话就按话改，`plan done` 的说明里回一句改了什么。

**关键逻辑的写法**：**完整、直白优先**——该说全的说全（写「不调 MyAgedCarePortal 接口」，不为省字写成「不调端口」），去掉的只能是废话、对齐空格和重复；超过 600 字 `plan check` 只提醒「看看有没有啰嗦」，不拒收（2026-09-13 项目所有者取消了 300 字硬门禁）。写成代码风格的多行文本，不写段落——守卫按执行顺序一行一条，结果写 `→ throw X` / `→ return` / `→ raise E`，赋值一行一个，编号放行尾 `//` 后；开头一行「改动：」说这一步改什么，结尾「不动：」列不碰的；**不复述模型规则原文**（人已经确认过模型），只写这一步的落点、顺序与分流。字数按 JavaScript 字符数量，空格与换行都算：**不要为了对齐编号补空格**，一对齐字数就翻倍（2026-09-13 s-001 第一版 575 / 615 字，去掉对齐空格才过）。

**按计划顺序写**。每完成一步 `node $DEV_TEAM/tools/plan.js done <项目目录> <切片id> <n>`——顺序与计划不一致 `plan check` 会报。不「先写了再说」绕过命名规则或计划顺序。

## 让代码可解码：模型到代码的对应

| 模型 | 代码 |
|---|---|
| `traces` | 类 / 方法 JSDoc 的 `@trace G-001 R-001` |
| 聚合不变量 | 类 JSDoc 的 `@aggregate-invariant [R-xxx] 文本` |
| 根 / 实体 / 值对象的 `invariants` | 类 JSDoc 的 `@invariant [R-xxx] 文本 {ErrorName}`（花括号是创建时违反抛出的错误） |
| 行为 / 领域服务操作的 `rules` | 方法 JSDoc 的 `@rule 文本`，一条一行 |
| 行为的 `raises` / `throws` | 方法体里 `this.raise(new XxxEvent(...))` / `throw new XxxError(...)`；解码器沿调用链传递 |
| 工厂 | 静态方法，全大写蛇形：`CREATE`、`FROM_PERSISTENCE` |
| 用例步骤 | 处理器 `execute` 体内每条语句上方的 `//` 注释 = 步骤文本；`if` 上方的 `//` = `when` |
| 用例 `actor` / 事件处理的 `trigger` | 处理器类的 `@actor` / `handle` 方法的参数类型 |
| 聚合叙述 `aggregateNarrative` | 聚合根类的 `@narrative` |
| 错误的 `condition` | 错误类的 `@condition`（不解码，只为人读） |
| `idRefs` | `props` 里持有其它聚合 id 的字段加 `@ref Module.Aggregate` |
| 端口 | `port.<Name>Interface.ts` 的接口 + `@external-system` 或 `@module` |
| 模块职责 | `module.ts` 的 `@responsibility` |

事件在聚合里 `raise`，由应用层在**最后一步** `publish`。仓储读写只看方法名前缀（`find*` / `exists*` / `count*` 是读，其余是写）。全表见编码规范「结构化注释」「解码规则汇总」。

## 领域代码的纪律

- 处理器里不出现业务 `if`（比较输入、字段、数值）、不直接 `throw` 领域错误（用 `assertFound` 之类的守卫，或让聚合抛）、不计算（哪怕一次加法）——判断属于聚合行为或领域服务，处理器只按领域调用的结果分流。
- 适配器只做线格式转换，不含任何业务判断；不为了跑通而在适配器里塞判断。
- 组合根只做装配：适配器 → 领域服务 → 处理器 → 事件订阅；是唯一允许 `new` 适配器的地方。
- 注释按编码规范「注释写什么」：讲代码的行为和原因；类上只说这个类守的规则，要提示别处守的最多一句「唯一性不由这里守」；上下文不必写全，模型的 `note` 不照抄进代码（第八十七批）。
- 不写模型没有的公共行为（私有辅助方法可以，解码器不看私有）。
- **模型有明显错误**：报告，不改；等模型师改完再继续。

## 计划确认之后人又裁了一条

在**原有步骤里**补守卫、补用例，把新规矩写进那几步的 `keyLogic`（`plans/<id>.json`，`.md` 跟着改成一样），别新开一步。**不要跑 `plan build --force`**（会把人的确认与完成记录清零），**不要手改 `modelFingerprint`**（那是防计划过期的闸门）。改完把情况交回开发指挥，由它跑 `plan amend` 核对后换指纹（2026-09-13 第七十三批）。

## 自检

```
node $DEV_TEAM/tools/decode.js <代码库> <临时目录>                       # 解码；临时目录放项目的 model-decoded/ 下
node $DEV_TEAM/tools/diff-model.js <项目目录>/model <临时目录>             # 与设计模型比对，目标 0 处差异
node $DEV_TEAM/tools/plan.js check <项目目录> <切片id> --code <代码库>      # 文件都在、顺序一致、walk.input 齐
node $DEV_TEAM/tools/test.js <代码库> <片段>                              # 一小批测试；不带片段是整套，慎用
```

每层写完自跑解码比对，差异为 0 再进下一层。解码器报的 lint（处理器里的业务判断、直接 throw、漏 publish）必须清零。产出里附最后一次比对、`plan check` 与测试的结果行。
