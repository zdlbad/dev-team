# dev-team

一个 Claude Code 技能：模型驱动的开发团队。业务是模型的源头，模型可编码，代码可解码，校验拿两者互证。**一个场景一个场景往前滚**，每个场景都先摆出一个能按的草稿原型，拿它去问人。

安装：克隆到 `~/.claude/skills/dev-team/`（或项目的 `.claude/skills/dev-team/`），在里面跑 `npm install`。之后在 Claude Code 里用 `/dev-team <子命令>`。

```
SKILL.md           开发指挥：流程、子命令、派角色、问人、裁定、现场
seed/principles.md 骨架思想（改底层思路先改它）
agents/            六个角色的指令与共用规范，tools/brief.js 装成派工书交给子 agent
schema/            模型与切片的 JSON schema
building-block/    代码库里 src/shared/building-block 的源码（含草稿原型的宿主 proto/）
template/project/  新项目模板
example/           样例：order-sample（业务与模型）、order-code（照模型写的代码与测试）
tools/             脚本，全部 Node
```

## 一个场景怎么走

1. **定场景**：业务分析从原料里提一个，或人自己说一个——谁、按什么、然后发生什么。
2. **建模**：模型师只建这个场景碰到的；校验器查业务对模型，审查角色判它拿不准的那几条。
3. **起草稿原型**：编码照模型写领域代码、内存仓储，和一个按身份分的产品页面。
4. **一起按**：人和模型师在页面上按，问出来的答案回到业务分析（立成语句）和模型师（改模型），页面跟着变。
5. 人说「这一段够了」，进下一个场景。

攒到一定量，人说「够了」，**正式化**：钉契约、补测试、写生产外壳，解码代码对模型，审查做 pre-pr。

人看的页面都在工作台一个地址里：`node tools/workbench.js <项目> --code <代码库>`，打开 http://localhost:4870。

## 自检

```
node tools/check-schema.js --self                                  # schema 本身
node tools/check-schema.js example/order-sample                    # 样例的 JSON 形状
node tools/validate.js example/order-sample --code example/order-code   # 业务对模型、代码对模型
node tools/proto.js check example/order-sample --code example/order-code
node tools/test.js example/order-code
```
