# dev-team

模型驱动的开发团队：规范、schema、构建块、工具、角色指令。**本仓库是一个 Claude Code skill**（入口 `SKILL.md`）；项目永远建在本目录之外。

安装：克隆到 `~/.claude/skills/dev-team/`（或项目的 `.claude/skills/dev-team/`），在其中执行 `npm install`。

```
SKILL.md           skill 路由（子命令表 + run 的分派规则）
seed/              规范（决策文档，入口 seed/README.md）
agents/            五个角色的指令（路由启动子 agent 时使用）
schema/            模型 JSON schema（2020-12），每种文件一份 + common
building-block/    src/shared/building-block 的 TypeScript 源码
template/project/  新项目模板
example/           样例：order-sample（模型）与 order-code（标准答案代码）
tools/             脚本（全部 Node）
```

## 一个切片怎么走

```
slice new → 人与模型师定范围 → 模型师建模 → 校验 ①（机械 + 判断清单）→ 校验角色填判断
→ 人审阅（review）→ 裁决写回（slice apply）→ 回流或人确认模型（门禁）
→ 编码 → 校验 ②（解码 + 比对）→ 判断 / 审阅 / 写回 → 干净 → 切片完成，人合并
```

以上是老式的按主题切片。默认用**故事切片**：建模切片（一条故事 → 业务理解一致 → 最少模型 → 走故事、裁定 → 模型确认，不编码）与实现切片（`--implements` 几条已确认的故事 → 编码 → 校验 ②）分开；一条故事的模型改动也可以就地接着编码，模型确认后人选。

`slice next` 随时能算出当前卡在哪、下一步该谁；`board` 看全部切片。

## 命令

```bash
npm install                                                   # 首次
node tools/new-project.js <目录> <系统名> [--codebase <代码库>]  # 新建项目（git init）
node tools/slice.js new <项目> <id> <标题> [--modules …] [--aggregates …] [--use-cases …] [--traces …]
node tools/slice.js next <项目> <id> [--json]                  # 下一步：谁、做什么、跑什么
node tools/slice.js advance <项目> <id> <model|code|validate> <pending|in-progress|done> [说明]
node tools/slice.js apply <项目> <报告 json> [--slice <id>]     # 裁决写回 decisions[]；回流项记入切片 log
node tools/board.js <项目> [--md]                              # 状态看板
node tools/check-schema.js --self                              # 编译全部 schema
node tools/check-schema.js <项目>                              # 校验 glossary / model / slices 的形状
node tools/validate.js <项目> [--code <代码库>] [--slice <id>]   # 校验，产出 reports/validate-1|2
node tools/review.js <报告 json>                               # 审阅页面（本地）
node tools/render.js <项目> [--decoded <解码目录>] [--out <html>] # 模型可视化（关系图 / 卡片 / 业务覆盖）；带 --decoded 标出差异
node tools/decode.js <代码库> <输出目录> [--system 名]           # 代码 → 模型
node tools/diff-model.js <model 目录> <解码目录>                 # 设计模型 vs 解码模型
```

## 自检

`example/order-sample`（模型）与 `example/order-code`（标准答案代码）互为镜像：

```bash
node tools/check-schema.js --self && node tools/check-schema.js example/order-sample
node tools/decode.js example/order-code /tmp/x && node tools/diff-model.js example/order-sample/model /tmp/x   # 0 处差异
node tools/validate.js example/order-sample --code example/order-code                                          # 两个方向都「干净」
node tools/board.js example/order-sample && node tools/render.js example/order-sample --decoded /tmp/x         # 看板 + 页面
```

## 建造进度

| 产物 | 状态 |
|---|---|
| 模型 JSON schema + 形状校验 | 完成 |
| 基础构建块 | 完成（tsc strict 通过） |
| 项目模板 + new-project | 完成 |
| 解码器（代码 → 模型） | 完成（样例零差异；反向测试能抓出未设计的行为、删掉的守卫、处理器里的业务判断、漏发布） |
| 校验器（机械检查 + 判断清单 + 报告） | 完成（方向 ① 二十余项机械检查；方向 ② 解码 + 比对 + lint；裁决按文字哈希判断过期） |
| 审阅工具 | 完成（本地页面，裁决写回报告 JSON） |
| 路由 + 五个角色指令 | 完成（`SKILL.md` 的 `run` 一次推进一步；`agents/` 五份） |
| 切片驱动 | 完成（`slice.js`：new / next / advance / apply / log；样例项目走通整个周期） |
| 状态看板 | 完成（`board.js`） |
| 可视化 | 完成（`render.js`：自包含 HTML，关系图可拖拽缩放、点节点看详情；带解码目录时差异节点描红、卡片并排差异） |
| 未定 | 测试的位置与命名；是否只以六边形为目标（seed/03 §八） |
