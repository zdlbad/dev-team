#!/usr/bin/env node
/**
 * 现场看板。开发指挥在上面写：当前在哪条故事线的哪一段、走到哪一步、谁在干什么。
 * 人打开页面就近似实时看得见后台角色的动向（页面每 2 秒自己取一次）。
 *
 * 用法：
 *   node tools/scene.js <项目> set --slice <id> --step "<这一步在做什么>" --who <角色>
 *                                  [--phase 业务|模型|编码|校验] [--note "<一句话>"] [--done]
 *   node tools/scene.js <项目> progress <角色> "<一句>"        细步：角色每做完一个小动作写一句（新建了什么、把什么从 xxx 改成 xxx）；挂在当前这一步下面，页面 2 秒一刷
 *                                （角色名也可以改用 --who 写在后面；写在前面与 dispatch、back 一致）
 *   node tools/scene.js <项目> ask "<问题>" --who <角色> --doing "<在做什么>" --context "<上下文>"
 *                                --options "甲：…|乙：…" --lean "<你偏向哪个>" --confidence 高|中|低
 *                                                 角色遇到要人裁的事，当场发问然后停下交回开发指挥（第七十三批）
 *   node tools/scene.js <项目> mode [逐个|问卷]      问答模式：人在电脑前就逐个问、当场答（缺省）；人去跑长任务就攒成问卷，
 *                                                 角色照自己偏向的先做下去，人回来一次性答，跟偏向不一样的再返工
 *   node tools/scene.js <项目> questions [--all] [--问卷]   列出等人回答的问题；--问卷 排成一份编号问卷，人可以一口气答完
 *   node tools/scene.js <项目> answer <问题号> "<人怎么答的>"   把人的答复记上，问题就算答完
 *   node tools/scene.js <项目> handoff "<一段话>"    收工交接：停在哪、等谁、有什么坑。换台机器的人打开看板先看它
 *   node tools/scene.js <项目> dispatch <角色> "<派了什么活，一句>"          开发指挥派角色时记一笔（谁、什么活、几点）
 *   node tools/scene.js <项目> back <角色> "<交回摘要，一句>" [--tokens n] [--tools n] [--ms n] [--outcome 交回|发问|没交回]
 *                                                 角色交回时记一笔：算出这一趟从派到回花了多久、用了多少
 *   node tools/scene.js <项目> journal [YYYY-MM-DD]  打印那一天的日志：按「派工」分块，每块里是角色的细步与耗时；给人复盘用
 *
 * 日志：现场看板上的每一笔（set / progress / ask / answer / mode / handoff / dispatch / back）都追加进
 * journal/<UTC 日期>.jsonl，只追加不裁剪（看板的 timeline 只留最近 60 条，日志是全的）。工作台「日志」页读它。
 *   node tools/scene.js <项目> serve [--port 4873]
 *   node tools/scene.js <项目>                      打印一屏（不起页面）
 *
 * 每次写都记下机器名；换了机器还没 git pull 就动手，看板和 slice next 都会提醒。
 *
 * 状态存 reports/_scene.json（随 git 走——reports/ 里的 json 都进 git，md 与 html 是重算出来的才忽略；开发指挥的写入目标之一，见 agents/common/project-layout.md 的写入权表）。
 * 角色名用 agents/README.md 的叫法：人、开发指挥、业务分析、讲解、文职、模型师、原型、接口、编码、模型校验、pre-pr 审查、解读。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')
const ME = os.hostname()
const mel = require('./lib/time') // 打印给人看的钟点用墨尔本；写进文件的仍是 UTC 的 ISO 串

const ROLES = ['人', '开发指挥', '业务分析', '讲解', '文职', '模型师', '原型', '接口', '编码', '模型校验', 'pre-pr 审查', '解读']
const PHASES = ['业务', '模型', '编码', '校验']
/** 问答模式：逐个＝人在电脑前，角色问完就停下等答；问卷＝人不在，角色照偏向先做，问题攒起来一次性答 */
const ASK_MODES = ['逐个', '问卷']
const die = (m) => {
  console.error(m)
  process.exit(1)
}

const args = process.argv.slice(2)
if (!args.length) die('用法：node tools/scene.js <项目> [set …|serve]')
const root = path.resolve(args[0])
if (!fs.existsSync(path.join(root, 'project.json'))) die(`不是项目目录（没有 project.json）：${root}`)
const cmd = args[1] ?? 'show'
/** 所有 --x 后面跟的值：取「第一个不带 -- 的参数」当正文时要把它们排掉 */
const USED = new Set(args.filter((a, i) => i > 0 && args[i - 1].startsWith('--')))
const opt = (k, d = null) => {
  const i = args.indexOf(k)
  return i > 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}

const scenePath = path.join(root, 'reports', '_scene.json')
const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return d
  }
}
const projectName = readJson(path.join(root, 'project.json'), {}).name ?? path.basename(root)

// ---------- 日志：只追加 ----------
const journalDir = path.join(root, 'journal')
const journalPath = (day) => path.join(journalDir, `${day}.jsonl`)
/** 记一笔进当天（UTC）的日志文件；看板怎么裁剪都不影响它 */
function journal(entry) {
  const ts = entry.ts ?? new Date().toISOString()
  fs.mkdirSync(journalDir, { recursive: true })
  fs.appendFileSync(journalPath(ts.slice(0, 10)), JSON.stringify({ ts, machine: ME, ...entry }) + '\n')
}
/** 读一天（或几天）的日志，按时间排好 */
function readJournal(days) {
  const out = []
  for (const d of days) {
    const p = journalPath(d)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ } }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts))
}
const fmtMs = (ms) => { if (ms == null) return ''; const s = Math.round(ms / 1000); if (s < 60) return `${s} 秒`; const m = Math.floor(s / 60); return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分` }
const fmtK = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} 小时` : `${Math.floor(h / 24)} 天`
}

function readScene() {
  return readJson(scenePath, { slice: null, phase: null, step: null, who: null, note: null, since: null, updatedAt: null, machine: null, handoff: null, timeline: [], progress: [], questions: [], askMode: ASK_MODES[0] })
}
function writeScene(s) {
  fs.mkdirSync(path.dirname(scenePath), { recursive: true })
  fs.writeFileSync(scenePath, JSON.stringify(s, null, 2) + '\n')
}

