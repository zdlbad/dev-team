---
name: dev-team
description: 模型驱动的开发团队。业务 → 模型 → 代码三阶段，模型可编码、代码可解码，校验互证；四个角色（业务分析、模型师、编码、模型校验）按切片迭代。用法：/dev-team <子命令> …
---

# dev-team — 路由

本文件所在目录是 dev-team 根目录（下称 `$DEV_TEAM`）。规范在 `$DEV_TEAM/seed/`，入口 `seed/README.md`。项目永远在 `$DEV_TEAM` 之外。

首次使用：在 `$DEV_TEAM` 执行 `npm install`。

## 子命令（当前可用）

| 子命令 | 作用 | 执行 |
|---|---|---|
| `new <目录> <系统名> [--codebase <代码库>]` | 新建项目（git init；可顺带拷入构建块） | `node $DEV_TEAM/tools/new-project.js …` |
| `check <项目目录>` | 校验项目模型文件的形状 | `node $DEV_TEAM/tools/check-schema.js …` |
| `help` | 打印本表 | — |

## 待接入（第二、三批建造）

解码器 · 校验器 · 审阅工具 · 四个角色（`agents/`）· 切片周期驱动 · 状态看板。
角色的定义依据 `seed/05-roles.md`；接入前不要凭空扮演角色。

## 路由规则

- 读到子命令后，只做该子命令的事；不把规范全文加载进上下文，按需读 `seed/` 中对应的一份。
- 项目目录的判定：含 `project.json` 的目录。
- 任何写入都遵守 `seed/01-phases-and-slices.md` 的写入权表。
