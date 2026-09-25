#!/usr/bin/env node
/**
 * 工作台：给人看的页面全在一个地址里，开工先把它起来。
 *
 *   node tools/workbench.js <项目> [--code <代码库>] [--port 4870] [--no-open]
 *
 * 四个页签：谁在干什么（scene，群聊的样子；等他答的问题、等他拍板的关卡列成待办；日志从这一页进）· 切片 · 模型图（model-page）· 草稿原型（proto）。
 * 子服务各挑一个空闲口、只听本机、不自己弹浏览器，全从这一个口代理出去（/p/<页面>/…）。退出时一并关掉。
 * 顶栏「N 件等你」数的是：看板上没答的问题，加上停在他手里的那一段（场景等他定下、草稿原型等他按）。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const clock = require('./lib/time')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
if (!root || !fs.existsSync(path.join(root, 'project.json'))) { console.error('用法：node tools/workbench.js <项目> [--code <代码库>] [--port 4870]'); process.exit(2) }
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const port = Number(opt('--port') ?? 4870)
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'))
const codebase = opt('--code') ? path.resolve(opt('--code')) : project.codebase ? path.resolve(root, project.codebase) : null
const tools = __dirname
const logDir = path.join(root, 'reports', '_workbench')
fs.mkdirSync(logDir, { recursive: true })
const INNER = {}
const children = []
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }

function connectable(host, p) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port: p }).once('connect', () => { c.destroy(); resolve(true) }).once('error', () => resolve(false))
    c.setTimeout(800, () => { c.destroy(); resolve(false) })
  })
}
async function portBusy(p) { return (await connectable('127.0.0.1', p)) || (await connectable('::1', p)) }
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
function adoptLater(name, p) {
  let left = 120
  const t = setInterval(async () => {
    if (INNER[name]) return clearInterval(t)
    if (await portBusy(p)) { INNER[name] = p; console.log(`${name}：起来了，已接上`); return clearInterval(t) }
    if (--left <= 0) { clearInterval(t); console.log(`${name}：两分钟了还没起来，放弃；看 reports/_workbench/${name}.log`) }
  }, 1000)
  t.unref()
}
async function ensure(name, argvOf, cwd, seconds) {
  const p = await freePort()
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a')
  const child = spawn(process.execPath, argvOf(p), { cwd: cwd ?? root, stdio: ['ignore', out, out], windowsHide: true })
  children.push({ name, child })
  if (await waitServed(name, p, seconds)) INNER[name] = p
  else adoptLater(name, p)
  return INNER[name] ?? null
}

// 原型要代码库里有 src/proto/main.ts 才起得来；工作台起得早，每 5 秒回头看一次
let protoTried = false
async function startProto() {
  if (protoTried || !codebase || !fs.existsSync(path.join(codebase, 'src', 'proto', 'main.ts'))) return
  protoTried = true
  const hostPort = await freePort()
  await ensure('proto', (p) => [path.join(tools, 'proto.js'), 'serve', root, '--code', codebase, '--port', String(p), '--proto-port', String(hostPort), '--no-open'], undefined, 30)
}
async function startAll() {
  await ensure('scene', (p) => [path.join(tools, 'scene.js'), root, 'serve', '--port', String(p)])
  await ensure('model', (p) => [path.join(tools, 'model-page.js'), root, '--port', String(p)])
  await startProto()
  const t = setInterval(() => startProto().catch((e) => console.log('草稿原型：起不来——' + e.message)), 5000)
  t.unref()
}
function stopAll() { for (const { child } of children) { try { child.kill() } catch { /* 已退出 */ } } }

