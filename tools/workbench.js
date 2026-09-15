#!/usr/bin/env node
/**
 * 工作台：一个地址、一套外壳，把给人看的页面全放进页签里。开工第一件事就是把它起来，人随时能查。
 *
 * 用法：node tools/workbench.js <项目目录> [--code <代码库>] [--port 4870]
 *
 * 页签（2026-09-13 项目所有者要直白的名字，「审阅」「审查」太像）：谁在干什么（scene）· 等你答（scene 的 /questions：攒着的问题列一页，问卷模式用）· 切片（现算：段落 / 修改 / 候选三栏，第八十六批）· 日志（现算：journal/<日期>.jsonl 按派工分块，角色做了什么、花了多久，给人复盘）· 读原文（导读/<切片>-原文选读.md）· 走故事（story；当前是模块切片时这一页装的是业务走查，页签名字跟着改）· 模型图（story 的 /model）· 这段改了什么（model-delta，按当前段落现算）
 *      · 审模型（review，读 reports/validate-1.json，校验器对模型的判断）· 审代码对模型（codemodel，读 reports/validate-2.json，方向 ② 留给人的判断）· 审代码（review，读 reports/pre-pr-*.json，pre-pr 审查的发现）· 编码计划（plans/<当前段落>.md 现渲染）· 试原型（proto，给了 --code 且 src/proto/main.ts 在才起）
 * 它自己把这几个服务拉起来：每个现挑一个空闲端口、只听 127.0.0.1、不许它们自己弹浏览器；页面统统从工作台这一个口代理出去（/p/<页面>/…），
 * 所以人只需要开 http://localhost:4870 这一个地址，别的口不用管也看不见。进程退出时把自己拉起来的一并关掉。
 * 当前是哪一段先读 reports/_scene.json，看板没写就从 slices/ 里挑没收口的、最近动过的那条；
 * 页签上「等你」的数按文件实数（报告、计划、故事、切片上的门），每 5 秒刷一次。
 *
 * 由来：2026-09-13 验收项目所有者：「现在有好几种 html 的 interface，统一一下做成一个工作台；dev-team 一开工应该就要 host 起来，人可以随时查。」
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { flipHtml } = require('./lib/theme')

// 白天 / 黑夜（2026-09-13 项目所有者要的）。每张页面本来是深是浅不一样：
// 现场页与外壳生来是深色，走故事、审模型、试原型、模型图、计划、增量生来是浅色。
// 人选了哪一头，跟它本来那一头不一样的页面就整页翻面（tools/lib/theme.js：色相不动、明度翻过来）。
const BORN_DARK = new Set(['scene'])
const themeOf = (req) => {
  // 地址上带 ?theme=dark|light 就按它来（截图、试样子、把某一页发给人看都用得上），否则看 cookie
  const q = (/[?&]theme=(light|dark)\b/.exec(req.url ?? '') ?? [])[1]
  if (q) return q
  return (/(?:^|;\s*)wb-theme=(light|dark)/.exec(req.headers.cookie ?? '') ?? [])[1] ?? null
}
/** 按人选的主题把一张页面调成该有的样子；没选过就原样发（外壳的脚本会按系统偏好选一次） */
function themed(html, who, theme) {
  if (!theme) return html
  // 外壳是「深色工具条 + 内容区」的两截结构，整页翻面会把工具条翻成浅色、内容区翻成深色，正好拧着。
  // 工具条两头都保持深色，只换内容区那块底。
  if (who === '外壳') {
    const mark = `<style data-theme-scheme>:root{color-scheme:${theme};--page:${theme === 'dark' ? '#0e1115' : '#f6f7f9'}}</style>`
    return html.includes('</head>') ? html.replace('</head>', mark + '</head>') : mark + html
  }
  const born = BORN_DARK.has(who) ? 'dark' : 'light'
  if (theme !== born) return flipHtml(html, theme)
  // 本来就是这一头的页面不用翻，但也要报一句 color-scheme：滚动条、输入框这些浏览器自己画的东西照它走
  const mark = `<style data-theme-scheme>:root{color-scheme:${theme}}</style>`
  return html.includes('</head>') ? html.replace('</head>', mark + '</head>') : mark + html
}

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null
if (!root || !fs.existsSync(path.join(root, 'project.json'))) { console.error('用法：node tools/workbench.js <项目目录> [--code <代码库>] [--port 4870]'); process.exit(2) }
const codebase = opt('--code') ? path.resolve(opt('--code')) : (() => { try { const c = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).codebase; return c ? path.resolve(root, c) : null } catch { return null } })()
const port = Number(opt('--port', 4870))
// 子服务的口每次现挑空闲的、只听本机、不告诉人：给人的地址只有工作台这一个（2026-09-13 项目所有者：「统一了之后只开 4870 那一个就够了」）
const INNER = {} // 名字 → 端口，startAll 时填
const tools = __dirname
const projectName = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).name } catch { return path.basename(root) } })()
const logDir = path.join(root, 'reports', '_workbench')
fs.mkdirSync(logDir, { recursive: true })

const scene = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'reports', '_scene.json'), 'utf8')) } catch { return {} } }
/** slices/ 里的切片，按文件改动时间从旧到新 */
function allSlices() {
  const dir = path.join(root, 'slices')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.story.json') && !f.startsWith('_'))
    .map((f) => { try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); s._mtime = fs.statSync(path.join(dir, f)).mtimeMs; return s } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => a._mtime - b._mtime)
}
/** 收口了没：模块切片走完业务走查、模型标 done 就算完；别的切片三关都 done 才算 */
const sliceClosed = (s) => (s.kind === 'module'
  ? (s.pass ?? '骨架') === '行为' && s.stages?.model?.status === 'done'
  : ['model', 'code', 'validate'].every((k) => s.stages?.[k]?.status === 'done'))
/**
 * 这条切片上那道等他拍板的门（第九十七批）：模块切片的「初稿定了」、段落切片的「出原型」。
 * 「切片」页拿它画按钮，顶上的待办数也拿它数——门开着就是在等他按，不该要他自己想起来去翻那一页。
 */
function gateOf(s) {
  if (s.kind === 'module' && (s.pass ?? '骨架') === '骨架' && s.stages?.model?.status === 'in-progress' && s.stages?.model?.proofreadAt) {
    return { kind: 'draft-ok', ask: '看过「模型图」页了？初稿允许不准，走查时再改精。', button: '初稿定了', why: '骨架初稿等你说「就按这个走」' }
  }
  if (s.kind === 'story' && s.stages?.model?.status === 'done' && !s.protoGo && s.stages?.code?.status === 'pending') {
    return { kind: 'proto-go', ask: '模型确认了。看过整个模型，这一段现在出原型？', button: '出原型', why: '模型确认了，等你说出不出原型' }
  }
  return null
}
/**
 * 现在在哪一条切片上。先认现场看板（开发指挥 `scene set --slice` 写的），看板没写就自己从 slices/ 里挑：
 * 没收口的里面最近动过的那条，都收口了就挑最近动过的那条。
 * 由来：2026-09-15 k-001 整轮下来看板的 slice 一直是 null，于是走故事、读原文、编码计划、这段改了什么
 * 四页统统说「还没指到哪一段」，顶上待办数恒为 0——看板漏记一笔，给人看的页面不该跟着瞎。
 */
function currentSlice() {
  const fromScene = scene().slice
  if (fromScene) return fromScene
  const all = allSlices()
  if (!all.length) return null
  const open = all.filter((s) => !sliceClosed(s))
  return (open.length ? open : all).slice(-1)[0].id
}
/**
 * 顶上每个页签还有几件等他的事（2026-09-15 项目所有者：「页面顶端给我一些待办事项的 count 提示」）。
 * 数的就是那一页自己会列出来的：没答的问题、报告里没填人裁决的条目、计划里没确认的步、故事里没过的步与卡。
 * **只在真轮到他的时候数**——口径照 slice.js 的 reportState：报告里还有错误、或校验角色还没填判断，那是角色的活，不是他的；
 * 计划还有步没补关键逻辑，也是写码角色的活。免得页签上挂着数，他点进去发现没自己的事。
 * 从前这些徽章是拿现场看板那句话套正则猜的，还有一处 badge('delta') 指着一个并不存在的页签——一抛错，
 * 排在它后面的「编码计划」就永远标不上。现在按文件实数。
 */
