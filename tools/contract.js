#!/usr/bin/env node
/**
 * 契约。实现切片开始前，接口角色把生产外壳的接口钉死：每个命令 / 查询一份 HTTP 契约、每个聚合一份表结构、
 * 每个模块一份错误 → 状态码，写在 contracts/（形状见 schema/contract.schema.json）。人确认后编码角色才动手。
 *
 * 两级标记（写在任何字段的值上）：
 *   （没问过）    还没问人——确认前必须清零
 *   （故意推迟）  人说以后再定——可以确认，编码角色不得实现这一项
 *
 * 用法：
 *   node tools/contract.js scaffold <项目目录> <切片id>          给范围内缺的契约建骨架：字段名从模型 input / fields 抄过来，其余标（没问过）
 *   node tools/contract.js check    <项目目录> <切片id> [--json]  缺哪些、哪些没问过、哪些没确认、字段名与模型对不上的
 *   node tools/contract.js confirm  <项目目录> <切片id>          人确认范围内的契约（没问过的清零才行）
 * 退出码：check 0 = 可以进编码；1 = 还有事没做；2 用法错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const { loadProject, walk, readJson, walkNames, conditionText } = require('./lib/project')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const sliceId = args[2] && !args[2].startsWith('--') ? args[2] : undefined
const today = new Date().toISOString().slice(0, 10)
function die(msg) { console.error(msg); process.exit(2) }
function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n') }
if (!['scaffold', 'check', 'confirm'].includes(cmd) || !root || !fs.existsSync(path.join(root, 'project.json')) || !sliceId) die('用法：node tools/contract.js <scaffold|check|confirm> <项目目录> <切片id> [--json]')
const slicePath = path.join(root, 'slices', `${sliceId}.json`)
if (!fs.existsSync(slicePath)) die(`切片不存在：${path.relative(process.cwd(), slicePath)}`)
const slice = readJson(slicePath)
const dir = path.join(root, 'contracts')
const UNASKED = '（没问过）', DEFERRED = '（故意推迟）'

// ---------- 范围 ----------
const { model } = loadProject(root)
const els = model.elements.filter((e) => e.kind !== 'invalid')
const byQ = (kind, q) => { const [m, n] = q.includes('.') ? q.split('.') : [null, q]; return els.find((e) => e.kind === kind && e.data.name === n && (!m || e.module === m)) ?? null }
const storyP = path.join(root, 'slices', `${sliceId}.story.json`)
const story = fs.existsSync(storyP) ? readJson(storyP) : null
const ucSet = new Set(), aggSet = new Set()
if (story) for (const s of story.steps) { const w = s.walk; if (!w || w.kind === 'none') continue; for (const n of walkNames(w.name)) if (n.includes('.')) ucSet.add(n); if (w.aggregate) aggSet.add(w.aggregate) }
for (const u of slice.scope.useCases ?? []) { const el = byQ('command-handler', u) ?? byQ('query-handler', u); if (el) ucSet.add(`${el.module}.${el.data.name}`) }
for (const a of slice.scope.aggregates ?? []) { const el = byQ('aggregate-root', a); if (el) aggSet.add(`${el.module}.${el.data.name}`) }
if (!ucSet.size && !aggSet.size) for (const m of slice.scope.modules ?? []) for (const el of els.filter((e) => e.module === m)) { if (['command-handler', 'query-handler'].includes(el.kind)) ucSet.add(`${m}.${el.data.name}`); if (el.kind === 'aggregate-root') aggSet.add(`${m}.${el.data.name}`) }
const useCases = [...ucSet].map((u) => byQ('command-handler', u) ?? byQ('query-handler', u)).filter(Boolean) // 事件处理没有 HTTP 入口
const aggregates = [...aggSet].map((a) => byQ('aggregate-root', a)).filter(Boolean)
const modules = [...new Set([...useCases, ...aggregates].map((e) => e.module))].sort()
if (!useCases.length && !aggregates.length) die('切片范围为空：契约无从谈起')

// ---------- 已有契约 ----------
function loadContracts() {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const f of walk(dir).filter((p) => p.endsWith('.json'))) { try { out.push({ file: path.relative(root, f).replaceAll('\\', '/'), abs: f, data: readJson(f) }) } catch { out.push({ file: path.relative(root, f), abs: f, data: null, broken: true }) } }
  return out
}
function markers(obj, found = { unasked: 0, deferred: 0 }) {
  if (typeof obj === 'string') { if (obj === UNASKED) found.unasked++; else if (obj === DEFERRED) found.deferred++ }
  else if (Array.isArray(obj)) for (const x of obj) markers(x, found)
  else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) markers(v, found)
  return found
}
const httpFile = (el) => `contracts/http.${el.data.name}.json`
const tableFile = (el) => `contracts/table.${el.data.name}.json`
const errorsFile = (m) => `contracts/errors.${m}.json`
const wireType = (t) => ({ string: 'string', number: 'number', boolean: 'boolean', date: 'string (ISO 日期)' })[t] ?? UNASKED

// ========== scaffold ==========
if (cmd === 'scaffold') {
  let made = 0
  for (const el of useCases) {
    const p = path.join(root, httpFile(el))
    if (fs.existsSync(p)) continue
    const isQuery = el.kind === 'query-handler'
    writeJson(p, {
      kind: 'http', useCase: `${el.module}.${el.data.name}`, method: isQuery ? 'GET' : UNASKED, path: UNASKED,
      request: (el.data.input ?? []).map((x) => ({ name: x.name, type: wireType(x.type), in: UNASKED })),
      response: { status: isQuery ? 200 : UNASKED, fields: isQuery ? (el.data.result ?? []).map((x) => ({ name: x.name, type: wireType(x.type) })) : [] },
      confirmedAt: null, note: '',
    })
    made++
  }
  for (const el of aggregates) {
    const p = path.join(root, tableFile(el))
    if (fs.existsSync(p)) continue
    writeJson(p, {
      kind: 'table', aggregate: `${el.module}.${el.data.name}`, orm: UNASKED, table: UNASKED,
      columns: [{ field: 'id', column: UNASKED, type: UNASKED }, { field: 'version', column: UNASKED, type: UNASKED, note: '乐观锁' }, ...el.data.fields.map((f) => ({ field: f.name, column: UNASKED, type: UNASKED, ...(f.nullable ? { nullable: true } : {}) }))],
      confirmedAt: null, note: '',
    })
    made++
  }
  for (const m of modules) {
    const p = path.join(root, errorsFile(m))
    if (fs.existsSync(p)) continue
    const errs = els.filter((e) => e.kind === 'error' && e.module === m)
    writeJson(p, { kind: 'error-status', module: m, map: errs.map((e) => ({ error: e.data.name, status: UNASKED, note: conditionText(e.data.condition) })), technical: { NotFoundError: 404, ConcurrencyError: 409, ValidationError: 400 }, confirmedAt: null, note: '' })
    made++
  }
  console.log(`契约骨架 ${made} 份（范围：用例 ${useCases.length}，聚合 ${aggregates.length}，模块 ${modules.length}）；字段名已从模型抄入，标「（没问过）」的逐项问人`)
}

// ========== check ==========
function runCheck() {
  const contracts = loadContracts()
  const byFile = new Map(contracts.map((c) => [c.file, c]))
  const missing = [], unasked = [], deferred = [], unconfirmed = [], mismatches = []
  const look = (file, label, fn) => {
    const c = byFile.get(file)
    if (!c || c.broken || !c.data) return missing.push(`${label} → ${file}`)
    const m = markers(c.data)
    if (m.unasked) unasked.push(`${file}：${m.unasked} 处`)
    if (m.deferred) deferred.push(`${file}：${m.deferred} 处`)
    if (!c.data.confirmedAt) unconfirmed.push(file)
    fn(c.data)
  }
  for (const el of useCases) look(httpFile(el), `${el.kind === 'query-handler' ? '查询' : '命令'} ${el.data.name} 的 HTTP 契约`, (d) => {
    const modelNames = new Set((el.data.input ?? []).map((x) => x.name))
    const wireNames = new Set((d.request ?? []).filter((x) => x.in !== 'auth').map((x) => x.name))
    for (const n of modelNames) if (!wireNames.has(n)) mismatches.push(`${httpFile(el)}：模型 input 有 ${n}，契约 request 没有`)
    for (const n of wireNames) if (!modelNames.has(n)) mismatches.push(`${httpFile(el)}：契约 request 有 ${n}，模型 input 没有（字段名不许重新发明；登录态的字段 in 写 auth）`)
    if (el.kind === 'query-handler') { const rn = new Set((el.data.result ?? []).map((x) => x.name)); for (const f of d.response?.fields ?? []) if (!rn.has(f.name)) mismatches.push(`${httpFile(el)}：响应字段 ${f.name} 不在模型 result 里`); for (const n of rn) if (!(d.response?.fields ?? []).some((f) => f.name === n)) mismatches.push(`${httpFile(el)}：模型 result 有 ${n}，响应没有`) }
  })
  for (const el of aggregates) look(tableFile(el), `聚合 ${el.data.name} 的表结构`, (d) => {
    const cols = new Set((d.columns ?? []).map((c) => c.field))
    for (const f of ['id', 'version', ...el.data.fields.map((x) => x.name)]) if (!cols.has(f)) mismatches.push(`${tableFile(el)}：字段 ${f} 没有列`)
  })
  for (const m of modules) look(errorsFile(m), `模块 ${m} 的错误 → 状态码`, (d) => {
    const mapped = new Set((d.map ?? []).map((x) => x.error))
    for (const e of els.filter((x) => x.kind === 'error' && x.module === m)) if (!mapped.has(e.data.name)) mismatches.push(`${errorsFile(m)}：错误 ${e.data.name} 没有状态码`)
  })
  return { slice: sliceId, scope: { useCases: useCases.map((e) => `${e.module}.${e.data.name}`), aggregates: aggregates.map((e) => `${e.module}.${e.data.name}`), modules }, missing, unasked, deferred, unconfirmed, mismatches, ok: !missing.length && !unasked.length && !unconfirmed.length && !mismatches.length }
}
if (cmd === 'check') {
  const r = runCheck()
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`契约核对 ${sliceId}：用例 ${r.scope.useCases.length}，聚合 ${r.scope.aggregates.length}，模块 ${r.scope.modules.length} → ${r.ok ? '齐了，可以进编码' : '还有事没做'}`)
    for (const x of r.missing) console.log(`  缺：${x}`)
    for (const x of r.mismatches) console.log(`  对不上：${x}`)
    for (const x of r.unasked) console.log(`  没问过：${x}`)
    for (const x of r.deferred) console.log(`  故意推迟：${x}（可以确认；编码不实现这一项）`)
    for (const x of r.unconfirmed) console.log(`  未确认：${x}`)
  }
  process.exit(r.ok ? 0 : 1)
}

// ========== confirm ==========
if (cmd === 'confirm') {
  const r = runCheck()
  if (r.missing.length || r.unasked.length || r.mismatches.length) { console.error(`不能确认：缺 ${r.missing.length}、没问过 ${r.unasked.length}、对不上 ${r.mismatches.length}——先 contract check 看清单`); process.exit(1) }
  const files = [...useCases.map(httpFile), ...aggregates.map(tableFile), ...modules.map(errorsFile)]
  let n = 0
  for (const f of files) { const p = path.join(root, f); const d = readJson(p); if (!d.confirmedAt) { d.confirmedAt = today; writeJson(p, d); n++ } }
  const s = readJson(slicePath)
  s.log.push({ ts: today, stage: 'contracts', text: `人确认契约 ${n} 份（共 ${files.length}）${r.deferred.length ? `；故意推迟 ${r.deferred.length} 处，编码不实现` : ''}` })
  writeJson(slicePath, s)
  console.log(`已确认 ${n} 份契约（共 ${files.length}）。${r.deferred.length ? `故意推迟 ${r.deferred.length} 处，编码角色不得实现。` : ''}下一步：编码计划（plan build）`)
}