const STAGES = { scene: ['scene', 'model', 'draft', 'walk'], formalize: ['code', 'check', 'accept'] }
const NAMES = { scene: '场景', model: '模型', draft: '草稿原型', walk: '一起按', code: '正式代码', check: '校验与审查', accept: '验收' }
function allSlices() {
  const dir = path.join(root, 'slices')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[sf]-\d+\.json$/.test(f)).sort().map((f) => readJson(path.join(dir, f))).filter(Boolean) : []
}
const st = (s, k) => s.stages?.[k]?.status ?? 'pending'
/** 停在他手里的那一步：场景写好了等他定下、草稿原型好了等他按 */
function gateOf(s) {
  if (s.kind !== 'scene') return st(s, 'check') === 'done' && st(s, 'accept') !== 'done' ? { kind: 'accept', ask: '在原型上把这一批按一遍，对了就验收。', button: '验收' } : null
  if (st(s, 'scene') !== 'done' && s.scene) return { kind: 'scene-ok', ask: '场景是这样的：「' + s.scene + '」对吗？', button: '场景定下' }
  if (st(s, 'draft') === 'done' && st(s, 'walk') !== 'done') return { kind: 'enough', ask: '在「草稿原型」页和模型师一起按过了？这一段够了就按。', button: '这一段够了' }
  return null
}
function todo() {
  const sc = readJson(path.join(root, 'reports', '_scene.json'), {})
  const qs = (sc.questions ?? []).filter((q) => !q.answeredAt)
  const gates = allSlices().map((s) => ({ s, g: gateOf(s) })).filter((x) => x.g)
  return { n: qs.length + gates.length, questions: qs.length, gates: gates.map((x) => ({ slice: x.s.id, title: x.s.title ?? '', kind: x.g.kind, ask: x.g.ask, button: x.g.button })) }
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
</style></head><body>${body}</body></html>`

function slicesPage() {
  const list = allSlices()
  if (!list.length) return '<p>还没有切片。业务分析提一个场景，或者你说一个；定了开发指挥就开 <code>s-001</code>。</p>'
  const tag = (x) => ({ done: '<b style="color:#1a7f37">✓</b>', 'in-progress': '<b style="color:#bf8700">…</b>' }[x] ?? '<span style="color:#8c959f">·</span>')
  const rows = list.map((s) => {
    const g = gateOf(s)
    const stages = STAGES[s.kind].map((k) => NAMES[k] + ' ' + tag(st(s, k))).join('　')
    return '<div class="fc"><b>' + esc(s.title) + '</b> <span style="color:#57606a">' + esc(s.id) + '</span>'
      + (s.scene ? '<div>' + esc(s.scene) + '</div>' : s.covers ? '<div>正式化：' + esc(s.covers.join('、')) + '</div>' : '')
      + '<div style="margin-top:4px">' + stages + '</div>'
      + (g ? '<div style="margin-top:8px">' + esc(g.ask) + ' <button data-gate="' + g.kind + '" data-slice="' + esc(s.id) + '">' + esc(g.button) + '</button> <span class="st"></span></div>' : '')
      + '</div>'
  }).join('')
  return rows + `<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-gate]'); if (!b) return
  b.disabled = true
  const r = await fetch('/slice/' + b.dataset.gate + '?slice=' + encodeURIComponent(b.dataset.slice), { method: 'POST' })
  const t = await r.text()
  if (r.ok) location.reload(); else { b.disabled = false; b.parentNode.querySelector('.st').textContent = '没成：' + t }
})
</script>`
}

function journalPage(date) {
  const dir = path.join(root, 'journal')
  // 日志文件按 UTC 日期分，本机时区和 UTC 差着几个小时：一个 UTC 文件里可能装着本地的两天，
  // 本地一天的事也可能散在两个文件里。给人看的「哪一天」按本地算，所以把文件全读进来、按本地日期重新分堆。
  // （几天下来也就一两百 KB，读全份最省心；存进文件的仍是 UTC 的 ISO 串。）
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) : []
  const byDay = new Map()
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const e = JSON.parse(line); const d = clock.date(e.ts); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e) } catch { /* 坏行跳过 */ }
    }
  }
  const days = [...byDay.keys()].sort().reverse()
  const day = date && byDay.has(date) ? date : days[0]
  const back = `<div style="text-align:right;margin:0 0 8px"><a href="/p/scene/${day ? '?date=' + day : ''}" style="text-decoration:none;color:#0969da;font-size:13px;border:1px solid #d0d7de;border-radius:6px;padding:2px 10px;background:#fff">← 回到现场</a></div>`
  const nav = `<div class="jnav">${days.map((d) => `<a href="/journal?date=${d}" class="${d === day ? 'on' : ''}">${d}</a>`).join('') || '<span>还没有日志</span>'}</div>`
  if (!day) return `<div class="ptree"><div class="ph">日志记的是角色们怎么配合：开发指挥几点派了谁做什么、角色每一句细步、几点交回、花了多久。scene.js 每写一笔看板就往 <code>journal/&lt;日期&gt;.jsonl</code> 追加一行，只追加不裁剪。</div></div>${nav}`
  const entries = byDay.get(day)
  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  const fmtMs = (ms) => { if (ms == null) return ''; const s = Math.round(ms / 1000); if (s < 60) return `${s} 秒`; const m = Math.floor(s / 60); return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分` }
  const fmtK = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
  const hm = (ts) => clock.hms(ts)
  const KIND = { plan: '计划', set: '看板', ask: '发问', answer: '答', mode: '模式', handoff: '交接', progress: '细步', back: '交回', dispatch: '派工', confirm: '确认', unconfirm: '撤销确认', comment: '留话', review: '审阅' }
  // 分块
  const blocks = [], open = new Map()
  for (const e of entries) {
    if (e.kind === 'dispatch') { const b = { kind: 'block', who: e.who, start: e, items: [], end: null }; blocks.push(b); open.set(e.who, b); continue }
    if (e.kind === 'back' && open.has(e.who)) { open.get(e.who).end = e; open.delete(e.who); continue }
    if ((e.kind === 'progress' || e.kind === 'ask' || e.kind === 'plan') && open.has(e.who)) { open.get(e.who).items.push(e); continue }
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
  const sum = `<div class="ptree"><div class="ph">${esc(day)}（${esc(clock.zone(entries[0]?.ts ?? new Date()))}，下面的钟点都是本地时间）共 ${entries.length} 笔：派工 ${blocks.filter((b) => b.kind === 'block').length} 趟${stillOpen.length ? `（${stillOpen.map(esc).join('、')} 还没交回）` : ''}；等你拍板累计 ${fmtMs(waitMs) || '0 秒'}。每块是一趟派工：开发指挥几点派了谁做什么、角色每一句细步与上一句隔了多久、几点交回、这一趟多长、用了多少。<b>最近的排在最上面</b>，一趟里面的细步仍按先后读下去。复盘时看：一趟里细步之间的空档在哪、哪一趟来回最多。</div></div>
${byRole.size ? `<table class="jsum"><tr><th>角色</th><th>派了几趟</th><th>共多久</th><th>细步</th><th>tokens</th><th>工具次数</th></tr>${[...byRole].map(([w, r]) => `<tr><td>${esc(w)}</td><td>${r.n}</td><td>${fmtMs(r.ms)}</td><td>${r.steps || ''}</td><td>${fmtK(r.tokens) || ''}</td><td>${r.tools || ''}</td></tr>`).join('')}</table>` : ''}`
  const item = (it, prev) => `<div class="ji"><span class="t">${hm(it.ts)}</span><span class="gap">+${fmtMs(new Date(it.ts) - prev)}</span><span class="tx">${it.kind === 'ask' ? '<b>发问：</b>' : it.kind === 'plan' ? '<b>计划：</b>' : it['步'] ? '<b>' + it['步'] + '.</b> ' : ''}${esc(it.text)}</span></div>`
  // 最近的排在上面：一天下来几十笔，人要看的是刚刚发生了什么，不该每次滚到底。
  // 一趟派工里面的细步仍按先后读下去——那是一趟活的经过，倒着读不成话；派工块自己按开工时间排。
  const html = blocks.slice().reverse().map((b) => {
    if (b.kind === 'event') { const e = b.e; return `<div class="je k-${esc(e.kind)}${e.done ? ' done' : ''}"><span class="t">${hm(e.ts)}</span><span class="who">${esc(e.who ?? '—')}</span><span class="k">${KIND[e.kind] ?? esc(e.kind)}${e.kind === 'set' && e.done ? '（完）' : ''}</span><span class="tx">${esc(e.text)}${e.kind === 'set' && e.slice ? `<span class="sl">${esc(e.slice)} · ${esc(e.phase ?? '—')}</span>` : ''}${e.kind === 'set' && e.note ? `<span class="sl">结果：${esc(e.note)}</span>` : ''}</span></div>` }
    const st = b.start, en = b.end
    let prev = new Date(st.ts).getTime()
    const items = b.items.map((it) => { const h = item(it, prev); prev = new Date(it.ts).getTime(); return h }).join('')
    const endLine = en
      ? `<div class="jb-end"><span class="t">${hm(en.ts)}</span><b>${esc(en.who)} ${esc(en.outcome ?? '交回')}</b><span class="stat">${fmtMs(en.elapsedMs)}${en.steps != null ? ` · ${en.steps} 句细步` : ''}${en.tokens != null ? ` · ${fmtK(en.tokens)} tokens` : ''}${en.tools != null ? ` · ${en.tools} 次工具` : ''}</span><span class="tx">${esc(en.text)}</span></div>`
      : '<div class="jb-end open">还没交回</div>'
    return `<details class="jb" open><summary><span class="t">${hm(st.ts)}</span> 开发指挥派 <b>${esc(st.who)}</b>：${esc(st.text)}${en ? `<span class="stat">${fmtMs(en.elapsedMs)} · ${b.items.length} 句细步</span>` : '<span class="stat open">进行中</span>'}</summary><div class="jbody">${items || '<div class="ji none">（没有写细步）</div>'}${endLine}</div></details>`
  }).join('')
  return back + sum + nav + `<div class="journal">${html}</div>`
}

