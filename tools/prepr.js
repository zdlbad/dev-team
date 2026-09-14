#!/usr/bin/env node
/**
 * pre-pr 审查的报告骨架与核对。审查本身是判断，由 pre-pr 审查角色做；本工具只负责：
 *   new    按模式列出角度与范围（要读的文件、可以跳过的 U-xxx），写 reports/pre-pr-<mode>.json 骨架
 *   check  核对角色填好的报告形状（每条发现有文件:行、失败场景、复核结论），写 .md
 *
 * 报告形状与校验报告一致（direction: 3），所以审阅页面（review.js）与裁决写回（slice apply）直接复用：
 *   judgments[] 里每条 = 一个发现：verdict 固定 fail，importance = 严重度（high 必须改 / medium 应该改 / low 说明），
 *   confidence = 复核（high CONFIRMED / medium PLAUSIBLE），sides.expected / sides.code，failure = 具体的失败场景。
 *   cleanAngles[] = 没有发现的角度（每个角度必须在 judgments 或 cleanAngles 之一出现）。
 *
 * 用法：
 *   node tools/prepr.js new   <项目目录> <切片id> --mode proto|shell [--code <代码库>]
 *   node tools/prepr.js check <项目目录> <切片id> --mode proto|shell
 * 退出码：0 正常；1 形状不对；2 用法错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const { loadProject, walk, readJson } = require('./lib/project')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const sliceId = args[2] && !args[2].startsWith('--') ? args[2] : undefined
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const mode = opt('--mode')
function die(msg) { console.error(msg); process.exit(2) }
if (!['new', 'check'].includes(cmd) || !root || !fs.existsSync(path.join(root, 'project.json')) || !sliceId || !['proto', 'shell'].includes(mode)) die('用法：node tools/prepr.js <new|check> <项目目录> <切片id> --mode proto|shell [--code <代码库>]')
const slicePath = path.join(root, 'slices', `${sliceId}.json`)
if (!fs.existsSync(slicePath)) die(`切片不存在：${path.relative(process.cwd(), slicePath)}`)
const slice = readJson(slicePath)
const codebase = opt('--code') ? path.resolve(opt('--code')) : path.resolve(root, slice.codebase)
const reportPath = path.join(root, 'reports', `pre-pr-${mode}.json`)
const reportMd = path.join(root, 'reports', `pre-pr-${mode}.md`)

/** 七个角度。A–D 对着模型与故事查（模型说的代码做了没）；E–F 对着代码本身查（模型不表达的：输入边界、错误处理、并发）；S 对着 agents/code/style.md 查风格，两种模式都跑，只出说明 / 应该改。 */
const ANGLES = {
  'A 用例流程': { question: '范围内每个用例的每一步，代码里走得通吗？', pass: '模型 steps 的每一步（调行为、分流、发事件）都能在处理器 / 聚合里指出对应的那行；故事的每一步都能在原型上跑出故事说的事实。', fail: '某一步在代码里没有对应的调用；某个 when 分流少了一侧；事件该发没发。', how: '拿模型的 steps 与故事的 walk 逐步对代码；解码比对已经保证结构一致，这里看的是行为——尤其是分流两侧、边界值、事件 payload 的内容。' },
  'B 被删的不变量': { question: '这次改动有没有删掉或放松一条规则，模型也同步删了，但没有人拍板？', pass: '每条模型 throws / raises / rules 在聚合行为里有守卫，且有一个测试用例走到它；这次改动删掉的守卫都能在裁定文件里找到依据。', fail: '守卫没了或条件变宽了，模型跟着改了所以解码比对是干净的，但 raw/rulings.md 里没有这条。', how: 'git diff 看这次动过的聚合行为；每个被删或被改的 if 找裁定；每个现存的 throws / raises 找测试。' },
  'C 契约完整': { question: 'contracts/ 里每个字段代码都接了吗？标「（故意推迟）」的有没有偷偷实现？', pass: 'HTTP 入口的字段名、来源（params / query / body）、类型与契约一致；表的每列都落了；错误按契约映射状态码；推迟的项没有代码。', fail: '字段名不同、可选变必填、类型漂移、错误映射缺、推迟项被实现了。', how: '逐份契约对代码；contract check 只查字段名，这里查类型、来源、可选性与状态码。' },
  'D 测试行为': { question: '测试测的是业务行为，还是实现细节？', pass: '每个用例断言的是模型说的事：状态变了、抛了哪个错、发了哪个事件、算出的金额；用例名带编号。', fail: '断言的是私有方法被调、某个依赖被调了几次、内部字段的值——模型里没有这一步。', how: '每个 it 找它对应的 rule / throws / raises / step；找不到的就是在测实现。' },
  'E 防御正确性': { question: '正常路径之外，代码自己的错误处理对不对？（只查没有 U-xxx 覆盖的纯工程项）', pass: '外部输入到达逻辑前按它自己声明的类型 / 消息校验了；错误没有被吞掉；部分失败的结果报得准确；抛出的错没有越过这一层声明的范围。', fail: '守卫比错误消息承诺的弱（说「正整数」只挡了 NaN）；try/catch 吞错；Promise.all 结果错位；一个层抛出了它不该抛的东西。', how: '找每个 catch、每个 parseInt / Number、每个 Promise.all / allSettled、每个入口的入参处理；已经有 U-xxx 语句并被模型回应的（重复提交、并发改、部分失败的语义）不在这里重查——那是校验 ① 与原型的事。' },
  'S 风格': { question: '代码读着顺不顺？（agents/code/style.md 的 S1–S8；只出「说明」或「应该改」，不出「必须改」）', pass: '领域概念是类；03 没定形状的数据类用经典写法；领域层没有技术词汇；登记在组合根里显式可见；没有为将来准备的开关；订阅者接事件、服务接参数；处理器体之外的注释讲行为与原因、类上只说自己守的规则、不抄模型 note 里的上下文（03「注释写什么」）；模块内没有另设 _shared/。', fail: '一个领域概念写成对象字面量加自由函数；技术词汇进了领域层的命名；一个只取一个值的布尔参数；逐行叙述的注释；类注释或方法注释抄了模型 note 里的上下文（并发洞、真保证在哪一层）、写了代码不负责的事；模块内出现 _shared/。', how: '逐条对 06 的表；03 已定形状的类（聚合根、处理器、命令、事件）按 03 算，不按 S2 挑。' },
  'F 并发与状态': { question: '两个流程同时碰同一份数据时会不会出错？（只查没有 U-xxx 覆盖的纯工程项）', pass: '共享状态在 await 前读、await 后用的地方有版本或重读；乐观锁在仓储 save 里落了；页面上同一实体的两个动作互相禁用。', fail: 'await 前后状态不一致；并发写覆盖；同一实体两个按钮能同时按。', how: '找每个 await 前后对同一状态的读写；找每个 save 有没有 version 比对；U-xxx 已覆盖的场景跳过。' },
}
const MODES = { proto: ['A 用例流程', 'B 被删的不变量', 'D 测试行为', 'S 风格'], shell: ['C 契约完整', 'E 防御正确性', 'F 并发与状态', 'S 风格'] }

