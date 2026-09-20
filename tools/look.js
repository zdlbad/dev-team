#!/usr/bin/env node
/**
 * look —— 一次只取要的那一小块，输出有上限。
 *
 * 为什么有它（2026-09-20）：量过两天的角色记录，37 次派工、2441 轮调用，每轮平均带 12.6 万 token 上下文。
 * 贵的不是某一次输出，是整份读进来的大文件（practice.md 117KB 读了 15 次、聚合根 80KB、走查 272KB）
 * 一进上下文，之后每一轮都再送一遍。所以要查一条语句、一个方法、走查一步，用它取那一块，不整份读文件。
 *
 * 用法：node tools/look.js <项目> <什么> [参数] [--max <字数>]
 *   R-123 | G-017 | U-001      一条业务语句：正文、标签、出处；模型里哪几处挂着它；走查哪几步用到它
 *   term <名字>                 词汇表一条（名字或别名）；没有一模一样的就列出名字里含它的
 *   model <名字>                一个模型元素的目录：字段名、创建、各方法的名字与作用、规则条数（不吐全文）
 *   model <名字>.<方法>         一个方法的七段全文；<方法> 也可以是 create、fields、invariants、narrative
 *   step <切片> <n>[-<m>]       走查的一步（或连续几步）：谁、哪天、正文、编号、walk
 *   gap <切片> [<n>]            缺口清单（每条一行）；给了 n 就是第 n 条全文
 *   judge [--open]              校验判断清单，一行一条；--open 只列还没填的
 *   judge <编号>                 一条判断的全文（业务、模型两侧，判定与理由）
 *   doc <文件> [<标题关键字>]    Markdown 的小节目录；给了关键字就是那一节全文。文件先按项目找，再按 dev-team 找
 *   --max <字数>                输出上限，默认 6000 字；超出就截断，并提示怎么取得更小
 *
 * 一次取多块（第一百七十批）：几个查询连着写，中间用 + 隔开——
 *   node tools/look.js <项目> R-166 + model ClaimableEntry.create + model Invoice.void + term 发票
 * 少跑几个来回：2026-09-20 模型师那一趟 46 轮里有 21 轮是一块一块地要。
 */
const fs = require('node:fs')
const path = require('node:path')
const { loadBusiness, loadModel, loadGlossary, readJson } = require('./lib/project')