const TABS = [['scene', '谁在干什么', '/p/scene/'], ['slices', '切片', '/slices'], ['model', '模型图', '/p/model/'], ['proto', '草稿原型', '/p/proto/']]
const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(project.name ?? '工作台')}</title><style>
html,body{margin:0;height:100%;font:14px system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:6px;padding:6px 12px;background:#24292f;color:#fff}
header b{margin-right:12px}header button{background:none;border:1px solid transparent;color:#d0d7de;padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit}
header button.on{background:#fff;color:#24292f}header .todo{margin-left:auto;color:#ffd33d;cursor:pointer}
iframe{border:0;width:100%;height:calc(100% - 40px);display:block}
</style></head><body><header><b>${esc(project.name ?? '')}</b>${TABS.map(([k, n]) => '<button data-t="' + k + '">' + n + '</button>').join('')}<span class="todo" id="todo"></span></header>
<iframe id="f"></iframe><script>
const T = ${JSON.stringify(Object.fromEntries(TABS.map(([k, , u]) => [k, u])))}
const f = document.getElementById('f')
function show(t) { for (const b of document.querySelectorAll('header button')) b.classList.toggle('on', b.dataset.t === t); f.src = T[t]; try { localStorage.setItem('wb-tab', t) } catch (e) {} }
document.querySelectorAll('header button').forEach((b) => b.addEventListener('click', () => show(b.dataset.t)))
async function todo() { try { const d = await (await fetch('/todo')).json(); document.getElementById('todo').textContent = d.n ? d.n + ' 件待办 ›' : '' } catch (e) {} }
let first = 'scene'; try { first = localStorage.getItem('wb-tab') || 'scene' } catch (e) {}
document.getElementById('todo').addEventListener('click', () => show('scene'))
show(T[first] ? first : 'scene'); todo(); setInterval(todo, 5000)
</script></body></html>`

const shimOf = (base) => `<script>(function(){var B=${JSON.stringify(base)};
var F=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.slice(0,3)!=='/p/')u=B+u;return F.call(window,u,o)};
document.addEventListener('click',function(e){var t=e.target;while(t&&t.tagName!=='A')t=t.parentNode;if(!t||!t.getAttribute)return;
var h=t.getAttribute('href');if(!h||h.charAt(0)!=='/'||h.charAt(1)==='/'||h.slice(0,3)==='/p/')return;e.preventDefault();var u=B+h;
if(t.target&&t.target!=='_self')window.open(u,t.target);else location.href=u},true)})()</script>`
function proxy(name, req, res, rest) {
  const up = http.request({ host: '127.0.0.1', port: INNER[name], method: req.method, path: rest, headers: { ...req.headers, host: `127.0.0.1:${INNER[name]}` } }, (ur) => {
    const ct = String(ur.headers['content-type'] ?? '')
    // 逐跳的头一律不转：body 到这里已经被 Node 解成了普通字节，再声明 chunked / gzip 就成了坏包，
    // 浏览器那一侧 fetch 报错、页面停在「连接中…」
    const hop = (h) => { const o = { ...h }; delete o['transfer-encoding']; delete o['content-encoding']; delete o['connection']; delete o['keep-alive']; return o }
    if (!/text\/html/.test(ct)) { res.writeHead(ur.statusCode ?? 200, hop(ur.headers)); return ur.pipe(res) }
    const buf = []
    ur.on('data', (c) => buf.push(c)).on('end', () => {
      let body = Buffer.concat(buf).toString('utf8')
      const shim = shimOf('/p/' + name)
      // 必须排在页面自己的脚本之前：页面一加载就 fetch('/feed')，晚一步就打到工作台根上 404，框里是空的
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

const MISSING = {
  proto: '草稿原型要代码库里有 <code>src/proto/main.ts</code>——编码起过草稿原型之后才有，出现了几秒后这一页自己会起来。',
  model: '模型图还没起来，等几秒再点一次。',
  scene: '看板还没起来，等几秒再点一次。',
}
function runSlice(res, argv) {
  const r = spawnSync(process.execPath, [path.join(tools, 'slice.js'), ...argv], { encoding: 'utf8' })
  res.writeHead(r.status === 0 ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
  res.end((r.stdout + r.stderr).trim())
}

const accessLog = fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' })
const server = http.createServer((req, res) => {
  const t0 = Date.now()
  res.on('finish', () => { try { accessLog.write(`${new Date().toISOString()} ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms\n`) } catch { /* 写不动不影响页面 */ } })
  const [url, qs] = (req.url ?? '/').split('?')
  const q = Object.fromEntries(new URLSearchParams(qs ?? ''))
  const html = (b) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(b) }
  const m = url.match(/^\/p\/([a-z]+)(\/.*)?$/)
  if (m) {
    if (!INNER[m[1]]) return html(wrap('<p>' + (MISSING[m[1]] ?? '这一页还没起来。') + '</p>'))
    return proxy(m[1], req, res, (m[2] || '/') + (qs ? '?' + qs : ''))
  }
  if (url === '/') return html(shell)
  if (url === '/todo') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(todo())) }
  if (url === '/slices') return html(wrap(slicesPage()))
  if (url === '/journal') return html(wrap(journalPage(q.date)))
  if (req.method === 'POST' && url === '/slice/scene-ok') return runSlice(res, ['advance', root, q.slice, 'scene', 'done', '他在页面上按的'])
  if (req.method === 'POST' && url === '/slice/enough') return runSlice(res, ['enough', root, q.slice, '他在页面上按的'])
  if (req.method === 'POST' && url === '/slice/accept') return runSlice(res, ['advance', root, q.slice, 'accept', 'done', '他在页面上按的'])
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('没有这一页')
})

;(async () => {
  if (await portBusy(port)) { console.log(`${port} 上已经有工作台在跑了。要换成新代码就先把它停掉，再起这一个。`); process.exit(1) }
  await startAll()
  server.listen(port, '127.0.0.1', () => {
    console.log('子页面都起在本机的临时口上、不对外，人不用管它们')
    console.log(`工作台：http://localhost:${port}　（Ctrl+C 结束，会一并关掉自己拉起来的子服务）`)
  })
})()
process.on('SIGINT', () => { stopAll(); process.exit(0) })
process.on('SIGTERM', () => { stopAll(); process.exit(0) })
process.on('exit', stopAll)
