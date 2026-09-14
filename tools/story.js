#!/usr/bin/env node
/**
 * 故事切片工具。故事文件：slices/<id>.story.json（schema/story.schema.json）。
 *
 * 用法：
 *   node tools/story.js approve <项目目录> <切片id>            人与团队对故事的业务理解一致：写 approved，把故事的编号顺带并入切片 traces
 *   node tools/story.js serve   <项目目录> [切片id] [--port 4871] [--no-open]
 *                                                         本地页面：/ 框架图（模块 × 故事）；/story?slice=<id> 走故事 + 裁定卡；/glossary 名词目录
 *   node tools/story.js apply   <项目目录> <切片id>            把裁定卡写进 raw/rulings.md 与切片 log；算出回流
 *   node tools/story.js usage   <项目目录> <切片id> propose <R-001,R-002 | --none>
 *                                                         业务分析按五问补完语句后，开发指挥登记本故事新增的编号（--none = 本故事没有新增）
 *   node tools/story.js usage   <项目目录> <切片id> confirm    人确认后：编号并入故事与切片的 traces，建模可以开始
 *   node tools/story.js state   <项目目录> <切片id> [--json]   故事走到哪（切片驱动也用它）
 *
 * 退出码：0 正常；2 用法或前置错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const id = args[2] && !args[2].startsWith('--') ? args[2] : undefined
const today = new Date().toISOString().slice(0, 10)

function die(msg) {
  console.error(msg)
  process.exit(2)
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n')
}
function storyPath(sliceId) {
  return path.join(root, 'slices', `${sliceId}.story.json`)
}
function slicePath(sliceId) {
  return path.join(root, 'slices', `${sliceId}.json`)
}
/** 故事文件此刻的样子，取个指纹当版本号：页面拿走时记下，保存时带回来核对，防止盖掉别人后来的改动 */
function storyRev(sliceId) {
  const f = storyPath(sliceId)
  if (!f || !fs.existsSync(f)) return null
  return require('node:crypto').createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12)
}

/** 这张卡是不是已经作废：争点被后来的裁定推翻了，裁定写的是「作废」而不是某个选项 */
function voided(c) {
  return c.ruling?.choice === '作废' || /^本卡作废/.test(c.ruling?.note ?? '')
}
/** 故事走到哪。顺序就是切片周期里的顺序。 */
function storyState(story) {
  if (story.basedOn && (!story.adds || /^（.*）$/.test(story.adds.trim()))) return { state: 'adds-missing', count: 1 }
  if (!story.steps.length) return { state: 'no-steps' }
  const challenged = story.steps.filter((s) => s.review?.verdict === 'challenge').length
  if (challenged) return { state: 'challenged', count: challenged }
  const notes = story.steps.filter((s) => s.review?.note && !s.review.handled).length + (story.note && !story.noteHandled ? 1 : 0)
  if (notes) return { state: 'notes', count: notes }
  if (!story.approved) return { state: 'unapproved' }
  // 理解一致之后、建模之前：业务分析按五问（同时 / 重复 / 一次几条 / 失败处置 / 可见性）补出本段还缺的情形，人确认
  if (!story.usage?.confirmedAt) return story.usage?.proposedAt ? { state: 'usage-proposed', count: (story.usage.proposed ?? []).length } : { state: 'usage-pending' }
  const noWalk = story.steps.filter((s) => !s.walk)
  if (noWalk.length) return { state: 'no-walk', count: noWalk.length }
  const hasQuiz = story.steps.some((s) => s.quiz)
  if (!hasQuiz) return { state: 'no-quiz' }
  const pendingQuiz = story.steps.filter((s) => s.quiz && !s.human).length
  const pendingChoice = story.choices.filter((c) => !c.ruling).length
  if (pendingQuiz || pendingChoice) return { state: 'awaiting-human', quiz: pendingQuiz, choices: pendingChoice }
  const unapplied = story.choices.filter((c) => c.ruling && !c.applied).length
  if (unapplied) return { state: 'unapplied', count: unapplied }
  const rework = story.choices.filter((c) => c.ruling && !voided(c) && c.ruling.choice !== c.current)
  const gaps = story.steps.filter((s) => s.walk?.gap)
  if (rework.length || gaps.length) return { state: 'rework', rework: rework.length, gaps: gaps.length }
  const wrong = story.steps.filter((s) => s.human && !s.human.correct).length
  return { state: 'done', wrong }
}
module.exports = { storyState }

if (require.main !== module) return

if (!cmd || !root || !fs.existsSync(path.join(root, 'project.json')) || (!id && cmd !== 'serve')) {
  die('用法：node tools/story.js <approve|apply|state> <项目目录> <切片id> | serve <项目目录> [切片id]')
}
if (id && !fs.existsSync(storyPath(id))) die(`故事不存在：${path.relative(process.cwd(), storyPath(id))}`)
const story = id ? readJson(storyPath(id)) : null

// ---------- state ----------
if (cmd === 'state') {
  const s = storyState(story)
  if (args.includes('--json')) console.log(JSON.stringify(s))
  else console.log(`${id}「${story.title}」：${s.state}${Object.entries(s).filter(([k]) => k !== 'state').map(([k, v]) => ` ${k}=${v}`).join('')}`)
}

// ---------- approve ----------
if (cmd === 'approve') {
  if (!story.steps.length) die('故事还没有步骤，谈不上理解一致')
  const slice = readJson(slicePath(id))
  const ids = new Set([...story.traces, ...story.steps.flatMap((s) => s.traces)])
  story.traces = [...ids].sort()
  story.approved = story.approved || today
  slice.traces = [...new Set([...slice.traces, ...ids])].sort()
  slice.log.push({ ts: today, stage: 'slice', text: `业务理解一致：故事「${story.title}」${story.steps.length} 步全部同意，${ids.size} 条编号顺带成为切片范围` })
  writeJson(storyPath(id), story)
  writeJson(slicePath(id), slice)
  console.log(`业务理解一致：${story.steps.length} 步，${ids.size} 条编号已并入 ${id} 的 traces`)
}

/** 人确认五问补出的语句：并进故事与切片的 traces，记两处日志。命令行与「走故事」页面共用 */
function confirmUsage(sliceId, via) {
  const sp = storyPath(sliceId)
  if (!sp || !fs.existsSync(sp)) return { ok: false, error: `没有这条故事：${sliceId}` }
  const st = readJson(sp)
  if (!st.approved) return { ok: false, error: '故事还没有理解一致（approve）' }
  if (!st.usage?.proposedAt) return { ok: false, error: '业务分析还没登记本故事按五问补出的语句（story usage … propose）' }
  if (st.usage.confirmedAt) return { ok: false, error: `这条故事的五问语句已经在 ${st.usage.confirmedAt} 确认过了` }
  const slice = readJson(slicePath(sliceId))
  const ids = st.usage.proposed ?? []
  st.usage.confirmedAt = today
  st.usage.confirmedVia = via ?? '命令行'
  st.traces = [...new Set([...st.traces, ...ids])].sort()
  slice.traces = [...new Set([...slice.traces, ...ids])].sort()
  slice.log.push({ ts: today, stage: 'slice', text: `人确认了本故事按五问补出的语句：${ids.length ? ids.join('、') : '无新增'}${ids.length ? '；已并入切片 traces，模型必须回应它们' : ''}` })
  st.log = [...(st.log ?? []), `${today} 人确认五问补出的语句 ${ids.length} 条（${via ?? '命令行'}）`]
  writeJson(sp, st)
  writeJson(slicePath(sliceId), slice)
  return { ok: true, ids, message: `五问补出的语句已确认 ${ids.length} 条；${ids.length ? '已并入 ' + sliceId + ' 的 traces；' : ''}下一步：模型师建模` }
}