function todo() {
  const readSafe = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) } catch { return null } }
  // 一份校验 / pre-pr 报告里还有几条等他：错误未清或判断没填完，都还没轮到他
  const waiting = (r) => {
    if (!r) return 0
    if ((r.errors ?? []).length + (r.warnings ?? []).length) return 0
    if ((r.judgments ?? []).some((x) => !x.verdict)) return 0
    return [...(r.judgments ?? []), ...(r.confirms ?? [])].filter((x) => !x.human?.verdict).length
  }
  const sc = scene(), sid = currentSlice()
  const t = { ask: 0, story: 0, review: 0, codemodel: 0, prepr: 0, plan: 0, slices: 0 }
  const why = {}
  const put = (k, n, text) => { t[k] = n; if (n) why[k] = text(n) }
  const other = (r) => (r?.slice && sid && r.slice !== sid ? `（${r.slice} 的报告）` : '')

  put('ask', (sc.questions ?? []).filter((q) => !q.answeredAt).length, (n) => `${n} 个问题等你答`)

  const r1 = readSafe('reports/validate-1.json'), r2 = readSafe('reports/validate-2.json')
  put('review', waiting(r1), (n) => `${n} 条模型判断等你审${other(r1)}`)
  put('codemodel', waiting(r2), (n) => `${n} 条代码对模型的判断等你审${other(r2)}`)
  const prs = ['reports/pre-pr-proto.json', 'reports/pre-pr-shell.json'].map(readSafe).filter(Boolean)
  const pr = prs.find((x) => x.slice === sid) ?? prs[0] ?? null
  put('prepr', waiting(pr), (n) => `${n} 条代码审查的发现等你审${other(pr)}`)

  // 故事 / 业务走查：模型建好、walk 填上了才轮到他坐下（之前是讲解与模型师的活）。
  // 模块切片的骨架初稿一步都没有，可模型师把形状上的选择留在了同一个文件里，那几张卡是留给他裁的——
  // 跟「初稿定了」那道门同时轮到他（文职校完），照数（2026-09-15 k-001 五张卡摆在那儿，工作台还说「没有等你的事」）。
  const cur = sid ? readSafe(`slices/${sid}.json`) : null
  const story = sid ? readSafe(`slices/${sid}.story.json`) : null
  const walked = (story?.steps ?? []).some((s) => s.walk)
  const draftGate = cur ? gateOf(cur)?.kind === 'draft-ok' : false
  if (story && (walked || draftGate)) {
    const steps = walked ? (story.steps ?? []).filter((s) => !s.review?.verdict).length : 0
    const cards = (story.choices ?? []).filter((c) => !c.ruling).length
    const usage = walked && story.usage?.proposedAt && !story.usage?.confirmedAt ? 1 : 0
    put('story', steps + cards + usage, () => [steps && `${steps} 步没过`, cards && `${cards} 张裁定卡没裁`, usage && '五问的语句没确认'].filter(Boolean).join('、'))
  }

  // 计划：关键逻辑补齐了才轮到他确认；已确认但事后被改过的那几步也要他重看（confirmedKeyLogic，第九十四批之后）
  const plan = sid ? readSafe(`plans/${sid}.json`) : null
  if (plan && !(plan.steps ?? []).some((s) => s.needsKeyLogic && !s.keyLogic)) {
    const unconfirmed = (plan.steps ?? []).filter((s) => !s.confirmedAt).length
    const stale = (plan.steps ?? []).filter((s) => s.confirmedAt && !s.doneAt && s.confirmedKeyLogic !== undefined && (s.keyLogic ?? null) !== (s.confirmedKeyLogic ?? null)).length
    put('plan', unconfirmed + stale, () => [unconfirmed && `${unconfirmed} 步没确认`, stale && `${stale} 步确认之后关键逻辑被改过`].filter(Boolean).join('、'))
  }

  // 「切片」页上那两道门（第九十七批）：门开着是真在等他按，进总数。
  const gates = allSlices().map((s) => ({ s, g: gateOf(s) })).filter((x) => x.g)
  // 候选修改是攒着的，不是等他现在办：没有门开着的时候这个徽章是灰的，不进「等你」的总数
  const cand = readSafe('slices/_candidates.json')
  const nCand = ((cand?.items ?? []).filter((x) => (x.status ?? 'open') === 'open')).length
  t.slices = gates.length + nCand
  if (t.slices) why.slices = [...gates.map((x) => `${x.s.id}：${x.g.why}，按「${x.g.button}」`), nCand && `${nCand} 件候选修改攒着，等这一段收口后挑`].filter(Boolean).join('；')
  const total = t.ask + t.story + t.review + t.codemodel + t.prepr + t.plan + gates.length
  return { tabs: t, soft: gates.length ? [] : ['slices'], total, why, slice: sid }
}

// ---------- 子服务 ----------
const children = []
// 用「连得上」判断端口有没有人在听：用 listen 试探会漏掉只听 ::1 的老进程（2026-09-13 踩过）
function connectable(host, p) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port: p }).once('connect', () => { c.destroy(); resolve(true) }).once('error', () => resolve(false))
    c.setTimeout(800, () => { c.destroy(); resolve(false) })
  })
}
async function portBusy(p) { return (await connectable('127.0.0.1', p)) || (await connectable('::1', p)) }
// 现挑一个空闲口：让系统分配再让开，子进程紧接着就去占
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject).listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => resolve(pt)) })
  })
}
async function waitServed(name, p, seconds = 6) {
  for (let i = 0; i < seconds * 4; i++) { if (await portBusy(p)) return true; await new Promise((r) => setTimeout(r, 250)) }
  console.log(`${name}：${seconds} 秒内没起来，先不等它了；两分钟内起来了会自动接上。看 reports/_workbench/${name}.log`)
  return false
}
/** 超时之后还接着看：子服务（多半是要先编译的原型）晚起来了就接上，页签不用一直显示「还没起来」 */
function adoptLater(name, p) {
  let left = 120
  const t = setInterval(async () => {
    if (INNER[name]) return clearInterval(t)
    if (await portBusy(p)) { INNER[name] = p; console.log(`${name}：起来了，已接上`); return clearInterval(t) }
    if (--left <= 0) { clearInterval(t); console.log(`${name}：两分钟了还没起来，放弃；看 reports/_workbench/${name}.log`) }
  }, 1000)
  t.unref()
}
/** 起一个子服务：现挑口、只听本机、不许它自己弹浏览器；起好了记进 INNER，页面就从工作台代理过去 */
async function ensure(name, argvOf, cwd, seconds) {
  const p = await freePort()
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a')
  const child = spawn(process.execPath, argvOf(p), { cwd: cwd ?? root, stdio: ['ignore', out, out], windowsHide: true })
  children.push({ name, child })
  if (await waitServed(name, p, seconds)) INNER[name] = p
  else adoptLater(name, p)
  return INNER[name] ?? null
}
/**
 * 靠文件起的那四页：报告与原型多半是工作台起来**之后**才有的——校验器跑完才写 validate-1.json，
 * pre-pr 交稿才写 pre-pr-*.json，原型编译过了才有 main.ts。
 * 从前只在起工作台那一刻看一眼文件在不在，不在就整整一个会话都没有那一页：2026-09-15 真出过，
 * validate-1.json 中午就写好了，工作台起得更早，他一下午点「审模型」看到的都是「还没有报告」。
 * 现在每 5 秒回头看一次，文件出现了就把那一页补起来。起过一次的不再起（没起来的交给 adoptLater 接）。
 */