// ========== new ==========
if (cmd === 'new') {
  const { business } = loadProject(root)
  const usage = business.filter((s) => s.kind === 'usage' && slice.traces.includes(s.id)).map((s) => ({ id: s.id, text: s.text }))
  const planP = path.join(root, 'plans', `${sliceId}.json`)
  const plan = fs.existsSync(planP) ? readJson(planP) : null
  const files = plan ? plan.steps.filter((s) => s.file && !s.file.includes('*')).map((s) => s.file) : []
  const guides = Object.fromEntries(MODES[mode].map((a) => [a, ANGLES[a]]))
  const report = {
    direction: 3, mode, project: root, slice: sliceId, at: new Date().toISOString(), decodedVersion: null, guides,
    scope: { codebase: path.relative(root, codebase).replaceAll('\\', '/'), files, useCases: plan?.scope.useCases ?? slice.scope.useCases, aggregates: plan?.scope.aggregates ?? slice.scope.aggregates, usage, contracts: mode === 'shell' && fs.existsSync(path.join(root, 'contracts')) ? walk(path.join(root, 'contracts')).map((f) => path.relative(root, f).replaceAll('\\', '/')) : [] },
    angles: MODES[mode],
    errors: [], warnings: [], confirms: [], judgments: [], cleanAngles: [], decided: [],
    blindSpots: mode === 'proto' ? ['C / E / F 在实现切片的外壳写完后查', '解码比对已保证结构一致，这里只看行为'] : ['A / B / D 已在故事切片的原型阶段查过', '老项目里旧的 U-xxx 已覆盖的并发 / 重复 / 部分失败场景由校验 ① 与原型负责，E / F 不重查；新项目没有 U，E / F 全查'],
    conclusion: null,
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  // 上一份报告是别的切片的、或已经填过发现的，先存档成 pre-pr-<模式>.<那条切片>.json 再盖——人还没过眼的说明不能被下一段的骨架冲掉（2026-09-14 s-001 那份被盖过一次）
  if (fs.existsSync(reportPath)) {
    let prev = null
    try { prev = readJson(reportPath) } catch { prev = null }
    if (prev?.slice && (prev.slice !== sliceId || (prev.judgments ?? []).length || (prev.confirms ?? []).length)) {
      const arch = path.join(root, 'reports', `pre-pr-${mode}.${prev.slice}.json`)
      fs.writeFileSync(arch, JSON.stringify(prev, null, 2) + '\n')
      console.log(`上一份报告（${prev.slice}，${(prev.judgments ?? []).length} 条发现）已存档：${path.relative(process.cwd(), arch)}`)
    }
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`报告骨架：${path.relative(process.cwd(), reportPath)}（模式 ${mode}：${MODES[mode].join('、')}；范围文件 ${files.length}，可跳过的旧使用语句 ${usage.length}）`)
}

// ========== check ==========
if (cmd === 'check') {
  if (!fs.existsSync(reportPath)) die(`报告不存在：${path.relative(process.cwd(), reportPath)}（先 prepr new）`)
  const r = readJson(reportPath)
  const problems = []
  for (const [i, j] of (r.judgments ?? []).entries()) {
    const at = `judgments[${i}]`
    if (!MODES[mode].includes(j.check)) problems.push(`${at}：check 必须是本模式的角度之一：${MODES[mode].join(' / ')}`)
    if (!/^[^:]+:\d+/.test(j.target ?? '')) problems.push(`${at}：target 要是 文件:行`)
    if (j.verdict !== 'fail') problems.push(`${at}：发现的 verdict 固定为 fail`)
    if (!['high', 'medium', 'low'].includes(j.importance)) problems.push(`${at}：importance 是严重度 high（必须改）/ medium（应该改）/ low（说明）`)
    if (j.check === 'S 风格' && j.importance === 'high') problems.push(`${at}：风格问题不出「必须改」`)
    if (!['high', 'medium'].includes(j.confidence)) problems.push(`${at}：confidence 是复核结论 high（CONFIRMED）/ medium（PLAUSIBLE）；REFUTED 的不进报告`)
    if (!j.sides?.expected || !j.sides?.code) problems.push(`${at}：sides.expected（模型 / 契约 / 代码自己承诺的）与 sides.code（实际怎么写的）都要有`)
    if (!j.failure) problems.push(`${at}：failure 要写具体的失败场景（什么输入 / 什么先后顺序 → 什么错）`)
    if (!j.reason) problems.push(`${at}：reason 一句话`)
  }
  for (const a of MODES[mode]) if (!(r.judgments ?? []).some((j) => j.check === a) && !(r.cleanAngles ?? []).includes(a)) problems.push(`角度「${a}」既没有发现也没列进 cleanAngles——每个角度都要有结论`)
  const must = (r.judgments ?? []).filter((j) => j.importance === 'high').length
  r.conclusion = problems.length ? null : must ? 'not-clean' : 'clean'
  if (!problems.length) {
    fs.writeFileSync(reportPath, JSON.stringify(r, null, 2) + '\n')
    const L = [`# pre-pr 审查 · ${sliceId} · ${mode === 'proto' ? '原型（A 用例流程 / B 被删的不变量 / D 测试行为 / S 风格）' : '外壳（C 契约完整 / E 防御正确性 / F 并发与状态 / S 风格）'}`, '', `- 时间：${r.at}`, `- 发现 ${r.judgments.length}（必须改 ${must}）· 干净的角度 ${r.cleanAngles.length}`, `- **结论：${r.conclusion === 'clean' ? '干净' : '有必须改的项'}**`, '', '## 发现', '']
    if (!r.judgments.length) L.push('（无）')
    for (const j of r.judgments) L.push(`- **${{ high: '必须改', medium: '应该改', low: '说明' }[j.importance]}** [${j.check}] \`${j.target}\`（${j.confidence === 'high' ? '已确认' : '可能'}）\n  - 应该：${j.sides.expected}\n  - 实际：${j.sides.code}\n  - 失败场景：${j.failure}\n  - ${j.reason}`)
    L.push('', '## 干净的角度', '', ...(r.cleanAngles.length ? r.cleanAngles.map((a) => `- ${a}`) : ['（无）']), '', '## 盲区', '', ...r.blindSpots.map((b) => `- ${b}`), '')
    fs.writeFileSync(reportMd, L.join('\n'))
  }
  console.log(`pre-pr ${mode}：发现 ${(r.judgments ?? []).length}（必须改 ${must}），干净角度 ${(r.cleanAngles ?? []).length}${problems.length ? `；形状问题 ${problems.length}：` : ` → ${r.conclusion === 'clean' ? '干净' : '有必须改的项'}`}`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  process.exit(problems.length ? 1 : 0)
}
