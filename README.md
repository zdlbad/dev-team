# dev-team

模型驱动的开发团队：规范、schema、构建块、工具。**本仓库是一个 Claude Code skill**（入口 `SKILL.md`）；项目永远建在本目录之外。

安装：克隆到 `~/.claude/skills/dev-team/`（或项目的 `.claude/skills/dev-team/`），在其中执行 `npm install`。

```
SKILL.md           skill 路由
seed/              规范（决策文档，入口 seed/README.md）
schema/            模型 JSON schema（2020-12），每种文件一份 + common
building-block/    src/shared/building-block 的 TypeScript 源码
template/project/  新项目模板
example/           样例模型（订单），供参考与工具测试
tools/             脚本
```

## 命令

```bash
npm install                                          # 首次
node tools/check-schema.js --self                    # 编译全部 schema
node tools/check-schema.js <项目目录>                 # 校验项目的 glossary / model / slices
node tools/new-project.js <目录> <系统名> [--codebase <代码库>]   # 新建项目（git init）；带 --codebase 时拷入构建块
```

## 建造进度

| 产物 | 状态 |
|---|---|
| 模型 JSON schema + 形状校验 | 完成 |
| 基础构建块 | 完成（tsc strict 通过） |
| 项目模板 + new-project | 完成 |
| 解码器（代码 → 模型） | 待建 |
| 校验器（机械检查 + 判断编排 + 报告） | 待建 |
| 审阅工具 | 待建 |
| 路由 + 四个角色的 agent 定义 | 待建 |
| 状态看板 | 待建 |
| 可视化 | 待建 |