const LATE = ['review', 'codemodel', 'prepr', 'proto']
const tried = new Set()
async function lateSpec(name) {
  const rp = (f) => { const x = path.join(root, 'reports', f); return fs.existsSync(x) ? x : null }
  const asReview = (f) => f && { of: (p) => [path.join(tools, 'review.js'), f, '--port', String(p), '--no-open'] }
  if (name === 'review') return asReview(rp('validate-1.json'))
  // 方向 ②：代码解码回来对模型，校验器留给人的判断（多半是「模型文字与代码注释是不是同一个意思」）
  if (name === 'codemodel') return asReview(rp('validate-2.json'))
  if (name === 'prepr') return asReview(rp('pre-pr-proto.json') ?? rp('pre-pr-shell.json'))
  if (name === 'proto') {
    if (!codebase || !fs.existsSync(path.join(codebase, 'src', 'proto', 'main.ts'))) return null
    const hostPort = await freePort()
    return { of: (p) => [path.join(tools, 'proto.js'), 'serve', root, '--code', codebase, '--port', String(p), '--proto-port', String(hostPort), '--story-base', '/p/story', '--no-open'], seconds: 30 }
  }
  return null
}
async function startLate(name) {
  if (tried.has(name)) return
  const spec = await lateSpec(name)
  if (!spec) return
  tried.add(name)
  await ensure(name, spec.of, undefined, spec.seconds)
}
async function startAll() {
  await ensure('scene', (p) => [path.join(tools, 'scene.js'), root, 'serve', '--port', String(p)])
  // 故事服务起的时候带哪一段：那一段得真有故事文件。没有就不带——story.js 找不到故事会直接退，
  // 而「模型图」「词汇表」两页也住在它里面，不能为了一个还没写故事的切片把那两页一起拖没（2026-09-16 在样例上真踩到）
  const s0 = currentSlice()
  const withStory = s0 && fs.existsSync(path.join(root, 'slices', `${s0}.story.json`)) ? [s0] : []
  await ensure('story', (p) => [path.join(tools, 'story.js'), 'serve', root, ...withStory, '--port', String(p), '--no-open'])
  for (const n of LATE) await startLate(n)
  const t = setInterval(() => { for (const n of LATE) if (!tried.has(n)) startLate(n).catch((e) => console.log(`${n}：补起来没成——${e.message}`)) }, 5000)
  t.unref()
}
// 页签背后那一页没起来时，页面上直说为什么，别让人对着一个连不上的空白框
// 报告一写出来工作台自己会把这一页补起来（每 5 秒看一次），所以话里不要他重启，只要他等几秒再点一次
const MISSING = {
  review: '审模型这一页要 <code>reports/validate-1.json</code>——校验器跑过这一段才有。报告一写出来这一页几秒后自己就起来了，不用重启工作台。',
  codemodel: '审代码对模型这一页要 <code>reports/validate-2.json</code>——代码写出来、校验器跑过方向 ② 才有。报告一写出来这一页几秒后自己就起来了。',
  prepr: '审代码这一页要 <code>reports/pre-pr-*.json</code>——pre-pr 审查交稿后才有。报告一写出来这一页几秒后自己就起来了。',
  proto: '试原型这一页要代码库里有 <code>src/proto/main.ts</code>——这一段进了编码阶段才有。它出现之后工作台会自己起这一页，原型要先编译，过半分钟再点一次这个页签。',
}
function stopAll() { for (const { child } of children) { try { child.kill() } catch { /* 已退出 */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(0) })
process.on('SIGTERM', () => { stopAll(); process.exit(0) })
process.on('exit', stopAll)

// ---------- 现算的页面 ----------
function deltaPage(slice) {
  if (!slice) return null
  const r = spawnSync(process.execPath, [path.join(tools, 'model-delta.js'), root, slice], { encoding: 'utf8' })
  const f = path.join(root, 'reports', `model-delta.${slice}.html`)
  if (r.status !== 0 || !fs.existsSync(f)) return `<p style="padding:20px;font-family:system-ui">增量页算不出来：${esc((r.stderr || r.stdout || '').trim() || '未知原因')}</p>`
  return fs.readFileSync(f, 'utf8')
}
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
// 计划 md → 简单 HTML：标题、表格、代码块、列表、段落。够看链路与关键逻辑，不追求全功能
function mdToHtml(md) {
  const lines = md.split('\n'); const out = []; let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++])
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(rows[0]); const body = rows.slice(2).map(cells)
      out.push(`<table><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`); continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    // 引用块：原文选读用它摘原句，整段原样显示（等宽、保留换行、不解析里面的记号）
    if (/^\s*>/.test(l)) {
      const q = []
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${esc(q.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(l)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, '')); out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); continue }
    if (!l.trim()) { i++; continue }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|\||```|\s*[-*]\s)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
  function inline(t) { return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>') }
}
function planPage(slice) {
  if (!slice) return '<p>还没指到哪一段。</p>'
  const f = path.join(root, 'plans', `${slice}.md`)
  // 模块切片不写代码（第九十七批），plan build 对它是直接拒的——别拿段落切片那句「模型确认后算出」骗他等
  if (!fs.existsSync(f) && slice.startsWith('k-')) return `<p>${esc(slice)} 是模块切片，不写代码：这一条只建模型（骨架初稿 + 业务走查）。模型定了之后按故事线切段落，代码与计划是段落切片的事。</p>`
  if (!fs.existsSync(f)) return `<p>${esc(slice)} 还没有编码计划（模型确认、你说了出原型之后，由开发指挥 <code>plan build</code> 算出）。</p>`
  let plan = null
  try { plan = JSON.parse(fs.readFileSync(path.join(root, 'plans', `${slice}.json`), 'utf8')) } catch { /* 没有 json 就只给表 */ }
  const tree = plan ? planTree(plan) : ''
  return planGate(slice) + tree + `<details class="seq"><summary>按顺序看（施工单原表）</summary><article class="md">${mdToHtml(fs.readFileSync(f, 'utf8'))}</article></details>`
}
/**
 * 按代码结构摆计划：把每一步按文件路径挂到 src/<模块>/<层>/<聚合>/ 的树上，测试挂在它测的那个源文件下面；
 * 别的切片已经做过、这次不列步骤的（already）也摆进去灰着——人看到的是整个代码结构，不是一张只有增量的单子。
 * 每张文件卡：第几步、新建 / 修改、对应哪个模型元素、要做什么、关键逻辑（折叠，超 600 字提醒——第七十批）、做完没。
 */
function planTree(plan) {
  const LAYER = { 'building-block': '构建块', domain: '领域', repository: '仓储接口', service: '领域服务', application: '应用', port: '端口', adapter: '适配器', shell: '外壳', composition: '组合根', proto: '原型入口', test: '测试', input: '故事输入' }
  const items = []
  for (const st of plan.steps) items.push({ kind: 'step', ...st })
  for (const a of plan.already || []) items.push({ kind: 'already', ...a })
  // 测试挂到源文件下：同一个目标、layer 是 test 的那一步
  const tests = items.filter((x) => x.layer === 'test' && x.file)
  const srcs = items.filter((x) => x.layer !== 'test')
  const testOf = (x) => tests.filter((t) => t.target === x.target)
  const orphanTests = tests.filter((t) => !srcs.some((x) => x.target === t.target))
  // 建目录树
  const rootNode = { name: '', dirs: new Map(), files: [] }
  const put = (x) => {
    const file = x.file || `（不是代码文件）/${x.target}`
    const parts = file.split('/')
    let node = rootNode
    for (const d of parts.slice(0, -1)) { if (!node.dirs.has(d)) node.dirs.set(d, { name: d, dirs: new Map(), files: [] }); node = node.dirs.get(d) }
    node.files.push({ ...x, base: parts[parts.length - 1], tests: x.layer === 'test' ? [] : testOf(x) })
  }
  for (const x of srcs) put(x)
  for (const t of orphanTests) put(t)
  const stepCount = (node) => node.files.filter((x) => x.kind === 'step').length + [...node.dirs.values()].reduce((n, d) => n + stepCount(d), 0)
  const doneCount = (node) => node.files.filter((x) => x.kind === 'step' && x.doneAt).length + [...node.dirs.values()].reduce((n, d) => n + doneCount(d), 0)
  const kl = (x) => {
    if (x.kind !== 'step') return ''
    if (!x.needsKeyLogic) return ''
    if (!x.keyLogic) return '<div class="kl none">关键逻辑还没补</div>'
    const n = x.keyLogic.length
    return `<details class="kl"><summary>关键逻辑 <span class="n${n > 600 ? ' over' : ''}">${n} 字${n > 600 ? '，超过 600 字——第七十批：完整直白优先，长了只提醒' : ''}</span></summary><pre>${esc(x.keyLogic)}</pre></details>`
  }
  const card = (x) => {
    const step = x.kind === 'step'
    const badge = step ? `<span class="no">第 ${x.n} 步</span>` : `<span class="no prior">已做过 · ${x.by?.slice === plan.slice ? '上一版' : esc(x.by?.slice || '')} 第 ${x.by?.n ?? '?'} 步</span>`
    const act = step ? `<span class="act ${x.action}">${x.action === 'create' ? '新建' : '修改'}</span>` : ''
    const done = step ? (x.doneAt ? `<span class="done">✓ 已写 ${esc(x.doneAt.slice(5, 16).replace('T', ' '))}</span>` : '<span class="todo">未写</span>') : ''
    // 分步确认：每张卡一个按钮，按了就地变成「已确认 · 撤销」，不整页刷新；写完的步不能撤。旁边「有话说」能留话，写码角色开写前读
    // （2026-09-14 项目所有者：「单步确认按钮不好用，而且也无法撤销或者加 comment」）
    // 人确认的是当时那段关键逻辑，角色事后改了文字，确认就不算数（2026-09-15 s-003 真出过：十八步全确认之后十步被重写）
    const stale = Boolean(x.confirmedAt) && !x.doneAt && x.confirmedKeyLogic !== undefined && (x.keyLogic ?? null) !== (x.confirmedKeyLogic ?? null)
    const confirmBtn = !step ? '' : (stale
      ? `<span class="todo">你 ${esc(x.confirmedAt)} 确认之后，关键逻辑被改过——上面是新的文字，看过再确认一次</span><button class="cst" data-confirm-step="${x.n}">这一步我确认</button>`
      : x.confirmedAt
      ? `<span class="okd">✓ 你已确认 ${esc(x.confirmedAt)}</span>${x.doneAt ? '<span class="okd">（已写完，不能撤；有话在下面留）</span>' : `<button class="cst un" data-unconfirm-step="${x.n}">撤销</button>`}`
      : (x.needsKeyLogic && !x.keyLogic ? '<span class="todo">关键逻辑没补，还不能确认</span>' : `<button class="cst" data-confirm-step="${x.n}">这一步我确认</button>`)) + '<span class="cmsg"></span>'
    const notes = (x.humanNotes || []).map((h) => `<div class="hn"><span class="t">${esc(String(h.ts).slice(5, 16).replace('T', ' '))}</span>${esc(h.text)}</div>`).join('')
    const talk = step ? `<details class="hc"${notes ? ' open' : ''}><summary>有话说${(x.humanNotes || []).length ? `（${x.humanNotes.length}）` : ''}</summary>${notes}<div class="hcf"><textarea rows="2" placeholder="对这一步想说的：哪里不对、要改成什么、为什么……${esc(plan.role)}角色开写前会读"></textarea><button class="cst hcb" data-comment-step="${x.n}">记下</button><span class="cmsg"></span></div></details>` : ''
    const tests = (x.tests || []).map((t) => `<div class="t"><span class="no">第 ${t.n} 步</span> 测试 <code>${esc(t.file)}</code> ${t.kind === 'step' ? (t.doneAt ? '<span class="done">✓</span>' : '<span class="todo">未写</span>') : '<span class="prior">已做过</span>'}${t.kind === 'step' ? kl(t) : ''}</div>`).join('')
    return `<div class="fc${step ? '' : ' prior'}"><div class="fh">${badge}${act}<code class="fn">${esc(x.base)}</code><span class="tg">${esc(x.target)}</span>${done}</div><div class="what">${esc(x.what || '')}${(x.traces || []).length ? ' <span class="tr">' + x.traces.map(esc).join(' ') + '</span>' : ''}</div>${kl(x)}${tests}${step ? '<div class="cf" data-step="' + x.n + '">' + confirmBtn + '</div>' + talk : ''}</div>`
  }
  const dir = (node, depth) => {
    const n = stepCount(node), d = doneCount(node)
    const sub = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((x) => dir(x, depth + 1)).join('')
    const files = node.files.sort((a, b) => (a.kind === 'step' ? 0 : 1) - (b.kind === 'step' ? 0 : 1) || (a.n ?? 0) - (b.n ?? 0)).map(card).join('')
    if (depth < 0) return sub + files
    return `<details${n ? ' open' : ''}><summary><code>${esc(node.name)}/</code> <span class="cnt${n ? '' : ' zero'}">${n ? `这次 ${n} 步${d ? `，已写 ${d}` : ''}` : '这次不动'}</span></summary><div class="dir">${sub}${files}</div></details>`
  }
  const total = plan.steps.length, done = plan.steps.filter((x) => x.doneAt).length
  return `<div class="ptree"><div class="ph">按代码结构看：<b>${total}</b> 步要写${done ? `（已写 ${done}）` : ''}，别的切片已做过、这次不动的 ${(plan.already || []).length} 个文件灰着摆在原位。每张卡上的「关键逻辑」是原型角色开写前写下的人话：这个方法收什么、先查什么再查什么、哪种情形抛哪个错、什么不做——你确认的是这些行为对不对，不是代码。</div>${dir(rootNode, -1)}</div>`
}
/** 计划页顶上的关卡那一块（不带脚本）：/plan/state 也用它，按钮按完就地换掉 */
function planGateDiv(slice) {
  let plan = null
  try { plan = JSON.parse(fs.readFileSync(path.join(root, 'plans', `${slice}.json`), 'utf8')) } catch { return '' }
  const done = plan.steps.filter((x) => x.doneAt).length
  // 人确认之后角色又改了关键逻辑的步：确认挂在变过的文字上，不算数（2026-09-15 s-003 真出过）
  const stale = plan.steps.filter((x) => x.confirmedAt && !x.doneAt && x.confirmedKeyLogic !== undefined && (x.keyLogic ?? null) !== (x.confirmedKeyLogic ?? null))
  if (stale.length) return `<div class="gate ask" id="gate"><b>等你重新确认 ${stale.length} 步：</b>第 ${stale.map((x) => x.n).join('、')} 步在你确认之后关键逻辑被改过，这几步的确认不算数了。卡上是新的文字，看过按那一步的「这一步我确认」。</div>`
  if (plan.confirmedAt) return `<div class="gate ok" id="gate">✓ 这份计划已于 ${esc(plan.confirmedAt)} 由你确认（${plan.steps.length} 步，已写完 ${done} 步）。想收回哪一步，按那张卡上的「撤销」；有话就在卡上「有话说」里留。</div>`
  const unfilled = plan.steps.filter((x) => x.needsKeyLogic && !x.keyLogic).length
  if (unfilled) return `<div class="gate wait" id="gate">这份计划还有 ${unfilled} 步关键逻辑没补，${esc(plan.role)}角色补完才能请你确认。</div>`
  const okd = plan.steps.filter((x) => x.confirmedAt).length
  return `<div class="gate ask" id="gate"><b>等你确认：</b>${plan.steps.length} 步（${esc(plan.role)}角色写）${okd ? `，已确认 ${okd} 步` : ''}。每张卡看过关键逻辑就按那一步的「这一步我确认」，按了能撤；有意见在卡上「有话说」里留，${esc(plan.role)}角色开写前会读。${plan.steps.length - okd} 步都确认了计划才算通过、才开写。
