# 项目结构：目录、名字、写入权

要在项目里落文件、起模块名的角色加载它；只在自己那一小块里干活的角色不必。

## 项目目录

```
<project>/                    每个项目一个文件夹、一个 git 仓库；变化靠 git 追溯
  project.json                有它的目录才算项目目录
  raw/                        原料，任意格式，人放入；暗的，按段落点亮（seed/layers.md）
  raw/rulings.md              人在对话中拍板的事，按批次累积，每条标层（开发指挥写）
  business/00-overview.md         粗读的产物：这门生意、钱的路径、模块候选；给人读，不进解析
  business/<Module>/abstraction.md   第一层：手册层面的抽象业务（按段落点亮）
  business/<Module>/practice.md   第二层：这家公司的做法，含情形语句
  glossary.json               词汇表
  stories/                    故事线索引：段落先后、一句衔接、每段到第几轮（开发指挥写）
  导读/                       讲解给人的东西：原文选读、导读课、沙盘
  demo/                       mock 产品：预演写的，整个项目一个 app 按模块长（纯前端、状态在浏览器里、fixtures 来自走查）。业务定了、模型没开工时给人按——**不是准绳，是收集和验证业务的工具**（第一百九十五、一百九十七批）
  model/                      设计模型（形状见 agents/model/shapes.md）
  model-decoded/<version>/    解码出的实际模型；与 model/ 同结构；版本 = 代码提交号 + 时间戳；永不手改、随时可删
  slices/<id>.json            切片记录；<id>.story.json 故事；_candidates.json 候选修改
  plans/<id>.json             编码计划：这次要动哪些代码文件、按什么顺序、每步守什么（开发指挥算骨架，写码角色补关键逻辑，人确认）
  contracts/                  生产外壳的契约：http.<UseCase> / table.<Aggregate> / errors.<Module>（接口角色写，人确认）
  reports/                    校验与审查报告，每种只留最新一份；json 进 git（审到一半的裁决、现场看板要随人换机器），md / html 重算得出、不进
  journal/<日期>.jsonl        派工与交回的流水，只追加
```

代码库在项目目录之外，其路径记在切片记录里（`codebase`）。计划与契约的形状见 `$DEV_TEAM/schema/plan.schema.json`、`schema/contract.schema.json`。

**名字的两套写法**（2026-09-13 第七十二批）：模块名（`modules.json`、`module.json`、模型文件里的 `module` 字段、类名、模型目录 `model/<Module>/`）是 PascalCase，只许「每个词首字母大写、其余小写」，不许 `HCPBilling` 这种整段大写的缩写（会换不回来）；代码与测试的文件夹全小写、多词用连字符：模块 `Participants` 的代码在 `src/participants/`，模块 `ServiceAgreements` 在 `src/service-agreements/`，聚合文件夹同理（`domain/service-agreement/`），测试镜像 `tests/<module-folder>/`。两者靠换算来回对应。

## 写入权：每个工件只有一个写入角色

| 角色 | 阶段 | 唯一写入目标 | 不得写 |
|---|---|---|---|
| 业务分析 | 一 | `business/00-overview.md`、`business/<Module>/abstraction.md`、`business/<Module>/practice.md`（含情形语句）、词汇表 | 模型、代码、故事 |
| 讲解 | 一（衔接业务到模型） | 故事（人物、步骤、`needs`、题目、缺口）、`导读/` | 业务描述、词汇表、模型 |
| 模型师 | 一 | 模块划分、两层模型；故事的 `walk` 与 `choices`；`reports/_model-notes.json` 的 `handled` | 业务描述（提交问题）、词汇表（提交新词）、代码 |
| 文职 | 一（人审模型前总校一趟） | 业务语句的正文与模型元素给人读的文字——只改字不改意 | 编号、标签、追溯、结构、故事、题目、卡、词汇表、代码 |
| 预演 | 一（业务定了、模型没开工） | `demo/`：那个能按的 mock 产品 | 业务语句、词汇表、走查、模型、代码——一个字都不动 |
| 原型 | 一→二 | 故事的领域层、应用层、内存适配器、组合根、原型入口、领域与用例测试；故事的 `walk.input`；计划的关键逻辑与完成记录 | 模型（报告不一致）、词汇表、契约 |
| 接口 | 二（实现切片开头） | 契约 `contracts/` | 代码、模型、业务描述 |
| 编码 | 二 | 生产外壳与外壳测试；计划的关键逻辑与完成记录 | 模型（报告不一致）、词汇表、契约（报给接口角色）、领域层与应用层（回到那一段） |
| 模型校验 | 三 | 校验报告里判断的 `verdict` / `confidence` / `reason` | 一切工件 |
| pre-pr 审查 | 三 | 审查报告里的 `judgments[]` / `cleanAngles[]` | 一切工件 |
| 解读 | 零 | `raw/legacy-reading.md`、词汇表的别名、模型草稿、解读说明 | 代码、`business/` |
| 开发指挥 | 贯穿 | 切片记录、候选修改清单、故事线索引、编码计划的骨架、模型文件的 `decisions[]`（`slice apply`）、`raw/rulings.md`、情形语句的编号登记（`story usage`）、模块点亮的编号登记（`slice lit`）、出原型（`slice proto-go`）、现场看板与日志 | 业务描述、模型、代码、契约、报告 |

人在每个阶段末拍板，并可直接编辑任何工件。校验只产报告，不改任何工件。
