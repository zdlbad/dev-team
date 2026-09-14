#!/usr/bin/env node
/**
 * 审阅工具：本地页面渲染校验报告 JSON，人逐条审阅，保存回同一文件。
 * 用法：node tools/review.js <报告 json> [--port 4870]
 *
 * 人看到的是：每类判断的指南（问什么、什么算通过）+ 校验角色的判断（结论 / 信心 / 理由）。
 * 人只做同意 / 不同意；校验角色尚未判断的条目，人可直接给通过 / 不通过。
 * 写回的形状：条目增加 human: { verdict, note, at }
 *   - 待判断（judgments）：verdict = agree | disagree | pass | fail
 *   - 需人确认（confirms）：verdict = 选项序号 | accepted | dismissed
 *   - 警告（warnings）：verdict = fixed | dismissed
 *
 * 两种看法（右上角切换）：
 *   · 按结构（缺省，报告带 project 时）：左边一棵模型树——模块 → 聚合（规则、字段、行为、值对象、错误、仓储）、命令、端口，
 *     每个节点标着还有几条判断等人；右边选中什么就摆什么：选一个命令，列它的每一步指到哪个方法（哪个聚合的创建方法、
 *     哪个仓储的哪个查询、哪个端口），规则挂在方法下面、抛哪个错跟在规则后面；判断卡就地展开，同意 / 不同意。
 *     2026-09-14 项目所有者点名：「模型是有结构的，我想依照结构去审，能看得见哪一步是哪个模块的哪个具体方法的职责」。
 *   · 按故事：故事切片按故事步骤分组（每步的标题就是故事那句话，步内命令步骤 → 记什么 → 守什么，信心低的在前）；
 *     没有故事时按重要度降序 → 信心升序 → 业务 / 模块 / 聚合分组。
 * 页首说清这页在问什么、谁答的；「其余高信心的一并同意」一键处理（两种看法都有）。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const file = process.argv[2] && path.resolve(process.argv[2])
const portIdx = process.argv.indexOf('--port')
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 4870
if (!file || !fs.existsSync(file)) {
  console.error('用法：node tools/review.js <报告 json> [--port 4870]')
  process.exit(2)
}

/** 模型的结构：模块 → 聚合（根、值对象、实体、错误、仓储、事件）、命令、查询、事件处理、领域服务、端口。给「按结构」那一面用。 */
function buildStructure(project, story) {
  const { loadModel, codePathOf } = require('./lib/project')
  const m = loadModel(project)
  const mods = new Map()
  const mod = (name) => {
    if (!mods.has(name)) mods.set(name, { name, aggregates: new Map(), commands: [], queries: [], handlers: [], services: [], ports: [] })
    return mods.get(name)
  }
  const aggOf = (M, folder, name) => {
    const key = folder || name || '（未归聚合）'
    if (!M.aggregates.has(key)) M.aggregates.set(key, { key, name: name || key, root: null, valueObjects: [], entities: [], errors: [], repositories: [], events: [] })
    return M.aggregates.get(key)
  }
  const rules = (list, level) => (list || []).map((r) => ({ text: r.text, traces: r.traces || [], throws: r.throws || [], level }))
  const behaviors = (list) => (list || []).map((b) => ({ name: b.name, note: b.note || '', input: b.input || [], output: b.output, rules: (b.rules || []).map((r) => (typeof r === 'string' ? { text: r, traces: [] } : { text: r.text, traces: r.traces || [] })), throws: b.throws || [], raises: b.raises || [], traces: b.traces || [] }))
  const fields = (list) => (list || []).map((f) => ({ name: f.name, type: f.type, note: f.note || f.description || '', traces: f.traces || [], ref: f.ref }))
  for (const el of m.elements) {
    const d = el.data || {}
    const M = mod(el.module)
    if (el.kind === 'aggregate-root') {
      const a = aggOf(M, el.aggregateFolder, d.name)
      a.name = d.name
      a.root = { file: el.file, name: d.name, narrative: d.aggregateNarrative || '', rules: [...rules(d.aggregateInvariants, 'aggregate'), ...rules(d.invariants, 'root')], fields: fields(d.fields), behaviors: behaviors(d.behaviors), traces: d.traces || [] }
    } else if (el.kind === 'value-object' || el.kind === 'entity') {
      const a = aggOf(M, el.aggregateFolder, d.aggregate)
      ;(el.kind === 'value-object' ? a.valueObjects : a.entities).push({ file: el.file, name: d.name, rules: rules(d.invariants, 'root'), fields: fields(d.fields), behaviors: behaviors(d.behaviors), traces: d.traces || [] })
    } else if (el.kind === 'error') {
      aggOf(M, el.aggregateFolder, d.aggregate).errors.push({ file: el.file, name: d.name, conditions: (d.condition || []).map((c) => (typeof c === 'string' ? { text: c, traces: [] } : { text: c.text, traces: c.traces || [] })), traces: d.traces || [] })
    } else if (el.kind === 'repository') {
      aggOf(M, el.aggregateFolder, d.aggregate).repositories.push({ file: el.file, name: d.name, methods: (d.methods || []).map((x) => ({ name: x.name, kind: x.kind, input: x.input || [], output: x.output })), traces: d.traces || [] })
    } else if (el.kind === 'event') {
      aggOf(M, el.aggregateFolder, d.aggregate).events.push({ file: el.file, name: d.name, fields: fields(d.fields), traces: d.traces || [] })
    } else if (el.kind === 'command-handler' || el.kind === 'query-handler' || el.kind === 'event-handler') {
      const item = { file: el.file, kind: el.kind, name: d.name, actor: d.actor, trigger: d.trigger, input: d.input || [], writes: d.writes || [], steps: (d.steps || []).map((s, i) => ({ i, text: s.text, call: s.call || null, output: s.output, throws: s.throws || [] })), throws: d.throws || [], raises: d.raises || [], traces: d.traces || [], storySteps: [] }
      ;(el.kind === 'command-handler' ? M.commands : el.kind === 'query-handler' ? M.queries : M.handlers).push(item)
    } else if (el.kind === 'service') {
      M.services.push({ file: el.file, name: d.name, behaviors: behaviors(d.behaviors || d.operations), traces: d.traces || [] })
    } else if (el.kind === 'port') {
      M.ports.push({ file: el.file, name: d.name, kind: d.kind, target: d.target, operations: (d.operations || []).map((o) => ({ name: o.name, input: o.input || [], output: o.output, note: o.note || '', traces: o.traces || [] })), traces: d.traces || [] })
    }
  }
  // 故事的哪几步走过哪个命令 / 查询
  for (const st of story?.steps || []) {
    const w = st.walk
    if (!w || !w.name || w.kind === 'none') continue
    for (const nm of String(w.name).split('+').map((x) => x.trim()).filter(Boolean)) {
      for (const M of mods.values()) for (const c of [...M.commands, ...M.queries, ...M.handlers]) {
        if (nm === M.name + '.' + c.name || nm === c.name) c.storySteps.push(st.n)
      }
    }
  }
  const order = (m.modules?.data?.modules || []).map((x) => x.name)
  // 每个元素将来落在代码库的哪个文件（模块文件夹全小写连字符）
  for (const M of mods.values()) {
    for (const a of M.aggregates.values()) for (const x of [a.root, ...a.valueObjects, ...a.entities, ...a.errors, ...a.repositories, ...a.events]) if (x) x.code = codePathOf(x.file)
    for (const x of [...M.commands, ...M.queries, ...M.handlers, ...M.services, ...M.ports]) x.code = codePathOf(x.file)
  }
  const list = [...mods.values()].sort((a, b) => (order.indexOf(a.name) + 1 || 999) - (order.indexOf(b.name) + 1 || 999) || a.name.localeCompare(b.name))
  return list.map((M) => ({ ...M, aggregates: [...M.aggregates.values()] }))
}

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>审阅</title>
<style>
  :root { --fg:#1f2328; --muted:#57606a; --line:#e6e8eb; --bg:#fff; --hi:#fff1f0; --mid:#fff8e1; --lo:#f6f8fa; --ok:#1a7f37; --bad:#cf222e; --agent:#eef4ff; --sel:#ddf4ff; --hl:#fff3bf; }
  body { margin:0; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color:var(--fg); background:var(--bg); }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid var(--line); padding:10px 20px; display:flex; gap:12px; align-items:center; z-index:2; }
  header h1 { font-size:16px; margin:0; flex:1; }
  button { font:inherit; padding:6px 14px; border:1px solid #d0d7de; border-radius:6px; background:#f6f8fa; cursor:pointer; }
  button.primary { background:#1f6feb; color:#fff; border-color:#1f6feb; }
  button.on { background:#ddf4ff; border-color:#54aeff; }
  .wrap { display:flex; align-items:flex-start; }
  aside { width:320px; flex:none; position:sticky; top:49px; max-height:calc(100vh - 49px); overflow:auto; border-right:1px solid var(--line); padding:10px 8px 40px; box-sizing:border-box; font-size:13px; }
  aside[hidden] { display:none; }
  main { flex:1; min-width:0; padding: 16px 20px 80px; max-width: 1100px; }
  .intro { background:var(--lo); border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:8px; }
  h2 { font-size:15px; margin:24px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  h3 { font-size:13px; color:var(--muted); margin:16px 0 6px; font-weight:600; }
  .item { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; background:var(--lo); }
  .item.high { background:var(--hi); } .item.medium { background:var(--mid); }
  .item.done { opacity:.55; }
  .target { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:var(--muted); word-break:break-all; }
  .check { font-weight:600; margin:2px 0 6px; }
  .sides { display:grid; grid-template-columns: 4em 1fr; gap:2px 8px; margin:6px 0; }
  .sides b { color:var(--muted); font-weight:500; }
  .sides span { white-space:pre-wrap; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  select, input[type=text] { font:inherit; padding:4px 6px; border:1px solid #d0d7de; border-radius:4px; }
  input[type=text] { flex:1; min-width: 240px; }
  .tag { display:inline-block; font-size:11px; padding:0 6px; border-radius:10px; border:1px solid #d0d7de; color:var(--muted); margin-left:6px; }
  .agent { background:var(--agent); border-radius:6px; padding:6px 10px; margin-top:6px; }
  .agent .v { font-weight:600; } .agent .v.pass { color:var(--ok); } .agent .v.fail { color:var(--bad); }
  .agent.none { color:var(--muted); font-style:italic; }
  details { margin-top:6px; } summary { cursor:pointer; color:#0969da; font-size:13px; }
  .guide { font-size:13px; color:var(--fg); padding:6px 0 0 4px; }
  .guide dt { color:var(--muted); font-weight:500; margin-top:4px; } .guide dd { margin:0 0 0 1em; }
  .empty { color:var(--muted); }
  .step { margin:22px 0 6px; padding:8px 12px; border-left:4px solid #1f6feb; background:#f0f6ff; border-radius:0 8px 8px 0; }
  .step .n { font-weight:700; margin-right:8px; } .step .who { color:var(--muted); margin-right:8px; } .step .cnt { color:var(--muted); font-size:12px; margin-left:8px; }
  .kind { font-size:12px; color:var(--muted); margin:10px 0 2px; }
  #status { color:var(--muted); font-size:12px; }
  body.dir1 header { border-bottom:3px solid #1f6feb; } body.dir2 header { border-bottom:3px solid #1a7f37; } body.prepr header { border-bottom:3px solid #d4770a; }
  body.dir1 header h1::before { content:'模型 ⇄ 业务'; } body.dir2 header h1::before { content:'代码 ⇄ 模型'; } body.prepr header h1::before { content:'代码审查'; }
  header h1::before { font-size:11px; font-weight:600; color:#fff; background:#1f6feb; border-radius:4px; padding:1px 7px; margin-right:10px; vertical-align:middle; }
  body.dir2 header h1::before { background:#1a7f37; } body.prepr header h1::before { background:#d4770a; }
  .sev { display:inline-block; font-size:11px; padding:0 7px; border-radius:4px; color:#fff; margin-right:6px; }
  .sev.high { background:#cf222e; } .sev.medium { background:#d4770a; } .sev.low { background:#8c959f; } .sev.ok { background:#1a7f37; }
  .angle { display:inline-block; font-size:11px; padding:0 6px; border-radius:10px; border:1px solid #d0d7de; color:var(--muted); margin-right:6px; }
  .clean { border:1px solid #a7d9b3; background:#eaf7ed; border-radius:10px; padding:16px 20px; margin:12px 0; }
  .clean b.big { font-size:18px; display:block; margin-bottom:6px; color:#1a7f37; }
  .nums { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0; }
  .nums .m { border:1px solid var(--line); border-radius:8px; padding:8px 14px; min-width:120px; } .nums .m b { font-size:20px; display:block; }
  .cc { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; background:var(--lo); } .cc.high { background:var(--hi); } .cc.medium { background:var(--mid); } .cc.done { opacity:.6; }
  .cc .ln { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:var(--muted); }
  .cc .ttl { font-weight:600; margin:4px 0; }
  .cc .fail { color:#7d2a2a; font-size:13px; margin:4px 0; }
  .tn .k.code { font-family: ui-monospace, Consolas, monospace; }
  /* 树 */
  .tn { display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:6px; cursor:pointer; white-space:nowrap; overflow:hidden; }
  .tn:hover { background:var(--lo); } .tn.sel { background:var(--sel); } .tn.hl { background:var(--hl); }
  .tn .lb { overflow:hidden; text-overflow:ellipsis; flex:1; }
  .tn .k { font-size:11px; color:var(--muted); flex:none; }
  .tn .cnt { flex:none; min-width:18px; text-align:center; font-size:11px; border-radius:9px; background:#cf222e; color:#fff; padding:0 5px; }
  .tn .cnt.zero { background:transparent; color:#8c959f; }
  .tn.zero .lb, .tn.zero .k { color:#8c959f; }
  .tn .tw { width:12px; flex:none; color:var(--muted); font-size:11px; }
  .tc { margin-left:14px; }
  .tmod { font-weight:700; margin-top:8px; }
  /* 右边的结构页 */
  .hd { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; margin-bottom:4px; }
  .hd h2 { margin:0; border:0; padding:0; font-size:18px; }
  .hd .k { color:var(--muted); font-size:12px; }
  .meta { color:var(--muted); font-size:13px; margin:2px 0 10px; }
  .narr { background:var(--lo); border-radius:8px; padding:8px 12px; margin:8px 0 14px; }
  .chip { display:inline-block; font-family: ui-monospace, Consolas, monospace; font-size:11px; padding:0 6px; border-radius:10px; border:1px solid #d0d7de; color:#0969da; background:#fff; margin:0 2px; cursor:pointer; }
  .chip.err { color:var(--bad); border-color:#f3b8b5; }
  .chip.hl { background:var(--hl); }
  .flow { list-style:none; margin:0; padding:0; }
  .flow > li { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:6px 0; background:#fff; }
  .flow .st { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .flow .no { font-weight:700; color:#1f6feb; flex:none; }
  .flow .tx { flex:1; min-width:200px; }
  .flow .arrow { color:var(--muted); }
  .flow .to { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:#0969da; cursor:pointer; }
  .flow .sm { margin:3px 0 0 26px; font-size:12.5px; color:var(--muted); display:flex; gap:8px; flex-wrap:wrap; align-items:baseline; }
  .flow .sm code { font-family: ui-monospace, Consolas, monospace; font-size:12px; }
  .flow .sep { color:#c4c9d0; }
  .flow .to.dead { color:var(--muted); cursor:default; }
  .sub { margin:6px 0 0 26px; border-left:2px solid var(--line); padding-left:10px; }
  .rule { padding:6px 0; border-top:1px dashed var(--line); }
  .rule:first-child { border-top:0; }
  .rule .lv { font-size:11px; color:var(--muted); margin-right:4px; }
  .rule.hl { background:var(--hl); }
  .jc { margin:6px 0 4px 0; border:1px solid var(--line); border-radius:8px; padding:8px 10px; background:var(--lo); }
  .jc.high { background:var(--hi); } .jc.medium { background:var(--mid); } .jc.done { opacity:.6; }
  .jc .ck { font-weight:600; font-size:13px; }
  .jc .biz { margin:4px 0; white-space:pre-wrap; }
  .land { margin:4px 0 2px; font-size:13px; } .land .k { color:var(--muted); font-size:12px; margin-right:4px; }
  .land .to { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:#0969da; cursor:pointer; }
  .land .ln { padding-left:2.6em; } .land .cd { display:block; font-family: ui-monospace, Consolas, monospace; font-size:11px; color:#8c959f; margin:0 0 3px; }
  table.f { border-collapse:collapse; width:100%; font-size:13px; margin:4px 0 10px; }
  table.f td, table.f th { border-top:1px solid var(--line); padding:5px 8px; text-align:left; vertical-align:top; }
  table.f th { color:var(--muted); font-weight:500; border-top:0; }
  table.f td.n { font-family: ui-monospace, Consolas, monospace; font-size:12px; white-space:nowrap; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; }
  .card h4 { margin:0 0 4px; font-size:14px; }
  .ovm { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0; }
  .ovm .m { border:1px solid var(--line); border-radius:8px; padding:8px 12px; min-width:160px; cursor:pointer; }
  .ovm .m b { font-size:15px; } .ovm .m .c { color:var(--bad); font-weight:700; } .ovm .m .c.zero { color:var(--ok); }
</style></head>
<body>
<header><h1 id="title">审阅</h1><span id="status"></span><button id="mode" hidden>按故事看</button><button id="agree-high">其余高信心的一并同意</button><button id="save" class="primary">保存</button></header>
<div class="wrap"><aside id="tree" hidden></aside><main id="main"></main></div>
<script>
const $ = (s, p=document) => p.querySelector(s)
let data = null
const IMP = { high:'高', medium:'中', low:'低' }
const CONF = { high:'高', medium:'中', low:'低' }
function groupKey(t) {
  const m = (t||'').match(/^model\\/([^/#]+)(?:\\/domain\\/([^/#]+))?/)
  if (!m) return /^[GRU]-/.test(t||'') ? '业务描述' : /^(src|tests)[\\/]/.test(t||'') ? (t||'').split(/[\\/]/).slice(0, 3).join('/') : '其它'
  return m[1] + (m[2] ? ' / ' + m[2] : '')
}
function rank(x) { return { high:3, medium:2, low:1 }[x] || 0 }
function esc(s) { return String(s ?? '—').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) }
function guideOf(check) {
  const g = (data.guides||{})[check]
  if (!g) return ''
  const opts = g.options ? '<dt>选项</dt><dd>' + g.options.map((o,i)=> (i+1)+'. '+esc(o)).join('<br>') + '</dd>' : ''
  return '<details><summary>怎么判断</summary><dl class="guide"><dt>问</dt><dd>'+esc(g.question)+'</dd>'
    + (g.pass ? '<dt>通过</dt><dd>'+esc(g.pass)+'</dd>' : '') + (g.fail ? '<dt>不通过</dt><dd>'+esc(g.fail)+'</dd>' : '')
    + (g.how ? '<dt>方法</dt><dd>'+esc(g.how)+'</dd>' : '') + opts + '</dl></details>'
}
function staleBlock(it) {
  const s = it.staleDecision
  if (!s) return ''
  if (s.reordered) return '<div class="agent none">这个命令的步骤重排过：这个位置上有一条旧裁决（' + esc(s.at) + '），讲的多半是别的一步，不作参考，请按现在这一步重新判断。</div>'
  return '<div class="agent none">上次裁决（' + esc(s.at) + '）：' + (s.verdict==='dismissed'?'无需改':'接受现状') + ' — ' + esc(s.note||'') + '。此后模型文字已变，请重新判断。</div>'
}
function agentBlock(it) {
  if (!it.verdict) return staleBlock(it) + '<div class="agent none">校验角色尚未判断——请直接给出通过 / 不通过。</div>'
  return staleBlock(it) + '<div class="agent">校验角色：<span class="v '+it.verdict+'">'+(it.verdict==='pass'?'通过':'不通过')+'</span>'
    + '<span class="tag">信心 '+(CONF[it.confidence]||'—')+'</span> ' + esc(it.reason||'') + '</div>'
}
const judgmentControls = (it, i) => {
  const opts = it.verdict
    ? '<option value="agree">同意</option><option value="disagree">不同意</option>'
    : '<option value="pass">通过</option><option value="fail">不通过</option>'
  return agentBlock(it) + '<div class="row"><select data-k="judgments" data-i="'+i+'" data-f="verdict"><option value="">— 你的意见 —</option>'+opts+'</select>'
    + '<input type="text" placeholder="备注（不同意时写为什么）" data-k="judgments" data-i="'+i+'" data-f="note"></div>'
}
const confirmControls = (it, i) => {
  const opts = (it.options||[]).map((o, k) => '<option value="'+(k+1)+'">'+ (k+1) + '. ' + esc(o) + '</option>').join('')
  return '<div class="row"><select data-k="confirms" data-i="'+i+'" data-f="verdict"><option value="">— 裁决 —</option>'+opts+'<option value="accepted">接受现状</option><option value="dismissed">驳回</option></select>'
    + '<input type="text" placeholder="备注（承认例外时必填理由）" data-k="confirms" data-i="'+i+'" data-f="note"></div>'
}
const warningControls = (it, i) =>
  '<div class="row"><select data-k="warnings" data-i="'+i+'" data-f="verdict"><option value="">— 处理 —</option><option value="fixed">已修</option><option value="dismissed">驳回</option></select>'
  + '<input type="text" placeholder="驳回理由" data-k="warnings" data-i="'+i+'" data-f="note"></div>'
// 把页面上的下拉与备注框接到数据上：改一处就记一处、稍后自动保存；树上的数字跟着变
function bindControls(root) {
  for (const el of root.querySelectorAll('[data-k]')) {
    const it = data[el.dataset.k][el.dataset.i]
    const v = it.human?.[el.dataset.f]
    if (v !== undefined && v !== null) el.value = v
    el.addEventListener('input', () => {
      it.human = it.human || {}; it.human[el.dataset.f] = el.value; it.human.at = new Date().toISOString().slice(0,10)
      const box = el.closest('.item, .jc'); if (box) box.classList.toggle('done', !!it.human.verdict)
      if (mode === 'structure') renderTree()
      if (mode === 'code') renderCodeTree()
      scheduleSave()
    })
    if (it.human?.verdict) { const box = el.closest('.item, .jc'); if (box) box.classList.add('done') }
  }
}
function introNode() {
  const intro = document.createElement('div'); intro.className='intro'
  const js = data.judgments || []
  const nHigh = js.filter(j => j.verdict === 'pass' && j.confidence === 'high').length, nLow = js.filter(j => j.verdict && !(j.verdict === 'pass' && j.confidence === 'high')).length, nFail = js.filter(j => j.verdict === 'fail').length
  const open = js.filter(j => !j.human?.verdict).length
  intro.innerHTML = data.mode ? '<b>这一页在问什么（审代码）：</b>pre-pr 审查角色读写好的代码，按几个角度找毛病：用例流程走得对不对、有没有删掉或放松规则、测试测的是不是行为、读着顺不顺。每条发现标着轻重——必须改、应该改、说明——附上会出什么事。<b>你做的：</b>同意它的判断，或不同意写一句为什么；上一轮让改的这轮核过的列在旁边。' + (mode === 'code' ? '<b>按代码结构看：</b>左边是这一段的代码文件，红数字是那个文件上还有几条等你。' : '') + '每次改动自动保存。'
    : (String(data.direction) === '2'
    ? '<b>这一页在问什么（审代码对模型）：</b>解码器把写好的代码读回一份模型，跟模型师的模型逐条比；对不上的地方一条一问「是代码写错了，还是模型该跟着改」。目标是代码文件，按结构看时挂在它对应的模型元素下。没有条目就是代码与模型一字不差。'
    : '<b>这一页在问什么（审模型）：</b>校验器给你在故事里确认过的每一条业务语句生成一问「模型有没有把它表达出来」，给每个命令的每一步生成一问「这一步是不是只做编排」。')
    + '<b>谁答的：</b>校验角色先答（通过 / 不通过 + 理由）。<b>你只做一件事：</b>看他的理由站不站得住，同意或不同意。这些都是确认，不是新的业务问题——要你拍板的业务分岔在故事页的裁定卡上。<br>'
    + '共 ' + js.length + ' 条，还有 <b>' + open + '</b> 条等你：校验角色高信心通过 ' + nHigh + ' 条（可以点右上角「其余高信心的一并同意」一次处理），' + '值得你看的 ' + nLow + ' 条（信心中 / 低' + (nFail ? '、不通过 ' + nFail + ' 条' : '') + '）。'
    + (mode === 'structure' ? '<b>按结构看：</b>左边是模型的树，红色数字是那一处还有几条等你；点一个命令，能看到它每一步指到哪个聚合的哪个方法、哪个仓储、哪个端口，规则挂在方法下面。' : (data.story ? '顺序按故事走：每一步的标题就是故事那句话，下面是这一步用到的业务在模型里对得上对不上。' : '顺序按重要度从高到低、信心从低到高。'))
    + '每次改动自动保存。'
  return intro
}
/* ---------------- 按故事 / 平铺 ---------------- */
function renderFlat() {
  const main = $('#main'); main.innerHTML = ''
  main.appendChild(introNode())
  section(main, '需人确认', data.confirms, confirmControls, true)
  if (data.story) storySection(main, data.judgments, judgmentControls)
  else section(main, '待判断', data.judgments, judgmentControls, true)
  section(main, '警告', data.warnings, warningControls, true)
  section(main, '错误（只读，必须修）', data.errors, () => '', false)
  bindControls(main)
  if (data.structure?.length) { indexJudgments(); for (const el of main.querySelectorAll('[data-go]')) el.addEventListener('click', () => { mode = 'structure'; try { localStorage.setItem('review-mode', mode) } catch {} sel = el.dataset.go; render(); window.scrollTo(0, 0) }) }
}
function itemNode(it, i, controls, withGuide) {
  const d = document.createElement('div'); d.className = 'item ' + (it.importance||'')
  const sides = it.sides ? '<div class="sides">' + Object.entries(it.sides).filter(([,v]) => v !== undefined).map(([k,v]) => '<b>'+({business:'业务',model:'模型',code:'代码'}[k]||k)+'</b><span>'+esc(typeof v==='string'?v:JSON.stringify(v))+'</span>').join('') + '</div>' : ''
  const mc = it.model !== undefined || it.code !== undefined ? '<div class="sides"><b>模型</b><span>'+esc(typeof it.model==='string'?it.model:JSON.stringify(it.model))+'</span><b>代码</b><span>'+esc(typeof it.code==='string'?it.code:JSON.stringify(it.code))+'</span></div>' : ''
  d.innerHTML = '<div class="target">' + esc(it.target) + '</div>' + (it.context ? '<div class="target" style="color:#555;font-family:inherit">' + esc(it.context) + '</div>' : '') + '<div class="check">' + esc(it.ask || it.check) + '</div>' + (it.ask ? '<div class="target" style="font-family:inherit">类别：' + esc(it.check) + '</div>' : '')
    + (it.text ? '<div>' + esc(it.text) + '</div>' : '') + sides + mc + (data.structure?.length && data.judgments?.includes(it) ? landingsHtml(it) : '') + (withGuide ? guideOf(it.check) : '') + controls(it, i)
  return d
}
function idsOf(it) {
  const t = it.target || ''
  if (/^[GRU]-\\d+/.test(t)) return [t.split('#')[0]]
  return (data.targetTraces || {})[t.split('#')[0]] || []
}
function kindOf(it) { return /#steps\\./.test(it.target||'') ? 0 : /^G-/.test(it.target||'') ? 1 : 2 }
const KIND = ['这一步在模型里怎么走（命令的步骤）', '能力', '记什么、守什么（字段、规则、错误）']
function storySection(main, items, controls) {
  const h = document.createElement('h2'); h.textContent = '待判断（' + (items||[]).length + '）· 按故事走'; main.appendChild(h)
  if (!items || !items.length) { const p = document.createElement('p'); p.className='empty'; p.textContent='（无）'; main.appendChild(p); return }
  const steps = data.story.steps || []
  const buckets = steps.map(() => [])
  const rest = []
  items.forEach((it, i) => {
    const ids = idsOf(it)
    const k = steps.findIndex(st => (st.traces||[]).some(id => ids.includes(id)))
    if (k >= 0) buckets[k].push({ it, i }); else rest.push({ it, i })
  })
  const order = (a, b) => kindOf(a.it) - kindOf(b.it) || (rank(a.it.confidence)||9) - (rank(b.it.confidence)||9) || (a.it.target||'').localeCompare(b.it.target||'')
  steps.forEach((st, k) => {
    const list = buckets[k]
    const hd = document.createElement('div'); hd.className = 'step'
    hd.innerHTML = '<span class="n">第 ' + esc(st.n ?? k+1) + ' 步</span><span class="who">' + esc(st.day||'') + ' · ' + esc(st.actor||'') + '</span>' + esc(st.text||'') + '<span class="cnt">' + (list.length ? list.length + ' 条' : '这一步没有要你看的') + '</span>'
    main.appendChild(hd)
    list.sort(order)
    let g = -1
    for (const { it, i } of list) {
      const kk = kindOf(it)
      if (kk !== g) { g = kk; const kh = document.createElement('div'); kh.className = 'kind'; kh.textContent = KIND[kk]; main.appendChild(kh) }
      main.appendChild(itemNode(it, i, controls, true))
    }
  })
  if (rest.length) {
    const hd = document.createElement('div'); hd.className = 'step'; hd.innerHTML = '<span class="n">不在故事步骤里的</span><span class="cnt">' + rest.length + ' 条</span>'; main.appendChild(hd)
    rest.sort(order)
    for (const { it, i } of rest) main.appendChild(itemNode(it, i, controls, true))
  }
}
function section(main, title, items, controls, withGuide) {
  const h = document.createElement('h2'); h.textContent = title + '（' + (items||[]).length + '）'; main.appendChild(h)
  if (!items || !items.length) { const p = document.createElement('p'); p.className='empty'; p.textContent='（无）'; main.appendChild(p); return }
  const idx = items.map((it, i) => ({ it, i }))
  idx.sort((a, b) => rank(b.it.importance) - rank(a.it.importance) || (rank(a.it.confidence)||9) - (rank(b.it.confidence)||9) || groupKey(a.it.target).localeCompare(groupKey(b.it.target)))
  let g = null
  for (const { it, i } of idx) {
    const k = (it.importance ? '重要度 ' + IMP[it.importance] + ' · ' : '') + groupKey(it.target)
    if (k !== g) { g = k; const h3 = document.createElement('h3'); h3.textContent = k; main.appendChild(h3) }
    main.appendChild(itemNode(it, i, controls, withGuide))
  }
}
/* ---------------- 按结构 ---------------- */
let mode = 'story', sel = null, hlId = null
const openNodes = new Set()
// 每条判断落在哪个模型文件上：目标是模型文件（命令的某一步）就是它自己；目标是业务编号就看校验器附的 related
function filesOf(it) {
  const t = it.target || ''
  if (t.startsWith('model/')) return [t.split('#')[0]]
  if (it.modelFile) return [it.modelFile]
  return it.related || []
}
function stepOf(it) { const t = it.target || ''; const k = t.indexOf('#steps.'); return k < 0 ? null : Number(t.slice(k + 7)) }
function isId(t) { return /^[GRU]-\\d+/.test(t || '') }
// 文件 → 落在它上面的判断（下标）
let byFile = new Map()
function indexJudgments() {
  byFile = new Map()
  ;(data.judgments || []).forEach((it, i) => { for (const f of filesOf(it)) { if (!byFile.has(f)) byFile.set(f, []); byFile.get(f).push(i) } })
}
const openCount = (files) => { const seen = new Set(); for (const f of files) for (const i of byFile.get(f) || []) if (!data.judgments[i].human?.verdict) seen.add(i); return seen.size }
function aggFiles(a) { return [a.root?.file, ...a.valueObjects.map(x => x.file), ...a.entities.map(x => x.file), ...a.errors.map(x => x.file), ...a.repositories.map(x => x.file), ...a.events.map(x => x.file)].filter(Boolean) }
function modFiles(M) { return [...M.aggregates.flatMap(aggFiles), ...[...M.commands, ...M.queries, ...M.handlers, ...M.services, ...M.ports].map(x => x.file)] }
// 一个元素的文字里有没有提到某个业务编号（高亮用）
function mentions(x, id) {
  const has = (list) => (list || []).some(r => (r.traces || []).includes(id))
  return has(x.rules) || has(x.fields) || has(x.conditions) || has(x.operations) || (x.behaviors || []).some(b => (b.traces || []).includes(id) || has(b.rules)) || (x.traces || []).includes(id)
}
function nodeHtml(id, label, kind, files, depth, hasKids, extra) {
  const n = openCount(files)
  const isSel = sel === id
  const hl = hlId && extra && extra.some(x => mentions(x, hlId))
  return '<div class="tn' + (isSel ? ' sel' : '') + (n ? '' : ' zero') + (hl ? ' hl' : '') + '" data-id="' + esc(id) + '" style="padding-left:' + (6 + depth * 14) + 'px">'
    + '<span class="tw"' + (hasKids ? ' data-tw="' + esc(id) + '"' : '') + '>' + (hasKids ? (openNodes.has(id) ? '▾' : '▸') : '') + '</span>'
    + (kind ? '<span class="k">' + esc(kind) + '</span>' : '') + '<span class="lb">' + esc(label) + '</span><span class="cnt' + (n ? '' : ' zero') + '">' + (n || '') + '</span></div>'
}
function renderTree() {
  const S = data.structure || []
  let h = ''
  for (const M of S) {
    const mid = 'm:' + M.name
    const openM = openNodes.has(mid)
    h += '<div class="tmod">' + nodeHtml(mid, M.name, '模块', modFiles(M), 0, true, null) + '</div>'
    if (!openM) continue
    for (const a of M.aggregates) {
      const aid = 'a:' + M.name + ':' + a.key
      const kids = [...a.valueObjects, ...a.entities, ...a.errors, ...a.repositories, ...a.events]
      h += nodeHtml(aid, a.name, '聚合', aggFiles(a), 1, kids.length > 0, [a.root, ...kids].filter(Boolean))
      if (!openNodes.has(aid)) continue
      for (const v of a.valueObjects) h += nodeHtml('f:' + v.file, v.name, '值对象', [v.file], 2, false, [v])
      for (const v of a.entities) h += nodeHtml('f:' + v.file, v.name, '实体', [v.file], 2, false, [v])
      for (const e of a.errors) h += nodeHtml('f:' + e.file, e.name, '错误', [e.file], 2, false, [e])
      for (const r of a.repositories) h += nodeHtml('f:' + r.file, r.name, '仓储', [r.file], 2, false, [r])
      for (const e of a.events) h += nodeHtml('f:' + e.file, e.name, '事件', [e.file], 2, false, [e])
    }
    for (const c of M.commands) h += nodeHtml('f:' + c.file, c.name, '命令', [c.file], 1, false, [c])
    for (const c of M.queries) h += nodeHtml('f:' + c.file, c.name, '查询', [c.file], 1, false, [c])
    for (const c of M.handlers) h += nodeHtml('f:' + c.file, c.name, '事件处理', [c.file], 1, false, [c])
    for (const s of M.services) h += nodeHtml('f:' + s.file, s.name, '领域服务', [s.file], 1, false, [s])
    for (const p of M.ports) h += nodeHtml('f:' + p.file, p.name, '端口', [p.file], 1, false, [p])
  }
  const tree = $('#tree')
  const top = tree.scrollTop
  tree.innerHTML = '<div class="tn' + (sel === null ? ' sel' : '') + '" data-id="" style="font-weight:600"><span class="tw"></span><span class="lb">总览</span><span class="cnt' + (openCount([...byFile.keys()]) ? '' : ' zero') + '">' + (openCount([...byFile.keys()]) || '') + '</span></div>' + h
  tree.scrollTop = top
  for (const el of tree.querySelectorAll('.tn')) el.addEventListener('click', (ev) => {
    const id = el.dataset.id
    if (ev.target.dataset.tw !== undefined && ev.target.dataset.tw !== '' ) { openNodes.has(id) ? openNodes.delete(id) : openNodes.add(id); renderTree(); return }
    sel = id || null
    if (id && (id.startsWith('m:') || id.startsWith('a:'))) openNodes.add(id)
    renderTree(); renderPane()
  })
}
// 树上找一个元素（按文件、按聚合名、按端口名、按仓储名）
function findByFile(f) { for (const M of data.structure || []) { for (const a of M.aggregates) { if (a.root?.file === f) return { kind: 'aggregate', M, a }; for (const v of [...a.valueObjects, ...a.entities]) if (v.file === f) return { kind: 'value', M, a, v }; for (const e of a.errors) if (e.file === f) return { kind: 'error', M, a, e }; for (const r of a.repositories) if (r.file === f) return { kind: 'repository', M, a, r }; for (const e of a.events) if (e.file === f) return { kind: 'event', M, a, e } } for (const c of [...M.commands, ...M.queries, ...M.handlers]) if (c.file === f) return { kind: 'usecase', M, c }; for (const s of M.services) if (s.file === f) return { kind: 'service', M, s }; for (const p of M.ports) if (p.file === f) return { kind: 'port', M, p } } return null }
function resolveTarget(M, call) {
  if (!call) return null
  const t = String(call.target || '')
  const [modName, name] = t.includes('.') ? t.split('.') : [M.name, t]
  const mods = (data.structure || []).filter(x => x.name === modName)
  for (const X of mods.length ? mods : data.structure || []) {
    for (const a of X.aggregates) {
      if (a.name === name || a.root?.name === name) return { id: 'a:' + X.name + ':' + a.key, label: (call.kind === 'factory' ? name + '.' + (call.method || 'CREATE') : name + (call.method ? '.' + call.method : '')), el: a.root }
      for (const v of [...a.valueObjects, ...a.entities]) if (v.name === name) return { id: 'f:' + v.file, label: name + '.' + (call.method || 'CREATE'), el: v }
      for (const r of a.repositories) if (r.name === name || r.name === name + 'Repository' || name === r.name.replace(/Repository$/, '')) return { id: 'f:' + r.file, label: r.name + '.' + (call.method || '?'), el: r }
    }
    for (const p of X.ports) if (p.name === name) return { id: 'f:' + p.file, label: '端口 ' + p.name + '.' + (call.method || '?'), el: p }
    for (const s of X.services) if (s.name === name) return { id: 'f:' + s.file, label: '领域服务 ' + s.name + '.' + (call.method || '?'), el: s }
  }
  return { id: null, label: (call.kind ? call.kind + ' ' : '') + t + (call.method ? '.' + call.method : ''), el: null }
}
const CALL_KIND = { factory: '创建', repository: '仓储', port: '端口', service: '领域服务', behavior: '行为', publish: '发事件', query: '查询' }
function chips(ids, cls) { return (ids || []).map(id => '<span class="chip ' + (cls || '') + (hlId === id ? ' hl' : '') + '" data-chip="' + esc(id) + '" title="' + esc((data.business || {})[id]?.text || '') + '">' + esc(id) + '</span>').join('') }
function errChips(names) { return (names || []).map(n => '<span class="chip err">' + esc(n) + '</span>').join('') }
// 落在某个文件上、并且（若给了编号）跟这个编号有关的判断
function judgmentsFor(file, ids, step) {
  const out = []
  for (const i of byFile.get(file) || []) {
    const it = data.judgments[i]
    if (step !== undefined && step !== null) { if (stepOf(it) === step) out.push(i); continue }
    if (stepOf(it) !== null) continue
    if (ids && !ids.includes(it.target)) continue
    out.push(i)
  }
  return out
}
// 一条判断最终落到哪个方法、字段、错误、端口操作：从它相关的模型文件里，找哪条规则 / 行为 / 字段 / 条件 / 操作带着这个编号
function landingsOf(it) {
  const out = []
  const push = (label, go, code) => { if (!out.some(x => x.label === label)) out.push({ label, go, code }) }
  const step = stepOf(it)
  if (step !== null) {
    const f = findByFile((it.target || '').split('#')[0])
    if (f?.c) { const st = f.c.steps[step]; const to = resolveTarget(f.M, st?.call); push(f.c.name + '.execute() 第 ' + (step + 1) + ' 步' + (to ? ' → ' + to.label : ''), to?.id || 'f:' + f.c.file, f.c.code) }
    return out
  }
  const id = it.target
  for (const file of filesOf(it)) {
    const f = findByFile(file)
    if (!f) continue
    if (f.kind === 'usecase') { push(f.c.name + '.execute()', 'f:' + f.c.file, f.c.code); continue }
    if (f.kind === 'port') { for (const o of f.p.operations) if (o.traces.includes(id)) push('端口 ' + f.p.name + '.' + o.name + '()', 'f:' + f.p.file, f.p.code); if (!out.length && f.p.traces.includes(id)) push('端口 ' + f.p.name, 'f:' + f.p.file, f.p.code); continue }
    if (f.kind === 'service') { for (const b of f.s.behaviors) if (b.traces.includes(id) || b.rules.some(r => r.traces.includes(id))) push('领域服务 ' + f.s.name + '.' + b.name + '()', 'f:' + f.s.file, f.s.code); continue }
    // 错误落在它声明的地方（错误类那个文件），不是抛它的地方；抛它的地方跟在创建方法后面写
    // 错误的落点是它自己那个类（与代码同名），不是抛它的地方
    if (f.kind === 'error') { for (const c of f.e.conditions) if (c.traces.includes(id)) { push(f.e.name + 'Error', 'f:' + f.e.file, f.e.code); break } continue }
    if (f.kind === 'repository') { push('仓储 ' + f.r.name, 'f:' + f.r.file, f.r.code); continue }
    if (f.kind === 'event') { push('事件 ' + f.e.name, 'f:' + f.e.file, f.e.code); continue }
    const el = f.kind === 'aggregate' ? f.a.root : f.v
    if (!el) continue
    const go = f.kind === 'aggregate' ? 'a:' + f.M.name + ':' + f.a.key : 'f:' + el.file
    // 「落到」只写模型上的位置（同代码），不记在哪儿抛
    for (const r of el.rules) if (r.traces.includes(id)) push(el.name + '.CREATE()', go, el.code)
    for (const b of el.behaviors) if (b.traces.includes(id) || b.rules.some(r => r.traces.includes(id))) push(el.name + '.' + b.name + '()', go, el.code)
    for (const fd of el.fields) if (fd.traces.includes(id)) push('字段 ' + el.name + '.' + fd.name, go, el.code)
    if (!el.rules.some(r => r.traces.includes(id)) && !el.behaviors.some(b => b.traces.includes(id) || b.rules.some(r => r.traces.includes(id))) && !el.fields.some(fd => fd.traces.includes(id)) && el.traces.includes(id)) push(el.name + '（只在元素上标了编号）', go, el.code)
  }
  return out
}
function landingsHtml(it) {
  const L = landingsOf(it)
  if (!L.length) return ''
  // 一行一个代码文件：这条业务落在模型的哪几处（同一个文件的并在一行），那一处的代码在哪
  const byCode = new Map()
  for (const x of L) { const k = x.code || ''; if (!byCode.has(k)) byCode.set(k, []); byCode.get(k).push(x) }
  return '<div class="land"><span class="k">落到</span>' + [...byCode.entries()].map(([code, xs]) => '<div class="ln">' + xs.map(x => '<span class="to" data-go="' + esc(x.go) + '">' + esc(x.label) + '</span>').join('<span class="k"> · </span>') + (code ? '<span class="k cd">' + esc(code) + '</span>' : '') + '</div>').join('') + '</div>'
}
function jcard(i) {
  const it = data.judgments[i]
  const short = it.check.replace(/？$/, '')
  return '<div class="jc ' + (it.importance || '') + (it.human?.verdict ? ' done' : '') + '"><div class="ck">' + esc(short) + '<span class="tag">' + esc(it.target) + '</span></div>'
    + (it.sides?.business ? '<div class="biz">' + esc(it.sides.business) + '</div>' : '')
    + landingsHtml(it)
    + judgmentControls(it, i)
    + (it.sides?.model ? '<details><summary>校验器对到的模型原文</summary><div class="biz" style="font-size:13px">' + esc(it.sides.model) + '</div></details>' : '')
    + guideOf(it.check) + '</div>'
}
function rulesHtml(el, opts) {
  if (!el || !el.rules?.length) return ''
  return '<div class="sub' + (opts?.flat ? '" style="margin-left:0;border:0;padding:0' : '') + '">' + el.rules.map(r => {
    const js = judgmentsFor(el.file, r.traces)
    return '<div class="rule' + (hlId && r.traces.includes(hlId) ? ' hl' : '') + '">' + (r.level === 'aggregate' ? '<span class="lv">聚合级</span>' : '') + esc(r.text) + ' ' + chips(r.traces) + (r.throws.length ? ' <span class="arrow">→ 抛出</span> ' + errChips(r.throws) : '')
      + js.map(jcard).join('') + '</div>'
  }).join('') + '</div>'
}
// 只挂在字段上的编号（规则、行为里没提到的）对应的判断，摆在字段表下面
function fieldJudgmentsHtml(el) {
  if (!el?.fields?.length) return ''
  const ruleIds = new Set([...(el.rules || []).flatMap(r => r.traces), ...(el.behaviors || []).flatMap(b => [...b.traces, ...b.rules.flatMap(r => r.traces)])])
  const ids = [...new Set(el.fields.flatMap(f => f.traces))].filter(id => !ruleIds.has(id))
  if (!ids.length) return ''
  const js = judgmentsFor(el.file, ids)
  if (!js.length) return ''
  return '<div class="rule"><span class="lv">落在字段上的判断：' + ids.filter(id => js.some(i => data.judgments[i].target === id)).map(id => esc(id) + '（' + el.fields.filter(f => f.traces.includes(id)).map(f => esc(f.name)).join('、') + '）').join('　') + '</span>' + js.map(jcard).join('') + '</div>'
}
function fieldsHtml(el) {
  if (!el?.fields?.length) return ''
  return '<table class="f"><tr><th>字段</th><th>类型</th><th>说明</th><th>业务</th></tr>' + el.fields.map(f => '<tr' + (hlId && f.traces.includes(hlId) ? ' class="hl"' : '') + '><td class="n">' + esc(f.name) + '</td><td class="n">' + esc(f.type) + (f.ref ? '<br><span class="k">→ ' + esc(f.ref) + '</span>' : '') + '</td><td>' + esc(f.note) + '</td><td>' + chips(f.traces) + '</td></tr>').join('') + '</table>'
}
function behaviorsHtml(el) {
  if (!el?.behaviors?.length) return ''
  return el.behaviors.map(b => '<div class="card"><h4><code>' + esc(b.name) + '(' + b.input.map(p => esc(p.name)).join(', ') + ')' + (b.output ? ' → ' + esc(b.output) : '') + '</code> ' + chips(b.traces) + (b.throws.length ? ' <span class="arrow">→ 抛出</span> ' + errChips(b.throws) : '') + '</h4>'
    + (b.note ? '<div class="k" style="margin:2px 0 6px">' + esc(b.note) + '</div>' : '')
    + (b.rules.length ? '<div class="sub" style="margin-left:0">' + b.rules.map(r => '<div class="rule' + (hlId && r.traces.includes(hlId) ? ' hl' : '') + '">' + esc(r.text) + ' ' + chips(r.traces) + judgmentsFor(el.file, r.traces).map(jcard).join('') + '</div>').join('') + '</div>' : '') + '</div>').join('')
}
function errorsHtml(a) {
  if (!a.errors.length) return ''
  return '<h3>错误——什么时候抛</h3>' + a.errors.map(e => '<div class="card" id="' + esc('f:' + e.file) + '"><h4><span class="chip err">' + esc(e.name) + '</span></h4>' + e.conditions.map(c => '<div class="rule' + (hlId && c.traces.includes(hlId) ? ' hl' : '') + '">' + esc(c.text) + ' ' + chips(c.traces) + judgmentsFor(e.file, c.traces).map(jcard).join('') + '</div>').join('') + leftover(e.file, e.conditions.flatMap(c => c.traces)) + '</div>').join('')
}
// 落在这个文件上、却没挂到任何一条具体规则 / 字段 / 条件上的判断（编号只写在元素的 traces 上）
function leftover(file, coveredIds) {
  const js = judgmentsFor(file).filter(i => !coveredIds.includes(data.judgments[i].target))
  return js.length ? '<div class="rule"><span class="lv">落在这个元素上、没对到哪一条</span>' + js.map(jcard).join('') + '</div>' : ''
}
function storyLine(c) { return c.storySteps?.length ? '故事：' + esc(data.story?.title || data.slice || '') + ' 第 ' + c.storySteps.join('、') + ' 步' : '故事没有走到这个' + (c.kind === 'query-handler' ? '查询' : '命令') }
function usecaseHtml(M, c) {
  const kindLabel = c.kind === 'query-handler' ? '查询' : c.kind === 'event-handler' ? '事件处理' : '命令'
  let h = '<div class="hd"><span class="k">' + esc(M.name) + ' › ' + kindLabel + '</span><h2>' + esc(c.name) + '</h2>' + chips(c.traces) + '</div>'
  if (c.code) h += '<div class="meta">代码：' + esc(c.code) + '</div>'
  h += '<div class="meta">' + (c.actor ? '执行者 ' + esc(c.actor) + ' · ' : '') + (c.trigger ? '触发于 ' + esc(c.trigger) + ' · ' : '') + storyLine(c) + (c.writes.length ? ' · 写 ' + c.writes.map(esc).join('、') : '') + (c.throws.length ? ' · 可能拒绝 ' + errChips(c.throws) : '') + (c.raises.length ? ' · 发出 ' + c.raises.map(esc).join('、') : '') + '</div>'
  if (c.input.length) h += '<div class="meta">输入：' + c.input.map(p => '<code>' + esc(p.name) + '</code>').join('、') + '</div>'
  const gj = judgmentsFor(c.file).filter(i => isId(data.judgments[i].target))
  if (gj.length) h += gj.map(jcard).join('')
  h += '<h3>每一步做什么、指到谁</h3><ol class="flow">'
  for (const s of c.steps) {
    const to = resolveTarget(M, s.call)
    const meta = []
    if (to) meta.push('<span class="arrow">→</span> <span class="to' + (to.id ? '' : ' dead') + '"' + (to.id ? ' data-go="' + esc(to.id) + '"' : '') + '>' + (s.call?.kind && CALL_KIND[s.call.kind] ? '<span class="k">' + CALL_KIND[s.call.kind] + '</span> ' : '') + esc(to.label) + '</span>')
    if (s.output) meta.push('<span class="k">得到</span> <code>' + esc(s.output) + '</code>')
    if (s.throws.length) meta.push('<span class="k">可能抛出</span> ' + errChips(s.throws))
    h += '<li><div class="st"><span class="no">' + (s.i + 1) + '</span><span class="tx">' + esc(s.text) + '</span></div>'
      + (meta.length ? '<div class="sm">' + meta.join('<span class="sep">·</span>') + '</div>' : '')
    h += judgmentsFor(c.file, null, s.i).map(jcard).join('')
    // 创建那一步：把目标聚合 / 值对象的规则挂在下面，抛哪个错跟在规则后面——职责在这儿
    if (to?.el && s.call?.kind === 'factory' && to.el.rules?.length) h += rulesHtml(to.el)
    // 调行为那一步：挂那个行为自己的规则（addDocument 不查重、不替换），不是整个聚合的
    // 交给领域服务那一步：挂那个操作自己的规则（唯一、出处这类要看别的实例才能判的），抛哪个错跟在后面
    if (to?.el && s.call?.kind === 'service') { const b = (to.el.behaviors || []).find(x => x.name === s.call.method); if (b && b.rules.length) h += rulesHtml({ file: to.el.file, rules: b.rules.map(r => ({ ...r, throws: b.throws || [] })) }) }
    if (to?.el && s.call?.kind === 'behavior') { const b = (to.el.behaviors || []).find(x => x.name === s.call.method); if (b && b.rules.length) h += rulesHtml({ file: to.el.file, rules: b.rules.map(r => ({ ...r, throws: b.throws || [] })) }) }
    if (to?.el && s.call?.kind === 'port' && to.el.operations) { const op = to.el.operations.find(o => o.name === s.call.method); if (op) h += '<div class="sub"><div class="rule">' + esc(op.note) + ' ' + chips(op.traces) + judgmentsFor(to.el.file, op.traces).map(jcard).join('') + '</div></div>' }
    h += '</li>'
  }
  h += '</ol>'
  return h
}
function aggregateHtml(M, a) {
  const r = a.root
  let h = '<div class="hd"><span class="k">' + esc(M.name) + ' › 聚合</span><h2>' + esc(a.name) + '</h2>' + chips(r?.traces) + '</div>'
  if (r?.code) h += '<div class="meta">代码：' + esc(r.code) + '</div>'
  if (r?.narrative) h += '<div class="narr">' + esc(r.narrative) + '</div>'
  if (r) {
    h += '<h3>规则——' + esc(r.name) + ' 守着什么</h3>' + (r.rules.length ? rulesHtml(r, { flat: true }) : '<p class="empty">（没有规则）</p>')
    h += '<h3>字段——记着什么</h3>' + fieldsHtml(r) + fieldJudgmentsHtml(r)
    if (r.behaviors.length) h += '<h3>行为</h3>' + behaviorsHtml(r)
    h += leftover(r.file, [...r.rules.flatMap(x => x.traces), ...r.fields.flatMap(x => x.traces), ...r.behaviors.flatMap(b => [...b.traces, ...b.rules.flatMap(x => x.traces)])])
  }
  for (const v of [...a.valueObjects, ...a.entities]) h += '<h3>' + (a.valueObjects.includes(v) ? '值对象' : '实体') + ' ' + esc(v.name) + '</h3><div class="card" id="' + esc('f:' + v.file) + '">' + chips(v.traces) + rulesHtml(v, { flat: true }) + fieldsHtml(v) + fieldJudgmentsHtml(v) + behaviorsHtml(v) + leftover(v.file, [...v.rules.flatMap(x => x.traces), ...v.fields.flatMap(x => x.traces), ...v.behaviors.flatMap(b => [...b.traces, ...b.rules.flatMap(x => x.traces)])]) + '</div>'
  h += errorsHtml(a)
  if (a.repositories.length) h += '<h3>仓储——能怎么查、怎么存</h3>' + a.repositories.map(rp => '<div class="card" id="' + esc('f:' + rp.file) + '"><h4>' + esc(rp.name) + '</h4>' + rp.methods.map(m => '<div class="rule"><code>' + esc(m.name) + '(' + m.input.map(p => esc(p.name)).join(', ') + ')' + (m.output ? ' → ' + esc(m.output) : '') + '</code> <span class="k">' + (m.kind === 'read' ? '读' : m.kind === 'write' ? '写' : esc(m.kind || '')) + '</span></div>').join('') + leftover(rp.file, []) + '</div>').join('')
  if (a.events.length) h += '<h3>事件</h3>' + a.events.map(e => '<div class="card" id="' + esc('f:' + e.file) + '"><h4>' + esc(e.name) + '</h4>' + chips(e.traces) + fieldsHtml(e) + fieldJudgmentsHtml(e) + leftover(e.file, e.fields.flatMap(x => x.traces)) + '</div>').join('')
  return h
}
function portHtml(M, p) {
  let h = '<div class="hd"><span class="k">' + esc(M.name) + ' › 端口 → ' + esc(p.target || '') + (p.kind ? '（' + esc(p.kind === 'module' ? '另一个模块' : p.kind === 'external-system' ? '外部系统' : p.kind) + '）' : '') + '</span><h2>' + esc(p.name) + '</h2>' + chips(p.traces) + '</div>'
  h += '<div class="meta">' + esc(M.name) + ' 经这个端口问 ' + esc(p.target || '别人') + '，只认答复，不读对方的记录。</div>'
  h += p.operations.map(o => '<div class="card"><h4><code>' + esc(o.name) + '(' + o.input.map(x => esc(x.name)).join(', ') + ')' + (o.output ? ' → ' + esc(o.output) : '') + '</code> ' + chips(o.traces) + '</h4><div>' + esc(o.note) + '</div>' + judgmentsFor(p.file, o.traces).map(jcard).join('') + '</div>').join('')
  h += leftover(p.file, p.operations.flatMap(o => o.traces))
  return h
}
function serviceHtml(M, s) { return '<div class="hd"><span class="k">' + esc(M.name) + ' › 领域服务</span><h2>' + esc(s.name) + '</h2>' + chips(s.traces) + '</div>' + behaviorsHtml(s) + leftover(s.file, s.behaviors.flatMap(b => [...b.traces, ...b.rules.flatMap(x => x.traces)])) }
function overviewHtml() {
  const S = data.structure || []
  let h = '<h2 style="margin-top:0">总览</h2><div class="ovm">' + S.map(M => { const n = openCount(modFiles(M)); return '<div class="m" data-go="' + esc('m:' + M.name) + '"><b>' + esc(M.name) + '</b><br><span class="c' + (n ? '' : ' zero') + '">' + (n ? n + ' 条等你' : '都看过了') + '</span><br><span class="k">' + M.aggregates.length + ' 个聚合 · ' + (M.commands.length + M.queries.length) + ' 个命令/查询 · ' + M.ports.length + ' 个端口</span></div>' }).join('') + '</div>'
  const orphan = (data.judgments || []).map((it, i) => ({ it, i })).filter(({ it }) => !filesOf(it).some(f => findByFile(f)))
  if (orphan.length) h += '<h3>没落到树上任何元素的判断</h3>' + orphan.map(({ i }) => jcard(i)).join('')
  return h
}
function renderPane() {
  const main = $('#main'); main.innerHTML = ''
  if (!sel) {
    main.appendChild(introNode())
    const d = document.createElement('div'); d.innerHTML = overviewHtml(); main.appendChild(d)
    section(main, '需人确认', data.confirms, confirmControls, true)
    section(main, '警告', data.warnings, warningControls, true)
    section(main, '错误（只读，必须修）', data.errors, () => '', false)
  } else {
    const d = document.createElement('div')
    let h = '<p class="empty">树上没有这个节点</p>'
    if (sel.startsWith('m:')) {
      const M = (data.structure || []).find(x => x.name === sel.slice(2))
      if (M) h = '<div class="hd"><span class="k">模块</span><h2>' + esc(M.name) + '</h2></div><div class="meta">' + M.aggregates.length + ' 个聚合 · ' + M.commands.length + ' 个命令 · ' + M.queries.length + ' 个查询 · ' + M.ports.length + ' 个端口。左边点开看每一个；命令那一页能看到每一步指到哪个方法。</div>'
        + '<h3>命令</h3>' + (M.commands.map(c => '<div class="card"><h4><span class="to" data-go="' + esc('f:' + c.file) + '">' + esc(c.name) + '</span> <span class="k">' + (c.actor ? '执行者 ' + esc(c.actor) + ' · ' : '') + storyLine(c) + '</span></h4><div class="k">' + c.steps.map((s, i) => (i + 1) + '. ' + esc(s.text)).join('　') + '</div></div>').join('') || '<p class="empty">（无）</p>')
        + '<h3>聚合</h3>' + M.aggregates.map(a => '<div class="card"><h4><span class="to" data-go="' + esc('a:' + M.name + ':' + a.key) + '">' + esc(a.name) + '</span> <span class="k">' + (a.root?.rules.length || 0) + ' 条规则 · ' + (a.root?.fields.length || 0) + ' 个字段 · ' + a.valueObjects.length + ' 个值对象 · ' + a.errors.length + ' 个错误</span></h4>' + (a.root?.narrative ? '<div class="k">' + esc(a.root.narrative) + '</div>' : '') + '</div>').join('')
        + (M.ports.length ? '<h3>端口</h3>' + M.ports.map(p => '<div class="card"><h4><span class="to" data-go="' + esc('f:' + p.file) + '">' + esc(p.name) + '</span> <span class="k">→ ' + esc(p.target || '') + '</span></h4></div>').join('') : '')
    } else if (sel.startsWith('a:')) {
      const [, mn, ...rest] = sel.split(':'); const key = rest.join(':')
      const M = (data.structure || []).find(x => x.name === mn); const a = M?.aggregates.find(x => x.key === key)
      if (a) h = aggregateHtml(M, a)
    } else if (sel.startsWith('f:')) {
      const f = findByFile(sel.slice(2))
      if (f) {
        if (f.kind === 'usecase') h = usecaseHtml(f.M, f.c)
        else if (f.kind === 'port') h = portHtml(f.M, f.p)
        else if (f.kind === 'service') h = serviceHtml(f.M, f.s)
        else h = aggregateHtml(f.M, f.a)
      }
    }
    d.innerHTML = h; main.appendChild(d)
    // 值对象 / 错误 / 仓储：整页是它的聚合，滚到它那一块
    if (sel.startsWith('f:')) { const anchor = document.getElementById(sel); if (anchor) setTimeout(() => anchor.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30) }
  }
  bindControls(main)
  for (const el of main.querySelectorAll('[data-go]')) el.addEventListener('click', () => { sel = el.dataset.go; const parts = sel.split(':'); if (parts[0] === 'a') openNodes.add('m:' + parts[1]); else { const f = sel.startsWith('f:') ? findByFile(sel.slice(2)) : null; if (f) { openNodes.add('m:' + f.M.name); if (f.a) openNodes.add('a:' + f.M.name + ':' + f.a.key) } else if (parts[0] === 'm') openNodes.add(sel) } renderTree(); renderPane(); window.scrollTo(0, 0) })
  for (const el of main.querySelectorAll('[data-chip]')) el.addEventListener('click', (ev) => { ev.stopPropagation(); hlId = hlId === el.dataset.chip ? null : el.dataset.chip; renderTree(); renderPane(); $('#status').textContent = hlId ? '高亮 ' + hlId + ' 落在哪儿（树上黄色的），再点一次取消' : '' })
}
/* ---------------- 按代码结构（校验 ②、pre-pr） ---------------- */
function isCodeMode() { return !!data.mode || String(data.direction) === '2' }
function fileOfTarget(t) { return String(t || '').split('#')[0].split(':')[0] }
function lineOfTarget(t) { const m = String(t || '').match(/:(\d+)/); return m ? Number(m[1]) : null }
function isCodeFile(f) { return f.startsWith('src/') || f.startsWith('tests/') }
const SEV = { high: '必须改', medium: '应该改', low: '说明' }
// 文件 → 落在它上面的条目 [{k:'judgments'|'confirms', i}]
let byCode = new Map(), codeFilesAll = []
function indexCode() {
  byCode = new Map()
  const add = (f, k, i) => { if (!byCode.has(f)) byCode.set(f, []); byCode.get(f).push({ k, i }) }
  ;(data.judgments || []).forEach((it, i) => { const f = fileOfTarget(it.target); if (isCodeFile(f)) add(f, 'judgments', i) })
  ;(data.confirms || []).forEach((it, i) => { const f = fileOfTarget(it.target); if (isCodeFile(f)) add(f, 'confirms', i) })
  codeFilesAll = [...new Set([...(data.codeFiles || []), ...byCode.keys()])].sort()
}
const openCode = (files) => files.reduce((n, f) => n + (byCode.get(f) || []).filter(({ k, i }) => !data[k][i].human?.verdict).length, 0)
function renderCodeTree() {
  const rootNode = { name: '', dirs: new Map(), files: [] }
  for (const f of codeFilesAll) { const parts = f.split('/'); let node = rootNode; for (const d of parts.slice(0, -1)) { if (!node.dirs.has(d)) node.dirs.set(d, { name: d, dirs: new Map(), files: [], path: (node.path ? node.path + '/' : '') + d }); node = node.dirs.get(d) } node.files.push({ name: parts[parts.length - 1], path: f }) }
  const allFiles = (node) => [...node.files.map(x => x.path), ...[...node.dirs.values()].flatMap(allFiles)]
  let h = ''
  const dir = (node, depth) => {
    const id = 'd:' + node.path, files = allFiles(node), n = openCode(files), cnt = files.reduce((a, f) => a + (byCode.get(f) || []).length, 0)
    const open = openNodes.has(id) || depth < 2
    h += '<div class="tn' + (n ? '' : ' zero') + (sel === id ? ' sel' : '') + '" data-id="' + esc(id) + '" style="padding-left:' + (6 + depth * 14) + 'px"><span class="tw" data-tw="' + esc(id) + '">' + (open ? '▾' : '▸') + '</span><span class="lb k code">' + esc(node.name) + '/</span><span class="cnt' + (n ? '' : ' zero') + '">' + (n || (cnt ? '' : '')) + '</span></div>'
    if (!open) return
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) dir(d, depth + 1)
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const items = byCode.get(f.path) || [], n2 = openCode([f.path])
      h += '<div class="tn' + (n2 ? '' : ' zero') + (sel === 'c:' + f.path ? ' sel' : '') + '" data-id="' + esc('c:' + f.path) + '" style="padding-left:' + (6 + (depth + 1) * 14) + 'px" title="' + esc(f.path) + '"><span class="tw"></span><span class="lb k code">' + esc(f.name) + '</span>' + (items.length ? '<span class="k">' + items.length + ' 条</span>' : '') + '<span class="cnt' + (n2 ? '' : ' zero') + '">' + (n2 || '') + '</span></div>'
    }
  }
  for (const d of [...rootNode.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) dir(d, 0)
  for (const f of rootNode.files) h += '<div class="tn" data-id="' + esc('c:' + f.path) + '"><span class="tw"></span><span class="lb k code">' + esc(f.name) + '</span></div>'
  const tree = $('#tree'), top = tree.scrollTop
  const total = openCode(codeFilesAll)
  tree.innerHTML = '<div class="tn' + (sel === null ? ' sel' : '') + '" data-id="" style="font-weight:600"><span class="tw"></span><span class="lb">总览</span><span class="cnt' + (total ? '' : ' zero') + '">' + (total || '') + '</span></div>' + (codeFilesAll.length ? h : '<div class="empty" style="padding:10px">这一段还没有代码文件可摆（计划没算、范围没划）</div>')
  tree.scrollTop = top
  for (const el of tree.querySelectorAll('.tn')) el.addEventListener('click', (ev) => {
    const id = el.dataset.id
    if (ev.target.dataset.tw) { openNodes.has(id) ? openNodes.delete(id) : openNodes.add(id); if (!openNodes.has(id)) openNodes.add('closed:' + id); renderCodeTree(); return }
    sel = id || null; renderCodeTree(); renderCodePane()
  })
}
function ccard(k, i) {
  const it = data[k][i]
  const sev = k === 'confirms' ? '<span class="sev ok">上一轮改过，核过</span>' : (it.importance ? '<span class="sev ' + it.importance + '">' + (SEV[it.importance] || it.importance) + '</span>' : '')
  const line = lineOfTarget(it.target)
  const sides = it.sides ? Object.entries(it.sides).filter(([, v]) => v !== undefined).map(([kk, v]) => '<b>' + ({ business: '业务', expected: '该是', model: '模型', code: '代码' }[kk] || kk) + '</b><span>' + esc(typeof v === 'string' ? v : JSON.stringify(v)) + '</span>').join('') : ''
  const ctl = k === 'confirms' ? confirmControls(it, i) : judgmentControls(it, i)
  return '<div class="cc ' + (k === 'judgments' ? (it.importance || '') : '') + (it.human?.verdict ? ' done' : '') + '">'
    + '<div>' + sev + (it.check ? '<span class="angle">' + esc(it.check) + '</span>' : '') + (line ? '<span class="ln">第 ' + line + ' 行</span>' : '') + '</div>'
    + (it.round1 ? '<div class="ttl">' + esc(it.round1) + '</div>' : '')
    + (sides ? '<div class="sides">' + sides + '</div>' : '')
    + (it.failure ? '<div class="fail">会出什么事：' + esc(it.failure) + '</div>' : '')
    + ctl + guideOf(it.check) + '</div>'
}
function codeOverviewHtml() {
  const js = data.judgments || [], cs = data.confirms || []
  const isPrepr = !!data.mode
  let h = ''
  if (!js.length && !cs.length) {
    h += '<div class="clean"><b class="big">' + (isPrepr ? 'pre-pr 审查没有发现' : '解码回来的模型与模型师的一字不差') + '</b>'
      + (isPrepr ? '查了 ' + (data.angles || []).length + ' 个角度' + ((data.cleanAngles || []).length ? '，干净的：' + data.cleanAngles.map(esc).join('、') : '') : '把代码读回一份模型，跟 model/ 下的逐条比：字段、规则、错误条件、步骤、端口——没有一处对不上')
      + '。<div class="k" style="margin-top:6px">比对时间 ' + esc((data.at || '').slice(0, 16).replace('T', ' ')) + (data.decodedVersion ? ' · 代码版本 ' + esc(data.decodedVersion) : '') + ' · 摆在左边的 ' + codeFilesAll.length + ' 个文件是这一段计划里要写或写过的' + ((data.deferred || []).length ? ' · 另有 ' + data.deferred.length + ' 项本段范围外、未建，不算' : '') + '</div></div>'
  } else {
    const c = (imp) => js.filter(x => x.importance === imp).length
    h += '<div class="nums"><div class="m"><b style="color:#cf222e">' + c('high') + '</b>必须改</div><div class="m"><b style="color:#d4770a">' + c('medium') + '</b>应该改</div><div class="m"><b style="color:#8c959f">' + c('low') + '</b>说明</div>' + (cs.length ? '<div class="m"><b style="color:#1a7f37">' + cs.length + '</b>上一轮改过、这轮核过</div>' : '') + '<div class="m"><b>' + (js.filter(x => !x.human?.verdict).length + cs.filter(x => !x.human?.verdict).length) + '</b>等你</div></div>'
    if (isPrepr) h += '<div class="k">角度：' + (data.angles || []).map(a => '<span class="angle">' + esc(a) + ((data.cleanAngles || []).includes(a) ? ' ✓ 干净' : '') + '</span>').join('') + '</div>'
  }
  if ((data.notes || []).length) h += '<details><summary>审查角色的说明（' + data.notes.length + '）</summary>' + data.notes.map(n => '<div class="narr">' + esc(n) + '</div>').join('') + '</details>'
  if ((data.blindSpots || []).length) h += '<details><summary>这一轮没查的（盲区，' + data.blindSpots.length + '）</summary><ul>' + data.blindSpots.map(b => '<li>' + esc(typeof b === 'string' ? b : b.text || JSON.stringify(b)) + '</li>').join('') + '</ul></details>'
  // 文件清单：有条目的排前面
  const withItems = codeFilesAll.filter(f => (byCode.get(f) || []).length)
  if (withItems.length) h += '<h3>有发现的文件</h3>' + withItems.map(f => '<div class="card"><h4><span class="to" data-go="' + esc('c:' + f) + '">' + esc(f) + '</span> <span class="k">' + (byCode.get(f) || []).length + ' 条，等你 ' + openCode([f]) + '</span></h4></div>').join('')
  // 不落在代码文件上的条目（目标是模型文件或别的）
  const rest = [...(data.judgments || []).map((it, i) => ({ k: 'judgments', i, it })), ...(data.confirms || []).map((it, i) => ({ k: 'confirms', i, it }))].filter(({ it }) => !isCodeFile(fileOfTarget(it.target)))
  if (rest.length) h += '<h3>不落在代码文件上的</h3>' + rest.map(({ k, i }) => ccard(k, i)).join('')
  return h
}
function renderCodePane() {
  const main = $('#main'); main.innerHTML = ''
  if (!sel) {
    main.appendChild(introNode())
    const d = document.createElement('div'); d.innerHTML = codeOverviewHtml(); main.appendChild(d)
    section(main, '警告', data.warnings, warningControls, true)
    section(main, '错误（只读，必须修）', data.errors, () => '', false)
  } else if (sel.startsWith('d:')) {
    const dirPath = sel.slice(2), files = codeFilesAll.filter(f => f.startsWith(dirPath + '/'))
    const d = document.createElement('div')
    d.innerHTML = '<div class="hd"><span class="k">目录</span><h2>' + esc(dirPath) + '/</h2></div>' + files.map(f => '<div class="card"><h4><span class="to" data-go="' + esc('c:' + f) + '">' + esc(f.slice(dirPath.length + 1)) + '</span> <span class="k">' + ((byCode.get(f) || []).length ? (byCode.get(f) || []).length + ' 条，等你 ' + openCode([f]) : '没有发现') + '</span></h4></div>').join('')
    main.appendChild(d)
  } else if (sel.startsWith('c:')) {
    const f = sel.slice(2), items = (byCode.get(f) || []).slice().sort((a, b) => (lineOfTarget(data[a.k][a.i].target) || 0) - (lineOfTarget(data[b.k][b.i].target) || 0))
    const modelFile = (data.judgments || []).concat(data.confirms || []).find(it => fileOfTarget(it.target) === f && it.modelFile)?.modelFile
    const d = document.createElement('div')
    d.innerHTML = '<div class="hd"><span class="k">文件</span><h2 style="font-family:ui-monospace,Consolas,monospace;font-size:15px">' + esc(f) + '</h2></div>'
      + (modelFile ? '<div class="meta">对应模型：<code>' + esc(modelFile) + '</code></div>' : '')
      + (items.length ? items.map(({ k, i }) => ccard(k, i)).join('') : '<div class="clean" style="padding:10px 14px">这个文件上没有发现。</div>')
    main.appendChild(d)
  }
  bindControls(main)
  for (const el of main.querySelectorAll('[data-go]')) el.addEventListener('click', () => { sel = el.dataset.go; renderCodeTree(); renderCodePane(); window.scrollTo(0, 0) })
}
function render() {
  $('#title').textContent = (data.mode ? '审代码（pre-pr ' + (data.mode === 'proto' ? '原型' : '外壳') + '）' : String(data.direction) === '2' ? '审代码对模型' : '审模型') + ' · ' + (data.project||'').split(/[\\\\/]/).pop() + (data.slice ? ' · ' + data.slice : '')
  document.body.className = data.mode ? 'prepr' : String(data.direction) === '2' ? 'dir2' : 'dir1'
  if (isCodeMode()) {
    // 校验 ② 与 pre-pr：按代码结构看，不切故事
    $('#mode').hidden = true
    mode = 'code'
    $('#tree').hidden = false
    indexJudgments(); indexCode(); renderCodeTree(); renderCodePane()
    return
  }
  const canStructure = !!(data.structure && data.structure.length)
  $('#mode').hidden = !canStructure
  if (!canStructure) mode = 'story'
  $('#mode').textContent = mode === 'structure' ? '按故事看' : '按结构看'
  $('#tree').hidden = mode !== 'structure'
  if (mode === 'structure') { indexJudgments(); if (!openNodes.size) for (const M of data.structure) openNodes.add('m:' + M.name); renderTree(); renderPane() }
  else renderFlat()
}
async function load() {
  data = await (await fetch('/data')).json()
  try { const m = localStorage.getItem('review-mode'); mode = m || (data.structure?.length ? 'structure' : 'story') } catch { mode = data.structure?.length ? 'structure' : 'story' }
  render()
}
async function save(auto) {
  $('#status').textContent = '保存中…'
  try {
    const r = await fetch('/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data) })
    $('#status').textContent = r.ok ? (auto ? '已自动保存 ' : '已保存 ') + new Date().toLocaleTimeString() : '保存失败——再点一次保存'
  } catch { $('#status').textContent = '保存失败——服务没在跑？' }
}
// 每次改动 800ms 后自动写盘；保存按钮留着，随时可以手动按
let saveTimer = null
function scheduleSave() { clearTimeout(saveTimer); $('#status').textContent = '有改动，稍后自动保存'; saveTimer = setTimeout(() => save(true), 800) }
$('#save').addEventListener('click', () => { clearTimeout(saveTimer); save(false) })
$('#mode').addEventListener('click', () => { mode = mode === 'structure' ? 'story' : 'structure'; try { localStorage.setItem('review-mode', mode) } catch {} render(); window.scrollTo(0, 0) })
$('#agree-high').addEventListener('click', () => {
  let n = 0
  for (const it of data.judgments || []) if (it.verdict === 'pass' && it.confidence === 'high' && !it.human?.verdict) { it.human = { ...(it.human||{}), verdict: 'agree', at: new Date().toISOString().slice(0,10) }; n++ }
  render(); scheduleSave(); $('#status').textContent = '已同意 ' + n + ' 条高信心的，稍后自动保存'
})
load()
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html)
  }
  if (req.method === 'GET' && req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    let obj
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return res.end(fs.readFileSync(file, 'utf8')) }
    // 故事切片：附上故事步骤（页面按步骤分组），以及每个模型文件目标的 traces（命令的步骤靠它对到故事的哪一步）
    try {
      // 项目目录按报告文件所在位置推（<项目>/reports/x.json）：报告可能是另一台机器写的，里面的 project 是那台机器的路径
      const projectDir = (obj.project && fs.existsSync(String(obj.project))) ? String(obj.project) : path.dirname(path.dirname(file))
      if (projectDir && obj.slice) {
        const sp = path.join(projectDir, 'slices', obj.slice + '.story.json')
        let st = null
        if (fs.existsSync(sp)) { st = JSON.parse(fs.readFileSync(sp, 'utf8')); obj.story = { title: st.title, steps: (st.steps || []).map((x) => ({ n: x.n, day: x.day, actor: x.actor, text: x.text, traces: x.traces || [] })) } }
        // 方向 ②：目标是代码文件（src/…、tests/…），对回模型文件，按结构看时才挂得上树
        try {
          const { modelKeyOf, loadModel } = require('./lib/project')
          const names = (loadModel(projectDir).moduleFiles || []).map((m) => m.module)
          for (const it of obj.judgments || []) {
            const t = String(it.target || '').split('#')[0].split(':')[0]
            if (!/^(src|tests)\//.test(t)) continue
            const key = modelKeyOf(t, names)
            if (key && fs.existsSync(path.join(projectDir, 'model', key))) it.modelFile = 'model/' + key
          }
        } catch { /* 对不回去就当没落点 */ }
        obj.targetTraces = {}
        for (const it of obj.judgments || []) {
          const f = String(it.target || '').split('#')[0]
          if (!f.startsWith('model/') || obj.targetTraces[f]) continue
          try { obj.targetTraces[f] = JSON.parse(fs.readFileSync(path.join(projectDir, f), 'utf8')).traces || [] } catch { obj.targetTraces[f] = [] }
        }
        // 按结构看：模型的树 + 业务语句原文（编号的提示）
        // 按代码结构看（校验 ②、pre-pr）：这一段要摆的代码文件——计划里这次要写的、上一段做过的、pre-pr 划进范围的
        try {
          const files = new Set()
          const pp = path.join(projectDir, 'plans', obj.slice + '.json')
          if (fs.existsSync(pp)) { const plan = JSON.parse(fs.readFileSync(pp, 'utf8')); for (const x of [...(plan.steps || []), ...(plan.already || [])]) if (x.file && !x.file.includes('*')) files.add(x.file) }
          for (const f of obj.scope?.files || []) files.add(f)
          obj.codeFiles = [...files].sort()
        } catch { obj.codeFiles = [] }
        try { obj.structure = buildStructure(projectDir, st) } catch (e) { console.error('[审阅] 模型结构算不出来，只给按故事那一面：' + e.message) }
        try { const { loadBusiness } = require('./lib/project'); obj.business = Object.fromEntries((loadBusiness(projectDir) || []).map((s) => [s.id, { text: s.text, label: s.label }])) } catch { /* 没有就不给提示 */ }
      }
    } catch { /* 附不上就按原样给 */ }
    return res.end(JSON.stringify(obj))
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const posted = JSON.parse(body)
        // 不整份覆盖：页面加载之后，校验角色可能又补了判断、校验器可能重跑过。
        // 先读盘上现在这份，只把人填的 human 按条合进去（同一条 = 目标、检查、两侧文字都一样）。
        const key = (x) => [x.target, x.check, x.sides?.business ?? '', x.sides?.model ?? '', x.sides?.code ?? ''].join(' ')
        let obj = posted
        try {
          const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
          for (const arr of ['judgments', 'confirms']) {
            const mine = new Map((posted[arr] ?? []).map((x) => [key(x), x]))
            for (const it of disk[arr] ?? []) {
              const p = mine.get(key(it))
              if (p && p.human) it.human = p.human
            }
          }
          obj = disk
        } catch { /* 盘上那份读不了就按页面的存 */ }
        // 页面附上的结构、业务原文、故事不是报告的一部分，不写回
        delete obj.structure; delete obj.business
        fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
        res.writeHead(200)
        res.end('ok')
        console.log(`已保存 ${new Date().toLocaleTimeString()}`)
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
  console.log(`审阅：${file}\n打开 ${url}（Ctrl+C 结束）`)
  // --no-open：工作台代理这一页，别再自己弹浏览器标签
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
})