/** 切片记录 + 故事，给页面当底图 */
function slices() {
  const dir = path.join(root, 'slices')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.story.json') && !f.startsWith('_'))
    .map((f) => {
      const d = readJson(path.join(dir, f), null)
      if (!d) return null
      const st = require('./lib/project').currentStory(root, f.replace(/\.json$/, ''))?.story ?? null
      const steps = st?.steps ?? []
      const lit = new Set()
      for (const x of steps) for (const t of x.traces ?? []) lit.add(t)
      return {
        id: d.id,
        title: d.title,
        kind: d.kind,
        intent: d.intent ?? '',
        line: d.businessStory ?? '',
        modules: d.scope?.modules ?? [],
        traces: lit.size || (d.traces ?? []).length,
        stages: d.stages ?? {},
        steps: steps.length,
        // 待点亮 = 讲解写了 needs、业务分析还没回填 traces
        dark: steps.filter((s) => (s.needs ?? []).length && !(s.traces ?? []).length).length,
        approved: st?.approved ?? null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

// ---------- set ----------
if (cmd === 'set') {
  const s = readScene()
  const slice = opt('--slice', s.slice)
  const who = opt('--who', s.who)
  const step = opt('--step', s.step)
  const phase = opt('--phase', s.phase)
  const note = opt('--note', null)
  if (who && !ROLES.includes(who)) die(`--who 要用 agents/README.md 的角色名：${ROLES.join('、')}`)
  if (phase && !PHASES.includes(phase)) die(`--phase 只有：${PHASES.join('、')}`)
  if (!step) die('--step 是必填的：这一步在做什么，一句人话')
  const now = new Date().toISOString()
  const changed = step !== s.step || who !== s.who || slice !== s.slice
  const entry = { ts: now, slice, phase, step, who, note, done: args.includes('--done'), machine: ME }
  writeScene({
    ...s,
    slice,
    phase,
    step,
    who,
    note,
    since: changed ? now : (s.since ?? now),
    updatedAt: now,
    machine: ME,
    timeline: [...(s.timeline ?? []), entry].slice(-60),
    progress: changed ? [] : (s.progress ?? []),
  })
  journal({ ts: now, kind: 'set', who, slice, phase, text: step, note, done: args.includes('--done') })
  console.log(`现场已更新：${slice ?? '—'} · ${phase ?? '—'} · ${who ?? '—'} · ${step}`)
  process.exit(0)
}

// ---------- progress：角色的细步 ----------
// 角色（子 agent）每做完一个小动作写一句：新建了哪个错误、把哪条规则从什么改成什么、哪个测试绿了。
// 大步（这一步在做什么、谁在干）仍由开发指挥 set；细步挂在当前大步下面，换一步就清空，动态里保留。
if (cmd === 'progress') {
  const whoOpt = opt('--who')
  const rest = args.slice(2).filter((a) => !a.startsWith('--') && a !== whoOpt)
  // 角色名写在正文前面也认。dispatch 与 back 都是「<角色> "<一句>"」，只有这里原先非得用 --who，
  // 三个角色命令两种写法，派工的人最容易在这里写错——而且错得不响：角色名被当成正文照样记下，
  // 一直到 back 才报「0 句细步」（2026-09-18 业务分析那一趟四句细步就这么全丢了）。
  let who = whoOpt
  let text = rest[0]
  if (rest[0] && ROLES.includes(rest[0])) {
    if (!rest[1]) die(`只写了角色名、没写细步正文。用法：scene progress <项目> ${rest[0]} "<一句：做了什么，具体到名字、从什么到什么>"`)
    who = who ?? rest[0]
    text = rest[1]
  }
  if (!text) die('用法：scene progress <项目> "<一句：做了什么，具体到名字、从什么到什么>" [--who 角色]；角色名写在正文前面也认')
  const s = readScene()
  who = who ?? s.who
  if (who && !ROLES.includes(who)) die(`--who 要用 agents/README.md 的角色名：${ROLES.join('、')}`)
  const now = new Date().toISOString()
  const entry = { ts: now, who, text, machine: ME }
  writeScene({
    ...s,
    updatedAt: now,
    progress: [...(s.progress ?? []), entry].slice(-40),
    timeline: [...(s.timeline ?? []), { ts: now, slice: s.slice, phase: s.phase, step: s.step, who, note: text, kind: 'progress', machine: ME }].slice(-60),
  })
  journal({ ts: now, kind: 'progress', who, slice: s.slice, phase: s.phase, text })
  console.log(`细步：${who ?? '—'} · ${text}`)
  process.exit(0)
}

// ---------- mode：问答模式 ----------
if (cmd === 'mode') {
  const s0 = readScene()
  const want = args.slice(2).find((a) => !a.startsWith('--'))
  if (!want) {
    const m = s0.askMode ?? ASK_MODES[0]
    console.log(`现在是「${m}」模式：${m === '逐个' ? '角色问完就停下，开发指挥当场把问题转给人，答了再让它接着跑' : '角色照自己偏向的那个先做下去，问题攒成一份问卷；人回来一次性答，跟偏向不一样的叫回角色返工'}`)
    const open = (s0.questions ?? []).filter((q) => !q.answeredAt)
    if (open.length) console.log(`攒着 ${open.length} 个问题没答（scene questions --问卷 排成问卷）`)
    process.exit(0)
  }
  if (!ASK_MODES.includes(want)) die(`只有两种模式：${ASK_MODES.join('、')}`)
  const note = opt('--note', null)
  const now = new Date().toISOString()
  writeScene({ ...s0, askMode: want, updatedAt: now, machine: ME,
    timeline: [...(s0.timeline ?? []), { ts: now, slice: s0.slice, phase: s0.phase, step: `问答改成「${want}」模式${note ? '：' + note : ''}`, who: '人', kind: 'mode', machine: ME }].slice(-60) })
  journal({ ts: now, kind: 'mode', who: '人', slice: s0.slice, phase: s0.phase, text: `问答改成「${want}」模式${note ? '：' + note : ''}` })
  console.log(want === '逐个'
    ? '改成「逐个」模式：角色遇到要人裁的事问完就停下，开发指挥当场转给人。'
    : '改成「问卷」模式：角色照自己偏向的那个先做下去，把问题攒起来；人回来 scene questions --问卷 一次性答，跟偏向不一样的把角色叫回来返工。')
  process.exit(0)
}

// ---------- ask：角色当场发问 ----------
// 第七十三批（2026-09-13 项目所有者）：要人裁的事别攒到交稿一次性列出来，遇到就问，五件事说全：
// 在做什么、上下文是怎样、遇到了什么问题、两到四个答案、你偏向哪个、信心高低。
// 问完角色就停下交回开发指挥；开发指挥立刻转给人，人答了再把角色接着往下跑（上下文还在）。
const CONFIDENCE = ['高', '中', '低']
if (cmd === 'ask') {
  const s0 = readScene()
  const question = args.slice(2).find((a) => !a.startsWith('--') && !USED.has(a))
  const who = opt('--who', s0.who)
  const doing = opt('--doing', null)
  const context = opt('--context', null)
  const optionsRaw = opt('--options', null)
  const lean = opt('--lean', null)
  const confidence = opt('--confidence', null)
  const missing = []
  if (!question) missing.push('问题正文（第一个不带 -- 的参数）')
  if (!doing) missing.push('--doing 你当时在做什么')
  if (!context) missing.push('--context 上下文：这件事牵涉到谁、哪个文件、哪一步')
  if (!optionsRaw) missing.push('--options 两到四个答案，用 | 隔开')
  if (!lean) missing.push('--lean 你偏向哪个')
  if (!confidence) missing.push('--confidence 信心 高|中|低')
  if (missing.length) die('发问要说全五件事，缺了：\n  ' + missing.join('\n  ') + '\n用法：scene ask <项目> "<问题>" --who <角色> --doing "…" --context "…" --options "甲：…|乙：…" --lean "甲" --confidence 中')
  if (who && !ROLES.includes(who)) die(`--who 要用 agents/README.md 的角色名：${ROLES.join('、')}`)
  if (!CONFIDENCE.includes(confidence)) die(`--confidence 只有：${CONFIDENCE.join('、')}`)
  const options = optionsRaw.split('|').map((x) => x.trim()).filter(Boolean)
  if (options.length < 2 || options.length > 4) die(`--options 要两到四个（用 | 隔开），现在是 ${options.length} 个`)
  const now = new Date().toISOString()
  const qs = s0.questions ?? []
  const id = 'q-' + String(qs.length + 1).padStart(3, '0')
  const mode = s0.askMode ?? ASK_MODES[0]
  const q = { id, ts: now, who, slice: s0.slice, phase: s0.phase, step: s0.step, doing, context, question, options, lean, confidence, mode, wentAhead: mode === '问卷' ? lean : null, answer: null, answeredAt: null, machine: ME }
  writeScene({
    ...s0,
    updatedAt: now,
    questions: [...qs, q],
    timeline: [...(s0.timeline ?? []), { ts: now, slice: s0.slice, phase: s0.phase, step: '发问：' + question.slice(0, 50) + (question.length > 50 ? '…' : ''), who, note: null, kind: 'ask', machine: ME }].slice(-60),
  })
  journal({ ts: now, kind: 'ask', who, slice: s0.slice, phase: s0.phase, id, text: question, lean, confidence, mode })
  console.log(mode === '逐个'
    ? `${id} 已挂上等人回答：${question}\n现在是「逐个」模式：停下来把这个问题交回开发指挥，别自己替人拿主意、别一边等一边往下写。`
    : `${id} 已攒进问卷：${question}\n现在是「问卷」模式：人不在，照你偏向的「${lean}」先做下去，别停。\n写一句细步说明这一处是按偏向做的（scene progress），交稿里也列出来——人回来答了，跟偏向不一样的那几处要返工。`)
  process.exit(0)
}

// ---------- questions：开发指挥把等人回答的问题取出来转给人 ----------
if (cmd === 'questions') {
  const s0 = readScene()
  const all = args.includes('--all')
  const list = (s0.questions ?? []).filter((q) => all || !q.answeredAt)
  if (!list.length) { console.log(all ? '一个问题都没提过' : '没有等人回答的问题'); process.exit(0) }
  const asForm = args.includes('--问卷') || args.includes('--form')
  if (asForm) {
    console.log(`一共 ${list.length} 个问题。挨个答就行，可以只写号码加你选的那个。\n`)
    list.forEach((q, i) => {
      console.log(`${i + 1}. ${q.question}　（${q.id}，${q.who ?? '—'} 问的）`)
      console.log(`   在做什么：${q.doing}`)
      console.log(`   上下文：${q.context}`)
      q.options.forEach((o, j) => console.log(`   ${j + 1}）${o}`))
      console.log(`   它偏向：${q.lean}（信心${q.confidence}）${q.wentAhead ? `——人不在，已经照这个先做下去了，你选别的就要返工` : ''}`)
      if (q.answeredAt) console.log(`   你答过：${q.answer}`)
      console.log('')
    })
    console.log('答完用 scene answer <问题号或序号> "<你的答复>" 一条条记上。')
    process.exit(0)
  }
  for (const q of list) {
    console.log(`${q.id}　${q.who ?? '—'}　${ago(q.ts)}前${q.answeredAt ? '　已答' : '　等人'}${q.wentAhead ? `　（问卷模式：已按「${q.wentAhead}」先做）` : ''}`)
    console.log(`  在做什么　${q.doing}`)
    console.log(`  上下文　　${q.context}`)
    console.log(`  问题　　　${q.question}`)
    q.options.forEach((o, i) => console.log(`  答案 ${i + 1}　${o}`))
    console.log(`  偏向　　　${q.lean}（信心${q.confidence}）`)
    if (q.answeredAt) console.log(`  人答　　　${q.answer}${(q.answerHistory ?? []).length ? `　（改过 ${q.answerHistory.length} 次，原来答的是「${q.answerHistory[0].answer}」）` : ''}`)
    console.log('')
  }
  process.exit(0)
}

// ---------- answer：把人的答复记上 ----------
/** 记下人对某个问题的答复。命令行与现场页面共用；页面上答的记 via「网页」 */
function recordAnswer(id, text, via) {
  const s0 = readScene()
  const qs = s0.questions ?? []
  // 问题号（q-003）或问卷上的序号（3，按没答的那几个数）都收
  const open = qs.filter((x) => !x.answeredAt)
  const q = qs.find((x) => x.id === id) ?? (/^[0-9]+$/.test(String(id)) ? open[Number(id) - 1] : null)
  if (!q) return { ok: false, error: `没有这个问题号：${id}（scene questions 看有哪些；问卷上的序号也收）` }
  // 答过的可以改（人在页面上点错是常事）：旧答复进 answerHistory，一条都不抹
  const redo = !!q.answeredAt
  if (!String(text ?? '').trim()) return { ok: false, error: '答复不能是空的' }
  const answer = String(text).trim()
  const now = new Date().toISOString()
  writeScene({
    ...s0,
    updatedAt: now,
    questions: qs.map((x) => (x.id === q.id
      ? { ...x, answer, answeredAt: now, answeredVia: via ?? '对话',
          answerHistory: redo ? [...(x.answerHistory ?? []), { answer: x.answer, at: x.answeredAt, via: x.answeredVia ?? null, replacedAt: now }] : (x.answerHistory ?? undefined) }
      : x)),
    timeline: [...(s0.timeline ?? []), { ts: now, slice: s0.slice, phase: s0.phase, step: `${q.id} 人${redo ? '改答' : '答'}：` + answer.slice(0, 50) + (answer.length > 50 ? '…' : ''), who: '人', note: null, kind: 'answer', machine: ME }].slice(-60),
  })
  journal({ ts: now, kind: 'answer', who: '人', slice: s0.slice, phase: s0.phase, id: q.id, text: answer, redo, via: via ?? '对话', askedBy: q.who ?? null })
  const sameAsLean = q.wentAhead && (answer.includes(q.wentAhead) || answer.includes(String(q.wentAhead).split('：')[0]) || String(q.wentAhead).includes(answer))
  const tail = !q.wentAhead
    ? '（把答复送回问这个问题的角色，让它接着往下跑）'
    : sameAsLean
      ? `（问卷模式里它已经照「${q.wentAhead}」先做了，看着跟你答的一样，多半不用返工——自己再确认一眼）`
      : `（问卷模式里它已经照「${q.wentAhead}」先做了，跟你答的不一样：把 ${q.who ?? '那个角色'} 叫回来返工）`
  return { ok: true, id: q.id, who: q.who, answer, redo, was: redo ? q.answer : null,
    tail: redo ? `（改的，原来答的是「${q.answer}」，已留在 answerHistory 里没抹掉；${q.who ?? '那个角色'} 要是照旧答复做过了，把它叫回来返工）` : tail }
}

if (cmd === 'answer') {
  const rest = args.slice(2).filter((a) => !a.startsWith('--'))
  const id = rest[0]
  const text = rest.slice(1).join(' ').trim()
  if (!id || !text) die('用法：scene answer <项目> <问题号，如 q-001> "<人怎么答的，照他的原话>"')
  const r = recordAnswer(id, text, '对话')
  if (!r.ok) die(r.error)
  console.log(`${r.id} 已记下人${r.redo ? '改后' : ''}的答复：${r.answer}\n${r.tail}`)
  process.exit(0)
}

// ---------- handoff：收工交接 ----------
/** 这条切片上还没答的问题（第一百七十八批） */
function openQuestionsOf(sc, sliceId) {
  return (sc.questions ?? []).filter((q) => q.slice === sliceId && !q.answeredAt)
}
/** 机器上看得见的「等他」：校验与审查报告里还等他按的那些（审模型页、审代码页） */
function humanTodoCount() {
  let n = 0
  for (const fn of ['validate-1.json', 'validate-2.json', 'pre-pr-proto.json', 'pre-pr-shell.json']) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(root, 'reports', fn), 'utf8'))
      n += require('./lib/project').humanTodo(r).length
    } catch {}
  }
  return n
}

