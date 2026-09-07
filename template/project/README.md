# __SYSTEM__

模型驱动开发项目。规范见 dev-team 的 `seed/`。

```
raw/                原料，任意格式，人放入
business/           业务描述：陈述性语句（目标 G-nnn、规则 R-nnn、使用 U-nnn），按主题分文件
glossary.json       词汇表：业务的语言
model/              设计模型（模型师唯一写入目标）
model-decoded/      解码出的实际模型（临时，不入库）
slices/             切片记录
reports/            校验报告（只留最新，不入库）
.viewer/            可视化状态（不进模型文件）
project.json        项目元信息
```

代码库在本目录之外，路径记在切片记录的 `codebase`。
