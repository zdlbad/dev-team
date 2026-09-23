# __SYSTEM__

模型驱动开发项目，用 dev-team 一个场景一个场景往前滚。思想见 dev-team 的 `seed/principles.md`，做法见 `agents/`。

```
raw/                原料，人放进来；raw/rulings.md 记人拍板的事
business/           业务描述：00-overview.md；<Module>/abstraction.md（业务抽象）、<Module>/practice.md（业务落地）
glossary.json       词汇表
model/              模型（模型师写）
model-decoded/      从代码解码出来的模型（临时，不入库）
slices/             切片记录：s-xxx 场景、f-xxx 正式化
reports/            校验与审查报告、现场看板
journal/            派工与交回的流水
project.json        项目元信息；codebase 记着代码库在哪
```

代码库在本目录之外。人看的页面都在工作台：`node <dev-team>/tools/workbench.js <本目录>`，开 http://localhost:4870。
