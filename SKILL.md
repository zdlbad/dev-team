---
name: dev-team
description: 模型驱动的开发团队。业务 → 模型 → 原型 → 代码，模型可编码、代码可解码，校验互证；九个角色（业务分析、讲解、模型师、原型、接口、编码、模型校验、pre-pr 审查、解读）按故事切片迭代，每条故事都能在原型上按着走，写码前先有人能看的计划，人在每个门禁拍板。用法：/dev-team <子命令> …
---

# dev-team — 路由

本文件所在目录是 dev-team 根目录（下称 `$DEV_TEAM`）。规范在 `$DEV_TEAM/seed/`（入口 `seed/README.md`），角色指令在 `$DEV_TEAM/agents/`。**项目永远在 `$DEV_TEAM` 之外**；项目目录的判定：含 `project.json` 的目录。

首次使用：在 `$DEV_TEAM` 执行 `npm install`。

## 子命令

| 子命令 | 作用 | 执行 |
|---|---|---|
| `new <目录> <系统名> [--codebase <代码库>]` | 新建项目（git init；可顺带拷入构建块） | `node $DEV_TEAM/tools/new-project.js …` |
| `slice new <项目> <id> <标题> [--story [--based-on <上一版id>]] [--implements <故事id,…>] [--modules …] [--aggregates …] [--use-cases …] [--traces …]` | 建切片记录；`--story` = **故事切片**（一条故事：理解一致 → 使用语句 → 最少模型 → 裁定 → 模型确认 → 编码计划 → 原型 → 审查 → 人按，同时建故事骨架）；`--based-on` 从上一版滚出；`--implements` = **实现切片**（把几条已在原型上走通的故事换上生产外壳：契约 → 计划 → 编码 → 校验 ② → 审查） | `node $DEV_TEAM/tools/slice.js new …` |
| `story approve <项目> <id>` | 人与团队对故事的业务理解一致（每步语句已确认）；编号顺带并入切片 traces | `node $DEV_TEAM/tools/story.js approve …` |
| `story usage <项目> <id> propose <U-001,… \| --none>` / `confirm` | 业务分析按这条故事补完使用语句后，路由登记新增编号（`--none` = 无新增）；人确认后编号并入切片 traces，模型必须回应它们 | `node $DEV_TEAM/tools/story.js usage …` |
| `story serve <项目> [id]` | 起本地页面：`/` 框架图（模块 × 故事）；`/story?slice=<id>` 走故事（业务语句逐条打勾、同意／质疑、预测再揭晓、裁定卡挂在步骤下）；`/glossary` 名词目录；`/model` 模型图（卡片下可留意见，存 `reports/_模型意见.json`） | `node $DEV_TEAM/tools/story.js serve …` |
| `story apply <项目> <id>` | 裁定卡写进 `raw/项目所有者的裁定.md` 与切片 log，算出回流 | `node $DEV_TEAM/tools/story.js apply …` |
| `plan build <项目> <id> [--code <代码库>] [--force]` | **编码计划**：从模型与切片范围算出要动哪些代码文件、按什么顺序，写 `plans/<id>.json` + `.md`；写码角色补每步的关键逻辑；已确认的要 `--force` 才重算 | `node $DEV_TEAM/tools/plan.js build …` |
| `plan confirm <项目> <id>` | 人确认计划（门禁）；确认前不开写 | `node $DEV_TEAM/tools/plan.js confirm …` |
| `plan done <项目> <id> <n>` | 写码角色完成第 n 步（记时间，核对顺序用） | `node $DEV_TEAM/tools/plan.js done …` |
| `plan check <项目> <id> [--code <代码库>]` | 核对：已确认、关键逻辑齐、文件都在、顺序与计划一致、故事的 `walk.input` 齐 | `node $DEV_TEAM/tools/plan.js check …` |
| `contract scaffold <项目> <id>` | 实现切片：给范围内缺的契约建骨架（字段名从模型抄，其余标「（没问过）」） | `node $DEV_TEAM/tools/contract.js scaffold …` |
| `contract check <项目> <id>` | 缺哪些、哪些没问过、哪些没确认、字段名与模型对不上的 | `node $DEV_TEAM/tools/contract.js check …` |
| `contract confirm <项目> <id>` | 人确认范围内的契约（没问过的清零才行；「（故意推迟）」的可以确认，编码不实现） | `node $DEV_TEAM/tools/contract.js confirm …` |
| `proto serve <项目> --code <代码库> [--port 4872]` | 起原型页面：编译代码库、启动内存原型；按故事走、手动跑命令与查询、看聚合状态与事件流水、重置、重新编译 | `node $DEV_TEAM/tools/proto.js serve …` |
| `proto check <项目> --code <代码库>` | 编译 + 启动 + 对照模型：命令、查询、聚合是否都登记进原型；故事的步骤能否对上 | `node $DEV_TEAM/tools/proto.js check …` |
| `test <代码库> [<片段>…]` | 编译并用 `node --test` 跑 `tests/` 下的一小批测试（03 第八节）；**不带片段就是整套，慎用** | `node $DEV_TEAM/tools/test.js …` |
| `prepr new <项目> <id> --mode proto\|shell [--code <代码库>]` | pre-pr 审查的报告骨架：列角度、范围文件、可跳过的 U-xxx | `node $DEV_TEAM/tools/prepr.js new …` |
| `prepr check <项目> <id> --mode proto\|shell` | 核对审查角色填好的报告形状，写 `.md` | `node $DEV_TEAM/tools/prepr.js check …` |
| `inventory <代码库> [--out <md>]` | 盘点一个既有代码库（给解读角色的地图） | `node $DEV_TEAM/tools/inventory.js …` |
| `read <代码库> <项目>` | 解读既有代码：先 `inventory`，再启动解读角色写出业务描述、词汇表、模型草稿与解读说明 | 路由自己执行（见下） |
| `slice next <项目> <id>` | 算出下一步：谁上场、跑什么 | `node $DEV_TEAM/tools/slice.js next …` |
| `slice advance <项目> <id> <model\|code\|validate> <状态> [说明]` | 推进阶段状态并写 log | `node $DEV_TEAM/tools/slice.js advance …` |
| `slice apply <项目> <报告 json> [--slice <id>]` | 人的裁决写回：校验报告 → `decisions[]` 与切片 log；pre-pr 报告 → 只记切片 log（代码问题不进 decisions） | `node $DEV_TEAM/tools/slice.js apply …` |
| `run <项目> <切片id>` | 跑切片周期的下一步（见下） | 路由自己执行 |
| `board <项目> [--md]` | 状态看板 | `node $DEV_TEAM/tools/board.js …` |
| `check <项目>` | 校验模型、切片、计划、契约文件的形状 | `node $DEV_TEAM/tools/check-schema.js …` |
| `validate <项目> [--code <代码库>] [--slice <id>]` | 校验：方向 ① 总是执行（含使用语句的落点），带 `--code` 时执行方向 ② | `node $DEV_TEAM/tools/validate.js …` |
| `review <报告 json>` | 起本地页面，人逐条填裁决，存回同一文件（校验报告与 pre-pr 报告通用） | `node $DEV_TEAM/tools/review.js …` |
| `render <项目> [--decoded <解码目录>] [--out <html>]` | 可视化：关系图 + 卡片 + 业务覆盖；带 `--decoded` 时标出与代码的差异 | `node $DEV_TEAM/tools/render.js …` |
| `decode <代码库> <输出目录>` | 从代码还原模型 | `node $DEV_TEAM/tools/decode.js …` |
| `diff <model 目录> <解码目录>` | 设计模型与解码模型比对 | `node $DEV_TEAM/tools/diff-model.js …` |
| `help` | 打印本表 | — |