/** 这条切片业务这一关的状态；读不到切片记录就当 done，不拦 */
function businessStatusOf(sliceId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'slices', sliceId + '.json'), 'utf8'))
    return j.stages?.business?.status ?? 'done'
  } catch { return 'done' }
}

if (cmd === 'handoff') {
  const text = args.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!text) die('用法：scene handoff <项目> "<一段话：停在哪、等谁、有什么坑>"')
  const s = readScene()
  // 要人裁的事写成散文，机器一件也看不见：slice next 看不见、工作台看不见、下一段接手的人当它是背景。
  // 2026-09-20 真出过——三个问题只写在交接第 3 条「三个问题等他定」，第二天接手就照着往下派，
  // 立完语句、判完三条，他的答复一到全部重来（第一百七十八批）。
  if (!args.includes('--散文也行')) {
    const 像在说等人 = /等他|等你|等人|要他定|请他|待他|等项目所有者|等裁/.test(text)
    const open = openQuestionsOf(s, s.slice)
    // 拦的是「说有人在等，可机器上一件都看不见」。看板上的问题算、审模型页与审代码页上
    // 等他按的那些也算——那些他打开工作台就看得见，不会像散文那样被下一段接手的人当背景。
    const todo = humanTodoCount()
    if (像在说等人 && !open.length && !todo) {
      die(`交接里写着「等他定」这类话，可看板上这条切片（${s.slice ?? '—'}）一件没答的问题都没有。\n` +
        `先把它们挂上去，交接才写得出谁在等什么：\n` +
        `  node tools/scene.js ${args[0]} ask "<问题>" --who 开发指挥 --doing "<在做什么>" --context "<上下文>" --options "甲：…|乙：…" --lean "<偏向>" --confidence 中\n` +
        `写成散文的等于不存在——第二天接手的人会照着往下派。真要这么写：末尾加 --散文也行。`)
    }
    if (open.length) console.log(`  交接里这条切片有 ${open.length} 件等他答：${open.map((q) => q.id).join('、')}（看板上有，接手的人看得见）`)
    if (todo) console.log(`  报告里还有 ${todo} 件等他按（审模型页 / 审代码页上看得见）`)
  }
  const now = new Date().toISOString()
  writeScene({
    ...s,
    handoff: { text, at: now, machine: ME, slice: s.slice },
    updatedAt: now,
    machine: ME,
    timeline: [...(s.timeline ?? []), { ts: now, slice: s.slice, phase: s.phase, step: '交接：' + text.slice(0, 60) + (text.length > 60 ? '…' : ''), who: '开发指挥', note: null, done: true, machine: ME }].slice(-60),
  })
  journal({ ts: now, kind: 'handoff', who: '开发指挥', slice: s.slice, phase: s.phase, text })
  console.log(`交接已写（${ME}）：${text.slice(0, 80)}`)
  process.exit(0)
}

