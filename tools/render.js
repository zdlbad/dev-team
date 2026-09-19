#!/usr/bin/env node
/**
 * 可视化：把模型渲染成一个自包含的 HTML 页面（给人看，不写任何状态）。
 *
 * 页面有三个视图：
 *   关系图 —— 节点是聚合根 / 实体 / 值对象 / 事件 / 领域服务 / 用例 / 端口 / 错误，边是调用、发出、触发、成员、引用、协调、抛出；
 *             按模块分区、按种类分列，力导向微调；可拖拽、缩放；点节点看详情；图例可开关。
 *   卡片   —— 每个模型文件一张卡片，全部内容。
 *   业务覆盖 —— 每条业务语句落到了哪些元素。
 *
 * 用法：node tools/render.js <项目目录> [--decoded <解码目录>] [--out <html>]
 *   --decoded 时与解码出的实际模型比对：图上有差异的节点描红，卡片底部并排列出「模型 ｜ 代码」。
 *   --out 缺省为 <项目目录>/reports/model.html。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadProject, ruleText, conditionText, labelOf } = require('./lib/project')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined)
if (!root || !fs.existsSync(path.join(root, 'model'))) {
  console.error('用法：node tools/render.js <项目目录> [--decoded <解码目录> | --baseline <基线模型目录>] [--out <html>]')
  process.exit(2)
}
const decodedDir = opt('--decoded') && path.resolve(opt('--decoded'))
// --baseline <目录>：与切片开工时的模型（基线）比，人只看增量；机制与 --decoded 相同，只是对面不是代码而是上一版
const baselineDir = opt('--baseline') && path.resolve(opt('--baseline'))
const otherDir = decodedDir ?? baselineDir
const other = baselineDir ? '上一版' : '代码'
const out = path.resolve(opt('--out') ?? path.join(root, 'reports', 'model.html'))
const { business, glossary, model } = loadProject(root)
const projectName = fs.existsSync(path.join(root, 'project.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).name : path.basename(root)

// ---------- 差异（可选） ----------
let findings = []
let decodedFiles = new Set()
if (otherDir) {
  const tmp = path.join(root, 'reports', '_render-diff.json')
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  spawnSync(process.execPath, [path.join(__dirname, 'diff-model.js'), path.join(root, 'model'), otherDir, '--json', tmp], { encoding: 'utf8' })
  if (fs.existsSync(tmp)) {
    findings = JSON.parse(fs.readFileSync(tmp, 'utf8')).findings.map((f) => ({ ...f, file: f.file.replace(/^model\//, '') }))
    fs.rmSync(tmp, { force: true })
  }
  const walk = (d, o = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name), o) : o.push(path.join(d, e.name))
    return o
  }
  decodedFiles = new Set(walk(otherDir).filter((p) => p.endsWith('.json') && !path.basename(p).startsWith('_')).map((p) => path.relative(otherDir, p).replaceAll('\\', '/')))
}
const findingsOf = (file) => findings.filter((f) => f.file === file.replace(/^model\//, ''))

// ---------- 小工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const chips = (xs, cls = 'trace') => (xs ?? []).map((x) => `<span class="chip ${cls}">${esc(x)}</span>`).join('')
const params = (ps) => (ps ?? []).map((p) => `${esc(p.name)}: ${esc(p.type)}`).join(', ')
const raiseText = (r) => (typeof r === 'string' ? r : `${r.event}（当 ${r.when}）`)
const raiseName = (r) => (typeof r === 'string' ? r : r.event)
const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v))
const KIND_LABEL = { 'aggregate-root': '聚合根', entity: '实体', 'value-object': '值对象', event: '事件', error: '错误', repository: '仓储', service: '领域服务', 'command-handler': '命令', 'query-handler': '查询', 'event-handler': '事件处理', port: '端口' }

// ---------- 卡片 ----------
// 字段成表：名字 | 类型 | 说明（说明下挂追溯标签）。一行挤成 "a: string, b: date" 人看不清哪栏是干什么的
function fieldsTable(fields) {
  return `<table class="fields">${fields.map((f) => `<tr><td class="fn"><code>${esc(f.name)}</code></td><td class="ft">${esc(f.type)}${f.nullable ? '<span class="muted">（可空）</span>' : ''}</td><td class="fd">${f.note ? esc(f.note) : '<span class="muted">—</span>'}${f.traces?.length ? `<div class="meta">${chips(f.traces)}</div>` : ''}</td></tr>`).join('')}</table>`
}
// 卡片头：种类 + 名字一行，追溯标签自己一行（原来挤在名字后面，七八个标签把标题冲散）
const cardHead = (kind, name, traces) => `<div class="hd"><span class="kind">${kind}</span><b class="name">${esc(name)}</b></div>${traces?.length ? `<div class="traces">${chips(traces)}</div>` : ''}`
function diffBlock(file) {
  const fs_ = findingsOf(file)
  if (!fs_.length) return ''
  const rows = fs_.map((f) => `<tr><td class="k">${esc(f.kind === 'missing-file' ? '整个文件' : f.path)}</td><td>${esc(f.kind === 'missing-file' ? '（模型有）' : show(f.model))}</td><td>${esc(f.kind === 'missing-file' ? `（${other}无）` : show(f.code))}</td></tr>`).join('')
  return `<div class="diff"><div class="dt">与${other}的差异（${fs_.length}）</div><table><tr><th>位置</th><th>模型</th><th>${other}</th></tr>${rows}</table></div>`
}
const cardCls = (file) => (findingsOf(file).length ? 'card bad' : otherDir ? 'card ok' : 'card')
/**
 * 一个方法的七段（第一百五十六批）：作用、入参、做法（每一步改哪几栏）、规则、错误、事件、返回。
 * 项目所有者读 Invoice.attachSupportingDocument：「模型方法这里说的没有条理」——五条规则用分号连成一串。
 * 老写法（没有作用与做法）至少把规则一条一行摆开。
 */