<button id="confirmPlan">剩下的一并确认</button><span id="confirmMsg"></span></div>`
}
/** 计划页顶上的关卡 + 整页的按钮脚本。按钮不整页刷新：确认 / 撤销就地换掉那一块，关卡那一块从 /plan/state 重取；留话就地追加一行（2026-09-14 项目所有者：「单步确认按钮不好用，而且也无法撤销或者加 comment」） */
function planGate(slice) {
  const div = planGateDiv(slice)
  if (!div) return ''
  return div + `<script>(function(){
var S=${JSON.stringify(slice)};
function esc(t){return String(t).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
async function post(u,body){var r=await fetch(u,{method:'POST',headers:{'content-type':'text/plain; charset=utf-8'},body:body||''});return {ok:r.ok,text:await r.text()}}
async function refreshGate(){try{var s=await (await fetch('/plan/state?slice='+encodeURIComponent(S))).json();var g=document.getElementById('gate');if(g&&s.gateHtml){var d=document.createElement('div');d.innerHTML=s.gateHtml;g.replaceWith(d.firstElementChild)}}catch(e){}}
function fail(m,t){m.innerHTML='<b style="color:#cf222e">没成：</b>'+esc(t)}
document.addEventListener('click',async function(e){
  var b=e.target.closest('button');if(!b)return;
  if(b.id==='confirmPlan'){b.disabled=true;var m=document.getElementById('confirmMsg');m.textContent='写着…';var r=await post('/plan/confirm?slice='+encodeURIComponent(S));if(r.ok){location.reload()}else{b.disabled=false;fail(m,r.text)}return}
  if(b.dataset.confirmStep||b.dataset.unconfirmStep){var n=b.dataset.confirmStep||b.dataset.unconfirmStep,cf=b.closest('.cf'),m=cf.querySelector('.cmsg');b.disabled=true;m.textContent='写着…';
    var r=await post('/plan/'+(b.dataset.confirmStep?'confirm':'unconfirm')+'?slice='+encodeURIComponent(S)+'&step='+n);
    if(r.ok){cf.innerHTML=b.dataset.confirmStep?'<span class="okd">✓ 你已确认 '+new Date().toISOString().slice(0,10)+'</span><button class="cst un" data-unconfirm-step="'+n+'">撤销</button><span class="cmsg"></span>':'<button class="cst" data-confirm-step="'+n+'">这一步我确认</button><span class="cmsg"></span>';refreshGate()}else{b.disabled=false;fail(m,r.text)}return}
  if(b.dataset.commentStep){var box=b.closest('.hcf'),ta=box.querySelector('textarea'),m=box.querySelector('.cmsg'),t=ta.value.trim();if(!t){m.textContent='先写一句';return}
    b.disabled=true;m.textContent='写着…';var r=await post('/plan/comment?slice='+encodeURIComponent(S)+'&step='+b.dataset.commentStep,t);
    if(r.ok){var d=document.createElement('div');d.className='hn';d.innerHTML='<span class="t">'+new Date().toISOString().slice(5,16).replace('T',' ')+'</span>'+esc(t);box.parentNode.insertBefore(d,box);ta.value='';m.textContent='记下了';var k=box.parentNode.querySelectorAll('.hn').length;box.parentNode.querySelector('summary').textContent='有话说（'+k+'）'}else{fail(m,r.text)}b.disabled=false}
});})()</script>`
}
/**
 * 「切片」页（第八十六批）：段落、修改、候选三栏。人在这里看见开发是按什么节拍走的——
 * 每个段落走到哪、每个修改切片改的是哪一件事、审阅点出来还没开的候选有几条。只读；记候选与开切片走命令行（slice candidate）。
 */
function slicesPage() {
  const dir = path.join(root, 'slices')
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.story.json') && !f.startsWith('_')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)) : []
  let cands = { items: [] }
  try { cands = JSON.parse(fs.readFileSync(path.join(dir, '_candidates.json'), 'utf8')) } catch { /* 还没记过候选 */ }
  const cur = currentSlice()
  const stg = (s) => ['model', 'code', 'validate'].map((k) => { const st = s.stages?.[k]?.status ?? 'pending'; const label = { model: '模型', code: '编码', validate: '校验' }[k]; return `<span class="st ${st}">${label}${st === 'done' ? ' ✓' : st === 'in-progress' ? ' …' : ''}</span>` }).join('')
  const closed = (s) => ['model', 'code', 'validate'].every((k) => s.stages?.[k]?.status === 'done')
  const last = (s) => { const l = (s.log || []).slice(-1)[0]; return l ? `${esc(l.ts)} ${esc(l.text)}` : '' }
  // 模块切片（第九十七批）：只有模型这一关，标着在骨架初稿还是业务走查
  const passLabel = (s) => (s.kind === 'module' ? `<span class="st ${s.stages?.model?.status === 'done' ? 'done' : 'in-progress'}">${(s.pass ?? '骨架') === '骨架' ? '骨架初稿' : '业务走查'}</span>` : '')
  // 两道要人拍板的门就在卡上：模块的「初稿定了」（文职校过、他看过模型图）、段落的「出原型」（模型确认了、还没算计划）。
  // 门开没开由 gateOf 一处说了算，顶上的待办数数的也是它
  const gate = (s) => {
    const g = gateOf(s)
    if (g) return `<div class="gt"><span>${esc(g.ask)}</span><button class="cst" data-gate="${g.kind}" data-slice="${esc(s.id)}">${esc(g.button)}</button><span class="cmsg"></span></div>`
    if (s.kind === 'story' && s.protoGo) return `<div class="meta">出原型：${esc(s.protoGo.at)}${s.protoGo.note ? `　${esc(s.protoGo.note)}` : ''}</div>`
    return ''
  }
  // 模型师起草时把形状上的选择留在走查文件里，那几张卡是留给他裁的——卡上提一句，
  // 别让他只看见一个「初稿定了」按钮、不知道还有几张卡在「走故事」页等着（2026-09-15 k-001 五张卡没人提醒）
  const choices = (s) => {
    if (s.kind !== 'module') return ''
    let st = null
    try { st = JSON.parse(fs.readFileSync(path.join(dir, `${s.id}.story.json`), 'utf8')) } catch { return '' }
    const n = (st.choices ?? []).filter((c) => !c.ruling).length
    return n ? `<div class="meta">形状上的选择 ${n} 张没裁——在「走故事」页裁</div>` : ''
  }
  const card = (s) => `<div class="sc${s.id === cur ? ' cur' : ''}${closed(s) ? ' closed' : ''}"><div class="sh"><span class="id">${esc(s.id)}</span><b>${esc(s.title)}</b>${s.id === cur ? '<span class="now">现在在这一段</span>' : ''}${closed(s) ? '<span class="okd">已收口</span>' : ''}<span class="sp"></span>${s.kind === 'module' ? passLabel(s) : stg(s)}</div>${s.intent ? `<div class="it">${esc(s.intent)}</div>` : ''}${s.origin ? `<div class="it">来源：${esc(s.origin)}${(s.touches || []).length ? `　动到 ${s.touches.map(esc).join('、')}` : ''}</div>` : ''}<div class="meta">${(s.scope?.modules || []).map(esc).join('、') || '（范围未定）'} · 编号 ${(s.traces || []).length} 条 · 日志 ${(s.log || []).length} 条</div>${choices(s)}${gate(s)}<div class="last" title="${last(s)}">最近：${last(s)}</div></div>`
  const modules = all.filter((s) => s.kind === 'module')
  const stories = all.filter((s) => ['story', 'initial', 'increment'].includes(s.kind))
  const changes = all.filter((s) => s.kind === 'change')
  // 模块切片已经在「模块」栏里了，别让它在「其他」栏再出现一遍
  const others = all.filter((s) => !modules.includes(s) && !stories.includes(s) && !changes.includes(s))
  const candCard = (x) => `<div class="cc ${esc(x.status)}"><div class="sh"><span class="id">#${x.n}</span><b>${esc(x.text)}</b><span class="sp"></span><span class="st ${esc(x.status)}">${x.status === 'open' ? '等着开' : x.status === 'opened' ? '已开成 ' + esc(x.openedAs) : '不做'}</span></div><div class="it">来源：${esc(x.origin)}${(x.touches || []).length ? `　动到 ${x.touches.map(esc).join('、')}` : ''}　记于 ${esc(x.ts)}</div>${x.note ? `<div class="meta">${esc(x.note)}</div>` : ''}</div>`
  const openN = cands.items.filter((x) => x.status === 'open').length
  return `<div class="ptree"><div class="ph">切片是迭代的步伐。<b>段落</b>一段一个最小业务动作，按故事线的先后走；<b>修改</b>只改已走通的段落上被试原型、审阅或裁定点出的一件事，编号 m-xxx；审阅页、试原型页上点出的事先记成<b>候选</b>、不当场改——当前段落收口后再从候选里挑一件开（第八十六批）。</div></div>
<div class="cols"><section>${modules.length ? `<h2>模块 <span class="n">${modules.length}</span></h2>${modules.map(card).join('')}` : ''}<h2>段落 <span class="n">${stories.length}</span></h2>${stories.map(card).join('') || '<p class="none">还没有段落。</p>'}</section>
<section><h2>修改 <span class="n">${changes.length}</span></h2>${changes.map(card).join('') || '<p class="none">还没有修改切片。</p>'}${others.length ? `<h2>其他 <span class="n">${others.length}</span></h2>${others.map(card).join('')}` : ''}</section>
<section><h2>候选 <span class="n">${openN} 等着开${cands.items.length > openN ? ` / 共 ${cands.items.length}` : ''}</span></h2>${cands.items.slice().reverse().map(candCard).join('') || '<p class="none">没有候选。审阅或试原型时点出的事，开发指挥用 <code>slice candidate add</code> 记在这里。</p>'}</section></div>`
}
/**
 * 「日志」页：读 journal/<日期>.jsonl（scene.js 每一笔都追加进去，只追加不裁剪），按「派工」分块——
 * 开发指挥几点派了谁做什么、角色每一句细步隔了多久、几点交回、这一趟多长、用了多少。
 * 2026-09-14 项目所有者：「一个任务 agent 们会跑很久……我没有 log 可以看到 agent 们是怎样配合的」。
 */