## `run`：切片周期的一步

`run` 每次只推进一步，推进完停下来向人报告；人说「继续」再跑下一步。**不连跑**，因为每一步之间都可能有人要看的东西。

1. 执行 `slice next <项目> <id> --json`，得到 `{ role, action, command, why }`。
2. 按 `role` 分派：
   - **人**：不做任何事。把 `action`、`command`、`why` 原样告诉人，停。
   - **路由**：直接执行 `command`（写回裁决、标记状态、算编码计划），把输出告诉人，停。算出编码计划后把 `plans/<id>.md` 的路径告诉人。
   - **模型校验**：先执行 `command`（校验器）。报告有错误或警告 → 告诉人，停。否则读 `$DEV_TEAM/agents/validator.md`，用 Agent 工具启动一个子 agent，提示词 = 该文件全文 + 上下文块（见 `agents/README.md`）+ 任务「填写 `reports/validate-<n>.json` 里全部判断」。子 agent 完成后，起审阅页面（`review`），把它的小结与页面地址告诉人，停。
   - **pre-pr 审查**：读 `$DEV_TEAM/agents/pre-pr-reviewer.md`，同样方式启动子 agent，任务 = `action`（含模式 proto / shell）。子 agent 完成后跑 `prepr check`，起审阅页面，把发现数、必须改数、干净的角度与页面地址告诉人，停。
   - **业务分析 / 模型师 / 原型 / 接口 / 编码**：读对应的 `agents/*.md`（原型 `prototyper.md`、接口 `interface.md`），同样方式启动子 agent，任务 = `action`。子 agent 完成后，把它的「产出」与「问题清单」原样转给人，停。**不替人回答问题清单**。三处特别的收尾：
     - 业务分析补完使用语句 → 路由按它产出里的编号执行 `story usage … propose`（无新增则 `--none`），再告诉人下一步是确认。
     - 原型 / 编码补完计划的关键逻辑 → 把 `plans/<id>.md` 给人看，等人 `plan confirm`；**不在同一次 run 里接着写码**。
     - 原型写完 → 另起 `proto serve` 页面，把地址告诉人。
   - **讲解**：读 `agents/guide.md`，同样方式启动子 agent。写故事时，子 agent 完成后把故事**用人话摘要**给人（人物、几步、涉及哪些编号、缺口），并告诉人下一步是走故事、在业务理解上达成一致；出题时把题数与裁定卡数告诉人，起 `story serve` 页面。

