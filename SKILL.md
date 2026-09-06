---
name: dev-team
description: 模型驱动的开发团队。业务 → 模型 → 代码三阶段，模型可编码、代码可解码，校验互证；五个角色（业务分析、讲解、模型师、编码、模型校验）按故事切片迭代，人在每个门禁拍板。用法：/dev-team <子命令> …
---

# dev-team — 路由

本文件所在目录是 dev-team 根目录（下称 `$DEV_TEAM`）。规范在 `$DEV_TEAM/seed/`（入口 `seed/README.md`），角色指令在 `$DEV_TEAM/agents/`。**项目永远在 `$DEV_TEAM` 之外**；项目目录的判定：含 `project.json` 的目录。

首次使用：在 `$DEV_TEAM` 执行 `npm install`。

## 子命令

| 子命令 | 作用 | 执行 |
|---|---|---|
| `new <目录> <系统名> [--codebase <代码库>]` | 新建项目（git init；可顺带拷入构建块） | `node $DEV_TEAM/tools/new-project.js …` |
| `slice new <项目> <id> <标题> [--story [--based-on <上一版id>]] [--implements <故事id,…>] [--modules …] [--aggregates …] [--use-cases …] [--traces …]` | 建切片记录；`--story` = **建模切片**（一条故事，到模型确认为止，同时建故事骨架）；`--based-on` 从上一版滚出；`--implements` = **实现切片**（把几条已确认模型的故事变成代码，范围从故事的 walk 推出，直接进编码） | `node $DEV_TEAM/tools/slice.js new …` |
| `story approve <项目> <id>` | 人与团队对故事的业务理解一致（每步语句已确认）；编号顺带并入切片 traces | `node $DEV_TEAM/tools/story.js approve …` |
| `story serve <项目> [id]` | 起本地页面：`/` 框架图（模块 × 故事，点故事看点亮了哪些域）；`/story?slice=<id>` 走故事（业务语句逐条打勾、同意／质疑、预测再揭晓、裁定卡挂在步骤下）；`/glossary` 名词目录（可留意见、提新词）；`/model` 模型图（每次打开重画 render 的结果；卡片下可留意见，存 `reports/_模型意见.json`，`slice next` 会先要求路由回应） | `node $DEV_TEAM/tools/story.js serve …` |
| `story apply <项目> <id>` | 裁定卡写进 `raw/项目所有者的裁定.md` 与切片 log，算出回流 | `node $DEV_TEAM/tools/story.js apply …` |
| `slice next <项目> <id>` | 算出下一步：谁上场、跑什么 | `node $DEV_TEAM/tools/slice.js next …` |
| `slice advance <项目> <id> <model\|code\|validate> <状态> [说明]` | 推进阶段状态并写 log | `node $DEV_TEAM/tools/slice.js advance …` |
| `slice apply <项目> <报告 json> [--slice <id>]` | 人的裁决写回 `decisions[]` 与切片 log | `node $DEV_TEAM/tools/slice.js apply …` |
| `run <项目> <切片id>` | 跑切片周期的下一步（见下） | 路由自己执行 |
| `board <项目> [--md]` | 状态看板 | `node $DEV_TEAM/tools/board.js …` |
| `check <项目>` | 校验模型文件的形状 | `node $DEV_TEAM/tools/check-schema.js …` |
| `validate <项目> [--code <代码库>] [--slice <id>]` | 校验：方向 ① 总是执行，带 `--code` 时执行方向 ② | `node $DEV_TEAM/tools/validate.js …` |
| `review <报告 json>` | 起本地页面，人逐条填裁决，存回同一文件 | `node $DEV_TEAM/tools/review.js …` |
| `render <项目> [--decoded <解码目录>] [--out <html>]` | 可视化：关系图 + 卡片 + 业务覆盖；带 `--decoded` 时标出与代码的差异 | `node $DEV_TEAM/tools/render.js …` |
| `decode <代码库> <输出目录>` | 从代码还原模型 | `node $DEV_TEAM/tools/decode.js …` |
| `diff <model 目录> <解码目录>` | 设计模型与解码模型比对 | `node $DEV_TEAM/tools/diff-model.js …` |
| `help` | 打印本表 | — |

## `run`：切片周期的一步

`run` 每次只推进一步，推进完停下来向人报告；人说「继续」再跑下一步。**不连跑**，因为每一步之间都可能有人要看的东西。