function methodBlock(b, head, extra = '') {
  const row = (k, v) => `<div class="m7"><span class="m7k">${k}</span><div>${v}</div></div>`
  const L = []
  if (b.purpose) L.push(row('作用', esc(b.purpose.text) + ' ' + chips(b.purpose.traces ?? [])))
  if (extra) L.push(extra)
  if ((b.input ?? []).some((i) => i.note)) L.push(row('入参', b.input.map((i) => `<code>${esc(i.name)}: ${esc(i.type)}</code>${i.note ? ' ' + esc(i.note) : ''}`).join('<br>')))
  if (b.purpose && (b.steps ?? []).length) L.push(row('做法', '<ol>' + b.steps.map((s) => `<li>${esc(s.text)}${(s.changes ?? []).length ? ` <span class="chg">→ 改 ${esc(s.changes.join('、'))}</span>` : ''}</li>`).join('') + '</ol>'))
  if ((b.rules ?? []).length) L.push(row('规则', '<ul>' + b.rules.map((r) => `<li>${esc(ruleText(r))}${typeof r === 'string' ? '' : ' ' + chips(r.traces ?? [])}</li>`).join('') + '</ul>'))
  L.push(row('错误', (b.throws ?? []).length ? esc(b.throws.join('，')) : '无'))
  L.push(row('事件', (b.raises ?? []).length ? esc(b.raises.map(raiseText).join('，')) : '无'))
  L.push(row('返回', b.output ? `<code>${esc(b.output)}</code>` : '无'))
  return `<li class="meth"><div class="mhd">${head}${b.simple ? ' <span class="muted">（简单方法）</span>' : ''}</div>${L.join('')}</li>`
}
function domainCard(el) {
  const d = el.data
  const inv = (list, label) => (list?.length ? `<div class="sec"><div class="sec-title">${label}</div><ul class="inv">${list.map((i) => `<li><div class="txt">${esc(i.text)}</div><div class="meta">${chips(i.traces)}${i.throws?.length ? `<span class="throws">抛出 ${esc(i.throws.join(', '))}</span>` : ''}</div></li>`).join('')}</ul></div>` : '')
  const behaviors = d.behaviors?.length
    ? `<div class="sec"><div class="sec-title">行为</div><ul class="meths">${d.behaviors.map((b) => methodBlock(b, `<code>${esc(b.name)}(${params(b.input)})${b.output ? ` → ${esc(b.output)}` : ''}</code> ${chips(b.traces)}`)).join('')}</ul></div>`
    : ''
  // 创建（第一百五十八批）：怎么被建出来，与行为同一套七段
  const create = d.create ? `<div class="sec"><div class="sec-title">创建</div><ul class="meths">${methodBlock(d.create, `<code>create(${params(d.create.input ?? [])})</code> ${chips(d.create.traces ?? [])}`)}</ul></div>` : ''
  return `<div class="${cardCls(el.file)}" id="${esc(el.file)}">${cardHead(KIND_LABEL[el.kind], d.name, d.traces)}
  ${d.aggregateNarrative ? `<p class="narr">${esc(d.aggregateNarrative)}</p>` : ''}
  ${d.fields?.length ? `<div class="sec"><div class="sec-title">字段</div>${fieldsTable(d.fields)}</div>` : ''}
  ${create}${inv(d.aggregateInvariants, '聚合级规则')}${inv(d.invariants, d.create ? '不变量' : '规则')}${behaviors}${diffBlock(el.file)}</div>`
}
function smallCard(el, body) {
  return `<div class="${cardCls(el.file)} small" id="${esc(el.file)}">${cardHead(KIND_LABEL[el.kind], el.data.name, el.data.traces)}${body}${diffBlock(el.file)}</div>`
}
function steps(list) {
  if (!list?.length) return '<span class="muted">（无步骤）</span>'
  return `<ol class="steps">${list
    .map((s) => {
      const call = s.call ? `<code>${esc(s.call.target)}.${esc(s.call.method)}</code> <span class="muted">${esc(s.call.kind)}</span>` : ''
      return `<li>${s.when ? `<span class="when">当 ${esc(s.when)}：</span>` : ''}${esc(s.text)} ${call}${s.output ? ` <span class="muted">→ ${esc(s.output)}</span>` : ''}${s.throws?.length ? ` <span class="muted">抛出 ${esc(s.throws.join('，'))}</span>` : ''}</li>`
    })
    .join('')}</ol>`
}
function useCaseCard(el) {
  const d = el.data
  const head = el.kind === 'event-handler' ? `触发：<code>${esc(d.trigger)}</code>` : `执行者：${esc(d.actor)}　输入：<span class="muted">${params(d.input) || '无'}</span>`
  const tail = [
    d.writes?.length ? `写：${esc(d.writes.join('，'))}${d.writesNote ? `（${esc(d.writesNote)}）` : ''}` : '',
    d.result ? `返回：<span class="muted">${params(d.result)}</span>` : '',
    d.raises?.length ? `发出：${d.raises.map(raiseText).map(esc).join('，')}` : '',
    d.throws?.length ? `抛出：${esc(d.throws.join('，'))}` : '',
  ].filter(Boolean)
  return `<div class="${cardCls(el.file)}" id="${esc(el.file)}">${cardHead(KIND_LABEL[el.kind], d.name, d.traces)}<div class="sec">${head}</div>${steps(d.steps)}${tail.length ? `<div class="sec muted2">${tail.join('　')}</div>` : ''}${diffBlock(el.file)}</div>`
}
function serviceCard(el) {
  const d = el.data
  const ops = d.operations
    .map((op) => op.purpose
      ? methodBlock(op, `<code>${esc(op.name)}(${params(op.input)})${op.output ? ` → ${esc(op.output)}` : ''}</code> ${chips(op.traces)}`, `<div class="m7"><span class="m7k">读 / 写</span><div>读 ${esc(op.reads.join('，') || '无')}；写 ${esc(op.writes.join('，') || '无')}</div></div>`)
      : `<li><code>${esc(op.name)}(${params(op.input)})${op.output ? ` → ${esc(op.output)}` : ''}</code> ${chips(op.traces)}<div class="sub">读：${esc(op.reads.join('，') || '无')}　写：${esc(op.writes.join('，') || '无')}</div>${op.rules?.length ? `<div class="sub">规则：</div><ul class="sub">${op.rules.map((r) => `<li>${esc(ruleText(r))}</li>`).join('')}</ul>` : ''}${steps(op.steps)}</li>`)
    .join('')
  return `<div class="${cardCls(el.file)}" id="${esc(el.file)}"><div class="hd"><span class="kind">领域服务</span> <b>${esc(d.name)}</b> <span class="muted">协调：${esc(d.coordinates.join('，'))}</span></div><ul>${ops}</ul>${diffBlock(el.file)}</div>`
}
const els = model.elements.filter((e) => e.kind !== 'invalid')
const handlersOf = (ev) => els.filter((e) => e.kind === 'event-handler' && e.data.trigger === ev)
function cardOf(el) {
  switch (el.kind) {
    case 'aggregate-root':
    case 'entity':
    case 'value-object':
      return domainCard(el)
    case 'event':
      return smallCard(el, `<div class="sec muted">载荷：${params(el.data.payload)}</div>${handlersOf(el.data.name).length ? `<div class="sec">处理者：${handlersOf(el.data.name).map((h) => `<a href="#${esc(h.file)}">${esc(h.data.name)}</a>`).join('，')}</div>` : '<div class="sec muted">（无处理者）</div>'}`)
    case 'error':
      return smallCard(el, `<div class="sec muted">${esc(conditionText(el.data.condition))}</div>`)
    case 'repository':
      return smallCard(el, `<ul class="plain">${el.data.methods.map((mt) => `<li><code>${esc(mt.name)}(${params(mt.input)})${mt.output ? ` → ${esc(mt.output)}` : ''}</code> <span class="muted">${mt.kind === 'read' ? '读' : '写'}</span></li>`).join('')}</ul>`)
    case 'service':
      return serviceCard(el)
    case 'port':
      return smallCard(el, `<div class="sec muted">${el.data.kind === 'external-system' ? '外部系统' : '模块'}：${esc(el.data.target)}</div><ul class="plain">${el.data.operations.map((op) => `<li><code>${esc(op.name)}(${params(op.input)})${op.output ? ` → ${esc(op.output)}` : ''}</code></li>`).join('')}</ul>`)
    default:
      return useCaseCard(el)
  }
}