// ---------- dispatch / back：开发指挥派角色、角色交回，各记一笔 ----------
// 2026-09-14 项目所有者：「一个任务 agent 们会跑很久……我没有 log 可以看到 agent 们是怎样配合的」。
// 派的时候记谁、什么活；回的时候记摘要、用了多少（tokens / 工具次数 / 毫秒，子 agent 的用量汇报里有），算出从派到回多久。
if (cmd === 'dispatch') {
  const who = args[2]
  const text = args.slice(3).find((a) => !a.startsWith('--') && !USED.has(a))
  if (!who || !ROLES.includes(who)) die(`用法：scene dispatch <项目> <角色> "<派了什么活>"；角色名：${ROLES.join('、')}`)
  if (!text) die('要写派了什么活，一句')
  const s = readScene()
  // 上游有待定，下游不开工（第一百七十八批）。业务这一关没定就别派模型及其下游；
  // 业务侧那几个角色照派——把问题问清楚、把语句立好本来就是他们的活。
  const 业务侧 = ['业务分析', '讲解', '文职']
  const bs = s.slice ? businessStatusOf(s.slice) : 'done'
  const open = openQuestionsOf(s, s.slice)
  const 硬派 = args.indexOf('--带着问题派')
  if (!业务侧.includes(who) && (bs !== 'done' || open.length) && 硬派 < 0) {
    die(`⛔ ${s.slice ?? '当前切片'} 的业务这一关是「${bs}」${open.length ? `，还有 ${open.length} 件等他答` : ''}，先不派${who}。\n` +
      open.map((q) => `   ${q.id}　${q.question}`).join('\n') + (open.length ? '\n' : '') +
      `调用顺序是业务 → 模型：上游没定，下游做出来的多半要重来（2026-09-20 就重来过一趟）。\n` +
      `  人答了：node tools/scene.js ${args[0]} answer <问题号> "<他怎么答的>"\n` +
      `  业务定了：node tools/slice.js advance <项目> ${s.slice ?? '<切片>'} business done\n` +
      `  确实挡不住这一趟：末尾加 --带着问题派 "<为什么这几条不影响它>"，理由会记进日志。`)
  }
  const now = new Date().toISOString()
  const 硬派理由 = 硬派 >= 0 ? (args[硬派 + 1] ?? '') : null
  if (硬派 >= 0 && !硬派理由) die('--带着问题派 后面要写一句为什么这几条不影响这一趟')
  journal({ ts: now, kind: 'dispatch', who, by: '开发指挥', slice: s.slice, phase: s.phase, text, ...(硬派理由 ? { 带着问题派: 硬派理由 } : {}) })
  console.log(`派工已记：${who} · ${text}`)
  if (硬派理由) console.log(`  ⚠ 带着 ${open.length} 件没答的问题派的，理由已记进日志：${硬派理由}`)
  // 2026-09-17：角色不写细步，人就只看得见「开工了」。派工时提醒开发指挥把这句写进提示词。
  // 2026-09-18：光提醒不够——开发指挥得自己现编命令，编错了还不响（业务分析那一趟四句细步全记成了「业务分析」）。
  // 改成把两行命令连角色名一起印出来，直接抄进提示词。
  const job = opt('--活')
  const briefTip = job
    ? `node tools/brief.js ${who} --活 ${job} --写 <scratchpad>/brief-${who}.md`
    : `node tools/brief.js ${who} --活 <这趟干什么> --写 <scratchpad>/brief-${who}.md`
  console.log(`
  ——————— 提示骨架，改完直接用（第一百七十六、一百七十八批）———————
  先跑：${briefTip}
  然后：

  你是 dev-team 的「${who}」。你的规矩在 <上面那个路径>，先用 Read 整份读一遍（一次读完，别分段）。

  项目目录：<绝对路径>        dev-team 目录：<绝对路径>（下称 $DEV_TEAM）
  切片：${s.slice ?? '<id>'}（标题；scope；traces）
  任务：${text}

  ★ 你已经知道、别让它去查的：<现成的格式、一条样例、文件在哪一行、上一趟的结论>
    ——这一栏空着就别发。2026-09-20 一句「照词汇表里现有错误的写法定」让角色花了 12 轮考古，
    贴一条现成词条只要 300 个 token。要它自己看、自己判的那些别贴，那种轮数省不得。

  细步：node tools/scene.js ${args[0]} progress ${who} "<一句：做了什么，具体到名字、从什么到什么>"
  交回：node tools/scene.js ${args[0]} back ${who} "<交回摘要，一句>"　　二十行以内
  ————————————————————————————————————————`)
  process.exit(0)
}
if (cmd === 'back') {
  const who = args[2]
  const text = args.slice(3).find((a) => !a.startsWith('--') && !USED.has(a))
  if (!who || !ROLES.includes(who)) die(`用法：scene back <项目> <角色> "<交回摘要>" [--tokens n] [--tools n] [--ms n] [--outcome 交回|发问|没交回]`)
  if (!text) die('要写交回了什么，一句')
  const s = readScene()
  const now = new Date().toISOString()
  const today = now.slice(0, 10), yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const all = readJournal([yesterday, today])
  // 这一趟从哪次派工算起：同一角色最近一次 dispatch，且它后面还没有 back
  let start = null, already = null
  for (let i = all.length - 1; i >= 0; i--) { const e = all[i]; if (e.who !== who) continue; if (e.kind === 'back') { already = e; break } if (e.kind === 'dispatch') { start = e; break } }
  // 角色自己交回过、开发指挥又补记一次：从前会在日志里多出一条没有派工可配的假记录（第一百七十二批）
  if (!start && already) {
    console.log(`这一趟 ${who} 已经交回过了（${already.ts.slice(11, 16)}「${String(already.text).slice(0, 30)}」），不再记一条。`)
    console.log('要补充的话，写进交接或裁定；真要再记一条，先 scene dispatch 起一趟新的。')
    return
  }
  const num = (k) => (opt(k) != null && /^[0-9]+$/.test(opt(k)) ? Number(opt(k)) : null)
  const elapsedMs = start ? new Date(now).getTime() - new Date(start.ts).getTime() : null
  const steps = start ? all.filter((e) => e.kind === 'progress' && e.who === who && e.ts > start.ts).length : null
  journal({ ts: now, kind: 'back', who, slice: s.slice, phase: s.phase, text, outcome: opt('--outcome', '交回'), tokens: num('--tokens'), tools: num('--tools'), ms: num('--ms'), elapsedMs, steps, dispatchedAt: start?.ts ?? null })
  console.log(`交回已记：${who} · ${text}${elapsedMs != null ? `　从派到回 ${fmtMs(elapsedMs)}${steps != null ? `、写了 ${steps} 句细步` : ''}` : '　（没找到这一趟的派工记录）'}${num('--tokens') != null ? `、${fmtK(num('--tokens'))} tokens` : ''}${num('--tools') != null ? `、${num('--tools')} 次工具` : ''}`)
  // 2026-09-17：一趟活一句细步都没有，人这段时间只看得见「开工了」。当场说出来，别等他问。
  if (steps === 0 && elapsedMs != null && elapsedMs > 120000) console.log(`  这一趟 ${fmtMs(elapsedMs)} 里一句细步都没写，人只看得见开工。派下一趟时把「每改完一组跑 scene progress」写进提示词`)
  process.exit(0)
}
/** 把一天的日志按「派工」分块：块 = 从 dispatch 到同角色的 back；角色的 progress 挂进块里；别的事件平铺 */
function groupJournal(entries) {
  const blocks = []
  const open = new Map() // 角色 → 块
  for (const e of entries) {
    if (e.kind === 'dispatch') { const b = { kind: 'block', who: e.who, start: e, items: [], end: null }; blocks.push(b); open.set(e.who, b); continue }
    if (e.kind === 'back' && open.has(e.who)) { const b = open.get(e.who); b.end = e; open.delete(e.who); continue }
    if ((e.kind === 'progress' || e.kind === 'ask') && open.has(e.who)) { open.get(e.who).items.push(e); continue }
    blocks.push({ kind: 'event', e })
  }
  return blocks
}
if (cmd === 'journal') {
  const day = args.slice(2).find((a) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(a)) ?? new Date().toISOString().slice(0, 10)
  const entries = readJournal([day])
  if (!entries.length) die(`${day} 没有日志（journal/${day}.jsonl 不存在或是空的）`)
  const hm = (ts) => ts.slice(11, 19)
  const L = [`日志 · ${projectName} · ${day}（UTC）　共 ${entries.length} 笔`, '']
  const byRole = new Map()
  for (const b of groupJournal(entries)) {
    if (b.kind === 'event') { const e = b.e; L.push(`${hm(e.ts)}  ${e.who ?? '—'}　${{ set: e.done ? '看板（完）' : '看板', ask: '发问', answer: '答', mode: '模式', handoff: '交接', progress: '细步', back: '交回', confirm: '确认', unconfirm: '撤销确认', comment: '留话', review: '审阅' }[e.kind] ?? e.kind}：${e.text}${e.kind === 'set' && e.slice ? `　[${e.slice} · ${e.phase ?? '—'}]` : ''}`); continue }
    const st = b.start, en = b.end
    L.push(`${hm(st.ts)}  开发指挥　派 ${st.who}：${st.text}`)
    let prev = new Date(st.ts).getTime()
    for (const it of b.items) { const t = new Date(it.ts).getTime(); L.push(`    ${hm(it.ts)}  +${fmtMs(t - prev).padEnd(9)} ${it.kind === 'ask' ? '发问：' : ''}${it.text}`); prev = t }
    if (en) {
      L.push(`${hm(en.ts)}  ${en.who}　${en.outcome ?? '交回'}（${fmtMs(en.elapsedMs)}${en.steps != null ? `，${en.steps} 句细步` : ''}${en.tokens != null ? `，${fmtK(en.tokens)} tokens` : ''}${en.tools != null ? `，${en.tools} 次工具` : ''}）：${en.text}`)
      const r = byRole.get(en.who) ?? { n: 0, ms: 0, tokens: 0, tools: 0 }; r.n++; r.ms += en.elapsedMs ?? 0; r.tokens += en.tokens ?? 0; r.tools += en.tools ?? 0; byRole.set(en.who, r)
    } else L.push(`         ${st.who}　（还没交回）`)
    L.push('')
  }
  if (byRole.size) { L.push('按角色算'); for (const [w, r] of byRole) L.push(`  ${w}　派 ${r.n} 趟　共 ${fmtMs(r.ms)}${r.tokens ? `　${fmtK(r.tokens)} tokens` : ''}${r.tools ? `　${r.tools} 次工具` : ''}`) }
  console.log(L.join('\n'))
  process.exit(0)
}