1. 执行 `slice next <项目> <id> --json`，得到 `{ role, action, command, why }`。
2. 按 `role` 分派：
   - **人**：不做任何事。把 `action`、`command`、`why` 原样告诉人，停。
   - **路由**：直接执行 `command`（写回裁决、标记状态），把输出告诉人，停。
   - **模型校验**：先执行 `command`（校验器）。报告有错误或警告 → 告诉人，停。否则读 `$DEV_TEAM/agents/validator.md`，用 Agent 工具启动一个子 agent，提示词 = 该文件全文 + 上下文块（见 `agents/README.md`）+ 任务「填写 `reports/validate-<n>.json` 里全部判断」。子 agent 完成后，起审阅页面（`review`），把它的小结与页面地址告诉人，停。
   - **业务分析 / 模型师 / 编码**：读对应的 `agents/*.md`，同样方式启动子 agent，任务 = `action`。子 agent 完成后，把它的「产出」与「问题清单」原样转给人，停。**不替人回答问题清单**。
   - **讲解**：读 `agents/guide.md`，同样方式启动子 agent。写故事时，子 agent 完成后把故事**用人话摘要**给人（人物、几步、涉及哪些编号、缺口），并告诉人下一步是走故事、在业务理解上达成一致；出题时把题数与裁定卡数告诉人，起 `story serve` 页面。

`run` 之外，路由在对话里还负责**讲解的现场部分**：人在页面上或对话里答题、拍板，路由判分（对照故事文件的答案）、追问、把人的原话与结论记回；人推翻语句或模型的，落成裁定并派给业务分析或模型师。可以用讲解准备的「扮演」素材在对话里演事件让人接（人当案例经理或财务，路由当政府与供应商）。
3. 任何一步失败（命令退出码非 0、子 agent 报告无法完成）：把原文给人，停。

启动子 agent 时附上的上下文块：

```
项目目录：<绝对路径>        dev-team 目录：$DEV_TEAM
切片：<id>（<标题>；scope：<modules / aggregates / useCases>；traces：<…>）
任务：<action>
```

## 故事切片：默认的切法

切片分两种：**建模切片**（一条故事：业务理解一致 → 最少模型 → 走故事、裁定 → 模型确认）与**实现切片**（若干条已确认的故事 → 代码 → 校验 ②）。故事管业务到模型；代码的范围另定：可以几条故事攒成一次大的模型改动再一起实现，也可以一条故事的模型改动直接带着代码落地（人在模型确认后选）。

战略设计（模块划分）通盘做一次；之后**每个建模切片是一条能走通的故事**，不是一组主题。`slice new … --story` 建切片，`slice next` 会依次要求：讲解写故事 → 人走故事、业务理解一致 → 模型师建最少的模型并走故事、列选择 → 校验 ① 机械检查 → 讲解出题 → 人走故事、过裁定卡（`story serve`）→ 路由写回（`story apply`）→ 回流模型师 → 校验角色填判断 → 人审阅 → 模型确认（建模切片到此完成）。到代码有两条路，由人定：几条故事汇成一次大的模型改动后另起实现切片（`slice new … --implements s-002,s-003` → 编码 → 校验 ②）；或这条故事的模型改动直接带着代码落地（`slice advance <项目> <id> code in-progress`，同一切片接着走编码与校验 ②）。理由见 `seed/01-phases-and-slices.md`「故事切片」。

故事**按版本滚雪球**：第一条是最小的能走通的主线，之后每条 `--based-on` 上一条，只多一段（缺口、怪事、前情），整条重新走通。上一版故事页上人勾选的缺口（`gapPicks`）就是下一版的 `adds`；人没勾，讲解推荐、人定。

## 路由规则

- 读到子命令后，只做该子命令的事；不把规范全文加载进上下文，按需读 `seed/` 中对应的一份。
- 扮演角色只通过 `agents/*.md`，不凭空扮演；路由自己不建模、不写代码、不判断。
- 任何写入都遵守 `seed/01-phases-and-slices.md` 的写入权表；路由自己只写 `slices/`、`reports/` 与模型文件的 `decisions[]`（通过 `slice apply`）。
- 人可以直接编辑任何工件；编辑后从 `slice next` 重新算下一步即可。
- **人在对话中拍板的事要落地**：路由负责追加到项目的 `raw/项目所有者的裁定.md`（按批次累积，写明依据、作废项与已知缺口），并用 `slice log` 记一条。角色只读它、遵守它，不得自行推翻——有疑虑写进问题清单。校验报告里的裁决走 `slice apply`，那是另一条路径。
- 报告不留历史，可追溯性靠项目自己的 git：每个门禁通过后提醒人提交。
