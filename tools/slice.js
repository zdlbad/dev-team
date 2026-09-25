#!/usr/bin/env node
/**
 * 切片：一段一个场景，攒够了一次正式化。
 *
 *   node tools/slice.js new <项目> s-001 "<标题>" [--场景 "<三四句：谁、按什么、然后呢>"] [--modules A,B]
 *   node tools/slice.js new <项目> f-001 "<标题>" --正式化 --covers s-001,s-002
 *   node tools/slice.js next <项目> [<切片>]          下一步该谁做什么；不给切片就取最近一条没收口的
 *   node tools/slice.js advance <项目> <切片> <关> <pending|in-progress|done> [说明]
 *   node tools/slice.js lit <项目> <切片> R-001,R-002   这一段立了哪几条语句
 *   node tools/slice.js enough <项目> <切片> [说明]    他在草稿原型上按过，说这一段够了
 *   node tools/slice.js list <项目>
 *
 * 场景切片的四关：scene（场景定下）→ model（模型）→ draft（草稿原型）→ walk（一起按，他说够了才收口）。
 *   一次按下来的答案攒成一批：advance <切片> model pending "<这一批答了什么>"，模型与草稿一起重开，
 *   业务分析先把答案立成语句（slice lit），模型师再改，编码再改草稿。
 * 正式化切片的三关：code（测试、外壳、契约）→ check（代码对模型、审查）→ accept（他按一遍）。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { openQuestions } = require('./lib/project')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const die = (m) => { console.error(m); process.exit(1) }
const today = new Date().toISOString().slice(0, 10)
const rel = (p) => path.relative(process.cwd(), p) || '.'

const STAGES = { scene: ['scene', 'model', 'draft', 'walk'], formalize: ['code', 'check', 'accept'] }
const NAMES = { scene: '场景', model: '模型', draft: '草稿原型', walk: '一起按', code: '正式代码', check: '校验与审查', accept: '验收' }

if (!cmd || !root) die('用法：node tools/slice.js <new|next|advance|lit|enough|list> <项目> …（详见文件头）')
if (!fs.existsSync(path.join(root, 'project.json'))) die(`${root} 不是项目目录（没有 project.json）`)
const dir = path.join(root, 'slices')
const fileOf = (id) => path.join(dir, `${id}.json`)
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const load = (id) => { if (!fs.existsSync(fileOf(id))) die(`没有切片 ${id}`); return readJson(fileOf(id)) }
const save = (s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fileOf(s.id), JSON.stringify(s, null, 2) + '\n', 'utf8') }
const all = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[sf]-\d+\.json$/.test(f)).sort().map((f) => readJson(path.join(dir, f))) : [])
const closed = (s) => STAGES[s.kind].every((k) => s.stages[k]?.status === 'done')
const log = (s, text) => (s.log = s.log ?? []).push({ at: today, text })
// 人拍板的那几关也记进日志（journal/<UTC 日期>.jsonl）：「我的」页要列出他几点拍了什么板，切片 log 只有日期
// 页面上按的，说明里带「页面上按的」；开发指挥照他口头的话跑的，算在对话里
function gateJournal(s, text, note) {
  const ts = new Date().toISOString()
  const via = /页面上按的|切片页按的/.test(note ?? '') ? '页面' : '对话'
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true })
  fs.appendFileSync(path.join(root, 'journal', `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, machine: os.hostname(), kind: 'gate', who: '人', slice: s.id, text, via }) + '\n')
}

if (cmd === 'new') {
  const [, , id, title] = args
  const formalize = args.includes('--正式化')
  if (!id || !title) die('用法：slice new <项目> <id> "<标题>" [--场景 "<…>"] | [--正式化 --covers s-001,s-002]')
  if (!(formalize ? /^f-\d{3}$/ : /^s-\d{3}$/).test(id)) die(formalize ? '正式化切片编号写成 f-001' : '场景切片编号写成 s-001')
  if (fs.existsSync(fileOf(id))) die(`${id} 已经有了`)
  const kind = formalize ? 'formalize' : 'scene'
  const s = { id, kind, title, stages: Object.fromEntries(STAGES[kind].map((k) => [k, { status: 'pending' }])), log: [] }
  if (formalize) {
    s.covers = (opt('--covers') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (!s.covers.length) die('正式化要写 --covers：这一批装哪几个场景')
    const open = s.covers.filter((c) => !fs.existsSync(fileOf(c)) || !closed(load(c)))
    if (open.length) die(`这几个场景还没收口，不能正式化：${open.join('、')}`)
  } else {
    s.scene = opt('--场景') ?? null
    s.modules = (opt('--modules') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    s.traces = []
  }
  log(s, formalize ? `开正式化：${s.covers.join('、')}` : '开场景')
  save(s)
  console.log(`建好 ${id}（${formalize ? '正式化' : '场景'}）：${title}`)
  process.exit(0)
}

if (cmd === 'list') {
  for (const s of all()) {
    const at = STAGES[s.kind].map((k) => `${NAMES[k]} ${{ done: '✓', 'in-progress': '…', pending: '·' }[s.stages[k]?.status] ?? '·'}`).join('  ')
    console.log(`${s.id}　${s.title}\n      ${at}${closed(s) ? '　（收口）' : ''}`)
  }
  process.exit(0)
}

if (cmd === 'advance') {
  const [, , id, stage, status, ...rest] = args
  const s = load(id)
  if (!STAGES[s.kind].includes(stage) || !['pending', 'in-progress', 'done'].includes(status)) {
    die(`用法：slice advance <项目> ${id} <${STAGES[s.kind].join('|')}> <pending|in-progress|done> [说明]`)
  }
  const note = rest.join(' ') || null
  s.stages[stage] = { status, at: today, ...(note ? { note } : {}) }
  // 一批答案回来：模型重开，草稿跟着重开，一起按也回到没收口
  if (s.kind === 'scene' && stage === 'model' && status === 'pending' && s.stages.draft?.status === 'done') {
    s.stages.draft = { status: 'pending', at: today }
    s.stages.walk = { status: 'pending', at: today }
    s.batch = { at: today, note, lit: false }
  }
  log(s, `${NAMES[stage]} → ${status}${note ? '：' + note : ''}`)
  save(s)
  if (status === 'done' && stage === 'scene') gateJournal(s, `场景定下：${s.title}${s.scene ? '（' + s.scene + '）' : ''}`, note)
  if (status === 'done' && stage === 'accept') gateJournal(s, `验收：${s.title}`, note)
  console.log(`${id} 的${NAMES[stage]}：${status}`)
  process.exit(0)
}

if (cmd === 'lit') {
  const [, , id, list] = args
  const s = load(id)
  if (s.kind !== 'scene') die('只有场景切片登记语句')
  const ids = String(list ?? '').split(/[,\s]+/).filter(Boolean)
  if (!ids.length) die('用法：slice lit <项目> <切片> R-001,R-002')
  s.traces = [...new Set([...(s.traces ?? []), ...ids])]
  if (s.batch) s.batch.lit = true
  log(s, `登记语句 ${ids.join('、')}`)
  save(s)
  console.log(`${id} 现在挂着 ${s.traces.length} 条语句`)
  process.exit(0)
}

if (cmd === 'enough') {
  const [, , id, ...rest] = args
  const s = load(id)
  if (s.kind !== 'scene') die('「够了」只对场景切片说')
  if (s.stages.draft?.status !== 'done') die(`${id} 的草稿原型还没好，没东西可按`)
  const open = openQuestions(root, id)
  if (open.length) die(`${id} 上还有 ${open.length} 件等人答：\n${open.map((q) => `  ${q.id}　${q.question}`).join('\n')}`)
  s.stages.walk = { status: 'done', at: today, ...(rest.length ? { note: rest.join(' ') } : {}) }
  log(s, '他说这一段够了' + (rest.length ? '：' + rest.join(' ') : ''))
  save(s)
  gateJournal(s, `这一段够了：${s.title}`, rest.join(' '))
  console.log(`${id} 收口。下一个场景 slice new；攒够了开 f-xxx 正式化。`)
  process.exit(0)
}

if (cmd === 'next') {
  const id = args[2]
  const s = id ? load(id) : all().filter((x) => !closed(x)).pop()
  if (!s) {
    console.log('没有没收口的切片。下一步：业务分析提一个场景，或他说一个；定了就 slice new <项目> s-xxx "<标题>" --场景 "<…>"')
    process.exit(0)
  }
  const step = next(s)
  console.log(`${s.id}「${s.title}」　${STAGES[s.kind].map((k) => `${NAMES[k]} ${s.stages[k]?.status ?? 'pending'}`).join(' · ')}`)
  console.log(`下一步：${step.who} — ${step.what}`)
  if (step.run) console.log(`执行：${step.run}`)
  process.exit(0)
}

die(`不认识的子命令：${cmd}`)

function next(s) {
  const st = (k) => s.stages[k]?.status ?? 'pending'
  const R = rel(root)
  const open = openQuestions(root, s.id)
  const ask = () => ({ who: '人', what: `答看板上的 ${open.length} 件：\n${open.map((q) => `    ${q.id}　${q.question}`).join('\n')}`, run: `node tools/scene.js ${R} answer <问题号> "<他怎么答的>"` })

  if (s.kind === 'formalize') {
    if (st('code') !== 'done') return { who: '编码', what: `把 ${s.covers.join('、')} 的草稿原型正式化：补测试、钉契约、写生产外壳。交回后跑测试，全绿再推`, run: `node tools/slice.js advance ${R} ${s.id} code done` }
    if (st('check') !== 'done') return { who: '审查', what: '解码代码、跑代码对模型的校验，判代码并做 pre-pr 审查；差异回编码改', run: `node tools/validate.js ${R} --code <代码库> --slice ${s.id}` }
    return { who: '人', what: '在原型上把这一批场景按一遍，对了就验收', run: `node tools/slice.js advance ${R} ${s.id} accept done` }
  }

  if (st('scene') !== 'done') {
    if (!s.scene) return { who: '业务分析', what: '提一个场景：谁、按什么、然后发生什么，三四句，用具体的人和钱', run: `node tools/brief.js 业务分析 --活 出场景` }
    return { who: '人', what: `看这个场景对不对：「${s.scene}」。对了就定下`, run: `node tools/slice.js advance ${R} ${s.id} scene done` }
  }
  if (open.length && st('model') !== 'done') return ask()
  if (s.batch && !s.batch.lit) return { who: '业务分析', what: `把这一批答案立成语句、注明出处，登记进切片：${s.batch.note ?? '（看看板上这一段答过的问题）'}`, run: `node tools/slice.js lit ${R} ${s.id} R-…` }
  if (st('model') !== 'done') {
    const rp = path.join(root, 'reports', 'validate-1.json')
    const r = fs.existsSync(rp) ? readJson(rp) : null
    const mine = r && r.slice === s.id && (!s.stages.model.at || r.at.slice(0, 10) >= s.stages.model.at)
    if (st('model') === 'pending') return { who: '模型师', what: '照场景简单建模：只建这个场景碰到的；交回后开发指挥跑校验', run: `node tools/slice.js advance ${R} ${s.id} model in-progress` }
    if (!mine) return { who: '开发指挥', what: '模型师交回了，跑一趟校验（业务对模型）', run: `node tools/validate.js ${R} --slice ${s.id}` }
    if (r.errors.length) return { who: '模型师', what: `校验有 ${r.errors.length} 条错，改掉再交回` }
    const unjudged = (r.judgments ?? []).filter((j) => !j.verdict).length
    if (unjudged) return { who: '审查', what: `判 ${unjudged} 条：模型对不对业务；拿不准的挂成问题（scene ask），下次一起按时问他`, run: `node tools/brief.js 审查 --活 判模型` }
    const failed = (r.judgments ?? []).filter((j) => j.verdict === 'fail').length
    if (failed) return { who: '模型师', what: `审查判了 ${failed} 条不通过，照理由改，再交回` }
    return { who: '开发指挥', what: '校验干净，模型这一关收口', run: `node tools/slice.js advance ${R} ${s.id} model done` }
  }
  if (st('draft') !== 'done') return { who: '编码', what: '照模型起草稿原型：领域代码加内存仓储，按身份分的页面调它；不写测试。交回后跑 proto check', run: `node tools/proto.js check ${R} --code <代码库>` }
  const notesP = path.join(root, 'reports', '_model-notes.json')
  const notes = fs.existsSync(notesP) ? Object.values(readJson(notesP)).flat().filter((n) => !n.handled) : []
  if (notes.length) return { who: '模型师', what: `他在模型图上留了 ${notes.length} 条意见，逐条处理，处理完把 handled 置真；要改模型就一并攒进这一批` }
  if (open.length) return ask()
  return { who: '人', what: '在工作台「草稿原型」页和模型师一起按。问出来的当场 scene ask；一次按下来的答案攒成一批再回流（advance model pending "<这一批>"）；这一段够了就说', run: `node tools/slice.js enough ${R} ${s.id}` }
}