/** 换了机器还没同步的提醒；没换机器返回 null */
function machineWarning(s) {
  if (!s.machine || s.machine === ME) return null
  return `现场上一次是在「${s.machine}」写的，本机是「${ME}」——先确认 git pull 过了再动手`
}

// ---------- 一屏文字 ----------
function textView() {
  const s = readScene()
  const all = slices()
  const cur = all.find((x) => x.id === s.slice)
  const L = []
  L.push(`现场 · ${projectName}`)
  L.push('')
  const mw = machineWarning(s)
  if (mw) { L.push('⚠ ' + mw); L.push('') }
  const open = (s.questions ?? []).filter((q) => !q.answeredAt)
  if (open.length) L.push(`问答模式：${s.askMode ?? ASK_MODES[0]}${(s.askMode ?? ASK_MODES[0]) === '问卷' ? '（角色照自己偏向的先做着，等你一次性答）' : ''}`)
  for (const q of open) {
    L.push(`● ${q.id} 等你回答（${q.who ?? '—'}，${ago(q.ts)}前）`)
    L.push(`  在做什么　${q.doing}`)
    L.push(`  上下文　　${q.context}`)
    L.push(`  问题　　　${q.question}`)
    q.options.forEach((o, i) => L.push(`  答案 ${i + 1}　${o}`))
    L.push(`  偏向　　　${q.lean}（信心${q.confidence}）${q.wentAhead ? '　——已经照这个先做下去了' : ''}`)
    L.push('')
  }
  if (s.handoff) { L.push(`交接（${s.handoff.machine}，${ago(s.handoff.at)}前）　${s.handoff.text}`); L.push('') }
  if (cur) {
    if (cur.line) L.push(`故事线　${cur.line}`)
    L.push(`段落　　${cur.title}（${cur.id}）`)
    if (cur.intent) L.push(`意图　　${cur.intent}`)
    L.push(`范围　　${cur.modules.join('、') || '（未定）'}　·　故事 ${cur.steps} 步${cur.dark ? `，其中 ${cur.dark} 步待点亮` : ''}　·　编号 ${cur.traces} 条`)
  }
  L.push(`阶段　　${s.phase ?? '—'}`)
  L.push(`这一步　${s.step ?? '—'}`)
  L.push(`谁在干　${s.who ?? '—'}${s.since ? `　（${ago(s.since)}）` : ''}`)
  if (s.note) L.push(`说明　　${s.note}`)
  const prog = (s.progress ?? []).slice(-6)
  if (prog.length) { L.push('细步'); for (const e of prog) L.push(`  ${mel.hm(e.ts)}　${e.who ?? '—'}　${e.text}`) }
  L.push('')
  L.push('动态')
  for (const e of (s.timeline ?? []).slice(-8)) L.push(e.kind === 'progress' ? `  ${mel.mdhm(e.ts)}　${e.who ?? '—'}　　└ ${e.note}` : `  ${mel.mdhm(e.ts)}　${e.who ?? '—'}　${e.step}`)
  return L.join('\n')
}

