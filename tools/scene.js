#!/usr/bin/env node
/**
 * 现场看板。开发指挥在上面写：当前在哪条故事线的哪一段、走到哪一步、谁在干什么。
 * 人打开页面就近似实时看得见后台角色的动向（页面每 2 秒自己取一次）。
 *
 * 用法：
 *   node tools/scene.js <项目> set --slice <id> --step "<这一步在做什么>" --who <角色>
 *                                  [--phase 业务|模型|编码|校验] [--note "<一句话>"] [--done]
 *   node tools/scene.js <项目> progress "<一句>" [--who 角色]   细步：角色每做完一个小动作写一句（新建了什么、把什么从 xxx 改成 xxx）；挂在当前这一步下面，页面 2 秒一刷
 *   node tools/scene.js <项目> handoff "<一段话>"    收工交接：停在哪、等谁、有什么坑。换台机器的人打开看板先看它
 *   node tools/scene.js <项目> serve [--port 4873]
 *   node tools/scene.js <项目>                      打印一屏（不起页面）
 *
 * 每次写都记下机器名；换了机器还没 git pull 就动手，看板和 slice next 都会提醒。
 *
 * 状态存 reports/_scene.json（随 git 走——reports/ 里的 json 都进 git，md 与 html 是重算出来的才忽略；开发指挥的写入目标之一，见 seed/01 的写入权表）。
 * 角色名用 seed/05 的叫法：人、开发指挥、业务分析、讲解、文职、模型师、原型、接口、编码、模型校验、pre-pr 审查、解读。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')
const ME = os.hostname()

const ROLES = ['人', '开发指挥', '业务分析', '讲解', '文职', '模型师', '原型', '接口', '编码', '模型校验', 'pre-pr 审查', '解读']
const PHASES = ['业务', '模型', '编码', '校验']
const die = (m) => {
  console.error(m)
  process.exit(1)
}

const args = process.argv.slice(2)
if (!args.length) die('用法：node tools/scene.js <项目> [set …|serve]')
const root = path.resolve(args[0])
if (!fs.existsSync(path.join(root, 'project.json'))) die(`不是项目目录（没有 project.json）：${root}`)
const cmd = args[1] ?? 'show'
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

function readScene() {
  return readJson(scenePath, { slice: null, phase: null, step: null, who: null, note: null, since: null, updatedAt: null, machine: null, handoff: null, timeline: [], progress: [] })
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
    .filter((f) => f.endsWith('.json') && !f.endsWith('.story.json'))
    .map((f) => {
      const d = readJson(path.join(dir, f), null)
      if (!d) return null
      const st = readJson(path.join(dir, f.replace(/\.json$/, '.story.json')), null)
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
  if (who && !ROLES.includes(who)) die(`--who 要用 seed/05 的角色名：${ROLES.join('、')}`)
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
  console.log(`现场已更新：${slice ?? '—'} · ${phase ?? '—'} · ${who ?? '—'} · ${step}`)
  process.exit(0)
}

// ---------- progress：角色的细步 ----------
// 角色（子 agent）每做完一个小动作写一句：新建了哪个错误、把哪条规则从什么改成什么、哪个测试绿了。
// 大步（这一步在做什么、谁在干）仍由开发指挥 set；细步挂在当前大步下面，换一步就清空，动态里保留。
if (cmd === 'progress') {
  const text = args.slice(2).find((a) => !a.startsWith('--') && a !== opt('--who'))
  if (!text) die('用法：scene progress <项目> "<一句：做了什么，具体到名字、从什么到什么>" [--who 角色]')
  const s = readScene()
  const who = opt('--who', s.who)
  if (who && !ROLES.includes(who)) die(`--who 要用 seed/05 的角色名：${ROLES.join('、')}`)
  const now = new Date().toISOString()
  const entry = { ts: now, who, text, machine: ME }
  writeScene({
    ...s,
    updatedAt: now,
    progress: [...(s.progress ?? []), entry].slice(-40),
    timeline: [...(s.timeline ?? []), { ts: now, slice: s.slice, phase: s.phase, step: s.step, who, note: text, kind: 'progress', machine: ME }].slice(-60),
  })
  console.log(`细步：${who ?? '—'} · ${text}`)
  process.exit(0)
}

// ---------- handoff：收工交接 ----------
if (cmd === 'handoff') {
  const text = args.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!text) die('用法：scene handoff <项目> "<一段话：停在哪、等谁、有什么坑>"')
  const s = readScene()
  const now = new Date().toISOString()
  writeScene({
    ...s,
    handoff: { text, at: now, machine: ME, slice: s.slice },
    updatedAt: now,
    machine: ME,
    timeline: [...(s.timeline ?? []), { ts: now, slice: s.slice, phase: s.phase, step: '交接：' + text.slice(0, 60) + (text.length > 60 ? '…' : ''), who: '开发指挥', note: null, done: true, machine: ME }].slice(-60),
  })
  console.log(`交接已写（${ME}）：${text.slice(0, 80)}`)
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
  if (prog.length) { L.push('细步'); for (const e of prog) L.push(`  ${e.ts.slice(11, 16)}　${e.who ?? '—'}　${e.text}`) }
  L.push('')
  L.push('动态')
  for (const e of (s.timeline ?? []).slice(-8)) L.push(e.kind === 'progress' ? `  ${e.ts.slice(5, 16).replace('T', ' ')}　${e.who ?? '—'}　　└ ${e.note}` : `  ${e.ts.slice(5, 16).replace('T', ' ')}　${e.who ?? '—'}　${e.step}`)
  return L.join('\n')
}
function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} 小时` : `${Math.floor(h / 24)} 天`
}

if (cmd === 'show') {
  console.log(textView())
  process.exit(0)
}

// ---------- serve ----------
if (cmd !== 'serve') die(`不认得的子命令：${cmd}（set | progress | handoff | serve | 不带子命令打印一屏）`)

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
.prog div{display:flex;gap:10px;padding:2px 0;font-size:13px;border-bottom:1px dashed var(--line,#e5e7eb)}.prog .t{color:#6b7280;font-variant-numeric:tabular-nums}.prog .r{color:#6b7280;min-width:4em}.tl .sub{padding-left:18px;font-size:12px}
</style></head><body><div class="wrap">
<h1>现场 · ${esc(projectName)}</h1>
<div class="sub" id="upd">连接中…</div>
<div id="app"></div>
<div class="sub" style="margin-top:18px">页面每 2 秒自己刷新一次。开发指挥用 <code>scene set</code> 往上写。</div>
</div>
<script>
const $=(s)=>document.querySelector(s)
function ago(iso){if(!iso)return '';const m=Math.floor((Date.now()-new Date(iso).getTime())/60000);if(m<1)return '刚刚';if(m<60)return m+' 分钟';const h=Math.floor(m/60);return h<24?h+' 小时':Math.floor(h/24)+' 天'}
function esc(x){return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
const PHASES=['业务','模型','编码','校验']
function stageTag(s){if(s==='done')return '<span class="tag done">完</span>';if(s==='in-progress')return '<span class="tag now">在做</span>';return '<span class="tag">待</span>'}
function render(d){
  const s=d.scene,cur=d.slices.find(x=>x.id===s.slice)
  let h=''
  if(d.warning)h+='<div class="warn">⚠ '+esc(d.warning)+'</div>'
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
  if(pg.length)h+='<div class="row"><div class="k">细步</div><div class="v"><div class="prog">'+pg.map(function(e){return '<div><span class="t">'+esc(e.ts.slice(11,16))+'</span><span class="r">'+esc(e.who||'—')+'</span><span>'+esc(e.text)+'</span></div>'}).join('')+'</div></div></div>'
  h+='</div>'

  const line=cur&&cur.line?d.slices.filter(x=>x.line===cur.line):d.slices
  h+='<div class="card"><table><tr><th>段落</th><th>范围</th><th>故事</th><th>模型</th><th>编码</th><th>校验</th></tr>'
  h+=line.map(x=>'<tr'+(x.id===s.slice?' class="cur"':'')+'><td><b>'+esc(x.title)+'</b><div class="dim">'+esc(x.id)+(x.intent?' · '+esc(x.intent):'')+'</div></td>'
    +'<td class="dim">'+esc(x.modules.join('、'))+'</td>'
    +'<td>'+(x.steps?(x.approved?'<span class="tag done">一致</span>':(x.dark?'<span class="tag">'+x.dark+' 步待点亮</span>':'<span class="tag now">'+x.steps+' 步</span>')):'<span class="tag">待写</span>')+'</td>'
    +'<td>'+stageTag(x.stages.model&&x.stages.model.status)+'</td><td>'+stageTag(x.stages.code&&x.stages.code.status)+'</td><td>'+stageTag(x.stages.validate&&x.stages.validate.status)+'</td></tr>').join('')
  h+='</table></div>'

  const tl=(s.timeline||[]).slice().reverse().slice(0,14)
  h+='<div class="card"><div class="tl">'+(tl.length?tl.map(e=>e.kind==='progress'?'<div class="sub"><span class="t">'+esc(e.ts.slice(5,16).replace('T',' '))+'</span><span class="r">'+esc(e.who||'—')+'</span><span class="dim">└ '+esc(e.note)+'</span></div>':'<div><span class="t">'+esc(e.ts.slice(5,16).replace('T',' '))+'</span><span class="r">'+esc(e.who||'—')+'</span><span>'+esc(e.step)+(e.note?' <span class="dim">· '+esc(e.note)+'</span>':'')+'</span></div>').join(''):'<div class="empty">还没有动态</div>')+'</div></div>'
  $('#app').innerHTML=h
  $('#upd').textContent=s.updatedAt?('更新于 '+ago(s.updatedAt)+'前'):'还没人写过现场'
}
async function tick(){try{render(await (await fetch('/data')).json())}catch(e){$('#upd').textContent='取不到数据：'+e.message}}
tick();setInterval(tick,2000)
</script></body></html>`

const wanted = Number(opt('--port', '4873'))
function listen(port, tries = 12) {
  const srv = http.createServer((req, res) => {
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
  srv.listen(port, () => console.log(`现场看板：http://localhost:${port}　（Ctrl+C 停）`))
}
listen(wanted)
