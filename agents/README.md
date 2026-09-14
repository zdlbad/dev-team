# agents/ — 角色指令与规范，按关注点分

十个角色不是自动注册的子 agent，而是**开发指挥启动角色时交给它的指令**：开发指挥（`SKILL.md`，就是和人对话的主 agent）用 `node $DEV_TEAM/tools/brief.js <角色>` 把这个角色要的全部文字装配成一份，连同上下文块与任务一起用 Agent 工具启动一个子 agent。角色**不再自己去读 seed**；思想在 `seed/`，做法全在这里。

```
agents/
  common/                 几个角色共用的规范库；谁要谁在 reads: 里点名，不是人人都带
    wording.md              语言与措辞：中文、正向陈述、直切要害、通顺不啰嗦不省略、不缩写、一个概念一个名字、规则句怎么写、一事一处、要人做决定的话
    project-layout.md       项目结构：目录、名字的两套写法、写入权表
    discipline.md           共同的纪律：上下文块、只写自己的、decisions[] 不许写、细步 progress、当场发问两种模式、交稿格式
    editor.md               角色：文职（它守的正是 wording.md）
  business/               业务这边
    layers.md               业务描述的文件形式、判层五问、编号与标签、七种种类与落点
    business-analyst.md     角色：业务分析
    guide.md                角色：讲解
  model/                  模型这边
    shapes.md               模型目录、模型名、各 JSON 文件的形状、由形状推论出的规则
    validation.md           校验规范：两个方向的检查项、判断的可审计性、报告
    modeler.md              角色：模型师
    validator.md            角色：模型校验
  code/                   代码这边
    coding-standard.md      编码规范：代码目录、命名、编解码对应、各层的形状、结构化注释、解码规则、禁止项、测试
    style.md                风格 S1–S8（读着顺不顺；冲突时编码规范为准）
    writing-code.md         原型与编码共守：先补关键逻辑、可解码对应、领域代码的纪律、计划确认后人又裁了一条、自检
    prototyper.md  coder.md  interface.md  pre-pr-reviewer.md   角色
  casual/                 临时才用的角色
    reader.md               角色：解读（接手既有代码库时）
```

**装配规则**：`brief.js` 按角色文件 frontmatter `reads:` 的顺序拼它点名的规范（相对 `agents/`，写 `../seed/…` 也认；`common/` 里的也要点名），最后拼角色文件正文。`discipline.md` 每个角色都点（问人、写细步、交稿格式都在里面）；`wording.md` 只有写给人读的文字的角色点（业务分析、讲解、文职、模型师）；`project-layout.md`（结构）只有要在项目里落文件、起模块名的角色点（模型师、原型、编码、接口）；业务分析在 `business/` 里干活，它的文件形式在 `business/layers.md`，不点结构。`node tools/brief.js 模型师 --list` 看会拼进哪些、各多大。

**改规矩时**：一件事只写在一处。所有角色都要守的进 `common/`；一个关注点里几个角色共用的进那个文件夹的规范文件；只有一个角色用的写在它自己的文件里。底层思路变了先改 `seed/`（见 `seed/README.md`）。

## 十个角色

主力（产真相工件）：业务分析、讲解、模型师、编码。辅助：解读、文职、原型、接口、模型校验、pre-pr 审查——讲解、解读、文职为人而设，其余为质量而设。

| 角色 | 文件 | 阶段 | 一句话 |
|---|---|---|---|
| 业务分析 | `business/business-analyst.md` | 一（粗读一次；之后按段落点亮） | 把原料点亮成两层业务语句，维护词汇表 |
| 讲解 | `business/guide.md` | 一（衔接业务到模型） | 写故事、摘原文、出题、把卡改成人话 |
| 文职 | `common/editor.md` | 一（人审模型前总校一趟） | 只改字不改意，校完把裁决接回来 |
| 模型师 | `model/modeler.md` | 一 | 建最少模型，填 `walk`，列业务逻辑的选择 |
| 模型校验 | `model/validator.md` | 三 | 逐条判断，填结论 / 信心 / 理由 |
| 原型 | `code/prototyper.md` | 一→二 | 领域层与应用层（最终代码）+ 内存适配器，装进原型宿主 |
| 接口 | `code/interface.md` | 二（实现切片开头） | 钉死外壳的契约 |
| 编码 | `code/coder.md` | 二 | 生产外壳与外壳测试 |
| pre-pr 审查 | `code/pre-pr-reviewer.md` | 三 | 找模型比对查不到的问题，先候选再复核 |
| 解读 | `casual/reader.md` | 零（既有代码入门） | 把旧代码读成一份原料 |

开发指挥（第十一个，`SKILL.md`）贯穿三阶段。谁能写哪个工件，见 `common/project-layout.md` 的写入权表。

角色文件同一模板：读 · 写 · 方法 · 问人 · 不做 · 自检。子 agent 不能和人聊天，对话由开发指挥执行，人的回答由开发指挥分流后记回裁定文件。