function journalPage(date) {
  const dir = path.join(root, 'journal')
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse() : []
  const day = date && days.includes(date) ? date : days[0]
  const nav = `<div class="jnav">${days.map((d) => `<a href="/journal?date=${d}" class="${d === day ? 'on' : ''}">${d}</a>`).join('') || '<span>还没有日志</span>'}</div>`
  if (!day) return `<div class="ptree"><div class="ph">日志记的是角色们怎么配合：开发指挥几点派了谁做什么、角色每一句细步、几点交回、花了多久。scene.js 每写一笔看板就往 <code>journal/&lt;日期&gt;.jsonl</code> 追加一行，只追加不裁剪。</div></div>${nav}`
  const entries = []
  for (const line of fs.readFileSync(path.join(dir, day + '.jsonl'), 'utf8').split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)) } catch { /* 坏行跳过 */ } }
  entries.sort((a, b) => a.ts.localeCompare(b.ts))
  const fmtMs = (ms) => { if (ms == null) return ''; const s = Math.round(ms / 1000); if (s < 60) return `${s} 秒`; const m = Math.floor(s / 60); return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分` }
  const fmtK = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
  const hm = (ts) => ts.slice(11, 19)
  const KIND = { set: '看板', ask: '发问', answer: '答', mode: '模式', handoff: '交接', progress: '细步', back: '交回', dispatch: '派工', confirm: '确认', unconfirm: '撤销确认', comment: '留话', review: '审阅' }
  // 分块
  const blocks = [], open = new Map()
  for (const e of entries) {
    if (e.kind === 'dispatch') { const b = { kind: 'block', who: e.who, start: e, items: [], end: null }; blocks.push(b); open.set(e.who, b); continue }
    if (e.kind === 'back' && open.has(e.who)) { open.get(e.who).end = e; open.delete(e.who); continue }
    if ((e.kind === 'progress' || e.kind === 'ask') && open.has(e.who)) { open.get(e.who).items.push(e); continue }
    blocks.push({ kind: 'event', e })
  }
  // 汇总：按角色；等人的时间（看板 who=人 到下一次 who≠人）
  const byRole = new Map()
  let waitMs = 0, waitFrom = null
  for (const e of entries) {
    if (e.kind === 'set') { if (e.who === '人' && !waitFrom) waitFrom = e.ts; else if (e.who !== '人' && waitFrom) { waitMs += new Date(e.ts) - new Date(waitFrom); waitFrom = null } }
    if (e.kind === 'back') { const r = byRole.get(e.who) ?? { n: 0, ms: 0, tokens: 0, tools: 0, steps: 0 }; r.n++; r.ms += e.elapsedMs ?? 0; r.tokens += e.tokens ?? 0; r.tools += e.tools ?? 0; r.steps += e.steps ?? 0; byRole.set(e.who, r) }
  }
  const stillOpen = [...open.keys()]
  const sum = `<div class="ptree"><div class="ph">${esc(day)}（UTC）共 ${entries.length} 笔：派工 ${blocks.filter((b) => b.kind === 'block').length} 趟${stillOpen.length ? `（${stillOpen.map(esc).join('、')} 还没交回）` : ''}；等你拍板累计 ${fmtMs(waitMs) || '0 秒'}。每块是一趟派工：开发指挥几点派了谁做什么、角色每一句细步与上一句隔了多久、几点交回、这一趟多长、用了多少。复盘时看：一趟里细步之间的空档在哪、哪一趟来回最多。</div></div>
${byRole.size ? `<table class="jsum"><tr><th>角色</th><th>派了几趟</th><th>共多久</th><th>细步</th><th>tokens</th><th>工具次数</th></tr>${[...byRole].map(([w, r]) => `<tr><td>${esc(w)}</td><td>${r.n}</td><td>${fmtMs(r.ms)}</td><td>${r.steps || ''}</td><td>${fmtK(r.tokens) || ''}</td><td>${r.tools || ''}</td></tr>`).join('')}</table>` : ''}`
  const item = (it, prev) => `<div class="ji"><span class="t">${hm(it.ts)}</span><span class="gap">+${fmtMs(new Date(it.ts) - prev)}</span><span class="tx">${it.kind === 'ask' ? '<b>发问：</b>' : ''}${esc(it.text)}</span></div>`
  const html = blocks.map((b) => {
    if (b.kind === 'event') { const e = b.e; return `<div class="je k-${esc(e.kind)}${e.done ? ' done' : ''}"><span class="t">${hm(e.ts)}</span><span class="who">${esc(e.who ?? '—')}</span><span class="k">${KIND[e.kind] ?? esc(e.kind)}${e.kind === 'set' && e.done ? '（完）' : ''}</span><span class="tx">${esc(e.text)}${e.kind === 'set' && e.slice ? `<span class="sl">${esc(e.slice)} · ${esc(e.phase ?? '—')}</span>` : ''}${e.kind === 'set' && e.note ? `<span class="sl">结果：${esc(e.note)}</span>` : ''}</span></div>` }
    const st = b.start, en = b.end
    let prev = new Date(st.ts).getTime()
    const items = b.items.map((it) => { const h = item(it, prev); prev = new Date(it.ts).getTime(); return h }).join('')
    const endLine = en
      ? `<div class="jb-end"><span class="t">${hm(en.ts)}</span><b>${esc(en.who)} ${esc(en.outcome ?? '交回')}</b><span class="stat">${fmtMs(en.elapsedMs)}${en.steps != null ? ` · ${en.steps} 句细步` : ''}${en.tokens != null ? ` · ${fmtK(en.tokens)} tokens` : ''}${en.tools != null ? ` · ${en.tools} 次工具` : ''}</span><span class="tx">${esc(en.text)}</span></div>`
      : '<div class="jb-end open">还没交回</div>'
    return `<details class="jb" open><summary><span class="t">${hm(st.ts)}</span> 开发指挥派 <b>${esc(st.who)}</b>：${esc(st.text)}${en ? `<span class="stat">${fmtMs(en.elapsedMs)} · ${b.items.length} 句细步</span>` : '<span class="stat open">进行中</span>'}</summary><div class="jbody">${items || '<div class="ji none">（没有写细步）</div>'}${endLine}</div></details>`
  }).join('')
  return sum + nav + `<div class="journal">${html}</div>`
}
/** 这一段的原文选读：讲解从 raw 里摘的原句与出处，人在走故事之前先读，不必自己去翻大文件 */
function sourcePage(slice) {
  if (!slice) return '<p>还没指到哪一段。</p>'
  const f = path.join(root, '导读', `${slice}-原文选读.md`)
  // 原文选读是段落切片的事：讲解写故事那一趟顺手摘（第九十三批）。模块切片没有这一步，照实说
  if (!fs.existsSync(f) && slice.startsWith('k-')) return `<p>${esc(slice)} 是模块切片，没有原文选读——这一条的底子是业务分析这一轮按模块点亮的语句，在「模型图」页上点开模块就看得见。原文选读是段落切片开工前讲解摘的。</p>`
  if (!fs.existsSync(f)) return `<p>${esc(slice)} 还没有原文选读。讲解写完故事后会从 <code>raw/</code> 里把这一段依据的原句摘出来放在 <code>导读/${esc(slice)}-原文选读.md</code>，给你先读。</p>`
  return `<article class="md">${mdToHtml(fs.readFileSync(f, 'utf8'))}</article>`
}
const wrap = (body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
body{margin:0;padding:16px 24px;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff}
.md h1{font-size:20px}.md h2{font-size:16px;margin-top:22px;border-bottom:1px solid #e6e8eb;padding-bottom:4px}.md h3{font-size:14px;color:#57606a}
.md table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}.md th,.md td{border:1px solid #e6e8eb;padding:5px 8px;text-align:left;vertical-align:top}.md th{background:#f6f8fa}
.ptree{margin:0 0 18px}.ptree .ph{color:#57606a;font-size:13px;margin:0 0 10px;padding:8px 12px;background:#f6f8fa;border:1px solid #e6e8eb;border-radius:6px}
.ptree details{margin:4px 0}.ptree summary{cursor:pointer;padding:3px 4px;border-radius:4px}.ptree summary:hover{background:#f6f8fa}.ptree summary code{font-size:13px;background:none;padding:0}
.ptree .cnt{font-size:12px;color:#1f6feb;margin-left:6px}.ptree .cnt.zero{color:#8c959f}.ptree .dir{margin-left:18px;border-left:1px solid #e6e8eb;padding-left:10px}
.fc{border:1px solid #e6e8eb;border-radius:8px;padding:8px 12px;margin:6px 0;background:#fff}.fc.prior{opacity:.55;background:#fafbfc}
.fh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.fh .no{font-size:11px;font-weight:700;color:#fff;background:#1f6feb;border-radius:999px;padding:0 8px}.fh .no.prior{background:#8c959f}
.fh .act{font-size:11px;padding:0 6px;border-radius:4px;border:1px solid #d0d7de;color:#57606a}.fh .act.create{color:#1a7f37;border-color:#a7d9b3}.fh .fn{font-weight:600;font-size:13px;background:none;padding:0}
.fh .tg{color:#57606a;font-size:12px}.fh .done{color:#1a7f37;font-size:12px;margin-left:auto}.fh .todo{color:#b45309;font-size:12px;margin-left:auto}
.fc .what{color:#1f2328;font-size:13px;margin:4px 0 0}.fc .tr{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#0969da}
.fc .kl{margin:6px 0 0}.fc .kl summary{font-size:12.5px;color:#0969da}.fc .kl .n{color:#57606a;font-weight:400}.fc .kl .n.over{color:#b45309}.fc .kl pre{white-space:pre-wrap;background:#f6f8fa;border:1px solid #e6e8eb;border-radius:6px;padding:8px 10px;font-size:12.5px;line-height:1.55;margin:4px 0 0}
.fc .kl.none{color:#b45309;font-size:12.5px}.fc .t{margin:6px 0 0 10px;padding-left:10px;border-left:2px solid #e6e8eb;font-size:12.5px;color:#57606a}.fc .t .no{font-size:11px;color:#fff;background:#8c959f;border-radius:999px;padding:0 6px}.fc .t .prior{color:#8c959f}
.fc .cf{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.fc .cst.un{background:#fff;color:#57606a;border-color:#d0d7de;padding:2px 10px;font-size:12px}
.fc .hc{margin-top:6px;font-size:12.5px}.fc .hc summary{color:#57606a;cursor:pointer}.fc .hn{margin:4px 0 0 12px;padding:3px 8px;border-left:3px solid #f3d27a;background:#fff8e1}.fc .hn .t{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8c959f;margin-right:6px}
.fc .hcf{display:flex;gap:8px;align-items:flex-start;margin:6px 0 0 12px}.fc .hcf textarea{flex:1;font:inherit;font-size:12.5px;padding:4px 6px;border:1px solid #d0d7de;border-radius:6px}.fc .hcb{padding:3px 10px;font-size:12px}.fc .cst{font:inherit;padding:4px 14px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer}.fc .cst:disabled{opacity:.5}.fc .okd{color:#1a7f37;font-size:12.5px}.fc .cmsg{font-size:12.5px;color:#57606a}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;align-items:start}.cols h2{font-size:15px;margin:0 0 8px;border-bottom:1px solid #e6e8eb;padding-bottom:4px}.cols h2 .n{font-size:12px;color:#57606a;font-weight:400;margin-left:6px}.cols .none{color:#8c959f;font-size:13px}
.sc,.cc{border:1px solid #e6e8eb;border-radius:8px;padding:8px 12px;margin:6px 0;background:#fff}.sc.cur{border-color:#1f6feb;box-shadow:0 0 0 2px #dbe7ff}.sc.closed{opacity:.75}.cc.opened,.cc.dropped{opacity:.6}
.sh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.sh .id{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#fff;background:#1f6feb;border-radius:999px;padding:0 8px}.cc .sh .id{background:#8c959f}.sh .sp{flex:1}.sh .now{font-size:11px;color:#b45309;border:1px solid #f3d27a;background:#fff8e1;border-radius:4px;padding:0 6px}.sh .okd{font-size:11px;color:#1a7f37}
.st{font-size:11px;padding:0 6px;border-radius:4px;border:1px solid #d0d7de;color:#57606a;margin-left:4px}.st.done{color:#1a7f37;border-color:#a7d9b3;background:#eaf7ed}.st.in-progress,.st.open{color:#b45309;border-color:#f3d27a;background:#fff8e1}.st.opened{color:#1a7f37;border-color:#a7d9b3}
.sc .gt{margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;color:#57606a}.sc .gt .cst{font:inherit;padding:3px 12px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer}.sc .gt .cst:disabled{opacity:.5}.sc .gt .cmsg{font-size:12.5px}
.sc .it,.cc .it{font-size:13px;margin:4px 0 0}.sc .meta,.cc .meta{font-size:12px;color:#57606a;margin-top:2px}.sc .last{font-size:12px;color:#8c959f;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jnav{margin:0 0 10px;font-size:13px}.jnav a{margin-right:10px;color:#0969da;text-decoration:none}.jnav a.on{font-weight:700;color:#1f2328;border-bottom:2px solid #1f6feb}
.jsum{border-collapse:collapse;font-size:12.5px;margin:0 0 12px}.jsum th,.jsum td{border:1px solid #e6e8eb;padding:3px 10px;text-align:left}.jsum th{background:#f6f8fa}
.journal .t{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#57606a;margin-right:8px}.journal .who{font-weight:600;margin-right:6px}.journal .k{font-size:11px;color:#57606a;border:1px solid #d0d7de;border-radius:4px;padding:0 5px;margin-right:8px}
.je{padding:3px 8px;font-size:13px;border-left:3px solid #e6e8eb;margin:3px 0}.je.k-set{border-left-color:#8c959f}.je.k-set.done{opacity:.7}.je.k-ask{border-left-color:#f3d27a;background:#fff8e1}.je.k-answer,.je.k-confirm,.je.k-review{border-left-color:#a7d9b3;background:#eaf7ed}.je.k-comment,.je.k-unconfirm{border-left-color:#f3d27a;background:#fff8e1}.je.k-handoff{border-left-color:#1f6feb}.je .sl{display:block;font-size:12px;color:#8c959f}
.jb{border:1px solid #e6e8eb;border-radius:8px;margin:8px 0;background:#fff}.jb summary{padding:6px 10px;cursor:pointer;font-size:13px}.jb summary:hover{background:#f6f8fa}.jb .stat{float:right;font-size:12px;color:#57606a}.jb .stat.open{color:#b45309}
.jbody{padding:4px 10px 8px 26px;border-top:1px solid #f0f2f4}.ji{display:flex;gap:8px;font-size:12.5px;padding:2px 0;align-items:baseline}.ji .gap{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#b45309;min-width:70px}.ji .tx{flex:1}.ji.none{color:#8c959f}
.jb-end{margin-top:6px;padding-top:6px;border-top:1px dashed #e6e8eb;font-size:13px}.jb-end .stat{float:none;margin-left:8px}.jb-end .tx{display:block;color:#57606a;font-size:12.5px;margin-top:2px}.jb-end.open{color:#b45309}
.seq{margin-top:10px}.seq summary{cursor:pointer;color:#0969da;font-size:13px}
.md blockquote{margin:8px 0;padding:8px 14px;border-left:3px solid #8a6d00;background:#fffdf5;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.55}
.gate{margin:0 0 14px;padding:10px 14px;border-radius:6px;border:1px solid #e6e8eb;background:#f6f8fa}.gate.ok{border-color:#a7d9b3;background:#eaf7ed}.gate.ask{border-color:#f3d27a;background:#fff8e1}.gate.wait{color:#57606a}.gate button{font:inherit;margin-left:10px;padding:4px 14px;border-radius:6px;border:1px solid #8a6d00;background:#ffd76a;cursor:pointer}.gate button:disabled{opacity:.5;cursor:default}#confirmMsg{margin-left:10px}
.md pre{background:#f6f8fa;border:1px solid #e6e8eb;border-radius:6px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.5}.md code{background:#f3f4f6;padding:0 4px;border-radius:3px;font-size:12.5px}
</style></head><body>${body}
<script>
// 「切片」页两道门的按钮（第九十七批）：初稿定了 / 出原型。点了就 POST 给工作台，工作台跑 slice.js 那一条命令；成了刷新，没成把原话写在旁边
document.querySelectorAll('[data-gate]').forEach(function (b) {
  b.addEventListener('click', async function () {
    b.disabled = true
    var m = b.nextElementSibling
    if (m) m.textContent = '记上…'
    try {
      var r = await fetch('/slice/' + b.dataset.gate + '?slice=' + encodeURIComponent(b.dataset.slice), { method: 'POST' })
      var t = await r.text()
      if (r.ok) location.reload()
      else { if (m) m.textContent = '没成：' + t; b.disabled = false }
    } catch (e) { if (m) m.textContent = '没成：' + e.message; b.disabled = false }
  })
})
</script></body></html>`

// ---------- 外壳 ----------
const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>工作台 · ${esc(projectName)}</title>
<style>
:root{--bg:#0f172a;--fg:#e5e7eb;--dim:#94a3b8;--line:#1e293b;--on:#38bdf8;--warn:#fbbf24}
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--page,#f6f7f9)}
header{display:flex;align-items:center;gap:6px;padding:0 14px;height:44px;background:var(--bg);color:var(--fg);flex-shrink:0}
header h1{font-size:14px;margin:0 14px 0 0;font-weight:600;white-space:nowrap}header h1 span{color:var(--dim);font-weight:400;margin-left:8px}
header button{font:inherit;color:var(--dim);background:none;border:0;border-bottom:2px solid transparent;padding:0 12px;height:44px;cursor:pointer;white-space:nowrap}
header button.on{color:#fff;border-bottom-color:var(--on)}
header button#theme{font-size:15px;padding:0 8px;border:0;opacity:.75}header button#theme:hover{opacity:1}header button .b{display:inline-block;margin-left:6px;font-size:11px;font-weight:700;padding:0 6px;border-radius:999px;background:var(--warn);color:#111}
header button .b.soft{background:#475569;color:#cbd5e1;font-weight:400}
header .td{font-size:12.5px;white-space:nowrap;padding:2px 10px;border-radius:999px;margin-right:10px}
header .td.on{background:var(--warn);color:#111;font-weight:600}header .td.off{color:var(--dim)}
header .sp{flex:1}header .now{color:var(--dim);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}header a{color:var(--dim);font-size:12px;margin-left:12px;text-decoration:none}header a:hover{color:#fff}
main{flex:1;position:relative}iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--page,#fff)}
</style></head><body>
<header><h1>工作台<span>${esc(projectName)}</span></h1>
<button data-t="scene" class="on">谁在干什么</button><button data-t="ask">等你答</button><button data-t="slices">切片</button><button data-t="journal">日志</button><button data-t="source">读原文</button><button data-t="story">走故事</button><button data-t="model">模型图</button><button data-t="delta">这段改了什么</button><button data-t="review">审模型</button><button data-t="codemodel">审代码对模型</button><button data-t="prepr">审代码</button><button data-t="plan">编码计划</button><button data-t="proto">试原型</button>
<span class="sp"></span><span class="td" id="todo"></span><span class="now" id="now"></span><button id="theme" title="白天 / 黑夜">🌙</button><a id="open" href="#" target="_blank" title="在新窗口打开这一页">新窗口 ↗</a></header>
<main><iframe id="f" src="/p/scene/"></iframe></main>
<script>
let cur='scene';let slice=null;let who=null
const url=(t)=>({scene:'/p/scene/',ask:'/p/scene/questions',slices:'/slices',journal:'/journal',source:'/source'+(slice?'?slice='+slice:''),story:'/p/story/story'+(slice?'?slice='+slice:''),model:'/p/story/model',delta:'/delta'+(slice?'?slice='+slice:''),review:'/p/review/',codemodel:'/p/codemodel/',prepr:'/p/prepr/',plan:'/plan'+(slice?'?slice='+slice:''),proto:'/p/proto/'})[t]
const f=document.getElementById('f'),open=document.getElementById('open')
function show(t){cur=t;for(const b of document.querySelectorAll('header button'))b.classList.toggle('on',b.dataset.t===t);f.src=url(t);open.href=url(t);try{localStorage.setItem('wb-tab',t)}catch{}}
for(const b of document.querySelectorAll('header button'))b.addEventListener('click',()=>show(b.dataset.t))
async function poll(){try{const s=await (await fetch('/state')).json();slice=s.slice;who=s.who
  document.getElementById('now').textContent=(s.slice?s.slice+' · ':'')+(s.phase?s.phase+' · ':'')+(s.who?s.who+' · ':'')+(s.step||'')
  // 模块切片上这一页装的是业务走查，不是故事线（第九十七批）——页签名字跟着当前切片走
  const sb=document.querySelector('header button[data-t="story"]')
  if(sb&&sb.firstChild&&sb.firstChild.nodeType===3)sb.firstChild.nodeValue=(slice||'').indexOf('k-')===0?'业务走查':'走故事'
}catch{}}
// 页签上的待办数：每一页还有几件等他的事，按文件实数（不是拿现场那句话套正则猜）。
// badge 找不到那个页签就跳过——从前 badge('delta') 指着一个并不存在的页签，一抛错后面的「编码计划」就永远标不上。
async function todo(){try{const d=await (await fetch('/todo')).json()
  const soft=new Set(d.soft||[])
  for(const b of document.querySelectorAll('header button[data-t]')){
    const t=b.dataset.t,n=(d.tabs||{})[t]||0
    let x=b.querySelector('.b')
    if(n){if(!x){x=document.createElement('span');x.className='b';b.appendChild(x)}
      x.textContent=n;x.classList.toggle('soft',soft.has(t))
      b.title=(d.why||{})[t]||''}
    else{if(x)x.remove();b.title=''}
  }
  const el=document.getElementById('todo')
  el.textContent=d.total?d.total+' 件等你':'没有等你的事'
  el.className='td '+(d.total?'on':'off')
  el.title=Object.entries(d.why||{}).map(([k,v])=>v).join('\\n')
  document.title=(d.total?'('+d.total+') ':'')+'工作台 · ${esc(projectName)}'
}catch{}}
poll();todo();setInterval(poll,5000);setInterval(todo,5000)
// 白天 / 黑夜：存 cookie，服务器按它决定每张页面翻不翻面；没选过就先照系统偏好定一次
const cookie=(k)=>((document.cookie.match('(?:^|; )'+k+'=([^;]*)')||[])[1]||'')
function setTheme(v){document.cookie='wb-theme='+v+'; path=/; max-age=31536000';location.reload()}
;(function(){
  let t=cookie('wb-theme')
  if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';setTheme(t);return}
  const b=document.getElementById('theme')
  b.textContent=t==='dark'?'🌙':'☀️'
  b.title=t==='dark'?'现在是黑夜，点一下换白天':'现在是白天，点一下换黑夜'
  b.addEventListener('click',()=>setTheme(t==='dark'?'light':'dark'))
})()
let t0=null;try{t0=localStorage.getItem('wb-tab')}catch{}
if(t0&&t0!=='scene')setTimeout(()=>show(t0),300)
</script></body></html>`

// ---------- 反向代理：子页面全从工作台这一个口出去 ----------
// 子页面里写死的根路径（fetch('/data')、href="/model"）在代理下会打到工作台自己身上，
// 所以给每张 HTML 注一小段：fetch 与点链接都自动加上这一页的前缀。
const shimOf = (base) => `<script>(function(){var B=${JSON.stringify(base)};
var F=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.slice(0,3)!=='/p/')u=B+u;return F.call(window,u,o)};
document.addEventListener('click',function(e){var t=e.target;while(t&&t.tagName!=='A')t=t.parentNode;if(!t||!t.getAttribute)return;
var h=t.getAttribute('href');if(!h||h.charAt(0)!=='/'||h.charAt(1)==='/'||h.slice(0,3)==='/p/')return;e.preventDefault();var u=B+h;
if(t.target&&t.target!=='_self')window.open(u,t.target);else location.href=u},true)})()</script>`
function proxy(name, req, res, rest) {
  const up = http.request({ host: '127.0.0.1', port: INNER[name], method: req.method, path: rest, headers: { ...req.headers, host: `127.0.0.1:${INNER[name]}` } }, (ur) => {
    const ct = String(ur.headers['content-type'] ?? '')
    // 逐跳的头一律不转：body 到这里已经被 Node 解成了普通字节，再声明 chunked / gzip 就成了坏包，
    // 浏览器那一侧 fetch 报错、页面停在「连接中…」（2026-09-13 现场页踩过）
    const hop = (h) => { const o = { ...h }; delete o['transfer-encoding']; delete o['content-encoding']; delete o['connection']; delete o['keep-alive']; return o }
    if (!/text\/html/.test(ct)) { res.writeHead(ur.statusCode ?? 200, hop(ur.headers)); return ur.pipe(res) }
    const buf = []
    ur.on('data', (c) => buf.push(c)).on('end', () => {
      let body = Buffer.concat(buf).toString('utf8')
      body = themed(body, name, themeOf(req))
      const shim = shimOf('/p/' + name)
      // 必须排在页面自己的脚本之前：页面一加载就 fetch('/data')，晚一步就打到工作台根上 404，框里是空的（2026-09-13 踩过）
      body = body.includes('</head>') ? body.replace('</head>', shim + '</head>')
        : body.includes('<body>') ? body.replace('<body>', '<body>' + shim)
        : shim + body
      // 改过正文就重算长度：上游是 chunked 传过来的，transfer-encoding 与 content-length 同时在，浏览器判成坏包，页面整个打不开
      const h = hop(ur.headers)
      h['content-length'] = String(Buffer.byteLength(body))
      h['cache-control'] = 'no-store'
      res.writeHead(ur.statusCode ?? 200, h)
      res.end(body)
    })
  })
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`${name} 这一页连不上：${e.message}`) })
  req.pipe(up)
}

// 访问日志：人说「页面不好用」时，服务器这边只看得见自己没出错，看不见他的浏览器碰到了什么。记一行就有据可查。
const accessLog = fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' })
const server = http.createServer((req, res) => {
  const t0 = Date.now()
  res.on('finish', () => { try { accessLog.write(`${new Date().toISOString()} ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms\n`) } catch { /* 日志写不动不影响页面 */ } })
  const [url, qs] = (req.url ?? '/').split('?')
  const q = Object.fromEntries(new URLSearchParams(qs ?? ''))
  const theme = themeOf(req)
  const html = (b, who = '现算') => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(themed(b, who, theme)) }
  // /p/<页面>/… → 转给对应的子服务；页面只认工作台这一个口
  const m = url.match(/^\/p\/([a-z]+)(\/.*)?$/)
  if (m) {
    const name = m[1]
    if (!INNER[name]) return html(wrap(`<p>${MISSING[name] ?? '这一页还没起来。'}</p>`))
    // theme 是工作台这一层的参数，别转给子服务：有的子服务按整串地址匹配路由，多一个参数就找不到页了
    const rest = [...new URLSearchParams(qs ?? '')].filter(([k]) => k !== 'theme')
    const q2 = new URLSearchParams(rest).toString()
    return proxy(name, req, res, (m[2] || '/') + (q2 ? '?' + q2 : ''))
  }
  // 换主题也留一个地址：/theme?set=dark|light（外壳上那个按钮走的是同一条路，脚本与截图也用得上）
  if (url === '/theme') {
    const v = q.set === 'dark' ? 'dark' : 'light'
    res.writeHead(302, { 'set-cookie': `wb-theme=${v}; Path=/; Max-Age=31536000`, location: '/', 'cache-control': 'no-store' })
    return res.end()
  }
  if (url === '/') return html(shell, '外壳')
  // 外壳拿 /state 决定每个页签的地址带哪一段。slice 报的是**算出来的**那一条（看板没写就从 slices/ 里挑），
  // 不是看板里那个字段的原样——看板漏记一笔，页签不该跟着指不到地方
  if (url === '/state') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ...scene(), slice: currentSlice() })) }
  if (url === '/todo') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(todo())) }
  if (url === '/delta') return html(deltaPage(q.slice || currentSlice()) ?? wrap('<p>还没指到哪一段。</p>'))
  if (url === '/slices') return html(wrap(slicesPage()))
  if (url === '/journal') return html(wrap(journalPage(q.date)))
  if (url === '/plan') return html(wrap(planPage(q.slice || currentSlice())))
  if (url === '/source') return html(wrap(sourcePage(q.slice || currentSlice())))
  // 计划页的按钮：确认 / 撤销 / 留话都不另写逻辑，直接跑命令行那一个（plan.js confirm | unconfirm | comment），门禁、日志、切片记录同一套；
  // 留话顺手记进现场日志（scene progress --who 人），事后在「日志」页看得见人在哪一步说了什么
  const planCmd = (sub, slice, extra, okText) => {
    const r = spawnSync(process.execPath, [path.join(tools, 'plan.js'), sub, root, slice, ...extra], { encoding: 'utf8', cwd: root })
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
    console.log(`页面上 plan ${sub} ${slice} ${extra[0] ?? ''} → ${r.status === 0 ? '成' : '拒'}：${out.split('\n')[0]}`)
    res.writeHead(r.status === 0 ? 200 : 409, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(out || (r.status === 0 ? okText : '没成'))
    return r.status === 0
  }
  if ((url === '/plan/confirm' || url === '/plan/unconfirm') && req.method === 'POST') {
    const slice = q.slice || currentSlice()
    if (!/^[sm]-[0-9]{3,}$/.test(slice ?? '')) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('没指到哪一段') }
    const stepNo = /^\d+$/.test(q.step ?? '') ? [q.step] : []
    if (url === '/plan/unconfirm' && !stepNo.length) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('撤销要指明第几步') }
    return planCmd(url === '/plan/confirm' ? 'confirm' : 'unconfirm', slice, stepNo, url === '/plan/confirm' ? '已确认' : '已撤销')
  }
  if (url === '/plan/comment' && req.method === 'POST') {
    const slice = q.slice || currentSlice()
    if (!/^[sm]-[0-9]{3,}$/.test(slice ?? '') || !/^\d+$/.test(q.step ?? '')) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('要指明哪一段第几步') }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const text = body.trim()
      if (!text) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('先写一句') }
      planCmd('comment', slice, [q.step, text], '记下了') // plan.js 自己把这一笔记进日志
    })
    return
  }
  // 「切片」页上的两道门（第九十七批）：模块切片「初稿定了」= slice advance model done；段落「出原型」= slice proto-go。跟计划页一样直接跑命令行那一个
  if ((url === '/slice/draft-ok' || url === '/slice/proto-go') && req.method === 'POST') {
    const slice = q.slice
    if (!/^[sk]-[0-9]{3,}$/.test(slice ?? '')) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('没指到哪一条切片') }
    const argv = url === '/slice/draft-ok' ? ['advance', root, slice, 'model', 'done', '初稿定了（项目所有者在切片页按的）'] : ['proto-go', root, slice, '项目所有者在切片页按了「出原型」']
    const r = spawnSync(process.execPath, [path.join(tools, 'slice.js'), ...argv], { encoding: 'utf8', cwd: root })
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
    console.log(`页面上 slice ${argv[0]} ${slice} → ${r.status === 0 ? '成' : '拒'}：${out.split('\n')[0]}`)
    res.writeHead(r.status === 0 ? 200 : 409, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(out || (r.status === 0 ? '记下了' : '没成'))
  }
  if (url === '/plan/state') {
    const slice = q.slice || currentSlice()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ slice, gateHtml: slice ? planGateDiv(slice) : '' }))
  }
  res.writeHead(404); res.end()
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`${port} 上已经有工作台在跑了。要换成新代码就先把它停掉（Ctrl+C 或结束那个 node 进程），再起这一个。`); process.exit(2) }
  throw e
})
startAll().then(() => {
  server.listen(port, () => {
    console.log(`子页面都起在本机的临时口上、不对外（${Object.keys(INNER).join('、') || '无'}），人不用管它们`)
    console.log(`工作台：http://localhost:${port}　（Ctrl+C 结束；会一并关掉自己拉起来的子服务）`)
  })
})