// ---------- 关系图数据 ----------
const modules = model.modules?.data.modules ?? []
const byName = (kind, mod, name) => els.find((e) => e.kind === kind && e.module === mod && e.data.name === name)
const domainByName = (mod, name) => ['aggregate-root', 'entity', 'value-object'].map((k) => byName(k, mod, name)).find(Boolean)
const aggregateOf = (el) => {
  if (el.kind === 'aggregate-root') return el.data.name
  if (el.data.aggregate) return el.data.aggregate
  const root = els.find((e) => e.kind === 'aggregate-root' && e.module === el.module && e.aggregateFolder === el.aggregateFolder)
  return root?.data.name ?? null
}
const nodes = []
const edges = []
const nodeIds = new Set()
for (const el of els) {
  if (el.kind === 'repository') continue // 仓储折叠成「用例 → 聚合」的读 / 写边
  nodes.push({ id: el.file, label: el.data.name, kind: el.kind, module: el.module, agg: ['aggregate-root', 'entity', 'value-object', 'event', 'error'].includes(el.kind) ? aggregateOf(el) : null, bad: findingsOf(el.file).length > 0, sub: el.kind === 'port' ? `${el.data.kind === 'external-system' ? '外部' : '模块'} ${el.data.target}` : el.kind === 'command-handler' || el.kind === 'query-handler' ? el.data.actor : el.kind === 'event-handler' ? `← ${el.data.trigger}` : '' })
  nodeIds.add(el.file)
}
const seen = new Set()
function edge(from, to, kind, label = '') {
  if (!from || !to || from === to) return
  const key = `${from}|${to}|${kind}`
  if (seen.has(key)) return
  seen.add(key)
  edges.push({ from, to, kind, label })
}
function resolveCall(mod, call) {
  switch (call.kind) {
    case 'behavior':
    case 'factory':
      return domainByName(mod, call.target)?.file
    case 'service':
      return byName('service', mod, call.target)?.file
    case 'port':
      return byName('port', mod, call.target)?.file
    case 'command':
      return byName('command-handler', mod, call.target)?.file
    case 'repository': {
      const repo = byName('repository', mod, call.target)
      return repo && byName('aggregate-root', mod, repo.data.aggregate)?.file
    }
  }
}
for (const el of els) {
  const d = el.data
  const mod = el.module
  if (['aggregate-root', 'entity', 'value-object'].includes(el.kind)) {
    for (const b of d.behaviors ?? []) {
      for (const r of b.raises ?? []) edge(el.file, byName('event', mod, raiseName(r))?.file, 'raise', b.name)
      for (const t of b.throws ?? []) edge(el.file, byName('error', mod, t)?.file, 'throw', b.name)
    }
    for (const i of d.invariants ?? []) for (const t of i.throws ?? []) edge(el.file, byName('error', mod, t)?.file, 'throw', '创建')
    if (el.kind === 'aggregate-root') {
      for (const m of els.filter((e) => ['entity', 'value-object'].includes(e.kind) && e.module === mod && aggregateOf(e) === d.name)) edge(el.file, m.file, 'member')
      const mf = model.moduleFiles.find((x) => x.module === mod)
      const agg = mf?.data.aggregates.find((a) => a.name === d.name)
      for (const r of agg?.idRefs ?? []) {
        const [tm, ta] = r.to.split('.')
        edge(el.file, byName('aggregate-root', tm, ta)?.file, 'ref', r.field)
      }
    }
  }
  if (el.kind === 'service') {
    for (const c of d.coordinates ?? []) edge(el.file, byName('aggregate-root', mod, c)?.file, 'coordinate')
    for (const op of d.operations) for (const s of op.steps ?? []) if (s.call) edge(el.file, resolveCall(mod, s.call), 'call', `${op.name}: ${s.call.method}`)
  }
  if (['command-handler', 'query-handler', 'event-handler'].includes(el.kind)) {
    if (el.kind === 'event-handler') edge(byName('event', mod, d.trigger)?.file, el.file, 'trigger')
    for (const s of d.steps ?? []) {
      if (!s.call) continue
      const to = resolveCall(mod, s.call)
      if (s.call.kind === 'repository') {
        const repo = byName('repository', mod, s.call.target)
        const m = repo?.data.methods.find((x) => x.name === s.call.method)
        edge(el.file, to, m?.kind === 'write' ? 'write' : 'read', s.call.method)
      } else edge(el.file, to, 'call', s.call.method)
    }
    for (const r of d.raises ?? []) edge(el.file, byName('event', mod, raiseName(r))?.file, 'raise')
  }
  if (el.kind === 'port' && d.kind === 'module') edge(el.file, modules.find((m) => m.name === d.target) && `mod:${d.target}`, 'module')
}
// 模块端口指向的模块：用一个模块节点承接
for (const e of edges) if (e.to.startsWith('mod:') && !nodeIds.has(e.to)) {
  nodes.push({ id: e.to, label: e.to.slice(4), kind: 'module', module: e.to.slice(4), agg: null, bad: false, sub: '模块' })
  nodeIds.add(e.to)
}
// 同一对节点之间的调用 / 读 / 写合并成一条边：种类取最强（写 > 调用 > 读），标签列出全部方法
const merged = []
const groups = new Map()
for (const e of edges) {
  if (!['call', 'read', 'write'].includes(e.kind)) {
    merged.push(e)
    continue
  }
  const key = e.from + '|' + e.to
  if (!groups.has(key)) groups.set(key, { from: e.from, to: e.to, kinds: new Set(), labels: [] })
  const g = groups.get(key)
  g.kinds.add(e.kind)
  if (e.label && !g.labels.includes(e.label)) g.labels.push(e.label)
}
for (const g of groups.values()) merged.push({ from: g.from, to: g.to, kind: g.kinds.has('write') ? 'write' : g.kinds.has('call') ? 'call' : 'read', label: g.labels.join(', ') })
const graph = { modules: modules.map((m) => m.name), nodes, edges: merged }

