# 项目结构与写入权

## 项目目录

```
<project>/                    一个项目一个文件夹、一个 git 仓库
  project.json                有它的目录才算项目目录；codebase 记着代码库在哪
  raw/                        原料，人放进来；只读
  raw/rulings.md              人拍板的事，按批累积（开发指挥写）
  business/00-overview.md     全景：这门生意、钱怎么走、模块候选
  business/<Module>/abstraction.md   业务抽象
  business/<Module>/practice.md      业务落地
  glossary.json               词汇表
  导读/                       给人读的原文选读
  model/                      模型（形状见 model/shapes.md）
  model-decoded/<版本>/       从代码解码出来的模型；永不手改、随时可删
  slices/<id>.json            切片记录：s-xxx 场景、f-xxx 正式化
  reports/                    校验与审查报告、现场看板（_scene.json）、模型图上的意见（_model-notes.json）
  journal/<日期>.jsonl        派工与交回的流水，只追加
```

代码库在项目目录之外：`src/`、`tests/`、`contracts/`，草稿原型的入口 `src/proto/main.ts`、产品页面 `src/proto/web/`。

**名字的两套写法**：模块名、类名、模型目录（`model/<Module>/`）用 PascalCase，只许每个词首字母大写，不许整段大写的缩写（`HCPBilling` 换不回来）；代码与测试的文件夹全小写、多词用连字符：模块 `ServiceAgreements` 的代码在 `src/service-agreements/`，聚合文件夹同理，测试镜像 `tests/<module-folder>/`。两套靠换算来回对应。

## 写入权：每个工件只有一个写入角色

| 角色 | 只写 | 不得写 |
|---|---|---|
| 业务分析 | `business/`、`glossary.json`、`导读/` | 模型、代码 |
| 模型师 | `model/`；`reports/_model-notes.json` 里的 `handled` | 业务描述、词汇表、代码 |
| 编码 | 代码库（`src/`、`tests/`、`contracts/`） | 模型、业务描述、词汇表 |
| 审查 | 校验报告里判断的 `verdict`、`confidence`、`reason`；`reports/pre-pr-<切片>.md` | 一切工件 |
| 文职 | 业务语句的正文、模型元素给人读的文字——只改字不改意 | 编号、标签、追溯、结构、词汇表、代码 |
| 分身 | 什么都不写 | 一切 |
| 开发指挥 | 切片记录、`raw/rulings.md`、现场看板与日志 | 业务描述、模型、代码、报告 |

人可以直接改任何工件。校验只出报告，不改工件。
