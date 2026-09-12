# dev-team

模型驱动的开发团队：规范、schema、构建块、工具、角色指令。**本仓库是一个 Claude Code skill**（入口 `SKILL.md`）；项目永远建在本目录之外。

安装：克隆到 `~/.claude/skills/dev-team/`（或项目的 `.claude/skills/dev-team/`），在其中执行 `npm install`。

```
SKILL.md           开发指挥（主持角色：子命令表、run 的分派、节奏、裁定分流）
seed/              规范（决策文档，入口 seed/README.md；00–07）
agents/            九个角色的指令（开发指挥启动子 agent 时使用）
schema/            模型 / 切片 / 故事 / 计划 / 契约的 JSON schema（2020-12），每种文件一份 + common
building-block/    src/shared/building-block 的 TypeScript 源码（含原型宿主 proto/）
template/project/  新项目模板
example/           样例：order-sample（模型、计划、契约）与 order-code（标准答案代码 + 测试）
tools/             脚本（全部 Node）
```

## 一段故事怎么走

业务不一次抽干：`raw/` 是暗的，沿故事线 → 段落逐段点亮（`seed/07-business-layers.md`）。一次动手多大见 `seed/01-phases-and-slices.md`「开发范围怎么切」。

```
开发指挥定故事线、切段落、排先后 → 讲解写本段故事（每步标需要哪条业务）
→ 业务分析点亮：回 raw 找、写成正向陈述句、分层（业务抽象 / 业务落地）、标种类、发编号、归模块 → 人走故事、理解一致
→ 业务分析过五问（会不会同时 / 重复 / 一次几条 / 失败处置 / 谁能看见）、补公司事实 → 人确认
→ 模型师建最少模型、走故事、列选择、在元素规则里写五问的回应 → 校验 ①（机械：每条语句都有落点，标签与文件、字母对得上）
→ 讲解出题 → 人预测、过裁定卡 → 写回 → 回流 → 校验角色填判断 → 人审阅 → 模型确认
→ 开发指挥算编码计划（要动哪些文件、什么顺序）→ 原型补关键逻辑 → 人确认计划
→ 原型按计划写：领域层 + 应用层（这就是最终代码）+ 内存适配器 + 测试 + 故事输入 → plan check
→ 校验 ②（解码比对 0 差异）→ pre-pr 审查（A 用例流程 / B 被删的不变量 / D 测试行为 / S 风格）→ 人审阅
→ 人在原型页面上按故事走、试连点 / 同时 / 成批 → 合并
```

几条故事攒够了，起**实现切片**（`--implements s-002,s-003`）：

```
接口角色定契约（HTTP 入口 / 表结构 / 错误 → 状态码；字段名沿用模型，没问过与故意推迟分开标）→ 人确认
→ 开发指挥算外壳计划 → 编码补关键逻辑（事务、锁、状态码）→ 人确认
→ 编码写外壳与外壳测试（领域代码一行不动）→ plan check → 校验 ②（仍 0 差异）
→ pre-pr 审查（C 契约完整 / E 防御正确性 / F 并发与状态 / S 风格）→ 人审阅 → 合并
```

既有代码用 `read` 让解读角色先写出一份原料（`raw/旧系统解读.md`）与模型草稿，再走粗读与点亮。`slice next` 随时能算出当前卡在哪、下一步该谁；`board` 看全部切片。

## 三个让 agent 少出错的位置

- **规范**：`seed/03` 管能不能解码（硬），`seed/06` 管读着顺不顺（软）。
- **上下文**：故事（人物、日期、金额）+ 模型 + 裁定 + 五问问出来的公司事实。
- **接口**：领域层的接口在模型里已经钉死（入参、返回、规则、事件、错误、步骤）；外壳的接口由契约钉死。写码前先有**计划**，人能看链路对不对，写完机器核对顺序与文件。

## 命令