if (cmd === 'show') {
  console.log(textView())
  process.exit(0)
}

// ---------- serve ----------
if (cmd !== 'serve') die(`不认得的子命令：${cmd}（set | progress | ask | questions | answer | mode | handoff | dispatch | back | journal | serve | 不带子命令打印一屏）`)

const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>现场 · ${esc(projectName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--hi:#7dd3fc;--ok:#86efac;--warn:#fcd34d;--live:#f472b6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:19px;margin:0 0 2px;font-weight:600}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.row{display:flex;gap:14px;padding:5px 0;align-items:baseline}
.k{color:var(--dim);font-size:13px;width:64px;flex:none}
.v{flex:1;min-width:0}
.big{font-size:22px;font-weight:600;line-height:1.4}
.phases{display:flex;gap:8px;margin:6px 0 14px;flex-wrap:wrap}
.ph{padding:4px 14px;border:1px solid var(--line);border-radius:999px;color:var(--dim);font-size:13px}
.ph.on{background:var(--hi);color:#0b1220;border-color:var(--hi);font-weight:600}
.who{display:inline-flex;align-items:center;gap:8px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;background:var(--live);animation:p 1.4s ease-in-out infinite}
.dot.idle{background:var(--warn);animation:none}
.dot.you{background:var(--ok);animation:none}
@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--dim);font-weight:500;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 10px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr.cur td{background:rgba(125,211,252,.07)}
.tag{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap;display:inline-block}
td:nth-child(n+3),th:nth-child(n+3){white-space:nowrap;width:1%;padding-right:14px}td:nth-child(2){white-space:nowrap;padding-right:18px}td:first-child{min-width:260px}
.tag.done{color:var(--ok);border-color:rgba(134,239,172,.4)}
.tag.now{color:var(--hi);border-color:rgba(125,211,252,.5)}
.tl{font-size:13.5px}
.tl div{padding:4px 0;border-bottom:1px solid var(--line);display:flex;gap:12px}
.tl .t{color:var(--dim);flex:none;width:92px}
.tl .r{color:var(--hi);flex:none;width:88px}
.dim{color:var(--dim)}
.empty{color:var(--dim);padding:8px 0}
.warn{background:rgba(252,211,77,.12);border:1px solid rgba(252,211,77,.5);color:var(--warn);border-radius:10px;padding:10px 14px;margin-bottom:14px}
.hand{border-left:3px solid var(--hi);padding:4px 12px;margin:4px 0 6px;white-space:pre-wrap}
.ask{background:rgba(134,239,172,.08);border:1px solid rgba(134,239,172,.45);border-radius:12px;padding:16px 20px;margin-bottom:14px}
.ask h2{font-size:16px;margin:0 0 10px;color:var(--ok);font-weight:600}
.ask .q{font-size:17px;font-weight:600;margin:10px 0 8px;line-height:1.5}
.ask .opt{padding:4px 0 4px 16px;border-left:2px solid var(--line)}
.ask .opt.lean{border-left-color:var(--ok)}
.ask .meta{display:flex;gap:14px;padding:3px 0;font-size:13.5px}
.ask .meta .k{color:var(--dim);width:64px;flex:none}
.ask .how{color:var(--dim);font-size:12.5px;margin-top:10px}
.ask .opt{cursor:pointer;border-radius:6px;transition:background .12s}
.ask .opt:hover{background:rgba(134,239,172,.10)}
.ask .opt.picked{background:rgba(134,239,172,.18);border-left-color:var(--ok)}
.ask textarea{width:100%;margin-top:10px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:14px/1.6 inherit;resize:vertical;min-height:54px}
.ask .send{margin-top:10px;display:flex;gap:10px;align-items:center}
.ask button{background:var(--ok);color:#0b1220;border:0;border-radius:8px;padding:7px 18px;font:600 14px inherit;cursor:pointer}
.ask button:disabled{opacity:.4;cursor:default}
.ask button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
.prog div{display:flex;gap:10px;padding:2px 0;font-size:13px;border-bottom:1px dashed var(--line,#e5e7eb)}.prog .t{color:#6b7280;font-variant-numeric:tabular-nums}.prog .r{color:#6b7280;min-width:4em}.tl .sub{padding-left:18px;font-size:12px}
</style></head><body><div class="wrap">
<h1>现场 · ${esc(projectName)}</h1>
<div class="sub" id="upd">连接中…</div>
<div id="app"></div>
<div class="sub" style="margin-top:18px">页面每 2 秒自己刷新一次。开发指挥用 <code>scene set</code> 往上写。</div>
</div>
<script>
const $=(s)=>document.querySelector(s)
function hm(iso){var d=new Date(iso),p=function(n){return String(n).padStart(2,'0')};return p(d.getHours())+':'+p(d.getMinutes())}
function mdhm(iso){var d=new Date(iso),p=function(n){return String(n).padStart(2,'0')};return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
function ago(iso){if(!iso)return '';const m=Math.floor((Date.now()-new Date(iso).getTime())/60000);if(m<1)return '刚刚';if(m<60)return m+' 分钟';const h=Math.floor(m/60);return h<24?h+' 小时':Math.floor(h/24)+' 天'}
function esc(x){return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
const PHASES=['业务','模型','编码','校验']
function stageTag(s){if(s==='done')return '<span class="tag done">完</span>';if(s==='in-progress')return '<span class="tag now">在做</span>';return '<span class="tag">待</span>'}
function render(d){
  const s=d.scene,cur=d.slices.find(x=>x.id===s.slice)
  let h=''
  if(d.warning)h+='<div class="warn">⚠ '+esc(d.warning)+'</div>'
  const all=(s.questions||[])
  const open=all.filter(q=>!q.answeredAt)
  const mode=s.askMode||'逐个'
  if(open.length>1)h+='<div class="ask" style="padding:10px 20px"><b>攒着 '+open.length+' 个问题等你</b> <span class="dim">· 问答模式：'+esc(mode)+'</span>'+' ' + LINK + '</div>'
  for(const q of open){
    h+='<div class="ask"><h2>● '+esc(q.id)+' '+(q.answeredAt?'改一下':'等你回答')+' <span class="dim" style="font-weight:400;font-size:13px">'+esc(q.who||'—')+' · '+ago(q.ts)+'前</span></h2>'
    h+='<div class="meta"><div class="k">在做什么</div><div>'+esc(q.doing)+'</div></div>'
    h+='<div class="meta"><div class="k">上下文</div><div>'+esc(q.context)+'</div></div>'
    h+='<div class="q">'+esc(q.question)+'</div>'
    h+=q.options.map(function(o,i){var lean=String(o).indexOf(String(q.lean))===0||String(q.lean).indexOf(String(i+1))===0
      return '<div class="opt'+(lean?' lean':'')+'">'+esc(o)+(lean?' <span class="dim">· 它偏向这个</span>':'')+'</div>'}).join('')
    h+='<div class="meta" style="margin-top:8px"><div class="k">偏向</div><div>'+esc(q.lean)+' <span class="dim">· 信心'+esc(q.confidence)+'</span>'
      +(q.wentAhead?' <span class="dim">· 你不在，已经照这个先做下去了，你选别的就要返工</span>':'')+'</div></div>'
    // 现场页只把问题亮出来；两种模式都给出「等你答」那一页的路——逐个模式下开发指挥会在对话里端给你，
    // 但你想点着答也随时点得到（第一百七十五批）
    h+='<div class="how">'+(mode==='问卷'
      ? '现在是问卷模式：这些攒着等你，<a href="/questions" target="_top" style="color:var(--ok)">去「等你答」那一页</a>一口气答完。'
      : '现在是逐个模式：开发指挥会在 Claude Code 的对话里把这个问题端给你；想点着答就<a href="/questions" target="_top" style="color:var(--ok)">去「等你答」那一页</a>。')+'</div>'
    h+='</div>'
  }

  if(s.handoff)h+='<div class="card"><div class="row"><div class="k">交接</div><div class="v"><div class="hand">'+esc(s.handoff.text)+'</div><span class="dim">'+esc(s.handoff.machine||'')+' · '+ago(s.handoff.at)+'前'+(s.handoff.slice?' · '+esc(s.handoff.slice):'')+'</span></div></div></div>'
  h+='<div class="card">'
  if(cur){
    if(cur.line)h+='<div class="row"><div class="k">故事线</div><div class="v">'+esc(cur.line)+'</div></div>'
    h+='<div class="row"><div class="k">段落</div><div class="v big">'+esc(cur.title)+' <span class="dim" style="font-size:14px;font-weight:400">'+esc(cur.id)+'</span></div></div>'
    if(cur.intent)h+='<div class="row"><div class="k">意图</div><div class="v">'+esc(cur.intent)+'</div></div>'
    h+='<div class="row"><div class="k">范围</div><div class="v">'+(cur.modules.length?esc(cur.modules.join('、')):'<span class="dim">未定</span>')
      +' <span class="dim">· 故事 '+cur.steps+' 步'+(cur.dark?'，其中 <b style="color:var(--warn)">'+cur.dark+' 步待点亮</b>':'')+' · 编号 '+cur.traces+' 条</span></div></div>'
  }else{h+='<div class="empty">还没有指到哪一段（<code>scene set --slice …</code>）</div>'}
  h+='</div>'

  h+='<div class="card"><div class="phases">'+PHASES.map(p=>'<span class="ph'+(p===s.phase?' on':'')+'">'+p+'</span>').join('')+'</div>'
  h+='<div class="row"><div class="k">这一步</div><div class="v big">'+(s.step?esc(s.step):'<span class="dim">—</span>')+'</div></div>'
  const cls=s.who==='人'?'you':(s.who&&s.who!=='开发指挥'?'':'idle')
  h+='<div class="row"><div class="k">谁在干</div><div class="v"><span class="who"><span class="dot '+cls+'"></span>'+esc(s.who||'—')+'</span>'
    +(s.since?' <span class="dim">· 已 '+ago(s.since)+'</span>':'')+(s.who==='人'?' <span class="dim">· 等你</span>':'')+'</div></div>'
  if(s.note)h+='<div class="row"><div class="k">说明</div><div class="v dim">'+esc(s.note)+'</div></div>'
  const pg=(s.progress||[]).slice().reverse().slice(0,12)
  if(pg.length)h+='<div class="row"><div class="k">细步</div><div class="v"><div class="prog">'+pg.map(function(e){return '<div><span class="t">'+esc(hm(e.ts))+'</span><span class="r">'+esc(e.who||'—')+'</span><span>'+esc(e.text)+'</span></div>'}).join('')+'</div></div></div>'
  h+='</div>'

  const line=cur&&cur.line?d.slices.filter(x=>x.line===cur.line):d.slices
  h+='<div class="card"><table><tr><th>段落</th><th>范围</th><th>故事</th><th>模型</th><th>编码</th><th>校验</th></tr>'
  h+=line.map(x=>'<tr'+(x.id===s.slice?' class="cur"':'')+'><td><b>'+esc(x.title)+'</b><div class="dim">'+esc(x.id)+(x.intent?' · '+esc(x.intent):'')+'</div></td>'
    +'<td class="dim">'+esc(x.modules.join('、'))+'</td>'
    +'<td>'+(x.steps?(x.approved?'<span class="tag done">一致</span>':(x.dark?'<span class="tag">'+x.dark+' 步待点亮</span>':'<span class="tag now">'+x.steps+' 步</span>')):'<span class="tag">待写</span>')+'</td>'
    +'<td>'+stageTag(x.stages.model&&x.stages.model.status)+'</td><td>'+stageTag(x.stages.code&&x.stages.code.status)+'</td><td>'+stageTag(x.stages.validate&&x.stages.validate.status)+'</td></tr>').join('')
  h+='</table></div>'

  const tl=(s.timeline||[]).slice().reverse().slice(0,14)
  h+='<div class="card"><div class="tl">'+(tl.length?tl.map(e=>e.kind==='progress'?'<div class="sub"><span class="t">'+esc(mdhm(e.ts))+'</span><span class="r">'+esc(e.who||'—')+'</span><span class="dim">└ '+esc(e.note)+'</span></div>':'<div><span class="t">'+esc(mdhm(e.ts))+'</span><span class="r">'+esc(e.who||'—')+'</span><span>'+esc(e.step)+(e.note?' <span class="dim">· '+esc(e.note)+'</span>':'')+'</span></div>').join(''):'<div class="empty">还没有动态</div>')+'</div></div>'
  $('#app').innerHTML=h

  $('#upd').textContent=s.updatedAt?('更新于 '+ago(s.updatedAt)+'前'):'还没人写过现场'
}
// 正在答题时不重画，不然两秒一刷会把选的和写的字冲掉
let answering=false
const picked={}
const reopened={}
function wireAsk(open){
  for(const q of open){
    const box=document.getElementById('t-'+q.id),btn=document.getElementById('b-'+q.id),msg=document.getElementById('m-'+q.id)
    if(!box||!btn)continue
    const card=btn.closest('.ask')
    const opts=[...card.querySelectorAll('.opt')]
    const refresh=()=>{const has=picked[q.id]!=null||box.value.trim();btn.disabled=!has;answering=!!has}
    opts.forEach(function(el,i){
      el.addEventListener('click',function(){
        picked[q.id]=i
        opts.forEach(x=>x.classList.remove('picked'))
        el.classList.add('picked')
        msg.textContent='选的是：'+q.options[i]
        refresh()
      })
      if(picked[q.id]===i){el.classList.add('picked');msg.textContent='选的是：'+q.options[i]}
    })
    box.addEventListener('input',refresh)
    box.addEventListener('focus',function(){answering=true})
    refresh()
    btn.addEventListener('click',async function(){
      const i=picked[q.id],extra=box.value.trim()
      const text=(i!=null?q.options[i]:'')+(i!=null&&extra?'　'+extra:extra)
      if(!text)return
      btn.disabled=true;msg.textContent='记上…'
      try{
        const r=await (await fetch('/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:q.id,text:text})})).json()
        if(!r.ok){msg.textContent='没记上：'+(r.error||'不知道为什么');btn.disabled=false;return}
        delete picked[q.id];answering=false;tick()
      }catch(e){msg.textContent='没记上：'+e.message;btn.disabled=false}
    })
  }
}
async function tick(){if(answering)return;try{render(await (await fetch('/data')).json())}catch(e){$('#upd').textContent='取不到数据：'+e.message}}
tick();setInterval(tick,2000)
</script></body></html>`

const QUESTIONS_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>等你答 · ${esc(projectName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--hi:#7dd3fc;--ok:#86efac;--warn:#fcd34d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:24px 20px 80px}
h1{font-size:19px;margin:0 0 2px;font-weight:600}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.q{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.q.open{border-color:rgba(134,239,172,.45);background:rgba(134,239,172,.06)}
.q .no{color:var(--ok);font-weight:600;font-size:13px}
.q .ttl{font-size:17px;font-weight:600;margin:8px 0 10px;line-height:1.5}
.meta{display:flex;gap:14px;padding:3px 0;font-size:13.5px}
.meta .k{color:var(--dim);width:64px;flex:none}
.opt{padding:7px 12px;margin:4px 0;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.opt:hover{background:rgba(134,239,172,.10)}
.opt.picked{background:rgba(134,239,172,.18);border-color:var(--ok)}
.lean{color:var(--dim);font-size:12.5px;margin-top:6px}
textarea{width:100%;margin-top:10px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:14px/1.6 inherit;resize:vertical;min-height:50px}
.act{margin-top:12px;display:flex;gap:10px;align-items:center}
button{background:var(--ok);color:#0b1220;border:0;border-radius:8px;padding:7px 18px;font:600 14px inherit;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
.done{opacity:.75}
.done .ans{color:var(--ok)}
.empty{color:var(--dim);padding:28px 0}
a{color:var(--hi)}
</style></head><body><div class="wrap">
<h1>等你答 · ${esc(projectName)}</h1>
<div class="sub" id="sub">连接中…</div>
<div id="app"></div>
</div>
<script>
const $=(x)=>document.querySelector(x)
function esc(x){return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function hm(iso){var d=new Date(iso),p=function(n){return String(n).padStart(2,'0')};return p(d.getHours())+':'+p(d.getMinutes())}
function mdhm(iso){var d=new Date(iso),p=function(n){return String(n).padStart(2,'0')};return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
function ago(iso){if(!iso)return '';const m=Math.floor((Date.now()-new Date(iso).getTime())/60000);if(m<1)return '刚刚';if(m<60)return m+' 分钟';const h=Math.floor(m/60);return h<24?h+' 小时':Math.floor(h/24)+' 天'}
let busy=false
const picked={},reopened={}
function render(d){
  const qs=d.scene.questions||[]
  const open=qs.filter(q=>!q.answeredAt||reopened[q.id])
  const done=qs.filter(q=>q.answeredAt&&!reopened[q.id]).slice(-8).reverse()
  const mode=d.scene.askMode||'逐个'
  let h=''
  if(!open.length)h+='<div class="empty">没有攒着的问题。'+(mode==='逐个'?'现在是逐个模式，角色问出来的问题开发指挥会在 Claude Code 的对话里端给你。':'角色一有要你裁的事就会攒到这儿。')+'</div>'
  open.forEach(function(q,i){
    h+='<div class="q open"><div class="no">'+(i+1)+' / '+open.length+'　'+esc(q.id)+'　'+esc(q.who||'—')+' 问的 · '+ago(q.ts)+'前'+(q.answeredAt?'　（在改）':'')+'</div>'
    h+='<div class="meta"><div class="k">在做什么</div><div>'+esc(q.doing)+'</div></div>'
    h+='<div class="meta"><div class="k">上下文</div><div>'+esc(q.context)+'</div></div>'
    h+='<div class="ttl">'+esc(q.question)+'</div>'
    h+=q.options.map(function(o,j){return '<div class="opt" data-q="'+esc(q.id)+'" data-i="'+j+'">'+esc(o)+'</div>'}).join('')
    h+='<div class="lean">它偏向：'+esc(q.lean)+'（信心'+esc(q.confidence)+'）'+(q.wentAhead?'　——你不在，已经照这个先做下去了，你选别的就要返工':'')+'</div>'
    if(q.answeredAt)h+='<div class="lean">你原来答的是「'+esc(q.answer)+'」，改了原答复不会被抹掉。</div>'
    h+='<textarea id="t-'+esc(q.id)+'" placeholder="想补充什么就写在这儿（可以不写）"></textarea>'
    h+='<div class="act"><button data-send="'+esc(q.id)+'" disabled>答这个</button><span class="lean" id="m-'+esc(q.id)+'">点一个答案，或者只写几句话也行</span></div></div>'
  })
  if(done.length){
    h+='<div class="sub" style="margin:26px 0 8px">答过的</div>'
    for(const q of done)h+='<div class="q done"><div class="no">'+esc(q.id)+'　'+esc(q.who||'—')+' 问的 · '+ago(q.answeredAt)+'前'+((q.answerHistory||[]).length?'　改过 '+q.answerHistory.length+' 次':'')+'</div><div class="ttl" style="font-size:15px">'+esc(q.question)+'</div><div class="ans">'+esc(q.answer)+'</div><div class="act"><button class="ghost" data-redo="'+esc(q.id)+'">改一下</button></div></div>'
  }
  $('#app').innerHTML=h
  $('#sub').textContent='问答模式：'+mode+(mode==='逐个'?'（你在电脑前或手机上，开发指挥在对话里一个个问；这一页备着）':'（你没在专注，问题攒在这儿，回来一口气答完）')
  wire()
}
function wire(){
  document.querySelectorAll('.opt').forEach(function(el){
    const id=el.dataset.q,i=Number(el.dataset.i)
    if(picked[id]===i)el.classList.add('picked')
    el.addEventListener('click',function(){
      picked[id]=i;busy=true
      document.querySelectorAll('.opt[data-q="'+id+'"]').forEach(x=>x.classList.remove('picked'))
      el.classList.add('picked')
      refresh(id)
    })
  })
  document.querySelectorAll('textarea').forEach(function(t){
    const id=t.id.slice(2)
    t.addEventListener('input',function(){busy=true;refresh(id)})
    t.addEventListener('focus',function(){busy=true})
  })
  document.querySelectorAll('[data-send]').forEach(function(b){
    const id=b.dataset.send
    refresh(id)
    b.addEventListener('click',async function(){
      const t=document.getElementById('t-'+id),msg=document.getElementById('m-'+id)
      const i=picked[id],extra=t.value.trim()
      const q=(LAST.scene.questions||[]).find(x=>x.id===id)
      const text=(i!=null?q.options[i]:'')+(i!=null&&extra?'　'+extra:extra)
      if(!text)return
      b.disabled=true;msg.textContent='记上…'
      try{
        const r=await (await fetch('/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,text:text})})).json()
        if(!r.ok){msg.textContent='没记上：'+(r.error||'不知道为什么');b.disabled=false;return}
        delete picked[id];delete reopened[id];busy=false;tick()
      }catch(e){msg.textContent='没记上：'+e.message;b.disabled=false}
    })
  })
  document.querySelectorAll('[data-redo]').forEach(function(b){
    b.addEventListener('click',function(){reopened[b.dataset.redo]=true;busy=false;tick()})
  })
}
function refresh(id){
  const t=document.getElementById('t-'+id),b=document.querySelector('[data-send="'+id+'"]')
  if(!t||!b)return
  b.disabled=!(picked[id]!=null||t.value.trim())
}
let LAST=null
async function tick(){if(busy)return;try{LAST=await (await fetch('/data')).json();render(LAST)}catch(e){$('#sub').textContent='取不到数据：'+e.message}}
tick();setInterval(tick,3000)
</script></body></html>`

const wanted = Number(opt('--port', '4873'))
function listen(port, tries = 12) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/answer')) {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        let out
        try {
          const { id, text } = JSON.parse(body || '{}')
          out = recordAnswer(id, text, '网页')
          if (out.ok) console.log(`${out.id} 人在网页上答了：${out.answer}\n${out.tail}`)
        } catch (e) { out = { ok: false, error: String(e.message) } }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(out))
      })
      return
    }
    if (req.url.split('?')[0] === '/questions') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(QUESTIONS_PAGE)
    }
    if (req.url.startsWith('/data')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      const sc = readScene()
      return res.end(JSON.stringify({ scene: sc, slices: slices(), machine: ME, warning: machineWarning(sc) }))
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1)
    die(String(e.message))
  })
  srv.listen(port, '127.0.0.1', () => console.log(`现场看板：http://localhost:${port}　（Ctrl+C 停）`))
}
listen(wanted)