const argv = process.argv.slice(2)
const maxAt = argv.indexOf('--max')
const MAX = maxAt >= 0 ? Number(argv.splice(maxAt, 2)[1]) || 6000 : 6000
const openAt = argv.indexOf('--open')
const OPEN = openAt >= 0 && !!argv.splice(openAt, 1)
const [projArg, what, ...rest] = argv
const DEV_TEAM = path.resolve(__dirname, '..')
const usage = () => { console.log(fs.readFileSync(__filename, 'utf8').match(/用法：[\s\S]*?\*\//)[0].replace(/\n \*\/?/g, '\n').trim()); process.exit(1) }
if (!projArg || !what) usage()
const root = path.resolve(projArg)
if (!fs.existsSync(path.join(root, 'project.json'))) { console.error('不是项目目录（没有 project.json）：' + root); process.exit(1) }

const out = []
const say = (s = '') => out.push(s)
function flush() {
  let t = out.join('\n')
  if (t.length > MAX) t = t.slice(0, MAX) + `\n…（截断：全文 ${t.length} 字，上限 ${MAX}。取更小的一块，比如 model <名字>.<方法>、step 一步、doc 的某一节；实在要全文加 --max）`
  console.log(t)
}
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s }
const textOf = (x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')
const storyOf = (id) => {
  const p = path.join(root, 'slices', id + '.story.json')
  if (!fs.existsSync(p)) { console.error('没有这个切片的走查：' + p); process.exit(1) }
  return readJson(p)
}

// 在一个模型文件里找挂着这个编号的每一处，报出人读得懂的位置
function tracePlaces(data, id) {
  const hits = []
  const visit = (node, where) => {
    if (Array.isArray(node)) { node.forEach((x, i) => visit(x, `${where}[${x && typeof x === 'object' && x.name ? x.name : i + 1}]`)); return }
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.traces) && node.traces.includes(id)) hits.push({ where: where || '（整个元素）', text: textOf(node) })
    for (const [k, v] of Object.entries(node)) if (k !== 'traces' && k !== 'decisions' && v && typeof v === 'object') visit(v, where ? `${where}.${k}` : k)
  }
  visit(data, '')
  return hits
}

function lookStatement(id) {
  const st = loadBusiness(root).find((s) => s.id === id)
  if (!st) { say('业务里没有 ' + id); return }
  say(`[${st.id}]${st.labelLayer || st.ruleKind ? ` (${[st.labelLayer, st.rawKind].filter(Boolean).join('-')})` : ''} ${st.text}`)
  say(`出处：${st.file}:${st.line}`)
  const model = loadModel(root)
  const places = []
  for (const el of model.elements) if (el.data) for (const h of tracePlaces(el.data, id)) places.push(`${el.data.name ?? el.className} ${h.where}${h.text ? '：' + clip(h.text, 90) : ''}`)
  say(places.length ? `模型里挂着它的 ${places.length} 处：\n  ` + places.join('\n  ') : '模型里没有地方挂着它')
  const slicesDir = path.join(root, 'slices')
  const steps = []
  if (fs.existsSync(slicesDir)) for (const f of fs.readdirSync(slicesDir).filter((f) => f.endsWith('.story.json'))) {
    const s = readJson(path.join(slicesDir, f))
    for (const x of s.steps ?? []) if ((x.traces ?? []).includes(id)) steps.push(`${s.slice ?? f.replace('.story.json', '')} 第 ${x.n} 步`)
  }
  if (steps.length) say('走查用到它：' + steps.join('、'))
}

function lookTerm(name) {
  const terms = loadGlossary(root).terms ?? []
  const hit = terms.find((t) => t.name === name || (t.aliases ?? []).includes(name))
  if (hit) { say(`${hit.name}${hit.aliases?.length ? `（别名：${hit.aliases.join('、')}）` : ''}\n${hit.definition ?? ''}`); return }
  const near = terms.filter((t) => t.name.includes(name) || (t.aliases ?? []).some((a) => a.includes(name)))
  say(near.length ? `没有叫「${name}」的；名字或别名里含它的：${near.map((t) => t.name).join('、')}` : `词汇表里没有「${name}」`)
}

function methodText(m, title) {
  say(title)
  if (m.purpose) say('作用：' + textOf(m.purpose))
  if (m.note) say('说明：' + textOf(m.note))
  if (m.input?.length) { say('入参：'); for (const p of m.input) say(`  ${p.name}: ${p.type}${p.note ? '　' + textOf(p.note) : ''}`) }
  if (m.reads?.length) say('读：' + m.reads.join('、'))
  if (m.writes?.length) say('写：' + m.writes.join('、'))
  if (m.steps?.length) { say('做法：'); m.steps.forEach((s, i) => say(`  ${i + 1}. ${textOf(s)}${s.changes?.length ? `（改：${s.changes.join('、')}）` : ''}`)) }
  if (m.rules?.length) { say('规则：'); m.rules.forEach((r, i) => say(`  ${i + 1}. ${textOf(r)}${r.traces?.length ? ' ' + r.traces.join(' ') : ''}`)) }
  if (m.throws?.length) say('错误：' + m.throws.join('、'))
  if (m.raises?.length) say('事件：' + m.raises.map((r) => (typeof r === 'string' ? r : r.event)).join('、'))
  if (m.output) say('返回：' + (typeof m.output === 'string' ? m.output : JSON.stringify(m.output)))
  if (m.traces?.length) say('挂着：' + m.traces.join(' '))
}

function lookModel(spec) {
  const [name, part] = spec.split('.')
  const el = loadModel(root).elements.find((e) => e.data?.name === name || e.className === name)
  if (!el) { say('模型里没有 ' + name); return }
  const d = el.data
  if (!part) {
    say(`${el.kind} ${d.name}　${el.file}`)
    if (d.condition) say('表示：' + d.condition)
    if (d.aggregateNarrative) say('叙述：' + clip(textOf(d.aggregateNarrative), 120) + '（全文：.narrative）')
    if (d.fields?.length) say(`字段 ${d.fields.length} 个：` + d.fields.map((f) => f.name).join('、') + '（全表：.fields）')
    const inv = [...(d.aggregateInvariants ?? []), ...(d.invariants ?? [])]
    if (inv.length) say(`不变量 ${inv.length} 条（全文：.invariants）`)
    if (d.create) say('create：' + clip(textOf(d.create.purpose), 80) + `（规则 ${d.create.rules?.length ?? 0} 条）`)
    for (const b of [...(d.behaviors ?? []), ...(d.operations ?? [])]) say(`${b.name}：${clip(textOf(b.purpose), 80)}（规则 ${b.rules?.length ?? 0} 条）`)
    if (d.payload) say('载荷：' + d.payload.map((p) => p.name).join('、'))
    if (d.steps && !d.behaviors) d.steps.forEach((s, i) => say(`  ${i + 1}. ${clip(textOf(s), 100)}`))
    return
  }
  if (part === 'fields') { for (const f of d.fields ?? []) say(`${f.name}: ${f.type}${f.nullable ? '（可空）' : ''}${f.note ? '　' + textOf(f.note) : ''}${f.traces?.length ? ' ' + f.traces.join(' ') : ''}`); return }
  if (part === 'invariants') { [...(d.aggregateInvariants ?? []), ...(d.invariants ?? [])].forEach((r, i) => say(`${i + 1}. ${textOf(r)}${r.throws?.length ? `（抛 ${r.throws.join('、')}）` : ''}${r.traces?.length ? ' ' + r.traces.join(' ') : ''}`)); return }
  if (part === 'narrative') { say(textOf(d.aggregateNarrative) || '（没有叙述）'); return }
  if (part === 'create') { if (!d.create) say(`${d.name} 没有 create`); else methodText(d.create, `${d.name} 的创建`); return }
  const m = [...(d.behaviors ?? []), ...(d.operations ?? [])].find((b) => b.name === part)
  if (!m) { say(`${d.name} 没有 ${part}；有：${[...(d.behaviors ?? []), ...(d.operations ?? [])].map((b) => b.name).join('、') || '（无方法）'}`); return }
  methodText(m, `${d.name}.${m.name}`)
}

function lookStep(slice, range) {
  const s = storyOf(slice)
  const [a, b] = String(range ?? '').split('-').map(Number)
  if (!a) { say('用法：step <切片> <n>[-<m>]'); return }
  for (const x of (s.steps ?? []).filter((x) => x.n >= a && x.n <= (b || a))) {
    say(`第 ${x.n} 步　${x.day ?? ''}　${x.actor ?? ''}`)
    say(x.text ?? '')
    if (x.traces?.length) say('编号：' + x.traces.join(' '))
    if (x.walk) {
      const w = x.walk
      say(`walk：${w.kind}${w.name ? ' ' + w.name : ''}`)
      for (const c of w.changes ?? []) say('  - ' + c)
      if (w.gap) say('  缺口：' + w.gap)
    }
    if (x.review?.verdict) say(`他的勾：${x.review.verdict}${x.review.note ? '　' + x.review.note : ''}`)
    say()
  }
}

function lookGap(slice, n) {
  const gaps = storyOf(slice).gaps ?? []
  if (n) { const g = gaps[Number(n) - 1]; say(g === undefined ? `没有第 ${n} 条（共 ${gaps.length} 条）` : `第 ${n} 条：${textOf(g)}`); return }
  gaps.forEach((g, i) => say(`${i + 1}. ${clip(textOf(g), 80)}`))
}

function lookJudge(id) {
  const p = path.join(root, 'reports', 'validate-1.json')
  if (!fs.existsSync(p)) { say('还没有 reports/validate-1.json'); return }
  const js = readJson(p).judgments ?? []
  if (id) {
    const hit = js.filter((j) => j.target === id)
    if (!hit.length) { say('没有 ' + id + ' 的判断'); return }
    for (const j of hit) {
      say(`${j.target}　${j.check}　重要度 ${j.importance}　判定 ${j.verdict ?? '（没填）'}　自信 ${j.confidence ?? '—'}`)
      if (j.ask) say('问：' + j.ask)
      say('业务：' + j.sides.business)
      say('模型：' + j.sides.model)
      if (j.reason) say('理由：' + j.reason)
      say()
    }
    return
  }
  const list = OPEN ? js.filter((j) => !j.verdict) : js
  say(`${OPEN ? '没填的' : '全部'} ${list.length} 条（共 ${js.length}）`)
  for (const j of list) say(`${j.target}　${j.importance}　${j.verdict ?? '没填'}${j.confidence ? '/' + j.confidence : ''}　${clip(j.check, 20)}`)
}

function lookDoc(file, key) {
  // agents/ 底下的规范，写不写 agents/ 前缀都认（派工书索引里印的是 model/shapes.md 那种短写法）
  const p = [path.join(root, file), path.join(DEV_TEAM, file), path.join(DEV_TEAM, 'agents', file)].find((x) => fs.existsSync(x))
  if (!p) { say('找不到 ' + file + '（按项目、按 dev-team 都找过）'); return }
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  const heads = lines.map((l, i) => ({ i, m: /^(#{1,6})\s+(.*)$/.exec(l) })).filter((h) => h.m)
  if (!key) { say(`${file} 的小节（${lines.length} 行）：`); for (const h of heads) say(`${'  '.repeat(h.m[1].length - 1)}${h.m[2]}`); return }
  try { // 记一笔：取回过哪一节。常取的升进派工书默认，从不取的彻底裁掉（第一百七十一批）
    const sc = JSON.parse(fs.readFileSync(path.join(root, 'reports', '_scene.json'), 'utf8'))
    fs.appendFileSync(path.join(root, 'reports', '_look-doc.jsonl'), JSON.stringify({ ts: new Date().toISOString(), who: sc.who ?? null, slice: sc.slice ?? null, step: sc.step ?? null, file, key }) + '\n')
  } catch { /* 没有现场看板或写不进去就不记，取回本身照做 */ }
  const at = heads.findIndex((h) => h.m[2].includes(key))
  if (at < 0) { say(`${file} 里没有标题含「${key}」的小节`); return }
  const level = heads[at].m[1].length
  const end = heads.slice(at + 1).find((h) => h.m[1].length <= level)
  say(lines.slice(heads[at].i, end ? end.i : lines.length).join('\n').trim())
}

// 一次取多块：用 + 隔开的几段，逐段照单块那样取（第一百七十批）
function one(parts) {
  const [what, ...rest] = parts
  if (!what) return
  if (/^[GRU]-\d{3,}$/.test(what)) lookStatement(what)
  else if (what === 'term') lookTerm(rest.join(' '))
  else if (what === 'model' && rest[0]) lookModel(rest[0])
  else if (what === 'step') lookStep(rest[0], rest[1])
  else if (what === 'gap' && rest[0]) lookGap(rest[0], rest[1])
  else if (what === 'judge') lookJudge(rest[0])
  else if (what === 'doc' && rest[0]) lookDoc(rest[0], rest.slice(1).join(' '))
  else { say('看不懂要取什么：' + [what, ...rest].join(' ')); say('') }
}
const groups = [[]]
for (const a of [what, ...rest]) { if (a === '+') groups.push([]); else groups[groups.length - 1].push(a) }
groups.forEach((g, i) => { if (i) say('———'); one(g) })
flush()