// ---------- 卡片视图与业务覆盖 ----------
const byKind = (k, mod) => els.filter((e) => e.kind === k && e.module === mod)
const cardSections = modules.map((m) => {
  const mf = model.moduleFiles.find((x) => x.module === m.name)
  const aggs = mf?.data.aggregates ?? []
  const aggBlocks = aggs.map((a) => {
    const inAgg = els.filter((e) => e.module === m.name && ['aggregate-root', 'entity', 'value-object', 'event', 'error', 'repository'].includes(e.kind) && aggregateOf(e) === a.name)
    const big = inAgg.filter((e) => ['aggregate-root', 'entity', 'value-object'].includes(e.kind)).sort((x) => (x.kind === 'aggregate-root' ? -1 : 1))
    const small = inAgg.filter((e) => !['aggregate-root', 'entity', 'value-object'].includes(e.kind))
    return `<details open class="agg"><summary><b>聚合 ${esc(a.name)}</b> ${chips(a.traces)} <span class="muted">成员：${esc(a.members.join('，') || '无')}${a.idRefs?.length ? `　引用：${a.idRefs.map((r) => `${esc(r.field)} → ${esc(r.to)}`).join('，')}` : ''}</span></summary>
      <div class="grid">${big.map(cardOf).join('') || '<div class="card bad">（缺聚合根文件）</div>'}</div><div class="grid small-grid">${small.map(cardOf).join('')}</div></details>`
  })
  const services = byKind('service', m.name).map(cardOf)
  const ucs = ['command-handler', 'query-handler', 'event-handler'].flatMap((k) => byKind(k, m.name)).map(cardOf)
  const ports = byKind('port', m.name).map(cardOf)
  const deny = mf?.data.denylist?.length ? `<p class="muted">不建模：${mf.data.denylist.map((d) => `${esc(d.noun)}（${esc(d.reason)}）`).join('；')}</p>` : ''
  return `<section id="mod-${esc(m.name)}"><h2>模块 ${esc(m.name)} ${chips(m.traces)}</h2><p class="resp">${esc(m.responsibility)}</p>${deny}${aggBlocks.join('')}
    ${services.length ? `<h3>领域服务</h3><div class="grid">${services.join('')}</div>` : ''}
    <h3>用例</h3><div class="grid">${ucs.join('') || '<span class="muted">（无）</span>'}</div>
    ${ports.length ? `<h3>端口</h3><div class="grid small-grid">${ports.join('')}</div>` : ''}</section>`
})
const traced = (id) => els.filter((e) => JSON.stringify(e.data).includes(`"${id}"`)).map((e) => `<a href="#${esc(e.file)}" class="jump">${esc(e.data.name)}</a>`)
const coverage = business.map((s) => `<tr><td><code>${esc(s.id)}</code></td><td>${esc(labelOf(s) ? `(${labelOf(s)}) ` : '')}${esc(s.text)}</td><td>${traced(s.id).join('，') || '<span class="bad-text">无落点</span>'}</td></tr>`)
const extraFiles = [...decodedFiles].filter((f) => !model.byFile.has('model/' + f))
const diffSection = otherDir
  ? `<section id="view-diff" class="view"><h2>差异汇总</h2>${findings.length ? `<ul>${findings.map((f) => `<li><a href="#model/${esc(f.file)}" class="jump">${esc(f.file)}</a> <span class="muted">${esc(f.path || '整个文件')}</span> — ${esc({ 'missing-file': `模型有、${other}无`, 'extra-file': `${other}有、模型无`, missing: `模型有、${other}无`, extra: `${other}有、模型无`, changed: '不一致' }[f.kind])}</li>`).join('')}</ul>` : '<p class="muted">设计模型与解码模型一致。</p>'}${extraFiles.length ? `<h3>${other}有、模型无的文件</h3><ul>${extraFiles.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</section>`
  : ''

// ---------- 页面 ----------
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>模型 · ${esc(projectName)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--muted:#6b7280;--ok:#16a34a;--bad:#dc2626;--chip:#eef2ff;--chip-t:#3730a3}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:#111}
header{background:#111827;color:#fff;padding:12px 24px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}header h1{margin:0;font-size:18px}header .muted{color:#cbd5e1}
nav{padding:6px 24px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
nav button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit}nav button.on{background:#111827;color:#fff;border-color:#111827}
nav .sp{flex:1}nav label{font-size:12.5px;color:#374151;margin-left:8px;white-space:nowrap}
main{padding:12px 24px;max-width:1600px}.view{display:none}.view.on{display:block}
section{margin-bottom:28px}h2{margin:18px 0 4px;font-size:17px}h3{margin:18px 0 8px;font-size:15px;color:#374151}.resp{margin:0 0 8px;color:#374151}
.agg{border:1px solid var(--line);border-radius:8px;background:#fafafa;padding:8px 12px;margin:10px 0}.agg summary{cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px;margin:8px 0}.small-grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto}.card.ok{border-left:4px solid var(--ok)}.card.bad{border-left:4px solid var(--bad)}
.hd{margin-bottom:4px}.kind{display:inline-block;font-size:11px;background:#e5e7eb;color:#374151;border-radius:4px;padding:0 6px;margin-right:4px}
.chip{display:inline-block;font-size:11px;background:var(--chip);color:var(--chip-t);border-radius:10px;padding:0 7px;margin-left:3px}
.meths{list-style:none;padding-left:0}.meth{border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;margin:6px 0}.mhd{margin-bottom:4px}.m7{display:grid;grid-template-columns:4.5em 1fr;gap:6px;padding:3px 0;border-top:1px dashed #e5e7eb;font-size:13px}.m7k{color:#6b7280;font-weight:600}.m7 ol,.m7 ul{margin:0;padding-left:18px}.chg{color:#2563eb;font-size:12px}
.sec{margin:4px 0}.sub{color:#374151;font-size:13px;margin-left:8px}.muted{color:var(--muted)}.muted2{color:#374151;font-size:13px}.narr{color:#374151;margin:4px 0;font-size:13px}
ul{margin:2px 0 2px 18px;padding:0}ul.plain{list-style:none;margin-left:0}ol.steps{margin:4px 0 4px 20px;padding:0}.when{color:#b45309}
code{background:#f3f4f6;padding:0 4px;border-radius:3px;font-size:12.5px}a{color:#1d4ed8;text-decoration:none}a:hover{text-decoration:underline}
.diff{margin-top:8px;border-top:1px dashed var(--bad);padding-top:6px}.dt{color:var(--bad);font-weight:600;font-size:13px}.diff table{border-collapse:collapse;width:100%;font-size:12.5px}.diff th,.diff td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}.diff td.k{color:var(--muted);white-space:nowrap}
table.cov{border-collapse:collapse;width:100%;background:#fff}table.cov th,table.cov td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}.bad-text{color:var(--bad)}
/* 卡片排版：留白、分行、字段成表（2026-09-13 项目所有者要求好看一些、容易看） */
.card{padding:14px 16px 12px;line-height:1.6}
.hd{display:flex;align-items:center;gap:8px;margin-bottom:2px}.hd .name{font-size:16px}
.traces{margin:0 0 6px;line-height:1.9}.traces .chip,.meta .chip{margin:0 4px 0 0}
.narr{color:#374151;margin:8px 0 12px;font-size:13.5px;line-height:1.75;max-width:72ch}
.sec{margin:10px 0 0}.sec-title{font-size:12px;color:var(--muted);letter-spacing:.04em;margin:0 0 4px;font-weight:600}
table.fields{border-collapse:collapse;width:100%;font-size:13px}table.fields td{border-top:1px solid var(--line);padding:5px 8px 5px 0;vertical-align:top}table.fields tr:first-child td{border-top:none}
table.fields .fn{white-space:nowrap;width:1%}table.fields .ft{white-space:nowrap;color:var(--muted);width:1%;padding-right:14px}table.fields .fd{color:#374151;line-height:1.55}
ul.inv{list-style:none;margin:0;padding:0}ul.inv li{padding:7px 0;border-top:1px solid var(--line)}ul.inv li:first-child{border-top:none}ul.inv .txt{line-height:1.65}
.meta{margin-top:3px;line-height:1.8}.meta .throws{font-size:12px;color:#b45309;margin-left:4px}
.card ul li{margin:3px 0}ol.steps li{margin:4px 0}
/* 图 */
#graph-wrap{display:flex;border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden;height:calc(100vh - 150px);min-height:520px}
#graph-area{position:relative;flex:1;min-width:0}#graph{width:100%;height:100%;cursor:grab;user-select:none;display:block}#graph.drag{cursor:grabbing}
.legend{flex:0 0 200px;border-right:1px solid var(--line);padding:8px 10px;font-size:12px;overflow:auto;background:#fafafa}
.legend div{margin:2px 0}.legend .hint{color:var(--muted);margin-top:6px;line-height:1.4}.legend label{display:flex;align-items:center;gap:6px;cursor:pointer}.legend .sw{display:inline-block;width:22px;height:0;border-top:2px solid #999}.legend .nd{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid #666}
.legend b{display:block;margin:4px 0 2px;color:#374151}.legend .hint{color:var(--muted);margin-top:6px}
#panel{position:absolute;right:0;top:0;bottom:0;width:min(520px,60%);background:#fff;border-left:1px solid var(--line);box-shadow:-4px 0 12px rgba(0,0,0,.06);overflow:auto;padding:10px 14px;display:none;z-index:1}#panel.on{display:block}#panel .close{float:right;border:0;background:#eee;border-radius:4px;cursor:pointer;padding:2px 8px}#panel .card{border:0;padding:0}.focus-btn{border:1px solid var(--line);background:#f3f4f6;border-radius:6px;padding:3px 10px;cursor:pointer;margin-bottom:8px}
#focus-bar{position:absolute;left:12px;top:10px;z-index:1;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:4px 10px;font-size:12.5px}#focus-bar button{margin-left:8px;border:1px solid #d97706;background:#fff;border-radius:4px;cursor:pointer;padding:1px 8px}
.hull{fill-opacity:.06;stroke-width:1.5;stroke-dasharray:6 4}.hull[style*="opacity: 1"]{stroke:#374151;stroke-width:3;stroke-dasharray:none}.hull-label{font-size:13px;font-weight:600;fill:#374151}.agg-hull{fill:none;stroke:#9ca3af;stroke-width:1;stroke-dasharray:3 3;rx:10}
.node{cursor:pointer}.node rect,.node polygon,.node ellipse{stroke-width:1.5}.node text{font-size:12px;pointer-events:none}.node .sub{font-size:10px;fill:#6b7280}.node.dim{opacity:.15}.node.bad rect,.node.bad ellipse,.node.bad polygon{stroke:#dc2626;stroke-width:2.5}
.edge{fill:none;stroke-width:1.5}.edge.dim{opacity:.06}.edge-label{font-size:10px;fill:#374151;pointer-events:none;paint-order:stroke;stroke:#fff;stroke-width:3px}
</style></head><body>
<header><h1>模型 · ${esc(projectName)}</h1><div class="muted">${modules.length} 个模块 · ${els.length} 个模型文件 · 业务语句 ${business.length} 条 · 词汇 ${glossary.terms.length} 个${otherDir ? ` · ${baselineDir ? "与上一版比对（本段增量）：" : "与解码模型比对："}${findings.length ? `<b style="color:#fca5a5">${findings.length} 处差异</b>` : '<b style="color:#86efac">一致</b>'}` : ''}</div></header>
<nav><button data-v="graph" class="on">关系图</button><button data-v="cards">卡片</button><button data-v="cov">业务覆盖</button>${otherDir ? '<button data-v="diff">差异</button>' : ''}<span class="sp"></span><button id="lay-toggle" title="按聚合分块：一个聚合一块，根在上、成员在下；分层：按命令→服务→聚合→成员→端口分列">布局：按聚合分块</button><label id="nav-hint">拖拽节点移动 · 滚轮缩放 · 拖空白平移 · 点节点看详情 · 双击空白重排</label></nav>
<main>
<section id="view-graph" class="view on"><div id="graph-wrap"><div class="legend" id="legend"></div><div id="graph-area"><div id="focus-bar" style="display:none">只显示所选节点及其邻居 <button id="focus-clear">显示全部</button></div><svg id="graph"></svg><div id="panel"><button class="close" id="panel-close">关闭</button><div id="panel-body"></div></div></div></div></section>
<section id="view-cards" class="view">${otherDir ? `<p class="muted">${baselineDir ? "左边绿条 = 与上一版一致（本段没动）；红条 = 本段新增或改动，卡片底部列出「现在 ｜ 上一版」。" : "左边绿条 = 与代码一致；红条 = 有差异，卡片底部列出「模型 ｜ 代码」。"}</p>` : ''}${cardSections.join('')}</section>
<section id="view-cov" class="view"><h2>业务覆盖</h2><table class="cov"><tr><th>编号</th><th>业务语句</th><th>落点</th></tr>${coverage.join('')}</table></section>
${diffSection}
</main>
<script>
const G = ${JSON.stringify(graph)}
const NODE_STYLE = {
  'aggregate-root': { fill:'#dbeafe', stroke:'#1d4ed8', label:'聚合根', shape:'rect', w:130, h:40 },
  'entity':         { fill:'#eff6ff', stroke:'#3b82f6', label:'实体', shape:'rect', w:110, h:32 },
  'value-object':   { fill:'#f8fafc', stroke:'#64748b', label:'值对象', shape:'rect', w:110, h:32 },
  'event':          { fill:'#ffedd5', stroke:'#ea580c', label:'事件', shape:'ellipse', w:140, h:34 },
  'error':          { fill:'#fee2e2', stroke:'#dc2626', label:'错误', shape:'ellipse', w:130, h:28, off:true },
  'service':        { fill:'#dcfce7', stroke:'#16a34a', label:'领域服务', shape:'diamond', w:130, h:44 },
  'command-handler':{ fill:'#ede9fe', stroke:'#7c3aed', label:'命令', shape:'round', w:160, h:40 },
  'query-handler':  { fill:'#f5f3ff', stroke:'#8b5cf6', label:'查询', shape:'round', w:160, h:40 },
  'event-handler':  { fill:'#fdf4ff', stroke:'#c026d3', label:'事件处理', shape:'round', w:210, h:40 },
  'port':           { fill:'#fef9c3', stroke:'#ca8a04', label:'端口', shape:'para', w:150, h:36 },
  'module':         { fill:'#f3f4f6', stroke:'#374151', label:'其它模块', shape:'rect', w:110, h:34 },
}
const EDGE_STYLE = {
  call:       { stroke:'#7c3aed', label:'调用（行为 / 工厂 / 服务 / 端口 / 命令）', arrow:true },
  write:      { stroke:'#1d4ed8', label:'读写聚合（含写）', arrow:true },
  read:       { stroke:'#9ca3af', label:'只读聚合', arrow:true, dash:'4 3' },
  raise:      { stroke:'#ea580c', label:'发出事件', arrow:true },
  trigger:    { stroke:'#c026d3', label:'事件触发处理', arrow:true, dash:'6 3' },
  ref:        { stroke:'#0891b2', label:'按 id 引用另一个聚合', arrow:true, dash:'8 4' },
  module:     { stroke:'#374151', label:'端口指向模块', arrow:true, dash:'6 3' },
  coordinate: { stroke:'#16a34a', label:'领域服务协调', arrow:false, dash:'3 3', off:true },
  member:     { stroke:'#94a3b8', label:'聚合成员', arrow:false, dash:'2 3', off:true },
  throw:      { stroke:'#dc2626', label:'抛出错误', arrow:true, dash:'2 2', off:true },
}
const COL = { 'command-handler':0, 'query-handler':0, 'event-handler':0, service:1, 'aggregate-root':2, entity:3, 'value-object':3, event:4, error:4, port:5, module:6 }
const COL_GAP = 300, ROW_H = 84
let showLabels = false, focus = null
const on = { node: Object.fromEntries(Object.keys(NODE_STYLE).map(k => [k, !NODE_STYLE[k].off])), edge: Object.fromEntries(Object.keys(EDGE_STYLE).map(k => [k, !EDGE_STYLE[k].off])) }
const svg = document.getElementById('graph')
const NS = 'http://www.w3.org/2000/svg'
const el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e }
// 框宽跟着名字走：从前是死宽 110~160，ClassificationAmountForQuarter 这种长名字整截出框外（2026-09-17 项目所有者截图点名）
const textW = s => { let w = 0; for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? 13 : 7.3; return w }
const fitW = n => { const s = NODE_STYLE[n.kind] || NODE_STYLE.module, pad = s.shape === 'ellipse' || s.shape === 'diamond' ? 44 : 22; return Math.max(s.w, Math.ceil(textW(n.label) + pad), n.sub ? Math.ceil(textW(n.sub) + pad) : 0) }
const nodes = G.nodes.map(n => ({ ...n, w: fitW(n), h: (NODE_STYLE[n.kind] || NODE_STYLE.module).h }))
for (const n of nodes) if (n.kind === 'module') n.proxy = nodes.some(m => m.module === n.module && m.kind !== 'module')
const byId = new Map(nodes.map(n => [n.id, n]))
const edges = G.edges.filter(e => byId.has(e.from) && byId.has(e.to))
const adj = new Map(nodes.map(n => [n.id, new Set()]))
for (const e of edges) { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from) }

// ---- 可见性 ----
function visibleNode(n) { return on.node[n.kind] !== false && !n.proxy && (!focus || n.id === focus || adj.get(focus).has(n.id)) }
function visibleEdge(e) {
  const a = byId.get(e.from), b = byId.get(e.to)
  if (!on.edge[e.kind] || !visibleNode(a) || !(visibleNode(b) || (b.proxy && b.hull))) return false
  return !focus || e.from === focus || e.to === focus
}

// ---- 按聚合分块（缺省）：一个聚合一块——根在上、成员在下排成网格；块在模块里一行行铺开 ----
// 由来：2026-09-17 项目所有者「模型图的 UI 改进一下，这样子我比较难去看」——分层布局把二十几个值对象摞成一长条，
// 名字截在框外、横向一大片空白，看不出谁属于哪个聚合。分层那一版留着，右上角可以切回去。
let LAYOUT = 'agg'
function layoutAgg() {
  W = svg.clientWidth || 1400; H = svg.clientHeight || 800
  const live = nodes.filter(n => !n.proxy && visibleNode(n))
  const mods = [...new Set([...G.modules, ...live.map(n => n.module)])].filter(m => live.some(n => n.module === m))
  const GAPX = 18, GAPY = 12, PAD = 14, BLOCK_GAP = 30, MOD_GAP = 66
  const maxRowW = Math.max(900, Math.min(2200, W / 0.75))
  let y0 = 46
  for (const m of mods) {
    const ns = live.filter(n => n.module === m)
    const roots = ns.filter(n => n.kind === 'aggregate-root')
    const blocks = []
    const taken = new Set()
    for (const r of roots) {
      const mem = ns.filter(n => n !== r && n.agg === r.label && ['entity', 'value-object', 'error', 'event'].includes(n.kind))
      mem.forEach(n => taken.add(n)); taken.add(r)
      blocks.push({ head: r, members: mem })
    }
    const rest = ns.filter(n => !taken.has(n))
    if (rest.length) blocks.push({ head: null, members: rest })
    // 每一块自己算多大：成员排成一到三列的网格，列宽取那一列里最宽的
    for (const b of blocks) {
      const k = b.members.length
      b.cols = k > 8 ? 3 : k > 3 ? 2 : 1
      const colW = []
      for (let c = 0; c < b.cols; c++) { let w = 0; for (let i = c; i < k; i += b.cols) w = Math.max(w, b.members[i].w); colW[c] = w }
      b.colW = colW
      b.rowH = Math.max(30, ...b.members.map(n => n.h), 0)
      const rows = Math.ceil(k / b.cols) || 0
      const innerW = colW.reduce((a, x) => a + x, 0) + GAPX * Math.max(0, b.cols - 1)
      b.w = Math.max(innerW, b.head ? b.head.w : 0) + PAD * 2
      b.h = (b.head ? b.head.h + GAPY : 0) + (rows ? rows * b.rowH + (rows - 1) * GAPY : 0) + PAD * 2 + 10
    }
    // 块在模块里一行行铺开，排满就换行
    let x = 40, rowTop = y0 + 26, rowH = 0
    for (const b of blocks) {
      if (x > 40 && x + b.w > maxRowW) { x = 40; rowTop += rowH + BLOCK_GAP; rowH = 0 }
      b.x = x; b.y = rowTop; rowH = Math.max(rowH, b.h); x += b.w + BLOCK_GAP
    }
    // 落位
    for (const b of blocks) {
      const headH = b.head ? b.head.h + GAPY : 0
      if (b.head) { b.head.x = b.x + b.w / 2; b.head.y = b.y + PAD + b.head.h / 2 }
      b.members.forEach((n, i) => {
        const c = i % b.cols, r = Math.floor(i / b.cols)
        let ox = b.x + PAD
        for (let j = 0; j < c; j++) ox += b.colW[j] + GAPX
        n.x = ox + b.colW[c] / 2
        n.y = b.y + PAD + headH + r * (b.rowH + GAPY) + b.rowH / 2
      })
    }
    y0 = rowTop + rowH + MOD_GAP
  }
  fit()
}
// ---- 分层布局：列固定；列内按邻居平均位置排序；拉开行距 ----
let W = 1400, H = 800
function layout() {
  if (LAYOUT === 'agg') return layoutAgg()
  return layoutLayered()
}
function layoutLayered() {
  W = svg.clientWidth || 1400; H = svg.clientHeight || 800
  const live = nodes.filter(n => !n.proxy)
  const mods = [...new Set([...G.modules, ...live.map(n => n.module)])]
  const colX = c => 140 + c * COL_GAP
  // 每个模块的高度 = 最挤的那一列的节点数 × 行高
  const countIn = (m, c) => live.filter(n => n.module === m && COL[n.kind] === c).length
  const rows = m => Math.max(2, ...[0, 1, 2, 3, 4, 5].map(c => countIn(m, c)))
  let y0 = 30
  const band = new Map()
  for (const m of mods) { const h = rows(m) * ROW_H + 30; band.set(m, { top: y0, bottom: y0 + h }); y0 += h + 60 }
  for (const n of live) { n.x = colX(COL[n.kind]); const b = band.get(n.module); n.y = (b.top + b.bottom) / 2 }
  // 初始次序：同聚合的成员靠在一起，其余按名字
  const columns = new Map()
  for (const n of live) { const k = n.module + '|' + COL[n.kind]; if (!columns.has(k)) columns.set(k, []); columns.get(k).push(n) }
  for (const g of columns.values()) g.sort((a, b) => (a.agg || '').localeCompare(b.agg || '') || a.label.localeCompare(b.label))
  const place = g => { // 按当前次序在带内均匀铺开
    const b = band.get(g[0].module), h = b.bottom - b.top, step = Math.min(ROW_H, h / (g.length + 0.2))
    const start = (b.top + b.bottom) / 2 - step * (g.length - 1) / 2
    g.forEach((n, i) => { if (!n.fixed) n.y = start + i * step })
  }
  for (const g of columns.values()) place(g)
  // 重心排序：来回扫几遍，每个节点取邻居 y 的平均，然后按它排序
  const neighborsY = n => { const ys = []; for (const id of adj.get(n.id)) { const m = byId.get(id); if (m && !m.proxy && visibleNode(m)) ys.push(m.y) } return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null }
  for (let sweep = 0; sweep < 6; sweep++) {
    const order = [...columns.entries()].sort((a, b) => (sweep % 2 ? -1 : 1) * (Number(a[0].split('|')[1]) - Number(b[0].split('|')[1])))
    for (const [, g] of order) {
      for (const n of g) { const y = neighborsY(n); n.bary = y == null ? n.y : y }
      // 同聚合的成员用根的重心，保证成员贴着根
      for (const n of g) if (['entity', 'value-object'].includes(n.kind) && n.agg) { const root = live.find(r => r.kind === 'aggregate-root' && r.module === n.module && r.label === n.agg); if (root) n.bary = root.y + 0.01 * (n.label.charCodeAt(0)) }
      g.sort((a, b) => a.bary - b.bary)
      place(g)
    }
  }
  fit()
}
function fit() {
  const b = bbox(nodes.filter(visibleNode), 40)
  let k = Math.min(1.1, (W - 20) / b.w, (H - 20) / b.h)
  if (k < 0.65) k = 0.65 // 太小就不再缩，交给平移
  view = { k, x: Math.max(10, (W - b.w * k) / 2) - b.x * k, y: Math.max(10, (H - b.h * k) / 2) - b.y * k }
}

// ---- 绘制 ----
let view = { x: 0, y: 0, k: 1 }
let gRoot, gHull, gEdge, gNode
function shapeOf(n) {
  const s = NODE_STYLE[n.kind] || NODE_STYLE.module, w = n.w, h = n.h
  const a = { fill: s.fill, stroke: s.stroke }
  if (s.shape === 'ellipse') return el('ellipse', { ...a, rx: w / 2, ry: h / 2 })
  if (s.shape === 'diamond') return el('polygon', { ...a, points: [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]].map(p => p.join(',')).join(' ') })
  if (s.shape === 'para') return el('polygon', { ...a, points: [[-w / 2 + 8, -h / 2], [w / 2, -h / 2], [w / 2 - 8, h / 2], [-w / 2, h / 2]].map(p => p.join(',')).join(' ') })
  return el('rect', { ...a, x: -w / 2, y: -h / 2, width: w, height: h, rx: s.shape === 'round' ? h / 2 : 4 })
}
// 边：水平出入的 S 形曲线。向右走：源右侧 → 目标左侧；向左走：源左侧 → 目标右侧；同列：从右侧绕出去再回来
function edgePath(e) {
  const a = byId.get(e.from), b = byId.get(e.to)
  let x1, y1, x2, y2, c1x, c2x
  if (b.hull) { // 目标是模块框：连到框的最近边
    x1 = a.x; y1 = a.y + (b.y > a.y ? a.h / 2 : -a.h / 2)
    x2 = Math.max(b.x - b.w / 2 + 20, Math.min(b.x + b.w / 2 - 20, a.x)); y2 = b.y > a.y ? b.y - b.h / 2 - 4 : b.y + b.h / 2 + 4
    return { d: 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + y2) / 2 + ' ' + x2 + ',' + (y1 + y2) / 2 + ' ' + x2 + ',' + y2, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 }
  }
  const dx = b.x - a.x
  if (Math.abs(dx) < 40) { // 同列
    x1 = a.x + a.w / 2; y1 = a.y; x2 = b.x + b.w / 2; y2 = b.y
    const bulge = 60 + Math.abs(y2 - y1) * 0.2
    return { d: 'M' + x1 + ',' + y1 + ' C' + (x1 + bulge) + ',' + y1 + ' ' + (x2 + bulge) + ',' + y2 + ' ' + (x2 + 4) + ',' + y2, lx: x1 + bulge * 0.75, ly: (y1 + y2) / 2 }
  }
  const dir = dx > 0 ? 1 : -1
  x1 = a.x + dir * a.w / 2; y1 = a.y; x2 = b.x - dir * (b.w / 2 + 4); y2 = b.y
  const span = Math.abs(x2 - x1)
  c1x = x1 + dir * span * 0.45; c2x = x2 - dir * span * 0.45
  return { d: 'M' + x1 + ',' + y1 + ' C' + c1x + ',' + y1 + ' ' + c2x + ',' + y2 + ' ' + x2 + ',' + y2, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 4 }
}
function draw() {
  svg.innerHTML = ''
  const defs = el('defs')
  for (const k in EDGE_STYLE) {
    const m = el('marker', { id: 'arr-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
    m.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: EDGE_STYLE[k].stroke })); defs.appendChild(m)
  }
  svg.appendChild(defs)
  gRoot = el('g'); svg.appendChild(gRoot)
  gHull = el('g'); gEdge = el('g'); gNode = el('g'); gRoot.append(gHull, gEdge, gNode)
  for (const e of edges) {
    const s = EDGE_STYLE[e.kind]
    const p = el('path', { class: 'edge', stroke: s.stroke })
    if (s.dash) p.setAttribute('stroke-dasharray', s.dash)
    if (s.arrow) p.setAttribute('marker-end', 'url(#arr-' + e.kind + ')')
    const title = el('title'); title.textContent = byId.get(e.from).label + ' → ' + byId.get(e.to).label + (e.label ? '：' + e.label : ''); p.appendChild(title)
    e.el = p; gEdge.appendChild(p)
    if (e.label) { const t = el('text', { class: 'edge-label', 'text-anchor': 'middle' }); t.textContent = e.label; e.tl = t; gEdge.appendChild(t) }
  }
  for (const n of nodes) {
    const g = el('g', { class: 'node' + (n.bad ? ' bad' : ''), 'data-id': n.id })
    g.appendChild(shapeOf(n))
    const t = el('text', { 'text-anchor': 'middle', y: n.sub ? -1 : 4 }); t.textContent = n.label; g.appendChild(t)
    if (n.sub) { const t2 = el('text', { class: 'sub', 'text-anchor': 'middle', y: 12 }); t2.textContent = n.sub; g.appendChild(t2) }
    const title = el('title'); title.textContent = (NODE_STYLE[n.kind] || {}).label + ' ' + n.label + (n.bad ? '（与${other}有差异）' : ''); g.appendChild(title)
    n.el = g; gNode.appendChild(g)
    g.addEventListener('mouseenter', () => highlight(n)); g.addEventListener('mouseleave', () => highlight(null))
    g.addEventListener('mousedown', ev => startDrag(n, ev)); g.addEventListener('click', () => { if (!n.moved) openPanel(n) })
  }
  position()
}
function position() {
  gHull.innerHTML = ''
  const mods = [...new Set(nodes.map(n => n.module))]
  for (const m of mods) {
    const ns = nodes.filter(n => n.module === m && visibleNode(n))
    if (!ns.length) continue
    const box = bbox(ns, 26)
    for (const p of nodes) if (p.proxy && p.module === m) { p.hull = true; p.x = box.x + box.w / 2; p.y = box.y + box.h / 2; p.w = box.w; p.h = box.h }
    gHull.appendChild(el('rect', { class: 'hull', 'data-m': m, x: box.x, y: box.y, width: box.w, height: box.h, rx: 14, fill: '#111827', stroke: '#9ca3af' }))
    const t = el('text', { class: 'hull-label', x: box.x + 12, y: box.y + 18 }); t.textContent = '模块 ' + m; gHull.appendChild(t)
    for (const a of [...new Set(ns.map(n => n.agg).filter(Boolean))]) {
      const an = ns.filter(n => n.agg === a && ['aggregate-root', 'entity', 'value-object'].includes(n.kind))
      if (an.length < 2) continue
      const b = bbox(an, 12)
      gHull.appendChild(el('rect', { class: 'agg-hull', x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }))
    }
  }
  for (const n of nodes) { n.el.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')'); n.el.style.display = visibleNode(n) ? '' : 'none' }
  for (const e of edges) {
    const vis = visibleEdge(e)
    e.el.style.display = vis ? '' : 'none'; if (e.tl) e.tl.style.display = vis && showLabels ? '' : 'none'
    if (!vis) continue
    const p = edgePath(e); e.el.setAttribute('d', p.d)
    if (e.tl) { e.tl.setAttribute('x', p.lx); e.tl.setAttribute('y', p.ly) }
  }
  gRoot.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')')
  document.getElementById('focus-bar').style.display = focus ? '' : 'none'
}
function bbox(ns, pad) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const n of ns) { x1 = Math.min(x1, n.x - n.w / 2); y1 = Math.min(y1, n.y - n.h / 2); x2 = Math.max(x2, n.x + n.w / 2); y2 = Math.max(y2, n.y + n.h / 2) }
  if (!ns.length) return { x: 0, y: 0, w: 10, h: 10 }
  return { x: x1 - pad, y: y1 - pad - (pad > 15 ? 8 : 0), w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 + (pad > 15 ? 8 : 0) }
}
function highlight(n) {
  for (const m of nodes) m.el.classList.toggle('dim', !!n && m !== n && !adj.get(n.id).has(m.id))
  for (const h of gHull.querySelectorAll('.hull')) h.style.opacity = n && n.kind === 'port' && adj.get(n.id).has('mod:' + h.dataset.m) ? '1' : ''
  for (const e of edges) {
    const near = !!n && (e.from === n.id || e.to === n.id)
    e.el.classList.toggle('dim', !!n && !near)
    if (e.tl && visibleEdge(e)) e.tl.style.display = near || showLabels ? '' : 'none'
  }
}
// ---- 交互 ----
let drag = null
function startDrag(n, ev) { ev.stopPropagation(); n.moved = false; drag = { n, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y } }
svg.addEventListener('mousedown', ev => { drag = { pan: true, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y }; svg.classList.add('drag') })
window.addEventListener('mousemove', ev => {
  if (!drag) return
  const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy
  if (drag.pan) { view.x = drag.ox + dx; view.y = drag.oy + dy }
  else { drag.n.x = drag.ox + dx / view.k; drag.n.y = drag.oy + dy / view.k; drag.n.fixed = true; if (Math.abs(dx) + Math.abs(dy) > 3) drag.n.moved = true }
  position()
})
window.addEventListener('mouseup', () => { drag = null; svg.classList.remove('drag') })
svg.addEventListener('wheel', ev => {
  ev.preventDefault()
  const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top
  const k = Math.max(0.3, Math.min(3, view.k * (ev.deltaY < 0 ? 1.1 : 0.9)))
  view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k; position()
}, { passive: false })
function relayout() { for (const n of nodes) n.fixed = false; layout(); position() }
document.getElementById('lay-toggle').addEventListener('click', () => {
  LAYOUT = LAYOUT === 'agg' ? 'layered' : 'agg'
  document.getElementById('lay-toggle').textContent = LAYOUT === 'agg' ? '布局：按聚合分块' : '布局：分层'
  relayout()
})
svg.addEventListener('dblclick', ev => { if (ev.target === svg || ev.target.classList.contains('hull')) relayout() })
// ---- 详情面板与聚焦 ----
const panel = document.getElementById('panel'), panelBody = document.getElementById('panel-body')
function openPanel(n) {
  const card = document.getElementById(n.id)
  panelBody.innerHTML = '<button class="focus-btn" id="focus-btn">只看它的关系</button>' + (card ? card.outerHTML : '<p class="muted">' + n.label + '</p>')
  const c = panelBody.querySelector('.card'); if (c) c.removeAttribute('id')
  document.getElementById('focus-btn').addEventListener('click', () => { focus = n.id; relayout(); panel.classList.remove('on') })
  panel.classList.add('on')
}
document.getElementById('panel-close').addEventListener('click', () => panel.classList.remove('on'))
document.getElementById('focus-clear').addEventListener('click', () => { focus = null; relayout() })
// ---- 图例 ----
const legend = document.getElementById('legend')
function buildLegend() {
  let h = '<b>节点</b>'
  for (const k in NODE_STYLE) if (nodes.some(n => n.kind === k && !n.proxy)) h += '<div><label><input type="checkbox" data-t="node" data-k="' + k + '"' + (on.node[k] ? ' checked' : '') + '><span class="nd" style="background:' + NODE_STYLE[k].fill + ';border-color:' + NODE_STYLE[k].stroke + '"></span>' + NODE_STYLE[k].label + '</label></div>'
  h += '<b>边</b>'
  for (const k in EDGE_STYLE) if (edges.some(e => e.kind === k)) h += '<div><label><input type="checkbox" data-t="edge" data-k="' + k + '"' + (on.edge[k] ? ' checked' : '') + '><span class="sw" style="border-color:' + EDGE_STYLE[k].stroke + ';border-top-style:' + (EDGE_STYLE[k].dash ? 'dashed' : 'solid') + '"></span>' + EDGE_STYLE[k].label + '</label></div>'
  h += '<b>显示</b><div><label><input type="checkbox" id="lbl-toggle"' + (showLabels ? ' checked' : '') + '>全部边标签</label></div>'
  h += '<div class="hint">虚线框 = 模块；点框 = 聚合' + (${JSON.stringify(!!otherDir)} ? '；红边框 = 与${other}有差异' : '') + '。悬停看相邻，点节点看详情，详情里可只看它的关系。</div>'
  legend.innerHTML = h
  legend.querySelectorAll('input[data-t]').forEach(i => i.addEventListener('change', () => { on[i.dataset.t][i.dataset.k] = i.checked; relayout() }))
  document.getElementById('lbl-toggle').addEventListener('change', ev => { showLabels = ev.target.checked; position() })
}
// ---- 视图切换 ----
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b))
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.v))
  document.getElementById('nav-hint').style.visibility = b.dataset.v === 'graph' ? '' : 'hidden'
  if (b.dataset.v === 'graph') relayout()
}))
document.querySelectorAll('a.jump, #view-cards a').forEach(a => a.addEventListener('click', ev => {
  const id = decodeURIComponent(a.getAttribute('href').slice(1)); const t = document.getElementById(id); if (!t) return
  ev.preventDefault(); document.querySelector('nav button[data-v="cards"]').click(); t.scrollIntoView({ block: 'center' }); t.style.outline = '2px solid #f59e0b'; setTimeout(() => t.style.outline = '', 1600)
}))
draw(); buildLegend(); relayout()
window.addEventListener('resize', () => position())
</script>
</body></html>`
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html)
console.log(`已写出 ${path.relative(process.cwd(), out)}（${modules.length} 个模块，${nodes.length} 个节点，${merged.length} 条边${otherDir ? `，${findings.length} 处差异` : ''}）`)
