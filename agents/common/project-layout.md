# 项目结构与写入权

## 项目目录

```
<project>/                    一个项目一个文件夹、一个 git 仓库
  project.json                有它的目录才算项目目录；codebase 记着代码库在哪，frontend 记着前端工程在哪（可省）
  raw/                        原料，人放进来；只读
  raw/rulings.md              人拍板的事，按批累积（开发指挥写）
  business/00-framework.md    业务框架：为什么存在、各方各自要什么、核心流程（给人看全貌）
  business/00-overview.md     全景：这门生意、钱怎么走、模块候选（细一层的参考）
  business/聚焦/<n>-<一段业务>.md  聚焦：框架的三节下到一段业务（业务分析）
  business/概念/<nn>-<概念>.md   概念卡的前半张：本质、类比、例子、样子（业务分析）
  business/<Module>/abstraction.md   业务抽象
  business/<Module>/practice.md      业务落地
  business/<Module>/behavior.md      应用行为
  glossary.json               词汇表
  导读/                       给人读的原文选读
  model/                      模型（形状见 model/shapes.md）
  model/概念/<nn>-<概念>.md      概念卡的细节（模型师）；工具读模型只认 .json，这里的 .md 不进校验
  model-decoded/<版本>/       从代码解码出来的模型；永不手改、随时可删
  slices/<id>.json            切片记录：s-xxx 场景、f-xxx 正式化
  reports/                    校验与审查报告、现场看板（_scene.json）、模型图上的意见（_model-notes.json）、业务页上的留言（_business-comments.json）
  journal/<日期>.jsonl        派工与交回的流水，只追加
```

代码库在项目目录之外：`src/`、`tests/`、`contracts/`。模块都放在 `src/modules/<module-folder>/`，测试镜像在 `tests/modules/<module-folder>/`；组合根、起服务、示例数据在 `src/bootstrap/`，技术件（HTTP 入口、事件总线，以后数据库连接、登录）在 `src/infras/`，基础构建块在 `src/shared/`，原型宿主在 `src/proto/`——这四样不是模块；谁能 import 谁见 `code/coding-standard.md`「依赖方向」。

**前端工程**：产品页面写在一个单独的前端工程里（React + TypeScript + Vite，界面用 Ant Design），放在代码库旁边的 `frontend/`：代码库是 `code/backend`，前端就是 `code/frontend`。放在别处的，在 `project.json` 里写 `"frontend": "<相对项目目录的路径>"`；写 `false` 表示这个项目没有前端工程。目录里有 `package.json` 才算数。工具都按这个找：`proto.js` 起它的开发服务，`validate.js` 读它上面的 `@trace`。
没有前端工程的项目（样例 `example/order-code`）用原型宿主：入口 `src/proto/main.ts`、产品页面 `src/proto/web/`（`src/shared/building-block/proto/README.md`）。

**名字的两套写法**：模块名、类名、模型目录（`model/<Module>/`）用 PascalCase，只许每个词首字母大写，不许整段大写的缩写（`HCPBilling` 换不回来）；代码与测试的文件夹全小写、多词用连字符：模块 `ServiceAgreements` 的代码在 `src/modules/service-agreements/`，聚合文件夹同理，测试镜像 `tests/modules/<module-folder>/`。两套靠换算来回对应。

## 写入权：每个工件只有一个写入角色

| 角色 | 只写 | 不得写 |
|---|---|---|
| 业务分析 | `business/`、`glossary.json`、`导读/`；`reports/_business-comments.json` 里的答复（经 `tools/comments.js`） | 模型、代码 |
| 模型师 | `model/`；`reports/_model-notes.json` 里的 `handled` | 业务描述、词汇表、代码 |
| 编码 | 代码库（`src/`、`tests/`、`contracts/`）、前端工程 | 模型、业务描述、词汇表 |
| 审查 | 校验报告里判断的 `verdict`、`confidence`、`reason`；`reports/pre-pr-<切片>.md` | 一切工件 |
| 文职 | 业务语句的正文、模型元素给人读的文字——只改字不改意 | 编号、标签、追溯、结构、词汇表、代码 |
| 分身 | 什么都不写 | 一切 |
| 开发指挥 | 切片记录、`raw/rulings.md`、现场看板与日志 | 业务描述、模型、代码、报告 |

人可以直接改任何工件。校验只出报告，不改工件。