```bash
npm install                                                   # 首次
node tools/new-project.js <目录> <系统名> [--codebase <代码库>]  # 新建项目（git init）
node tools/slice.js new <项目> <id> <标题> [--story [--based-on <id>]] [--implements <id,…>] [--modules …] [--aggregates …] [--use-cases …] [--traces …]
node tools/story.js approve|apply|serve <项目> [<id>]          # 故事：理解一致 / 裁定写回 / 页面
node tools/story.js usage <项目> <id> propose <U-…|--none> | confirm   # 五问补出的语句：登记 / 人确认
node tools/slice.js next <项目> <id> [--json]                  # 下一步：谁、做什么、跑什么
node tools/slice.js advance <项目> <id> <model|code|validate> <pending|in-progress|done> [说明]
node tools/slice.js apply <项目> <报告 json> [--slice <id>]     # 裁决写回（校验报告进 decisions[]；pre-pr 只记 log）
node tools/plan.js build|confirm|done|check <项目> <id> …       # 编码计划：算链路 / 人确认 / 记完成 / 核对顺序与文件
node tools/contract.js scaffold|check|confirm <项目> <id>       # 契约：骨架 / 核对 / 人确认
node tools/proto.js serve|check <项目> --code <代码库>          # 原型：页面 / 对照模型
node tools/test.js <代码库> [<片段>…]                           # 测试：编译 + node --test 一小批
node tools/prepr.js new|check <项目> <id> --mode proto|shell    # pre-pr 审查：骨架 / 形状核对
node tools/board.js <项目> [--md]                              # 状态看板（算出来的：每个切片走到哪）
node tools/scene.js <项目> set --slice <id> --step "…" --who <角色> [--phase …] [--note …] [--done]
node tools/scene.js <项目> serve [--port 4873]                  # 现场看板（开发指挥写的：这一步谁在干什么）
node tools/check-schema.js --self                              # 编译全部 schema
node tools/check-schema.js <项目>                              # 校验 glossary / model / slices / plans / contracts 的形状
node tools/validate.js <项目> [--code <代码库>] [--slice <id>]   # 校验，产出 reports/validate-1|2
node tools/review.js <报告 json>                               # 审阅页面（本地；校验与 pre-pr 报告通用）
node tools/render.js <项目> [--decoded <解码目录>] [--out <html>] # 模型可视化；带 --decoded 标出差异
node tools/model-delta.js <项目> <切片> [--base <提交>]            # 模型增量：基线提交 → 现在，人只确认增量
node tools/decode.js <代码库> <输出目录> [--system 名]           # 代码 → 模型
node tools/diff-model.js <model 目录> <解码目录>                 # 设计模型 vs 解码模型
node tools/inventory.js <代码库> [--out <md>]                   # 盘点既有代码库
```

## 自检

`example/order-sample`（模型、计划、契约）与 `example/order-code`（标准答案代码与测试）互为镜像：

```bash
node tools/check-schema.js --self && node tools/check-schema.js example/order-sample
node tools/decode.js example/order-code /tmp/x && node tools/diff-model.js example/order-sample/model /tmp/x   # 0 处差异
node tools/validate.js example/order-sample --code example/order-code                                          # 两个方向都「干净」
node tools/plan.js check example/order-sample s-001 --code example/order-code                                  # 计划：30 步一致
node tools/contract.js check example/order-sample s-001                                                        # 契约：齐了
node tools/test.js example/order-code                                                                          # 31 个用例通过
node tools/proto.js check example/order-sample --code example/order-code                                       # 原型登记齐
node tools/board.js example/order-sample && node tools/render.js example/order-sample --decoded /tmp/x         # 看板 + 页面
```

## 建造进度

| 产物 | 状态 |
|---|---|
| 模型 JSON schema + 形状校验 | 完成（含计划、契约） |
| 基础构建块 | 完成（tsc strict 通过；含原型宿主） |
| 项目模板 + new-project | 完成 |
| 解码器（代码 → 模型） | 完成（样例零差异；跳过 `src/shared`、`src/proto` 与测试） |
| 校验器（机械检查 + 判断清单 + 报告） | 完成（方向 ① 含标签检查、每条语句的落点与判断；方向 ② 解码 + 比对 + lint） |
| 审阅工具 | 完成（校验报告与 pre-pr 报告通用） |
| 开发指挥 + 九个角色指令 | 完成（`SKILL.md` 的 `run` 一次推进一步；`agents/` 九份） |
| 切片驱动 | 完成（`slice.js`：new / next / advance / apply / log；`story.js` 含五问补出语句的登记与确认） |
| 编码计划 | 完成（`plan.js`：从模型算链路、人确认、记完成、核对顺序与文件） |
| 契约 | 完成（`contract.js`：骨架、核对字段名与模型一致、人确认；两级标记） |
| 测试 | 完成（03 第八节；`test.js` 编译 + `node --test`；样例 31 个用例——它们抓出了内存仓储 `structuredClone` 丢原型的 bug） |
| pre-pr 审查 | 完成（`prepr.js`：骨架与形状核对；七个角度两次跑） |
| 状态看板 | 完成（`board.js` 算状态；`scene.js` 现场看板，开发指挥写、页面每 2 秒自取） |
| 可视化 | 完成（`render.js`） |
| 原型 | 完成（`proto.js`：编译、宿主、页面、对照模型） |
| 未定 | 目标架构是否只以六边形为目标；HTTP 入口的文件位置（等第一个实现切片按技术选型定） |