// ---------- usage：五问补出的语句按故事登记（编号不限字母；U 已停发，只为老项目保留） ----------
if (cmd === 'usage') {
  const sub = args[3]
  // 第八十九批：五问与点亮同一趟做，人在走故事页一坐确认——propose 不等 approve；confirm 仍要先理解一致
  if (sub === 'confirm' && !story.approved) die('故事还没有理解一致（approve），五问语句的确认等理解一致之后')
  if (sub === 'propose') {
    const none = args.includes('--none')
    const ids = none ? [] : (args[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!none && !ids.length) die('用法：story usage <项目目录> <切片id> propose <R-001,R-002 | --none>')
    if (ids.some((x) => !/^[GRU]-\d{3,}$/.test(x))) die(`编号形如 R-001：${ids.join('、')}`)
    const { loadBusiness } = require('./lib/project')
    const known = new Set(loadBusiness(root).map((s) => s.id))
    const missing = ids.filter((x) => !known.has(x))
    if (missing.length) die(`这些编号在 business/ 里不存在（业务分析要先写进语句）：${missing.join('、')}`)
    story.usage = { proposed: ids, proposedAt: today, confirmedAt: null }
    story.log = [...(story.log ?? []), `${today} 业务分析按五问补语句：${ids.length ? ids.join('、') : '无新增'}`]
    writeJson(storyPath(id), story)
    console.log(`已登记本故事按五问补出的语句 ${ids.length} 条${ids.length ? '：' + ids.join('、') : '（无新增）'}；下一步：人确认（story usage ${id} confirm）`)
  } else if (sub === 'confirm') {
    const r = confirmUsage(id, '命令行')
    if (!r.ok) die(r.error)
    console.log(r.message)
  } else die('用法：story usage <项目目录> <切片id> propose <R-001,… | --none> | confirm')
}

// ---------- apply ----------
if (cmd === 'apply') {
  const slice = readJson(slicePath(id))
  const rulingsFile = path.join(root, 'raw', 'rulings.md')
  const pending = story.choices.filter((c) => c.ruling && !c.applied)
  const rework = []
  if (pending.length) {
    const lines = [`\n## ${today}（故事切片 ${id}「${story.title}」的裁定卡）\n`, '| 事项 | 裁定 |', '|---|---|']
    for (const c of pending) {
      const opt = c.options.find((o) => o.key === c.ruling.choice)
      const changed = !voided(c) && c.ruling.choice !== c.current
      lines.push(`| ${c.question} | ${c.ruling.previous ? `**改判**（原 ${c.ruling.previous}）→ ` : ''}**${c.ruling.choice}**：${opt?.text ?? ''}${c.ruling.note ? `（${c.ruling.note}）` : ''}${voided(c) ? ' — 本卡作废，争点已不存在' : changed ? ' — 与模型现状不同，回流模型师' : ' — 与模型现状一致'} |`)
      if (changed) rework.push(`${c.id} ${c.question}：改为「${c.ruling.choice}」${opt ? '（' + opt.text + '）' : ''}${c.ruling.note ? '——' + c.ruling.note : ''}`)
      c.applied = true
    }
    fs.appendFileSync(rulingsFile, lines.join('\n') + '\n')
  }
  // 人同意的步骤：它依据的业务语句算「已在这条故事里被人确认」，记到 business/_confirmed.json（不是语句，解析器不读）
  const confirmedP = path.join(root, 'business', '_confirmed.json')
  const confirmed = fs.existsSync(confirmedP) ? readJson(confirmedP) : {}
  let newlyConfirmed = 0
  for (const s of story.steps.filter((x) => x.review?.verdict === 'agree')) {
    for (const tid of (s.review.confirmed ?? s.traces)) {
      confirmed[tid] = confirmed[tid] ?? []
      if (!confirmed[tid].some((c) => c.slice === id && c.step === s.n)) {
        confirmed[tid].push({ slice: id, story: story.title, step: s.n, at: s.review.at.slice(0, 10), ...(s.review.note ? { note: s.review.note } : {}) })
        newlyConfirmed++
      }
    }
  }
  if (newlyConfirmed) writeJson(confirmedP, Object.fromEntries(Object.entries(confirmed).sort()))
  const challenges = story.steps.filter((s) => s.review?.verdict === 'challenge')
  const wrong = story.steps.filter((s) => s.human && !s.human.correct)
  const gaps = story.steps.filter((s) => s.walk?.gap).map((s) => `第 ${s.n} 步：${s.walk.gap}`)
  slice.log.push({ ts: today, stage: 'model', text: `故事裁定卡写回：${pending.length} 条，回流 ${rework.length} 项；预测 ${story.steps.filter((s) => s.human).length} 题，错 ${wrong.length} 题${gaps.length ? `；走不通 ${gaps.length} 处` : ''}` })
  for (const r of rework) slice.log.push({ ts: today, stage: 'model', text: `回流：${r}` })
  for (const s of challenges) slice.log.push({ ts: today, stage: 'slice', text: `质疑：第 ${s.n} 步（${s.traces.join('、')}）——${s.review.note ?? ''}` })
  const notes = story.steps.filter((x) => x.review?.note && !x.review.handled)
  for (const s of notes.filter((x) => x.review.verdict === 'agree')) slice.log.push({ ts: today, stage: 'slice', text: `想法：第 ${s.n} 步（${s.traces.join('、')}）——${s.review.note}` })
  for (const s of notes) s.review.handled = true
  if (story.note && !story.noteHandled) { slice.log.push({ ts: today, stage: 'slice', text: `整条故事的想法：${story.note}` }); story.noteHandled = true }
  if (newlyConfirmed) slice.log.push({ ts: today, stage: 'slice', text: `人确认了 ${newlyConfirmed} 条语句在本故事中的用法（business/_confirmed.json）` })
  for (const g of gaps) slice.log.push({ ts: today, stage: 'model', text: `走不通：${g}` })
  for (const s of wrong) slice.log.push({ ts: today, stage: 'model', text: `预测错：第 ${s.n} 步「${s.quiz.ask}」人答 ${s.human.answer}，模型 ${s.quiz.answer}${s.human.note ? '——' + s.human.note : ''}` })
  story.log = [...(story.log ?? []), `${today} 写回 ${pending.length} 条裁定，回流 ${rework.length}`]
  writeJson(storyPath(id), story)
  writeJson(slicePath(id), slice)
  console.log(`已写回 ${pending.length} 条裁定到 raw/rulings.md；回流 ${rework.length} 项；质疑 ${challenges.length} 步；确认语句 ${newlyConfirmed} 条；预测错 ${wrong.length} 题；走不通 ${gaps.length} 处`)
  for (const s of challenges) console.log(`  质疑：第 ${s.n} 步——${s.review.note ?? ''}`)
  for (const s of notes.filter((x) => x.review.verdict === 'agree')) console.log(`  想法：第 ${s.n} 步——${s.review.note}`)
  if (story.note) console.log(`  整条故事：${story.note}`)
  for (const r of rework) console.log(`  回流：${r}`)
  for (const g of gaps) console.log(`  走不通：${g}`)
}

// ---------- serve ----------
if (cmd === 'serve') {
  const portIdx = args.indexOf('--port')
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4871
  const CSS = `
  :root { --fg:#1f2328; --muted:#57606a; --line:#e6e8eb; --bg:#fff; --lo:#f6f8fa; --ok:#1a7f37; --bad:#cf222e; --walk:#eef4ff; --gap:#fff1f0; --rec:#fff8e1; --biz:#f3f7ee; }
  body { margin:0; font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color:var(--fg); background:var(--bg); }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid var(--line); padding:10px 20px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; z-index:3; }
  #rail { flex-basis:100%; display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
  #rail:empty { display:none; }
  #rail a { display:inline-flex; align-items:center; gap:3px; min-width:24px; height:24px; padding:0 7px; border:1px solid var(--line); border-radius:6px; font-size:12px; text-decoration:none; color:var(--muted); background:#fff; }
  #rail a.done { background:#dcfce7; border-color:#9ccc9c; color:#166534; }
  #rail a.todo { background:#fff7e6; border-color:#f2c57c; color:#8a5a00; }
  #rail a.challenge { background:#ffe9e9; border-color:#e5a0a0; color:#a40e26; }
  #rail a.old { opacity:.55; }
  #rail a i { font-style:normal; font-size:10px; }
  #rail .lab { font-size:12px; color:var(--muted); margin-right:2px; }
  #rail button.fold { height:24px; padding:0 8px; font-size:12px; margin-left:6px; }
  .todo { background:#fff7e6; border:1px solid #f2c57c; border-radius:8px; padding:9px 11px; margin-bottom:12px; font-size:13px; }
  .todo.clear { background:#f0fbf2; border-color:#9ccc9c; }
  .todo b { display:block; margin-bottom:5px; }
  .todo a { display:block; color:#0969da; text-decoration:none; padding:2px 0; border-top:1px solid rgba(0,0,0,.06); }
  .todo a:first-of-type { border-top:0; }
  .todo a:hover { text-decoration:underline; }
  .todo .why { color:var(--muted); }
  header h1 { font-size:16px; margin:0; flex:1; }
  #segs { position:sticky; top:43px; z-index:2; background:var(--lo); border-bottom:1px solid var(--line); padding:5px 20px; font-size:12px; }
  #segs .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:2px 0; opacity:.55; }
  #segs .row.here { opacity:1; }
  #segs .row .chain { min-width:190px; }
  #segs .chain { color:var(--muted); margin-right:4px; }
  #segs a { display:inline-flex; gap:6px; align-items:baseline; text-decoration:none; color:var(--fg); background:#fff; border:1px solid #d0d7de; border-radius:999px; padding:3px 11px; }
  #segs a:hover { border-color:#1f6feb; }
  #segs a.on { border-color:#1f6feb; background:#eef4ff; font-weight:600; }
  #segs a .d { color:var(--muted); font-weight:400; font-size:11px; }
  #segs .arrow { color:#9ca3af; }
  header a { color:#0969da; font-size:13px; }
  button { font:inherit; padding:6px 14px; border:1px solid #d0d7de; border-radius:6px; background:#f6f8fa; cursor:pointer; }
  button.primary { background:#1f6feb; color:#fff; border-color:#1f6feb; }
  button:disabled { opacity:.5; cursor:default; }
  main { display:grid; grid-template-columns: minmax(0, 1fr) 380px; gap:20px; padding:16px 20px 80px; align-items:start; }
  main.one { grid-template-columns: minmax(0, 1fr); max-width:1000px; }
  aside { position:sticky; top:96px; max-height: calc(100vh - 112px); overflow:auto; padding-right:4px; }
  .step, .choice { scroll-margin-top:104px; }
  .flash { outline:2px solid #f59e0b; outline-offset:2px; }
  .step .head { cursor:pointer; user-select:none; }
  .step .head .fold { color:var(--muted); font-size:11px; width:12px; }
  .step .head .sum { font-size:12px; color:var(--muted); margin-left:8px; }
  .step .head .sum.todo-sum { color:#8a5a00; }
  .step.collapsed .body { display:none; }
  .step.collapsed { padding:8px 14px; }
  .persona { background:var(--lo); border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:12px; }
  .lineage { margin-top:6px; font-size:13px; } .lineage b { color:#1f6feb; }
  .prev { margin-top:8px; background:#fff; border:1px solid var(--line); border-left:3px solid #1f6feb; border-radius:6px; padding:8px 11px; font-size:13px; }
  .prev .t { color:var(--muted); font-weight:600; font-size:12px; margin-bottom:3px; }
  .prev.leads { border-left-color:#8250df; margin-top:14px; }
  .usage { margin:22px 0 10px; border:1px solid #86efac; background:#f0fdf4; border-radius:10px; padding:14px 18px; }
  .usage.done { border-color:#d1d5db; background:#f9fafb; }
  .usage .t { font-weight:600; margin-bottom:6px; }
  .usage .ok { color:#15803d; font-weight:400; font-size:13px; }
  .usage .wait { color:#b45309; font-weight:400; font-size:13px; }
  .usage .u-item { padding:8px 0; border-top:1px dashed #d1d5db; }
  .usage .u-item b { color:#065f46; }
  .usage .u-act { margin-top:12px; display:flex; gap:12px; align-items:center; }
  .usage button { background:#16a34a; color:#fff; border:0; border-radius:8px; padding:7px 18px; font:600 14px inherit; cursor:pointer; }
  .usage button:disabled { opacity:.45; cursor:default; }
  .badge { font-size:11px; border-radius:6px; padding:1px 6px; margin-left:auto; } .badge.new { background:#dcfce7; color:#166534; } .badge.old { background:#f3f4f6; color:#6b7280; }
  .step.old-step { opacity:.82; }
  h2 { font-size:15px; margin:18px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  h2:first-child { margin-top:0; }
  .step { border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:10px 0; }
  .step.agree { border-color:#9ccc9c; } .step.challenge { border-color:#e5a0a0; }
  .step .head { display:flex; gap:10px; align-items:baseline; }
  .step .n { font-weight:700; color:var(--muted); }
  .step .day { color:var(--muted); font-size:12px; }
  .step .actor { font-weight:600; }
  .step .text { margin:6px 0; }
  a.term { color:inherit; text-decoration:none; border-bottom:1px dotted #0969da; }
  a.term:hover { color:#0969da; }
  .biz { background:var(--biz); border-radius:6px; padding:8px 10px; margin-top:8px; font-size:13px; }
  .biz .t { color:var(--muted); font-weight:600; font-size:12px; margin-bottom:4px; display:flex; justify-content:space-between; }
  .biz label.s { display:grid; grid-template-columns: 18px 56px 1fr; gap:6px; padding:3px 0; cursor:pointer; align-items:start; }
  .biz label.s.on { color:#1a7f37; }
  .biz .seen { margin-top:6px; border-top:1px dashed #cbd8bd; padding-top:5px; }
  .biz .seen .bar { display:flex; gap:8px; align-items:center; color:var(--muted); font-size:12px; cursor:pointer; }
  .biz .seen .bar button { font-size:11px; padding:2px 8px; }
  .biz .seen.shut .body { display:none; }
  .biz .seen label.s .where { color:var(--muted); font-size:11px; }
  .cnote-kept { font-size:12px; color:#1a7f37; margin-top:3px; }
  .walk .dup { color:#9aa4b0; }
  .walk .dup em { font-style:normal; font-size:11px; color:#9aa4b0; }
  .biz code { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:#0969da; }
  .biz .kind { color:var(--muted); }
  .quiz { margin-top:8px; padding:8px 10px; border:1px dashed #d0d7de; border-radius:6px; }
  .quiz .ask { font-weight:600; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px; }
  input[type=text], select, textarea { font:inherit; padding:4px 6px; border:1px solid #d0d7de; border-radius:4px; }
  textarea { width:100%; box-sizing:border-box; min-height:52px; resize:vertical; }
  .verdict { font-weight:600; } .verdict.ok { color:var(--ok); } .verdict.bad { color:var(--bad); }
  .facts { display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:8px; }
  .fact { display:flex; flex-direction:column; min-width:140px; }
  .fact b { font-size:11px; color:var(--muted); font-weight:500; }
  .fact .bar { height:6px; background:#dbe4ff; border-radius:3px; margin-top:3px; overflow:hidden; }
  .fact .bar i { display:block; height:100%; background:#1f6feb; }
  .walk { background:var(--walk); border-radius:6px; padding:8px 10px; margin-top:8px; font-size:13px; }
  .walk.gap { background:var(--gap); }
  .walk .k { color:var(--muted); }
  .walk ol { margin:2px 0 4px 0; padding-left:22px; } .walk li { margin:2px 0; }
  .walk code { font-family: ui-monospace, Consolas, monospace; font-size:12px; }
  .review { margin-top:10px; border-top:1px dashed var(--line); padding-top:8px; }
  .review .btns { display:flex; gap:8px; margin-bottom:6px; align-items:center; }
  .review button.on.agree { background:#dcf5dc; border-color:#9ccc9c; }
  .review button.on.challenge { background:#fde2e2; border-color:#e5a0a0; }
  .choice { border:1px solid #d0d7de; border-left:4px solid #f59e0b; border-radius:8px; padding:10px 12px; margin:10px 0; background:#fffdf7; }
  .choice.ruled { border-left-color:#1f6feb; background:#fff; }
  .choice .q { font-weight:600; margin-bottom:4px; }
  .choice .ctx { color:var(--muted); font-size:12px; margin-bottom:6px; white-space:pre-wrap; }
  /* 编号那一栏跟着编号本身宽窄走：写死 22 宽时，长一点的编号会压在选项文字上（2026-09-13 项目所有者截图点名） */
  .opt { display:grid; grid-template-columns: minmax(22px, max-content) 1fr; gap:4px 8px; padding:6px 8px; border:1px solid transparent; border-radius:6px; margin:4px 0; cursor:pointer; font-size:13px; }
  .opt:hover { background:var(--lo); }
  .opt.sel { border-color:#1f6feb; background:#eef4ff; }
  .opt .key { font-weight:700; white-space:nowrap; }
  .opt .cons { color:var(--muted); font-size:12px; grid-column:2; white-space:pre-wrap; }
  .opt .tag { margin-left:6px; }
  .tag { display:inline-block; font-size:11px; padding:0 6px; border-radius:10px; border:1px solid #d0d7de; color:var(--muted); margin-left:6px; }
  .tag.rec { background:var(--rec); } .tag.cur { background:var(--lo); }
  .gaps li { font-size:13px; margin:6px 0; } .gaps label { white-space:nowrap; color:#166534; font-weight:600; }
  #status { color:var(--muted); font-size:12px; }
  .summary { color:var(--muted); font-size:13px; }
  .hint { color:var(--muted); font-size:12px; }
  .term-card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; }
  .term-card:target { outline:2px solid #f59e0b; }
  .term-card .nm { font-weight:700; }
  .term-card .al { color:var(--muted); font-size:12px; }
  .term-card .df { margin:4px 0; }
  .term-card .notes { font-size:13px; margin-top:6px; background:#fff8e1; border-left:4px solid #f59e0b; border-radius:4px; padding:6px 10px; }
  .term-card .notes b { color:#b45309; }
  .term-card .notes .n { margin:2px 0; }
  .term-card.has-notes { border-color:#f59e0b; }
  .dd { position:relative; }
  .dd > button { background:#fff8e1; border-color:#f59e0b; color:#b45309; }
  .dd .menu { display:none; position:absolute; right:0; top:36px; background:#fff; border:1px solid #f59e0b; border-radius:8px; box-shadow:0 4px 14px rgba(0,0,0,.1); min-width:260px; max-height:60vh; overflow:auto; padding:6px 0; z-index:5; }
  .dd.open .menu { display:block; }
  .dd .menu a { display:block; padding:6px 14px; color:#1f2328; text-decoration:none; font-size:13px; }
  .dd .menu a:hover { background:#fff8e1; }
  .dd .menu a small { color:var(--muted); }
  .toc { column-count:3; column-gap:16px; font-size:13px; margin-bottom:12px; }
  .toc a { display:block; color:#0969da; text-decoration:none; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } aside { position:static; max-height:none; } .toc { column-count:1; } }
  `
  const SHARED_JS = `
const $ = (s, p=document) => p.querySelector(s)
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
let termRe = null, termOf = {}
function buildTerms(glossary) {
  const pairs = []
  for (const t of glossary) for (const a of [t.name, ...(t.aliases||[])]) if (a && a.length >= 2) { pairs.push(a); termOf[a] = t.name }
  pairs.sort((a, b) => b.length - a.length)
  termRe = pairs.length ? new RegExp(pairs.map(a => a.replace(/[.*+?^\${}()|[\\]\\\\/]/g, '\\\\$&')).join('|'), 'g') : null
}
function linkTerms(text) {
  const e = esc(text)
  if (!termRe) return e
  return e.replace(termRe, m => '<a class="term" href="/glossary#' + encodeURIComponent(termOf[m]) + '" target="glossary" title="' + esc(termOf[m]) + '">' + m + '</a>')
}
`
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>走故事</title><style>${CSS}</style></head>
<body>
<header><a href="/">← 框架图</a><h1 id="title">走故事</h1><a href="/board" target="board">谁在做什么 ↗</a><a href="/glossary" target="glossary">名词目录 ↗</a><a href="/model" target="model">模型图 ↗</a><span id="status"></span><button id="approve">业务理解一致</button><button id="save" class="primary">保存</button><div id="rail"></div></header>
<nav id="segs"></nav>
<main><section id="story"></section><aside id="side"></aside></main>
<script>
${SHARED_JS}
let data = null, biz = {}
let revealed = {}
let collapsed = {}, collapsedInit = false
function fmt(v) { return typeof v === 'number' ? (Number.isInteger(v) && Math.abs(v) < 1000 ? String(v) : v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : esc(v) }
function numEq(a, b) { const x = Number(String(a).replace(/[,$\\s]/g,'')), y = Number(String(b).replace(/[,$\\s]/g,'')); return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x-y) < 0.005 }
function isCorrect(q, ans) { return q.kind === 'number' ? numEq(ans, q.answer) : String(ans).trim() === String(q.answer).trim() }
function maxFact(label) { let m = 0; for (const s of data.steps) { const v = s.facts?.[label]; if (typeof v === 'number' && v > m) m = v } return m }
function confirmedSet(s) { return new Set(s.review?.confirmed ?? []) }
function bizLine(s, i, id, seenAt) {
  const b = biz[id]
  const on = confirmedSet(s).has(id)
  const body = b ? (b.label ? '<span class="kind">(' + esc(b.label) + ') </span>' : '') + linkTerms(b.text) : '<span class="kind">（业务描述里找不到这条）</span>'
  const where = seenAt ? '<span class="where">第 ' + seenAt + ' 步已看过</span> ' : ''
  return '<label class="s' + (on ? ' on' : '') + '"><input type="checkbox" data-conf="' + i + '" data-id="' + esc(id) + '"' + (on ? ' checked' : '') + '><code>' + esc(id) + '</code><span>' + where + body + '</span></label>'
}
/** 每个编号头一次出现在第几步；同一条语句在后面的步骤里只是又用到一次，不必重读 */
function firstSeen() {
  const at = {}
  for (const s of data.steps) for (const id of s.traces || []) if (at[id] == null) at[id] = s.n
  return at
}
function stepComplete(s) { const c = confirmedSet(s); return s.review?.verdict === 'agree' && (s.traces||[]).every(t => c.has(t)) }
/** 这一步还差什么：一句话一件事，索引、步骤条与折叠摘要都用它 */
function stepTodo(s) {
  const out = []
  const c = confirmedSet(s)
  const miss = (s.traces || []).filter(t => !c.has(t))
  if (miss.length) out.push({ kind: 'biz', text: miss.length + ' 条语句没勾（' + miss.join('、') + '）' })
  if (s.quiz && !s.human) out.push({ kind: 'quiz', text: '一道题没答' })
  const cards = data.choices.filter(x => x.step === s.n && !x.ruling)
  if (cards.length) out.push({ kind: 'card', text: cards.length + ' 张卡没裁（' + cards.map(x => x.id).join('、') + '）' })
  if (!s.review) out.push({ kind: 'review', text: '这一步没审过' })
  else if (s.review.verdict === 'challenge') out.push({ kind: 'challenge', text: '你在这里留了质疑' })
  return out
}
function jump(sel) {
  const el = document.querySelector(sel)
  if (!el) return
  const host = el.closest('.step')
  if (host?.classList.contains('collapsed')) { collapsed[Number(host.dataset.i)] = false; host.classList.remove('collapsed') }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1600)
}
/** 五问补出的语句：业务分析登记了、等人确认的那几条。原来只能在命令行确认，人在页面上找不到（2026-09-13 他点名） */
function usageBlock() {
  const u = data.usage
  if (!u || !u.proposedAt) return ''
  const ids = u.proposed || []
  const done = !!u.confirmedAt
  let h = '<div class="usage' + (done ? ' done' : '') + '"><div class="t">五问补出的语句' + (done ? '　<span class="ok">已确认 ' + esc(u.confirmedAt) + '</span>' : '　<span class="wait">等你确认</span>') + '</div>'
  h += '<p class="summary">走完故事之后，业务分析把这一段还会碰上的情形补成了语句：会不会同时、会不会重复、一次几条与半路没做完、失败了怎么处置、谁能看见。这里只说业务上可能碰上什么，软件怎么回应由模型师定。确认之后这些编号并进本段，模型必须一一回应。</p>'
  if (!ids.length) h += '<p class="summary">这一段没有新增。</p>'
  for (const id of ids) {
    const b = (typeof biz !== 'undefined' ? biz : {})[id] || {}
    h += '<div class="u-item"><b>' + esc(id) + '</b>' + (b.label ? ' <span class="tag">' + esc(b.label) + '</span>' : '') + '<div>' + linkTerms(b.text || '（这条语句在 business/ 里找不到）') + '</div></div>'
  }
  if (!done) h += '<div class="u-act"><button id="u-ok">这几条我确认</button><span class="hint" id="u-msg">确认之后编号并进本段，校验会要求模型给它们落点</span></div>'
  return h + '</div>'
}
function wireUsage() {
  const b = document.getElementById('u-ok')
  if (!b) return
  b.addEventListener('click', async function () {
    b.disabled = true
    const msg = document.getElementById('u-msg')
    msg.textContent = '记上…'
    try {
      const r = await (await fetch('/usage-confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slice: data.slice }) })).json()
      if (!r.ok) { msg.textContent = '没确认上：' + (r.error || '不知道为什么'); b.disabled = false; return }
      await load()
    } catch (e) { msg.textContent = '没确认上：' + e.message; b.disabled = false }
  })
}

function renderRail() {
  const st = data.steps
  let h = '<span class="lab">跳到：</span>'
  st.forEach(s => {
    const td = stepTodo(s)
    const bad = s.review?.verdict === 'challenge'
    const cls = bad ? 'challenge' : (td.length ? 'todo' : 'done')
    const tip = '第 ' + s.n + ' 步　' + s.day + '　' + s.actor + (td.length ? '　还差：' + td.map(x => x.text).join('；') : '　已过')
    h += '<a href="#step-' + s.n + '" class="' + cls + (inherited(s) ? ' old' : '') + '" title="' + esc(tip) + '" data-go="#step-' + s.n + '">' + s.n + (td.length ? '<i>●</i>' : '') + '</a>'
  })
  const loose = data.choices.filter(c => !c.step || !st.some(s => s.n === c.step))
  const looseOpen = loose.filter(c => !c.ruling)
  if (looseOpen.length) h += '<a href="#card-' + esc(looseOpen[0].id) + '" class="todo" title="' + esc('不挂在某一步上的卡还有 ' + looseOpen.length + ' 张没裁') + '" data-go="#card-' + esc(looseOpen[0].id) + '">卡<i>●</i></a>'
  const shut = data.steps.every((s, i) => collapsed[i])
  h += '<button class="fold" id="foldall">' + (shut ? '全部展开' : '全部收起') + '</button>'
  $('#rail').innerHTML = h
}
function renderTodo() {
  const st = data.steps
  const rows = []
  st.forEach(s => { for (const td of stepTodo(s)) rows.push({ href: '#step-' + s.n, label: '第 ' + s.n + ' 步', why: td.text, kind: td.kind }) })
  for (const c of data.choices) {
    if (c.ruling) continue
    if (c.step && st.some(s => s.n === c.step)) continue
    rows.push({ href: '#card-' + c.id, label: '裁定 ' + c.id, why: '没裁（不挂在某一步上）', kind: 'card' })
  }
  const order = { quiz: 0, card: 1, biz: 2, review: 3, challenge: 4 }
  rows.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
  if (!rows.length) return '<div class="todo clear"><b>都走完了</b>每一步都勾全并审过，题答了，卡裁了。</div>'
  return '<div class="todo"><b>还差 ' + rows.length + ' 处</b>' + rows.map(r => '<a href="' + r.href + '" data-go="' + r.href + '">' + esc(r.label) + '　<span class="why">' + esc(r.why) + '</span></a>').join('') + '</div>'
}
function canApprove() { return data.steps.length && data.steps.every(stepComplete) }
function choiceCard(c, ci) {
  let a = '<div class="choice' + (c.ruling ? ' ruled' : '') + '" id="card-' + esc(c.id) + '"><div class="q">裁定 ' + esc(c.id) + '　' + esc(c.question) + '</div>' + (c.context ? '<div class="ctx">' + esc(c.context) + '</div>' : '')
  for (const o of c.options) {
    const sel = c.ruling?.choice === o.key
    a += '<div class="opt' + (sel ? ' sel' : '') + '" data-c="' + ci + '" data-k="' + esc(o.key) + '"><span class="key">' + esc(o.key) + '</span><span>' + esc(o.text) + (o.key === c.recommended ? '<span class="tag rec">推荐</span>' : '') + (o.key === c.current ? '<span class="tag cur">模型现状</span>' : '') + '</span>' + (o.consequence ? '<span class="cons">' + esc(o.consequence) + '</span>' : '') + '</div>'
  }
  a += '<div class="row"><input type="text" style="flex:1" data-cnote="' + ci + '" placeholder="理由或补充（可空；还没裁也存得住）" value="' + esc(c.ruling?.note ?? c.note ?? '') + '"></div>' + (!c.ruling && c.note ? '<div class="cnote-kept">这段话已经存下来了，等你裁定时并进裁定备注</div>' : '') + '</div>'
  return a
}
function bindRail() {
  document.querySelectorAll('#rail [data-go]').forEach(el => el.addEventListener('click', ev => { ev.preventDefault(); jump(el.dataset.go) }))
  const fa = document.getElementById('foldall')
  if (fa) fa.addEventListener('click', () => {
    const shut = data.steps.every((s, i) => collapsed[i])
    data.steps.forEach((s, i) => { collapsed[i] = !shut })
    render()
  })
}
function render() {
  $('#title').textContent = data.title + '（' + data.slice + '）'
  const ab = $('#approve'); ab.textContent = data.approved ? '理解一致 ' + data.approved : '业务理解一致'; ab.disabled = !!data.approved || !canApprove()
  ab.title = data.approved ? '' : '每一步的语句都打了勾、并点了「同意」，才算理解一致；点了之后故事用到的编号顺带成为切片范围'
  const st = data.steps
  if (!collapsedInit) { st.forEach((s, i) => { collapsed[i] = stepTodo(s).length === 0 }); collapsedInit = true }
  const seenAt = firstSeen()
  const walkSeen = {}
  for (const s of st) for (const k of ['asks', 'changes']) for (const x of s.walk?.[k] ?? []) for (const line of String(x).split(/；/).map(y => y.trim()).filter(Boolean)) if (walkSeen[line] == null) walkSeen[line] = s.n
  const done = st.filter(stepComplete).length, challenged = st.filter(s => s.review?.verdict === 'challenge').length
  const answered = st.filter(s => s.human).length, right = st.filter(s => s.human?.correct).length, quizzes = st.filter(s => s.quiz).length
  const ruled = data.choices.filter(c => c.ruling).length
  const total = st.reduce((n, s) => n + (s.traces||[]).length, 0), conf = st.reduce((n, s) => n + confirmedSet(s).size, 0)
  let h = '<div class="persona"><b>' + esc(data.persona.name) + '</b>　' + linkTerms(data.persona.description) + '<div class="summary">已过 ' + done + '/' + st.length + ' 步，语句确认 ' + conf + '/' + total + '，质疑 ' + challenged + (quizzes ? '　·　预测 ' + answered + '/' + quizzes + '，答对 ' + right : '') + '　·　裁定 ' + ruled + '/' + data.choices.length + '</div>' + (data.basedOn ? '<div class="lineage">上一版：<a href="/story?slice=' + esc(data.basedOn) + '">' + esc(data.basedOn) + (base ? '「' + esc(base.title) + '」' : '') + '</a>　这一版加了：<b>' + esc(data.adds || '') + '</b>' + (base ? '　·　新步骤 ' + st.filter(s => !inherited(s)).length + ' 步，老步骤 ' + st.filter(inherited).length + ' 步（灰标）' : '') + '</div>' : '') + (data.previously ? '<div class="prev"><div class="t">前情提要 — 上一版结束时</div>' + linkTerms(data.previously.text) + (data.previously.facts && Object.keys(data.previously.facts).length ? '<div class="facts">' + Object.entries(data.previously.facts).map(([k, v]) => '<div class="fact"><b>' + esc(k) + '</b><span>' + fmt(v) + '</span></div>').join('') + '</div>' : '') + '</div>' : '') + '<div class="hint">每一步下面是它依据的业务语句，看懂一条勾一条；全勾了就是同意这一步。觉得不对点「质疑」写理由。带虚线的词点一下看名词目录。裁定挂在它发生的那一步下面。</div></div>'
  let lock = false
  st.forEach((s, i) => {
    const open = !s.quiz || s.human || revealed[i]
    const old = inherited(s)
    const td = stepTodo(s)
    const shut = !!collapsed[i]
    const cls = 'step' + (s.review ? ' ' + s.review.verdict : '') + (lock ? ' locked' : '') + (old ? ' old-step' : '') + (shut ? ' collapsed' : '')
    const sum = td.length ? '<span class="sum todo-sum">还差：' + esc(td.map(x => x.text).join('；')) + '</span>' : '<span class="sum">已过</span>'
    h += '<div class="' + cls + '" id="step-' + s.n + '" data-i="' + i + '"><div class="head" data-fold="' + i + '"><span class="fold">' + (shut ? '▸' : '▾') + '</span><span class="n">' + s.n + '</span><span class="day">' + esc(s.day) + '</span><span class="actor">' + esc(s.actor) + '</span>' + sum + (base ? '<span class="badge ' + (old ? 'old">上一版已有' : 'new">本版新增') + '</span>' : '') + '</div>'
    h += '<div class="body"><div class="text">' + linkTerms(s.text) + '</div>'
    if (s.traces?.length) {
      const fresh = s.traces.filter(t => seenAt[t] === s.n)
      const again = s.traces.filter(t => seenAt[t] !== s.n)
      const cf = confirmedSet(s)
      const againOn = again.filter(t => cf.has(t)).length
      h += '<div class="biz"><div class="t"><span>业务内容：看懂一条勾一条</span><span>' + cf.size + '/' + s.traces.length + '</span></div>'
      h += fresh.map(t => bizLine(s, i, t)).join('')
      if (again.length) {
        // 全勾过了就收起；还有没勾的，只在这一步另有新语句时才收起（免得整块内容都藏起来）
        const seenShut = againOn === again.length || fresh.length > 0
        h += '<div class="seen' + (seenShut ? ' shut' : '') + '" data-seen="' + i + '"><div class="bar"><span data-seentog="' + i + '">前面看过的 ' + again.length + ' 条（已勾 ' + againOn + '）　▾</span>' + (againOn < again.length ? '<button data-seenall="' + i + '">这几条前面看过，勾上</button>' : '') + '</div><div class="body">' + again.map(t => bizLine(s, i, t, seenAt[t])).join('') + '</div></div>'
      }
      h += '</div>'
    }
    if (s.quiz) {
      h += '<div class="quiz"><div class="ask">先猜：' + esc(s.quiz.ask) + '</div>'
      if (s.human) {
        h += '<div class="row"><span class="verdict ' + (s.human.correct ? 'ok' : 'bad') + '">' + (s.human.correct ? '答对' : '答错') + '</span><span>你答：' + esc(s.human.answer) + '　模型：' + esc(s.quiz.answer) + '</span></div>'
        if (s.quiz.explain) h += '<div>' + linkTerms(s.quiz.explain) + '</div>'
      } else if (!lock) {
        if (s.quiz.kind === 'choice') h += '<div class="row"><select data-ans="' + i + '"><option value="">选一个</option>' + (s.quiz.options||[]).map(o => '<option>' + esc(o) + '</option>').join('') + '</select><button data-reveal="' + i + '">揭晓</button></div>'
        else h += '<div class="row"><input type="text" data-ans="' + i + '" placeholder="' + (s.quiz.kind === 'number' ? '填数字' : '填答案') + '"><button data-reveal="' + i + '">揭晓</button></div>'
      }
      h += '</div>'
    }
    if (open && s.facts && Object.keys(s.facts).length) {
      h += '<div class="facts">' + Object.entries(s.facts).map(([k, v]) => {
        const mx = typeof v === 'number' && v >= 100 ? maxFact(k) : 0
        return '<div class="fact"><b>' + esc(k) + '</b><span>' + fmt(v) + '</span>' + (mx ? '<div class="bar"><i style="width:' + Math.max(2, Math.round(v / mx * 100)) + '%"></i></div>' : '') + '</div>'
      }).join('') + '</div>'
    }
    if (open && s.walk) {
      const w = s.walk
      h += '<div class="walk' + (w.gap ? ' gap' : '') + '">'
      if (w.kind === 'none') h += '<span class="k">模型里没有动作</span>'
      else h += '<span class="k">' + ({command:'命令',query:'查询',event:'事件',time:'时间触发'})[w.kind] + '</span> <code>' + esc(w.name) + '</code>' + (w.aggregate ? ' → <code>' + esc(w.aggregate) + '</code>' : '')
      const lines = (arr) => arr.flatMap(x => String(x).split(/；/).map(s => s.trim()).filter(Boolean))
      const mark = (x) => { const at = walkSeen[x]; return at != null && at !== s.n ? '<span class="dup">' + esc(x) + ' <em>（同第 ' + at + ' 步）</em></span>' : esc(x) }
      const ol = (arr) => { const L = lines(arr); return L.length === 1 ? ' ' + mark(L[0]) : '<ol>' + L.map(x => '<li>' + mark(x) + '</li>').join('') + '</ol>' }
      if (w.asks?.length) h += '<div><span class="k">先问：</span>' + ol(w.asks) + '</div>'
      if (w.changes?.length) h += '<div><span class="k">写入的事实：</span>' + ol(w.changes) + '</div>'
      if (w.emits?.length) h += '<div><span class="k">发出：</span>' + w.emits.map(e => '<code>' + esc(e) + '</code>').join(' ') + '</div>'
      if (w.throws?.length) h += '<div><span class="k">可能拒绝：</span>' + w.throws.map(e => '<code>' + esc(e) + '</code>').join(' ') + '</div>'
      if (w.gap) h += '<div><b>走不通：</b>' + esc(w.gap) + '</div>'
      h += '</div>'
    }
    data.choices.forEach((c, ci) => { if (c.step === s.n) h += choiceCard(c, ci) })
    const rv = s.review?.verdict
    h += '<div class="review"><div class="btns"><button class="agree' + (rv === 'agree' ? ' on' : '') + '" data-rev="agree" data-i="' + i + '">同意（勾全部）</button><button class="challenge' + (rv === 'challenge' ? ' on' : '') + '" data-rev="challenge" data-i="' + i + '">质疑</button>' + (stepComplete(s) ? '<span class="verdict ok">已过</span>' : '') + '</div>'
    h += '<textarea data-rnote="' + i + '" placeholder="' + (rv === 'challenge' ? '质疑的理由（必填）' : '你的想法：哪里不对、哪里没讲清、旧系统是怎么做的……') + '">' + esc(s.review?.note ?? '') + '</textarea></div>'
    h += '</div></div>'
    if (s.quiz && !s.human && !revealed[i]) lock = true
  })
  if (data.leadsTo) h += '<div class="prev leads"><div class="t">往下接什么 — 不在本段展开</div>' + linkTerms(data.leadsTo) + '</div>'
  h += usageBlock()
  $('#story').innerHTML = h
  wireUsage()
  renderRail()
  let a = renderTodo()
  const loose = data.choices.map((c, ci) => [c, ci]).filter(([c]) => !c.step || !st.some(s => s.n === c.step))
  if (loose.length) { a += '<h2>裁定（不挂在某一步上）</h2>'; for (const [c, ci] of loose) a += choiceCard(c, ci) }
  if (data.gaps?.length) a += '<h2>缺口 = 下一版故事的候选</h2><p class="summary">这条主线没走到的怪事，不用在这里答。勾的是「下一版先做哪个」：从这条故事起笔只加那一段，整条重新走通。没勾的不丢，自动跟到下一版的候选栏，一版做一个；勾多个就按顺序排。</p><ul class="gaps">' + data.gaps.map((g, gi) => '<li><label><input type="checkbox" data-gap="' + gi + '"' + ((data.gapPicks || []).includes(gi) ? ' checked' : '') + '> 滚成下一版</label>　' + linkTerms(g) + '</li>').join('') + '</ul>'
  a += '<h2>整条故事的想法</h2><textarea id="note" placeholder="整体上哪里不对、缺了什么、顺序不合理……">' + esc(data.note ?? '') + '</textarea>'
  $('#side').innerHTML = a
  const m = document
  m.querySelectorAll('#side [data-go]').forEach(el => el.addEventListener('click', ev => { ev.preventDefault(); jump(el.dataset.go) }))
  m.querySelectorAll('[data-fold]').forEach(el => el.addEventListener('click', () => {
    const i = Number(el.dataset.fold); collapsed[i] = !collapsed[i]
    const box = el.closest('.step'); box.classList.toggle('collapsed', collapsed[i])
    el.querySelector('.fold').textContent = collapsed[i] ? '▸' : '▾'
    renderRail(); bindRail()
  }))
  bindRail()
  m.querySelectorAll('[data-seentog]').forEach(el => el.addEventListener('click', () => el.closest('.seen').classList.toggle('shut')))
  m.querySelectorAll('[data-seenall]').forEach(b => b.addEventListener('click', () => {
    const s = data.steps[Number(b.dataset.seenall)]
    const box = b.closest('.seen')
    const set = new Set(s.review?.confirmed ?? [])
    box.querySelectorAll('input[data-id]').forEach(cb => set.add(cb.dataset.id))
    s.review = s.review ?? { verdict: 'agree', at: new Date().toISOString() }
    s.review.confirmed = [...set]
    render(); dirty()
  }))
  m.querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.reveal); const s = data.steps[i]
    const inp = m.querySelector('[data-ans="' + i + '"]'); const ans = (inp?.value ?? '').trim()
    if (!ans) return inp?.focus()
    s.human = { answer: ans, correct: isCorrect(s.quiz, ans), at: new Date().toISOString() }
    revealed[i] = true; render(); dirty()
  }))
  m.querySelectorAll('[data-conf]').forEach(cb => cb.addEventListener('change', () => {
    const s = data.steps[Number(cb.dataset.conf)]
    if (!s.review) s.review = { verdict: 'agree', at: new Date().toISOString() }
    const set = confirmedSet(s); cb.checked ? set.add(cb.dataset.id) : set.delete(cb.dataset.id)
    s.review.confirmed = [...set]; if (!s.review.confirmed.length) delete s.review.confirmed
    render(); dirty()
  }))
  m.querySelectorAll('[data-rev]').forEach(b => b.addEventListener('click', () => {
    const s = data.steps[Number(b.dataset.i)]
    const note = s.review?.note, conf = s.review?.confirmed
    s.review = { verdict: b.dataset.rev, at: new Date().toISOString() }
    if (note) s.review.note = note
    if (b.dataset.rev === 'agree') s.review.confirmed = [...(s.traces||[])]
    else if (conf) s.review.confirmed = conf
    render(); dirty()
  }))
  m.querySelectorAll('[data-rnote]').forEach(el => el.addEventListener('input', () => {
    const s = data.steps[Number(el.dataset.rnote)]
    if (!s.review) s.review = { verdict: 'agree', at: new Date().toISOString() }
    s.review.note = el.value; if (!s.review.note) delete s.review.note
    dirty()
  }))
  m.querySelectorAll('.opt').forEach(el => el.addEventListener('click', () => {
    const c = data.choices[Number(el.dataset.c)]
    if (c.ruling && c.ruling.choice === el.dataset.k) return
    if (c.applied && !c.unlocked) { if (!confirm('这张卡的裁定已经写进裁定文件。要改判吗？改判会记成新的一条裁定，原来的保留。')) return; c.unlocked = true }
    const note = c.ruling?.note
    const prev = c.applied ? c.ruling.choice : c.ruling?.previous
    c.ruling = { choice: el.dataset.k, at: new Date().toISOString() }
    if (note) c.ruling.note = note
    if (prev && prev !== el.dataset.k) c.ruling.previous = prev
    if (c.note && !c.ruling.note) { c.ruling.note = c.note; delete c.note }
    c.applied = false; delete c.unlocked; render(); dirty()
  }))
  m.querySelectorAll('[data-cnote]').forEach(el => el.addEventListener('input', () => {
    const c = data.choices[Number(el.dataset.cnote)]
    const v = el.value
    // 还没选甲乙丙也要存得住：先记在卡上，裁定时并进 ruling.note。从前这里直接 return，人写的字会被默默丢掉。
    if (c.ruling) { c.ruling.note = v; if (!v) delete c.ruling.note; delete c.note }
    else { if (v) c.note = v; else delete c.note }
    dirty()
  }))
  $('#note').addEventListener('input', () => { data.note = $('#note').value; if (!data.note) delete data.note; dirty() })
  m.querySelectorAll('[data-gap]').forEach(cb => cb.addEventListener('change', () => { const set = new Set(data.gapPicks || []); cb.checked ? set.add(Number(cb.dataset.gap)) : set.delete(Number(cb.dataset.gap)); data.gapPicks = [...set].sort((x, y) => x - y); if (!data.gapPicks.length) delete data.gapPicks; dirty() }))
}
const SLICE = new URLSearchParams(location.search).get('slice') || ''
let base = null
function renderSegs(segs) {
  const box = $('#segs')
  if (!box) return
  if (!segs || segs.length < 2) { box.style.display = 'none'; return }
  // 按业务故事分行，行内按故事里最早那一天排；没归到链上的（比如走完整条链的老切片）单独一行
  const groups = []
  for (const s of segs) {
    const key = s.businessStory || ''
    let g = groups.find((x) => x.key === key)
    if (!g) { g = { key: key, items: [] }; groups.push(g) }
    g.items.push(s)
  }
  const chip = (s) => {
    const when = s.day ? s.day.slice(5).split('-').join('/') : '待写'
    const on = s.slice === data.slice ? ' on' : ''
    return '<a class="seg' + on + '" href="/story?slice=' + esc(s.slice) + '" title="' + esc(s.intent || '') + '">' + esc(s.title) + '<span class="d">' + when + '·' + s.steps + '步' + (s.approved ? '' : '·待认可') + '</span></a>'
  }
  box.innerHTML = groups.map((g) => {
    const here = g.items.some((s) => s.slice === data.slice)
    const label = g.key ? '业务故事「' + esc(g.key) + '」' : '没归到业务故事链上'
    return '<div class="row' + (here ? ' here' : '') + '"><span class="chain">' + label + '</span>' + g.items.map(chip).join('<span class="arrow">→</span>') + '</div>'
  }).join('')
}
let rev = null
async function load() { const r = await (await fetch('/data?slice=' + SLICE)).json(); if (!r.story) { $('#story').innerHTML = '<p>没有这条故事：' + esc(SLICE) + '</p>'; return } data = r.story; base = r.base; biz = r.business; rev = r.rev; buildTerms(r.glossary); render(); renderSegs(r.segs) }
function inherited(s) { return !!(base && base.texts.includes(s.text)) }
async function save(auto) {
  if (!auto) { const bad = data.steps.filter(s => s.review?.verdict === 'challenge' && !s.review.note); if (bad.length) { alert('第 ' + bad.map(s => s.n).join('、') + ' 步点了质疑但没写理由'); return false } }
  const r = await fetch('/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ ...data, _rev: rev }) })
  if (r.status === 409) {
    const msg = await r.text()
    $('#status').innerHTML = '<b style="color:#cf222e">没保存：' + esc(msg) + '</b>'
    return false
  }
  if (r.ok) { try { const j = await r.json(); if (j.rev) rev = j.rev } catch {} }
  $('#status').textContent = r.ok ? (auto ? '已自动保存 ' : '已保存 ') + new Date().toLocaleTimeString() : '保存失败'
  return r.ok
}
let saveTimer = null
function dirty() { $('#status').textContent = '有改动…'; clearTimeout(saveTimer); saveTimer = setTimeout(() => save(true), 700) }
$('#approve').addEventListener('click', async () => {
  if (data.approved || !canApprove()) return
  if (!confirm('确认：你与团队对这条故事的业务理解一致？（它用到的编号会顺带成为切片的范围）')) return
  data.approved = new Date().toISOString().slice(0,10); render(); await save(false)
})
$('#save').addEventListener('click', () => save(false))
load()
</script></body></html>`
  const glossaryHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>名词目录</title><style>${CSS}</style></head>
<body>
<header><h1>名词目录</h1><a href="/model" target="model">模型图 ↗</a><span id="status"></span><div class="dd" id="dd"><button id="dd-btn">已保存的意见（0）▾</button><div class="menu" id="dd-menu"></div></div><button id="save" class="primary">保存全部</button></header>
<main class="one"><section id="g"></section></main>
<script>
${SHARED_JS}
let terms = [], notes = {}
function render() {
  const sorted = [...terms].sort((a, b) => a.name.localeCompare(b.name))
  let h = '<p class="hint">法定名是模型与代码里用的名字；别名是原料与日常的叫法。哪个词定义不对、名字起得不好，写在它下面的框里，业务分析会来改。</p>'
  h += '<div class="term-card" id="__new"><span class="nm">新增名词</span><div class="hint">业务里在用、目录里没有的词。业务分析会核对来源后收录并起法定名。</div><div class="row"><input type="text" id="new-name" placeholder="叫法（中文或英文）" style="width:220px"><input type="text" id="new-def" style="flex:1" placeholder="一句话解释，最好说它在哪个场景出现"><button id="save-new">保存</button></div></div>'
  const withNotes = sorted.filter(t => (notes[t.name] ?? []).length)
  const total = withNotes.reduce((n, t) => n + notes[t.name].length, 0) + (notes['_新增'] ?? []).length
  $('#dd-btn').textContent = '已保存的意见（' + total + '）▾'
  $('#dd-menu').innerHTML = (withNotes.length || (notes['_新增'] ?? []).length) ? withNotes.map(t => '<a href="#' + encodeURIComponent(t.name) + '">' + esc(t.name) + ' <small>' + esc((t.aliases||[])[0] ?? '') + ' · ' + notes[t.name].length + ' 条</small></a>').join('') + ((notes['_新增'] ?? []).length ? '<a href="#__pending">待收录的新词 <small>' + notes['_新增'].length + ' 条</small></a>' : '') : '<a>还没有意见</a>'
  h += '<div class="toc">' + sorted.map(t => '<a href="#' + encodeURIComponent(t.name) + '">' + esc(t.name) + (t.aliases?.[0] ? '　' + esc(t.aliases[0]) : '') + '</a>').join('') + '</div>'
  const nn = notes['_新增'] ?? []
  if (nn.length) h += '<div class="term-card has-notes" id="__pending"><span class="nm">待收录</span><div class="notes">' + nn.map(n => esc(n.at.slice(0,10)) + '「' + esc(n.text) + '」' + (n.handled ? '（已处理）' : '')).join('；') + '</div></div>'
  for (const t of sorted) {
    const ns = notes[t.name] ?? []
    h += '<div class="term-card' + (ns.length ? ' has-notes' : '') + '" id="' + esc(t.name) + '"><span class="nm">' + esc(t.name) + '</span>' + (t.aliases?.length ? '<span class="al">　' + t.aliases.map(esc).join(' · ') + '</span>' : '') + '<div class="df">' + esc(t.definition) + '</div>'
    if (ns.length) h += '<div class="notes"><b>已有意见</b>' + ns.map(n => '<div class="n">' + esc(n.at.slice(0,10)) + '　' + esc(n.text) + (n.handled ? '　<span class="tag">已处理</span>' : '') + '</div>').join('') + '</div>'
    h += '<div class="row"><input type="text" style="flex:1" data-term="' + esc(t.name) + '" placeholder="意见：定义哪里不对、该叫什么、和哪个词混了……"><button data-save-term="' + esc(t.name) + '">保存</button></div></div>'
  }
  $('#g').innerHTML = h
  document.querySelectorAll('[data-save-term]').forEach(b => b.addEventListener('click', () => { const el = document.querySelector('[data-term="' + b.dataset.saveTerm + '"]'); if (!el.value.trim()) return el.focus(); post([{ term: b.dataset.saveTerm, text: el.value.trim() }], b.dataset.saveTerm) }))
  $('#save-new').addEventListener('click', () => { const nn = $('#new-name').value.trim(), nd = $('#new-def').value.trim(); if (!nn) return $('#new-name').focus(); post([{ term: '_新增', text: nn + '：' + (nd || '（未写解释）') }], '__pending') })
  if (location.hash) { const el = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (el) el.scrollIntoView({ block: 'center' }) }
}
async function load() { const r = await (await fetch('/data')).json(); terms = r.glossary; notes = r.termNotes || {}; render() }
async function post(add, jumpTo) {
  const r = await fetch('/term-notes', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(add) })
  $('#status').textContent = r.ok ? '已保存 ' + add.length + ' 条意见 ' + new Date().toLocaleTimeString() : '保存失败'
  if (r.ok) { await load(); if (jumpTo) { const el = document.getElementById(jumpTo); if (el) el.scrollIntoView({ block: 'center' }) } }
}
$('#save').addEventListener('click', async () => {
  const add = []
  document.querySelectorAll('[data-term]').forEach(el => { if (el.value.trim()) add.push({ term: el.dataset.term, text: el.value.trim() }) })
  const nn = $('#new-name').value.trim(), nd = $('#new-def').value.trim()
  if (nn) add.push({ term: '_新增', text: nn + '：' + (nd || '（未写解释）') })
  if (!add.length) { $('#status').textContent = '没有新意见'; return }
  post(add)
})
window.addEventListener('hashchange', render)
$('#dd-btn').addEventListener('click', ev => { ev.stopPropagation(); $('#dd').classList.toggle('open') })
document.addEventListener('click', ev => { if (!ev.target.closest('#dd')) $('#dd').classList.remove('open') })
$('#dd-menu').addEventListener('click', () => $('#dd').classList.remove('open'))
load()
</script></body></html>`

  /** 框架图的数据：模块 × 故事。模块来自 model/modules.json；聚合来自 module.json（若有）与故事的 walk */
  function mapData() {
    const { loadModel, loadSlices, loadBusiness, walk, labelOf } = require('./lib/project')
    const model = loadModel(root)
    const modules = (model.modules?.data.modules ?? []).map((m) => {
      const mf = model.moduleFiles.find((f) => f.module === m.name)
      return { name: m.name, responsibility: m.responsibility ?? '', traces: m.traces ?? [], aggregates: (mf?.data.aggregates ?? []).map((a) => a.name) }
    })
    const slices = Object.fromEntries(loadSlices(root).map((s) => [s.data.id, s.data]))
    const stories = walk(path.join(root, 'slices')).filter((p) => p.endsWith('.story.json')).map((p) => {
      const st = readJson(p)
      const ids = new Set([...st.traces, ...st.steps.flatMap((s) => s.traces)])
      const aggs = new Set(st.steps.map((s) => s.walk?.aggregate).filter(Boolean))
      const sl = slices[st.slice]
      return { slice: st.slice, title: st.title, persona: st.persona.name, basedOn: st.basedOn ?? null, adds: st.adds ?? '', approved: st.approved, steps: st.steps.length, traces: [...ids], aggregates: [...aggs], model: sl?.stages.model.status ?? 'pending', code: sl?.stages.code.status ?? 'pending' }
    }).sort((a, b) => a.slice.localeCompare(b.slice))
    for (const st of stories) for (const q of st.aggregates) { const [mod, agg] = q.includes('.') ? q.split('.') : [null, q]; const m = modules.find((x) => x.name === mod); if (m && !m.aggregates.includes(agg)) m.aggregates.push(agg) }
    const statements = {}
    for (const s of loadBusiness(root)) statements[s.id] = { kind: s.kind, file: s.file }
    // 模块关系：modules.json 的 relations 优先；缺省时从端口（模块 → 目标模块）与 business/00-overview.md 的主题图推导
    let relations = model.modules?.data.relations ?? null
    if (!relations) {
      const rel = new Map() // "A>B" → Set(what)
      const add = (from, to, what) => { if (!from || !to || from === to) return; const k = from + '>' + to; if (!rel.has(k)) rel.set(k, new Set()); if (what) rel.get(k).add(what) }
      for (const el of model.elements.filter((e) => e.kind === 'port' && e.data.kind === 'module')) add(el.module, el.data.target, (el.data.operations ?? []).map((o) => o.name).join('、'))
      const topicsOf = {}
      for (const m of modules) for (const mm of m.responsibility.matchAll(/主题 ?([0-9、，, ]+)/g)) for (const n of mm[1].split(/[、，, ]+/).filter(Boolean)) (topicsOf[n] = topicsOf[n] ?? []).push(m.name)
      const pano = path.join(root, 'business', '00-overview.md')
      if (fs.existsSync(pano)) for (const mm of fs.readFileSync(pano, 'utf8').matchAll(/T(\d+)\s*-->\s*\|"([^"]*)"\|\s*T(\d+)/g)) for (const a of topicsOf[mm[1]] ?? []) for (const b of topicsOf[mm[3]] ?? []) add(a, b, mm[2])
      relations = [...rel].map(([k, ws]) => ({ from: k.split('>')[0], to: k.split('>')[1], what: [...ws].join('；') }))
    }
    return { system: model.modules?.data.system ?? '', modules, stories, statements, relations, groups: model.modules?.data.groups ?? [] }
  }
  const mapHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>框架图</title><style>${CSS}
  .stories { display:flex; flex-direction:column; gap:6px; max-height:60vh; overflow:auto; }
  .story-btn { border:1px solid #d0d7de; border-radius:8px; padding:8px 12px; background:#fff; cursor:pointer; text-align:left; }
  .story-btn.sel { border-color:#1f6feb; background:#eef4ff; }
  .story-btn .t { font-weight:600; } .story-btn .m { color:var(--muted); font-size:12px; }
  .story-btn .a { font-size:12px; color:#166534; } .story-btn.child { margin-left:18px; position:relative; } .story-btn.child::before { content:'↳'; position:absolute; left:-15px; top:8px; color:#9ca3af; }
  .node text.ct tspan.new { fill:#166534; font-weight:600; }
  .node.newlit rect { stroke:#22c55e; stroke-width:2; }
  .delta { font-size:12px; margin-top:6px; color:#166534; }
  main.map { padding:0; display:block; }
  svg { position:fixed; left:0; top:52px; width:100vw; height:calc(100vh - 52px); background:#fafbfc; cursor:grab; user-select:none; }
  .float { position:fixed; z-index:3; background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.08); width:320px; max-width:calc(100vw - 32px); }
  .float .bar { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--line); font-weight:600; font-size:13px; cursor:pointer; }
  .float .bar .sp { flex:1; }
  .float .body { padding:8px 10px; max-height:calc(100vh - 140px); overflow:auto; }
  .float.min .body { display:none; }
  .float.min { width:auto; }
  #fl-stories { left:16px; top:64px; }
  #fl-panel { right:16px; top:64px; }
  #fl-legend { left:16px; bottom:12px; font-size:12px; color:var(--muted); background:rgba(255,255,255,.9); padding:4px 10px; border-radius:8px; border:1px solid var(--line); position:fixed; z-index:3; }
  .grp rect { rx:18; stroke-width:1; stroke-dasharray:6 4; }
  .grp text { font: 600 14px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; fill:#6b7280; pointer-events:none; }
  .grp .gn { font-size:11px; font-weight:400; }
  .node rect { fill:#fff; stroke:#c9d1d9; stroke-width:1.2; rx:10; }
  .node.empty rect { stroke-dasharray:4 3; }
  .node.lit rect { stroke:#1f6feb; stroke-width:2.5; fill:#f2f6ff; }
  .node.sel rect { stroke:#f59e0b; stroke-width:2.5; }
  .node text { font: 13px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; pointer-events:none; }
  .node text.nm { font-weight:700; }
  .node text.ct { font-size:11px; fill:#57606a; }
  .node text.ct tspan.lit { fill:#1f6feb; font-weight:600; }
  .edge { stroke:#b6bec8; stroke-width:1.3; fill:none; marker-end:url(#arr); }
  .edge.lit { stroke:#1f6feb; stroke-width:2.2; marker-end:url(#arr-lit); }
  .edge.dim { opacity:.25; }
  .edge.hi { stroke:#f59e0b; stroke-width:2.4; marker-end:url(#arr-hi); }
  .elabel { font: 11px system-ui, sans-serif; fill:#b45309; pointer-events:none; }
  .elabel rect { fill:#fff8e1; stroke:#f59e0b; stroke-width:.6; }
  .panel { font-size:13px; }
  .panel .nm { font-weight:700; font-size:15px; }
  .panel .rs { color:var(--muted); margin:6px 0; }
  .panel ul { padding-left:18px; margin:6px 0; } .panel li { margin:2px 0; }
  .panel .cnt { display:flex; gap:12px; font-size:12px; color:var(--muted); margin:6px 0; } .panel .cnt b { color:var(--fg); font-size:14px; } .panel .cnt .lit b { color:#1f6feb; }
  .aggs code { background:var(--lo); padding:0 5px; border-radius:3px; margin-right:4px; font-size:12px; } .aggs code.lit { background:#dbe4ff; color:#1f6feb; }
</style></head>
<body>
<header><h1 id="title">框架图</h1><a href="/board" target="board">谁在做什么 ↗</a><a href="/glossary" target="glossary">名词目录 ↗</a><a href="/model" target="model">模型图 ↗</a><span id="status"></span></header>
<main class="map"><section id="m"></section></main>
<script>
${SHARED_JS}
let D = null, sel = null, selNode = null, pos = {}, drag = null, showStories = false, showPanel = false
const MS = { pending: '未开始', 'in-progress': '进行中', done: '已确认' }
let W = 1100, H = 700; const NW = 172, NH = 62
function litSets() { const st = D.stories.find(s => s.slice === sel); const base = st?.basedOn ? D.stories.find(s => s.slice === st.basedOn) : null; return { st, base, lit: new Set(st?.traces ?? []), litAgg: new Set(st?.aggregates ?? []), bLit: new Set(base?.traces ?? []), bAgg: new Set(base?.aggregates ?? []) } }
function lineageOrder() { const by = {}; for (const s of D.stories) (by[s.basedOn && D.stories.some(x => x.slice === s.basedOn) ? s.basedOn : ''] = by[s.basedOn && D.stories.some(x => x.slice === s.basedOn) ? s.basedOn : ''] || []).push(s); const out = []; const go = (k, d) => { for (const s of by[k] || []) { out.push({ s, d }); go(s.slice, d + 1) } }; go('', 0); return out }
function counts(m) {
  const { st, base, lit, litAgg, bLit, bAgg } = litSets()
  const goals = m.traces.filter(t => D.statements[t]?.kind === 'goal'), rules = m.traces.filter(t => D.statements[t]?.kind === 'rule' || D.statements[t]?.kind === 'usage')
  const c = { st, base, g: goals.length, r: rules.length, a: m.aggregates.length, kg: goals.filter(t => lit.has(t)).length, kr: rules.filter(t => lit.has(t)).length, ka: m.aggregates.filter(a => litAgg.has(m.name + '.' + a)).length }
  if (base) { c.ng = goals.filter(t => lit.has(t) && !bLit.has(t)).length; c.nr = rules.filter(t => lit.has(t) && !bLit.has(t)).length; c.na = m.aggregates.filter(a => litAgg.has(m.name + '.' + a) && !bAgg.has(m.name + '.' + a)).length; c.bLit = !!(goals.some(t => bLit.has(t)) || rules.some(t => bLit.has(t)) || m.aggregates.some(a => bAgg.has(m.name + '.' + a))) }
  return c
}
function isLit(m) { const c = counts(m); return !!(c.st && (c.kg || c.kr || c.ka)) }
function layout() {
  const ms = D.modules, n = ms.length
  ms.forEach((m, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; pos[m.name] = { x: W / 2 + Math.cos(a) * 400, y: H / 2 + Math.sin(a) * 280 } })
  const E = D.relations.map(r => [r.from, r.to]).filter(([a, b]) => pos[a] && pos[b])
  const G = D.groups || [], gx = {}
  G.forEach((g, gi) => { const cx = W * (gi + 0.5) / G.length; for (const name of g.modules) gx[name] = cx })
  if (G.length) ms.forEach((m) => { if (gx[m.name] !== undefined) pos[m.name].x = gx[m.name] + (Math.random() - 0.5) * 120 })
  for (let it = 0; it < 400; it++) {
    const f = {}; for (const m of ms) f[m.name] = { x: 0, y: 0 }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = pos[ms[i].name], b = pos[ms[j].name]; let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy || 1; const d = Math.sqrt(d2)
      const rep = 90000 / d2; f[ms[i].name].x += dx / d * rep; f[ms[i].name].y += dy / d * rep; f[ms[j].name].x -= dx / d * rep; f[ms[j].name].y -= dy / d * rep
      // 矩形不重叠
      const ox = NW + 30 - Math.abs(dx), oy = NH + 24 - Math.abs(dy)
      if (ox > 0 && oy > 0) { const px = Math.sign(dx || 1) * ox * 0.5, py = Math.sign(dy || 1) * oy * 0.5; if (ox < oy) { f[ms[i].name].x += px; f[ms[j].name].x -= px } else { f[ms[i].name].y += py; f[ms[j].name].y -= py } }
    }
    for (const [a, b] of E) { const pa = pos[a], pb = pos[b]; const dx = pb.x - pa.x, dy = pb.y - pa.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const k = (d - 300) * 0.015; f[a].x += dx / d * k; f[a].y += dy / d * k; f[b].x -= dx / d * k; f[b].y -= dy / d * k }
    for (const m of ms) { const p = pos[m.name]; if (gx[m.name] !== undefined) f[m.name].x += (gx[m.name] - p.x) * 0.06; p.x += (W / 2 - p.x) * 0.002 + f[m.name].x * 0.9; p.y += (H / 2 - p.y) * 0.002 + f[m.name].y * 0.9; p.x = Math.max(NW / 2 + 10, Math.min(W - NW / 2 - 10, p.x)); p.y = Math.max(150, Math.min(H - NH / 2 - 40, p.y)) }
  }
}
function edgeEnds(a, b) {
  // 从矩形边缘出发
  const pa = pos[a], pb = pos[b]; const dx = pb.x - pa.x, dy = pb.y - pa.y
  const cut = (p, sx, sy) => { const ax = Math.abs(sx), ay = Math.abs(sy); const t = Math.min(ax ? (NW / 2) / ax : 1e9, ay ? (NH / 2) / ay : 1e9); return { x: p.x + sx * t, y: p.y + sy * t } }
  return [cut(pa, dx, dy), cut(pb, -dx, -dy)]
}
function render() {
  const { st, lit, litAgg } = litSets()
  const litNames = new Set(D.modules.filter(isLit).map(m => m.name))
  let h = ''
  let stories = '<div class="stories">' + lineageOrder().map(({ s, d }) => '<button class="story-btn' + (s.slice === sel ? ' sel' : '') + (d ? ' child' : '') + '" style="margin-left:' + (d * 18) + 'px" data-s="' + esc(s.slice) + '"><div class="t">' + esc(s.title) + '</div>' + (s.basedOn ? '<div class="a">+ ' + esc(s.adds || '（未写 adds）') + '</div>' : '') + '<div class="m">' + esc(s.slice) + ' · ' + esc(s.persona) + ' · ' + s.steps + ' 步 · ' + s.traces.length + ' 条语句' + (s.approved ? ' · 理解一致' : ' · 待走完') + ' · 模型' + MS[s.model] + '</div></button>').join('') + (D.stories.length ? '' : '<span class="hint">还没有故事</span>') + '</div>'
  if (st) stories += '<p class="summary" style="margin:8px 0 0"><b>' + esc(st.title) + '</b>　点亮 ' + litNames.size + '/' + D.modules.length + ' 个域　·　<a href="/story?slice=' + esc(st.slice) + '">进入故事 →</a></p>'
  const { base } = litSets()
  if (st && base) { const cs = D.modules.map(m => ({ m, c: counts(m) })); const newMods = cs.filter(x => !x.c.bLit && isLit(x.m)); const dg = cs.reduce((a, x) => a + (x.c.ng || 0), 0), dr = cs.reduce((a, x) => a + (x.c.nr || 0), 0), da = cs.reduce((a, x) => a + (x.c.na || 0), 0); stories += '<div class="delta">比上一版「' + esc(base.title) + '」多点亮 ' + newMods.length + ' 个域' + (newMods.length ? '（' + newMods.map(x => esc(x.m.name)).join('、') + '）' : '') + '，+' + dg + ' 目标 +' + dr + ' 规则 +' + da + ' 聚合（图上绿色 +n）</div>' }
  h += '<div class="float' + (showStories ? '' : ' min') + '" id="fl-stories"><div class="bar" data-toggle="stories"><span>故事</span><span class="sp"></span><span>' + (showStories ? '▾' : '▸') + '</span></div><div class="body">' + stories + '</div></div>'
  // svg
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" id="g"><defs>'
  for (const [id, c] of [['arr', '#b6bec8'], ['arr-lit', '#1f6feb'], ['arr-hi', '#f59e0b']]) s += '<marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + c + '"/></marker>'
  s += '</defs>'
  const GC = ['#e8f1ff', '#f3f4f6', '#fff4e0', '#eaf7ea']
  const GS = ['#8fb3ff', '#c4c9d0', '#f2c57c', '#9ccc9c']
  ;(D.groups || []).forEach((g, gi) => {
    const ps = g.modules.map(n => pos[n]).filter(Boolean); if (!ps.length) return
    const x0 = Math.min(...ps.map(p => p.x)) - NW / 2 - 24, x1 = Math.max(...ps.map(p => p.x)) + NW / 2 + 24
    const y0 = Math.min(...ps.map(p => p.y)) - NH / 2 - 44, y1 = Math.max(...ps.map(p => p.y)) + NH / 2 + 20
    s += '<g class="grp"><rect x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0) + '" height="' + (y1 - y0) + '" fill="' + GC[gi % GC.length] + '" stroke="' + GS[gi % GS.length] + '"/><text x="' + (x0 + 14) + '" y="' + (y0 + 22) + '">' + esc(g.name) + '</text>' + (g.note ? '<title>' + esc(g.note) + '</title>' : '') + '</g>'
  })
  const pairSeen = {}
  D.relations.forEach((r, i) => {
    if (!pos[r.from] || !pos[r.to]) return
    const [p1, p2] = edgeEnds(r.from, r.to)
    const both = D.relations.some(o => o.from === r.to && o.to === r.from)
    // 双向：各弯一点，分开
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2; const dx = p2.x - p1.x, dy = p2.y - p1.y; const d = Math.sqrt(dx * dx + dy * dy) || 1
    const off = both ? 18 : 0; const cx = mx - dy / d * off, cy = my + dx / d * off
    const cls = 'edge' + (st ? (litNames.has(r.from) && litNames.has(r.to) ? ' lit' : ' dim') : '') + (selNode && (r.from === selNode || r.to === selNode) ? ' hi' : '')
    s += '<path class="' + cls + '" data-e="' + i + '" d="M' + p1.x + ',' + p1.y + ' Q' + cx + ',' + cy + ' ' + p2.x + ',' + p2.y + '"><title>' + esc(r.from + ' → ' + r.to + '：' + r.what) + '</title></path>'
    if (selNode && (r.from === selNode || r.to === selNode)) {
      const lx = (p1.x + 2 * cx + p2.x) / 4, ly = (p1.y + 2 * cy + p2.y) / 4; const txt = r.what.length > 22 ? r.what.slice(0, 21) + '…' : r.what; const w = txt.length * 11 + 10
      s += '<g class="elabel" transform="translate(' + (lx - w / 2) + ',' + (ly - 9) + ')"><rect width="' + w + '" height="18" rx="4"/><text x="5" y="13">' + esc(txt) + '</text></g>'
    }
  })
  for (const m of D.modules) {
    const p = pos[m.name], c = counts(m)
    const cls = 'node' + (litNames.has(m.name) ? ' lit' : '') + (c.base && litNames.has(m.name) && !c.bLit ? ' newlit' : '') + (selNode === m.name ? ' sel' : '') + (!c.g && !c.r && !c.a ? ' empty' : '')
    const seg = (k, n, label, nn) => (st && k ? '<tspan class="lit">' + k + '/' + n + '</tspan>' : (st ? k + '/' : '') + n) + (nn ? '<tspan class="new">+' + nn + '</tspan>' : '') + ' ' + label
    s += '<g class="' + cls + '" data-n="' + esc(m.name) + '" transform="translate(' + (p.x - NW / 2) + ',' + (p.y - NH / 2) + ')"><rect width="' + NW + '" height="' + NH + '"/><text class="nm" x="10" y="24">' + esc(m.name) + '</text><text class="ct" x="10" y="45">' + seg(c.kg, c.g, '目标', c.ng) + ' · ' + seg(c.kr, c.r, '规则', c.nr) + ' · ' + seg(c.ka, c.a, '聚合', c.na) + '</text><title>' + esc(m.responsibility) + '</title></g>'
  }
  s += '</svg>'
  // panel
  let pnl = '<div class="panel">'
  const pnlTitle = selNode ? selNode : '域的详情'
  const sm = D.modules.find(m => m.name === selNode)
  if (!sm) pnl += '<div class="hint">点一个域看：职责、它给谁什么、谁给它什么、名下的聚合。</div>'
  else {
    const c = counts(sm)
    pnl += '<div class="nm">' + esc(sm.name) + '</div><div class="rs">' + esc(sm.responsibility) + '</div>'
    pnl += '<div class="cnt"><span' + (st && c.kg ? ' class="lit"' : '') + '><b>' + (st ? c.kg + '/' : '') + c.g + '</b> 目标</span><span' + (st && c.kr ? ' class="lit"' : '') + '><b>' + (st ? c.kr + '/' : '') + c.r + '</b> 规则</span><span' + (st && c.ka ? ' class="lit"' : '') + '><b>' + (st ? c.ka + '/' : '') + c.a + '</b> 聚合</span></div>'
    if (sm.aggregates.length) pnl += '<div class="aggs">' + sm.aggregates.map(a => '<code' + (litAgg.has(sm.name + '.' + a) ? ' class="lit"' : '') + '>' + esc(a) + '</code>').join('') + '</div>'
    const out = D.relations.filter(r => r.from === sm.name), inn = D.relations.filter(r => r.to === sm.name)
    if (out.length) pnl += '<div><b>给出去</b><ul>' + out.map(r => '<li>→ ' + esc(r.to) + '：' + esc(r.what) + '</li>').join('') + '</ul></div>'
    if (inn.length) pnl += '<div><b>拿进来</b><ul>' + inn.map(r => '<li>← ' + esc(r.from) + '：' + esc(r.what) + '</li>').join('') + '</ul></div>'
  }
  pnl += '</div>'
  h += s
  h += '<div class="float' + (showPanel ? '' : ' min') + '" id="fl-panel"><div class="bar" data-toggle="panel"><span>' + esc(pnlTitle) + '</span><span class="sp"></span><span>' + (showPanel ? '▾' : '▸') + '</span></div><div class="body">' + pnl + '</div></div>'
  h += '<div id="fl-legend">' + esc(D.system) + '：' + D.modules.length + ' 个域 · 箭头 = 谁把什么事实给谁（悬停看） · 蓝 = 被当前故事点亮 · 绿框 / 绿 +n = 比上一版新点亮 · 虚线框 = 只留位置 · 点域看详情 · 拖动摆位置（位置会记住，<a href="#" id="reset-pos">重新排</a>）</div>'
  $('#m').innerHTML = h
  document.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { sel = sel === b.dataset.s ? null : b.dataset.s; render() }))
  document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => { if (b.dataset.toggle === 'stories') showStories = !showStories; else showPanel = !showPanel; render() }))
  const svg = $('#g')
  const pt = (ev) => { const r = svg.getBoundingClientRect(); return { x: (ev.clientX - r.left) * W / r.width, y: (ev.clientY - r.top) * H / r.height } }
  svg.querySelectorAll('.node').forEach(g => {
    g.addEventListener('mousedown', ev => { drag = { n: g.dataset.n, moved: false, start: pt(ev), orig: { ...pos[g.dataset.n] } }; ev.preventDefault() })
  })
  svg.addEventListener('mousemove', ev => { if (!drag) return; const p = pt(ev); const dx = p.x - drag.start.x, dy = p.y - drag.start.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; pos[drag.n] = { x: drag.orig.x + dx, y: drag.orig.y + dy }; if (drag.moved) render() })
  window.addEventListener('mouseup', () => { if (!drag) return; if (!drag.moved) { selNode = selNode === drag.n ? null : drag.n; if (selNode) showPanel = true; render() } else savePos(); drag = null })
}
function fit() { W = Math.max(700, window.innerWidth); H = Math.max(500, window.innerHeight - 52) }
function posKey() { return 'dev-team:map-pos:' + (D?.system || '') }
function savePos() { try { localStorage.setItem(posKey(), JSON.stringify({ W, H, pos })) } catch (e) {} }
function loadPos() { try { const o = JSON.parse(localStorage.getItem(posKey()) || 'null'); if (!o || !o.pos) return false; const names = new Set(D.modules.map(m => m.name)); if (!D.modules.every(m => o.pos[m.name])) return false; for (const k in o.pos) if (names.has(k)) pos[k] = { x: o.pos[k].x * W / o.W, y: o.pos[k].y * H / o.H }; return true } catch (e) { return false } }
function resetPos() { try { localStorage.removeItem(posKey()) } catch (e) {} layout(); render() }
async function load() { D = await (await fetch('/data-map')).json(); const q = new URLSearchParams(location.search).get('slice'); if (q) sel = q; fit(); if (!loadPos()) layout(); render() }
window.addEventListener('resize', () => { const ow = W, oh = H; fit(); for (const k in pos) { pos[k].x *= W / ow; pos[k].y *= H / oh } render() })
document.addEventListener('click', ev => { if (ev.target.id === 'reset-pos') resetPos() })
load()
</script></body></html>`
  const fileOf = (sid) => (sid ? storyPath(sid) : null)
  const { loadBusiness, loadGlossary, labelOf } = require('./lib/project')
  const notesP = path.join(root, 'business', '_glossary-notes.json')
  const modelNotesP = path.join(root, 'reports', '_model-notes.json')
  const MODEL_INJECT = "\n<style>\n  .mnote { margin-top:8px; border-top:1px dashed #d0d7de; padding-top:6px; font-size:12px; }\n  .mnote textarea { width:100%; min-height:38px; box-sizing:border-box; font:inherit; font-size:12px; border:1px solid #d0d7de; border-radius:6px; padding:4px 6px; }\n  .mnote .row { display:flex; gap:6px; align-items:center; margin-top:4px; }\n  .mnote button { font-size:12px; padding:3px 10px; border:1px solid #1f6feb; background:#1f6feb; color:#fff; border-radius:6px; cursor:pointer; }\n  .mnote .old { background:#fff7e6; border:1px solid #f2c57c; border-radius:6px; padding:4px 8px; margin:3px 0; }\n  .mnote .old.done { background:#f3f4f6; border-color:#d0d7de; color:#6b7280; }\n  .mnote .old small { color:#6b7280; margin-left:6px; }\n  .mnote-top { position:fixed; right:16px; top:52px; z-index:9; }\n  .mnote-top button.dd { font-size:12px; padding:4px 10px; border:1px solid #d0d7de; background:#fff; border-radius:6px; cursor:pointer; }\n  .mnote-top .menu { display:none; position:absolute; right:0; top:30px; width:360px; max-height:60vh; overflow:auto; background:#fff; border:1px solid #d0d7de; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,.1); padding:6px; }\n  .mnote-top.open .menu { display:block; }\n  .mnote-top .menu a { display:block; padding:5px 6px; border-bottom:1px solid #f0f0f0; color:#111; text-decoration:none; font-size:12px; }\n  .mnote-top .menu a b { color:#1f6feb; }\n  .mnote-top .menu a.done { color:#9ca3af; }\n</style>\n<div class=\"mnote-top\" id=\"mnote-top\"><button class=\"dd\" id=\"mnote-dd\">对模型的意见（0）▾</button><div class=\"menu\" id=\"mnote-menu\"></div></div>\n<script>\n(function () {\n  const esc = (s) => String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c])\n  let notes = {}\n  function box(file) {\n    const old = (notes[file] || []).map((n) => '<div class=\"old' + (n.handled ? ' done' : '') + '\">' + esc(n.text) + '<small>' + n.at.slice(0, 16).replace('T', ' ') + (n.handled ? ' · 已处理' : ' · 待模型师') + '</small></div>').join('')\n    return '<div class=\"mnote\" data-mfile=\"' + esc(file) + '\">' + old + '<textarea placeholder=\"对这个模型元素的意见：名字不对、放错地方、多了少了、和业务不符……\"></textarea><div class=\"row\"><button data-msave=\"' + esc(file) + '\">保存意见</button><span class=\"st\"></span></div></div>'\n  }\n  function paint() {\n    document.querySelectorAll('.card[id]').forEach((c) => { const f = c.id; let m = c.querySelector(':scope > .mnote'); if (m) m.outerHTML = box(f); else c.insertAdjacentHTML('beforeend', box(f)) })\n    const all = []; for (const f in notes) for (const n of notes[f]) all.push({ f, ...n })\n    all.sort((a, b) => b.at.localeCompare(a.at))\n    const open = all.filter((n) => !n.handled).length\n    document.getElementById('mnote-dd').textContent = '对模型的意见（' + open + (all.length !== open ? '/' + all.length : '') + '）▾'\n    document.getElementById('mnote-menu').innerHTML = all.length ? all.map((n) => '<a href=\"#\" data-jump=\"' + esc(n.f) + '\" class=\"' + (n.handled ? 'done' : '') + '\"><b>' + esc(n.f.split('/').pop().replace(/\\.json$/, '')) + '</b> ' + esc(n.text.slice(0, 60)) + '</a>').join('') : '<a>还没有意见。在「卡片」视图每张卡下面写。</a>'\n  }\n  async function load() { try { notes = await (await fetch('/model-notes')).json() } catch (e) { notes = {} } paint() }\n  document.addEventListener('click', async (ev) => {\n    const b = ev.target.closest('[data-msave]')\n    if (b) {\n      const wrap = b.closest('.mnote'); const ta = wrap.querySelector('textarea'); const text = ta.value.trim(); if (!text) return\n      b.disabled = true\n      const r = await fetch('/model-notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: b.dataset.msave, text }) })\n      b.disabled = false; ta.value = ''\n      if (r.ok) { notes = await r.json(); paint() } else wrap.querySelector('.st').textContent = '保存失败'\n      return\n    }\n    if (ev.target.id === 'mnote-dd') { document.getElementById('mnote-top').classList.toggle('open'); return }\n    const j = ev.target.closest('[data-jump]')\n    if (j) { ev.preventDefault(); document.getElementById('mnote-top').classList.remove('open'); document.querySelector('nav [data-v=\"cards\"]')?.click(); const el = document.getElementById(j.dataset.jump); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid #f59e0b'; setTimeout(() => (el.style.outline = ''), 2000) } return }\n    if (!ev.target.closest('#mnote-top')) document.getElementById('mnote-top').classList.remove('open')\n  })\n  load()\n})()\n</script>"
  /** board.js 的输出是 markdown；这里只认它真的会用到的几种写法 */
  function boardHtml(md) {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
    const lines = md.split('\n')
    let h = '', i = 0
    while (i < lines.length) {
      const L = lines[i]
      if (/^\|/.test(L) && /^\|[\s:-]+\|/.test(lines[i + 1] ?? '')) {
        const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        const head = cells(L)
        i += 2
        const body = []
        while (i < lines.length && /^\|/.test(lines[i])) { body.push(cells(lines[i])); i++ }
        h += '<div class="tw"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        for (const r of body) {
          const you = r.some((c) => c === '等你')
          h += '<tr class="' + (you ? 'you' : '') + '">' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>'
        }
        h += '</tbody></table></div>'
        continue
      }
      const m = /^(#{1,3})\s+(.*)$/.exec(L)
      if (m) { h += '<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'; i++; continue }
      if (/^- /.test(L)) {
        const items = []
        while (i < lines.length && /^- /.test(lines[i])) { items.push(lines[i].slice(2)); i++ }
        h += '<ul>' + items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</ul>'
        continue
      }
      if (L.trim()) h += '<p>' + inline(L) + '</p>'
      i++
    }
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>谁在做什么</title><style>' + CSS + `
  body { margin:0 }
  .wrap { max-width:1100px; margin:0 auto; padding:16px 20px 60px }
  h1 { font-size:20px; margin:0 0 4px } h2 { font-size:16px; margin:24px 0 8px }
  .tw { overflow-x:auto; margin:8px 0 }
  table { border-collapse:collapse; width:100%; font-size:13px }
  th, td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top }
  th { background:var(--lo); font-weight:600; white-space:nowrap }
  tr.you td { background:#fff7e6 }
  tr.you td:first-child { border-left:3px solid #f59e0b }
  ul { margin:6px 0; padding-left:20px } li { margin:2px 0 }
  code { font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#0969da }
  .foot { margin-top:24px; color:var(--muted); font-size:12px }
` + '</style></head><body><div class="wrap">' + h + '<div class="foot">每 20 秒自动刷新。这一页的数据就是 <code>node tools/board.js &lt;项目&gt;</code> 的输出，两边永远一致。</div></div><script>setTimeout(() => location.reload(), 20000)</script></body></html>'
  }
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/board') {
      // 直接跑 board.js 拿它的 markdown，页面只做渲染——两边永远说同一件事
      const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'board.js'), root], { encoding: 'utf8' })
      const md = r.stdout || ('看板算不出来：' + (r.stderr || ''))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(boardHtml(md))
    }
    if (req.method === 'GET' && url === '/model') {
      // 每次打开都重新画：模型是活的
      const out = path.join(root, 'reports', 'model.html')
      const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'render.js'), root, '--out', out], { encoding: 'utf8' })
      if (r.status !== 0 || !fs.existsSync(out)) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('画不出模型图：' + (r.stderr || r.stdout)) }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      const html = fs.readFileSync(out, 'utf8')
      return res.end(html.includes('</body>') ? html.replace('</body>', MODEL_INJECT + '</body>') : html + MODEL_INJECT)
    }
    if (req.method === 'GET' && url === '/model-notes') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify(fs.existsSync(modelNotesP) ? readJson(modelNotesP) : {}))
    }
    if (req.method === 'POST' && url === '/model-notes') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { file, text } = JSON.parse(body)
          if (!file || !text) throw new Error('缺 file 或 text')
          const notes = fs.existsSync(modelNotesP) ? readJson(modelNotesP) : {}
          ;(notes[file] = notes[file] ?? []).push({ text, at: new Date().toISOString(), slice: id ?? null, handled: false })
          writeJson(modelNotesP, notes)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(notes))
        } catch (e) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(e.message)) }
      })
      return
    }
    if (req.method === 'GET' && (url === '/' || url === '/story' || url === '/glossary')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(url === '/' ? mapHtml : url === '/story' ? html : glossaryHtml)
    }
    if (req.method === 'GET' && url === '/data-map') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify(mapData()))
    }
    if (req.method === 'GET' && url === '/data') {
      const sid = new URLSearchParams(req.url.split('?')[1] || '').get('slice') || id
      const file = fileOf(sid)
      const business = {}
      for (const s of loadBusiness(root)) business[s.id] = { text: s.text, kind: s.kind, ruleKind: s.ruleKind, layer: s.layer, label: labelOf(s) }
      const termNotes = fs.existsSync(notesP) ? readJson(notesP) : {}
      const story = file && fs.existsSync(file) ? readJson(file) : null
      let base = null
      if (story?.basedOn) { const bf = fileOf(story.basedOn); if (bf && fs.existsSync(bf)) { const b = readJson(bf); base = { slice: b.slice, title: b.title, texts: b.steps.map((s) => s.text) } } }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      // 段落清单：按故事里最早的那一天排，没有步骤的（还没写）排在最后。故事页顶上那一排就用它
      const segs = []
      const slicesDir = path.join(root, 'slices')
      for (const f of (fs.existsSync(slicesDir) ? fs.readdirSync(slicesDir) : []).filter((n) => n.endsWith('.story.json'))) {
        try {
          const s = readJson(path.join(root, 'slices', f))
          const sp = path.join(root, 'slices', s.slice + '.json')
          const sl = fs.existsSync(sp) ? readJson(sp) : null
          const days = (s.steps || []).map((x) => String(x.day || '')).filter((d) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(d)).sort()
          segs.push({ slice: s.slice, title: s.title, day: days[0] || '', steps: (s.steps || []).length, approved: s.approved || null, businessStory: (sl && sl.businessStory) || '', intent: (sl && sl.intent) || '' })
        } catch (e) { /* 读不动的跳过，页面照开 */ }
      }
      segs.sort((x, y) => (x.day ? 0 : 1) - (y.day ? 0 : 1) || String(x.day).localeCompare(String(y.day)) || String(x.slice).localeCompare(String(y.slice)))
      return res.end(JSON.stringify({ story, base, business, glossary: loadGlossary(root).terms, termNotes, segs, rev: storyRev(sid) }))
    }
    if (req.method === 'POST' && url === '/usage-confirm') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let out
        try { out = confirmUsage(JSON.parse(body || '{}').slice, '网页') } catch (e) { out = { ok: false, error: String(e.message) } }
        if (out.ok) console.log(out.message)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      })
      return
    }
    if (req.method === 'POST' && (url === '/save' || url === '/term-notes')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const obj = JSON.parse(body)
          if (url === '/save') {
            if (!/^s-[0-9]{3,}$/.test(obj.slice || '')) throw new Error('故事缺 slice')
            // 页面手里那份是从哪一版改起的？跟磁盘上现在这一版对不上，就说明这中间别人改过（角色、命令行、另一台机器）。
            // 直接写会把那些改动整个盖掉，而且一声不响。宁可拒绝，让人刷新后在新版本上重做这一下。
            const now = storyRev(obj.slice)
            const from = obj._rev
            if (from && now && from !== now) {
              res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('这条故事在服务器上已被改动（多半是某个角色刚落了裁定或改了措辞）。请刷新这一页，再把你刚才那一下重做一遍——直接保存会把那些改动盖掉。')
              console.log('挡下一次会盖掉改动的保存：页面从 ' + from + ' 改起，磁盘上已是 ' + now)
              return
            }
            const toWrite = { ...obj }
            delete toWrite._rev
            writeJson(storyPath(obj.slice), toWrite)
          }
          else {
            const notes = fs.existsSync(notesP) ? readJson(notesP) : {}
            for (const n of obj) {
              notes[n.term] = notes[n.term] ?? []
              notes[n.term].push({ text: n.text, at: new Date().toISOString(), slice: id ?? null, handled: false })
            }
            writeJson(notesP, notes)
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, rev: url === '/save' ? storyRev(obj.slice) : null }))
          console.log(`已保存 ${url} ${new Date().toLocaleTimeString()}`)
        } catch (e) {
          res.writeHead(400)
          res.end(String(e.message))
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log(`框架图 ${url}　走故事 ${url}story?slice=${id ?? '<切片id>'}　名词目录 ${url}glossary（Ctrl+C 结束）`)
    // --no-open：工作台把这一页代理在自己那个口后面，这里再弹一个浏览器标签，人就看见好几个口了（2026-09-13 项目所有者点名）
    if (process.platform === 'win32' && !args.includes('--no-open')) spawn('cmd', ['/c', 'start', '', id ? `${url}story?slice=${id}` : url], { stdio: 'ignore', detached: true }).unref()
  })
}

if (!['approve', 'serve', 'apply', 'state', 'usage'].includes(cmd)) die(`未知子命令：${cmd}`)