`run` 之外，路由在对话里还负责**讲解的现场部分**：人在页面上或对话里答题、拍板，路由判分（对照故事文件的答案）、追问、把人的原话与结论记回；人推翻语句或模型的，落成裁定并派给业务分析或模型师。人对使用语句、契约、编码计划的拍板也一样落成裁定。可以用讲解准备的「扮演」素材在对话里演事件让人接。

3. 任何一步失败（命令退出码非 0、子 agent 报告无法完成）：把原文给人，停。

启动子 agent 时附上的上下文块：

```
项目目录：<绝对路径>        dev-team 目录：$DEV_TEAM
切片：<id>（<标题>；scope：<modules / aggregates / useCases>；traces：<…>）
任务：<action>
```

## 故事切片：默认的切法

切片分两种：**故事切片**（一条故事：理解一致 → 使用语句 → 最少模型 → 裁定 → 模型确认 → 编码计划 → 原型 → 校验 ② → 审查 → 人按）与**实现切片**（若干条已在原型上走通的故事 → 契约 → 编码计划 → 生产外壳 → 校验 ② → 审查 → 合并）。故事管业务到模型到原型；生产代码的范围另定，几条故事攒够了一起上。

战略设计（模块划分）通盘做一次；之后**每个故事切片是一条能走通的故事**，不是一组主题。`slice new … --story` 建切片，`slice next` 会依次要求：讲解写故事 → 人走故事、理解一致 → **业务分析按故事细补使用语句（五问）→ 人确认** → 模型师建最少的模型并走故事、列选择 → 校验 ① 机械检查（含 U-xxx 的落点）→ 讲解出题 → 人走故事、过裁定卡（`story serve`）→ 路由写回（`story apply`）→ 回流模型师 → 校验角色填判断 → 人审阅 → 模型确认 → **路由算编码计划 → 原型补关键逻辑 → 人确认计划** → 原型按计划写（领域代码 + 内存适配器 + 测试 + `walk.input`）→ `plan check` → 校验 ②（0 差异）→ **pre-pr 审查（A / B / D / S）→ 人审阅** → 人在原型上走故事、试 U-xxx → 合并。**每条故事都反映在原型上**：原型里的领域代码就是最终代码，只有仓储与端口是内存的。

生产的外壳由实现切片补：`slice new … --implements s-002,s-003` → **接口角色定契约 → 人确认** → 路由算外壳计划 → 编码补关键逻辑（事务、锁、状态码）→ 人确认 → 编码按计划写外壳与外壳测试 → `plan check` → 校验 ② → **pre-pr 审查（C / E / F / S）→ 人审阅** → 合并。理由见 `seed/01-phases-and-slices.md`「故事切片」。

故事**按版本滚雪球**：第一条是最小的能走通的主线，之后每条 `--based-on` 上一条，只多一段（缺口、怪事、前情），整条重新走通。上一版故事页上人勾选的缺口（`gapPicks`）就是下一版的 `adds`；人没勾，讲解推荐、人定。

## `read`：解读既有代码

1. 项目不存在就先 `new`。执行 `node $DEV_TEAM/tools/inventory.js <代码库> --out <项目>/raw/代码盘点.md`。
2. 读 `agents/reader.md`，用 Agent 工具启动解读角色，上下文块里给代码库路径与盘点文件路径，任务 = 「按四遍法写出 business/、glossary.json、model/ 与 model/_解读说明.md」。
3. 完成后把「这个系统是什么」那段、产出与问题清单原样转给人；之后进正常流程：人读业务描述 → 业务分析通盘粗过一遍使用语句 → 讲解写导读与故事 → 模型师在草稿上按故事收敛。

## 路由规则

- 读到子命令后，只做该子命令的事；不把规范全文加载进上下文，按需读 `seed/` 中对应的一份。
- 扮演角色只通过 `agents/*.md`，不凭空扮演；路由自己不建模、不写代码、不判断。
- 任何写入都遵守 `seed/01-phases-and-slices.md` 的写入权表；路由自己只写 `slices/`、`plans/`（`plan build` 出骨架）、`reports/` 与模型文件的 `decisions[]`（通过 `slice apply`）。
- 人可以直接编辑任何工件；编辑后从 `slice next` 重新算下一步即可。
- **人在对话中拍板的事要落地**：路由负责追加到项目的 `raw/项目所有者的裁定.md`（按批次累积，写明依据、作废项与已知缺口），并用 `slice log` 记一条。角色只读它、遵守它，不得自行推翻——有疑虑写进问题清单。校验报告里的裁决走 `slice apply`，那是另一条路径。
- **写码前先有计划、计划先给人看**：原型与编码两个角色在 `plan confirm` 之前只补关键逻辑，不写代码；写的时候按计划顺序、每步 `plan done`。这是让人能看见 agent 在做什么的地方，不省。
- 报告不留历史，可追溯性靠项目自己的 git：每个门禁通过后提醒人提交。
