#!/usr/bin/env node
/**
 * 比对设计模型与解码模型（方向 ②）。
 * 用法：node tools/diff-model.js <model 目录> <model-decoded/<版本> 目录> [--json <输出文件>]
 * 退出码：0 无差异；1 有差异。
 *
 * 规则：
 * - 忽略 questions / decisions / denylist / writesNote / system（设计侧独有）
 * - 集合型数组（traces、throws、writes、reads、coordinates、members、raises、changes）无序比较
 * - 命名型数组（fields、behaviors、methods、operations、input、result、payload、aggregates、modules、invariants、aggregateInvariants、idRefs、steps）按 name/text/顺序匹配
 * - 规则、作用（purpose）只比那句话：编号是模型自己用来挑语句的，代码注释里不写
 * - 模型可写可不写的几样（创建 create、作用 purpose、行为的做法 steps、步骤上的 changes 与 raises）：模型写了就比；
 *   模型没写、代码读得出来不算差异（老模型没有这几样照样认，agents/model/shapes.md）。模型写了、代码没有照报
 * - 跨模块的类型：模型写「模块.类型」；代码里模块之间不许 import，只能用本模块另写的一份。那一份标了 @ref 的解码出来就是
 *   「模块.类型」；没标的，同名（Fund ↔ Funding.Fund）或「模块名+类型名」（CatalogueService ↔ Catalogue.Service）算一致，别的名字照报
 */
const fs = require('node:fs')
const path = require('node:path')

const [modelDir, decodedDir] = process.argv.slice(2).map((p) => p && path.resolve(p))
const jsonIdx = process.argv.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null
if (!modelDir || !decodedDir) {
  console.error('用法：node tools/diff-model.js <model 目录> <解码目录> [--json <输出文件>]')
  process.exit(2)
}

const IGNORE = new Set(['questions', 'decisions', 'denylist', 'writesNote', 'system', 'groups', 'relations', 'carries'])
// 步骤上的 traces 是模型自己用来挑步骤的，代码注释里不写它，不算差异
const DESIGN_ONLY_IN_STEPS = new Set(['input', 'traces'])
const SET_KEYS = new Set(['traces', 'throws', 'writes', 'reads', 'coordinates', 'members', 'raises', 'changes'])
// 模型可写可不写、写了才比的几样：键 → 这个键出现在什么路径底下才算（null：哪里都算）
const OPTIONAL_IN_MODEL = [
  { key: 'create', at: null },
  { key: 'purpose', at: null },
  { key: 'steps', at: /\/(behaviors\/[^/]+|create)$/ }, // 行为与创建的做法；处理器、领域服务操作的步骤照旧必比
  { key: 'changes', at: /\/steps\/\d+$/ },
  { key: 'raises', at: /\/steps\/\d+$/ },
]
function optionalInModel(k, p) {
  return OPTIONAL_IN_MODEL.some((o) => o.key === k && (!o.at || o.at.test(p)))
}
// 装类型名的那几栏：字段与入参的 type、方法与操作的 output（步骤上的 output 是变量名，不算）、事件处理器的 trigger
function isTypeSlot(p) {
  return /\/(type|trigger)$/.test(p) || (/\/output$/.test(p) && !/\/steps\/\d+\/output$/.test(p))
}
/** 模型「模块.类型」与代码本模块里那一份同名、或「模块名+类型名」的别名算一致；数组的 [] 两边要一样 */
function sameCrossModuleType(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const m = a.match(/^([A-Z][A-Za-z0-9]*)\.([A-Za-z0-9]+)((?:\[\])*)$/)
  if (!m) return false
  const [, mod, name, arr] = m
  return b === name + arr || b === mod + name + arr
}
const KEYED = { fields: 'name', behaviors: 'name', methods: 'name', operations: 'name', input: 'name', result: 'name', payload: 'name', aggregates: 'name', modules: 'name', invariants: 'text', aggregateInvariants: 'text', idRefs: 'field' }

function walk(dir, out = [], base = dir) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, base)
    else if (e.name.endsWith('.json') && !e.name.startsWith('_')) out.push(path.relative(base, p).replaceAll('\\', '/'))
  }
  return out
}
function load(dir, relPath) {
  return JSON.parse(fs.readFileSync(path.join(dir, relPath), 'utf8'))
}
function raiseKey(r) {
  return typeof r === 'string' ? r : `${r.event}|${r.when}`
}

const findings = [] // { file, path, kind: missing-file|extra-file|missing|extra|changed, model, code }
function diff(a, b, file, p) {
  // 规则带了编号的（模型里写成 { text, traces }），跟代码比的时候只比那句话：
  // 编号是模型自己用来挑规则的，代码注释里不写它，不算差异
  // 条件写成数组、或某一句标了编号的，跟代码比的时候只比那句话
  if (p.endsWith(String.fromCharCode(47) + 'condition')) {
    const flat = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.text : x)).join('；') : v)
    a = flat(a); b = flat(b)
  }
  if (p.endsWith(String.fromCharCode(47) + 'rules')) {
    if (Array.isArray(a)) a = a.map((x) => (x && typeof x === 'object' ? x.text : x))
    if (Array.isArray(b)) b = b.map((x) => (x && typeof x === 'object' ? x.text : x))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = p.split('/').pop()
    if (key === 'raises') {
      // 同一个事件先按 event|when 原文配；配不上的再按事件名配，when 的文字差异报成 changed（模型中文、代码英文时照样对得上）
      const ka = a.map(raiseKey)
      const kb = b.map(raiseKey)
      const restA = a.filter((x, i) => !kb.includes(ka[i]))
      const restB = b.filter((x, i) => !ka.includes(kb[i]))
      const eventOf = (r) => (typeof r === 'string' ? r : r.event)
      const usedB = new Set()
      for (const x of restA) {
        const j = restB.findIndex((y, idx) => !usedB.has(idx) && eventOf(y) === eventOf(x))
        if (j < 0) { findings.push({ file, path: p, kind: 'missing', model: raiseKey(x), code: null }); continue }
        usedB.add(j)
        const y = restB[j]
        if ((x.when ?? null) !== (y.when ?? null)) findings.push({ file, path: `${p}/${eventOf(x)}/when`, kind: 'changed', model: x.when ?? null, code: y.when ?? null })
      }
      restB.forEach((y, idx) => { if (!usedB.has(idx)) findings.push({ file, path: p, kind: 'extra', model: null, code: raiseKey(y) }) })
      return
    }
    if (SET_KEYS.has(key)) {
      const ka = a.map(raiseKey)
      const kb = b.map(raiseKey)
      for (const x of ka) if (!kb.includes(x)) findings.push({ file, path: p, kind: 'missing', model: x, code: null })
      for (const x of kb) if (!ka.includes(x)) findings.push({ file, path: p, kind: 'extra', model: null, code: x })
      return
    }
    if (KEYED[key]) {
      const k = KEYED[key]
      // 不变量用原文当键：代码注释换了语言（模型中文、代码英文），原文就配不上。
      // 先按原文配；配不上的，两边按先后一一配对，把代码那一条的键改成模型那一条的，文字差异由下面比 text 时报出（交给判断）
      if (k === 'text') {
        const textsA = new Set(a.map((x) => x.text))
        const textsB = new Set(b.map((x) => x.text))
        const restA = a.filter((x) => !textsB.has(x.text))
        const restB = b.filter((x) => !textsA.has(x.text))
        const n = Math.min(restA.length, restB.length)
        b = b.map((x) => { const i = restB.indexOf(x); return i >= 0 && i < n ? { ...x, text: restA[i].text, __codeText: x.text } : x })
      }
      const mapA = new Map(a.map((x) => [x[k], x]))
      const mapB = new Map(b.map((x) => [x[k], x.__codeText !== undefined ? { ...x, text: x.__codeText, __codeText: undefined } : x]))
      for (const [id, x] of mapA) {
        if (!mapB.has(id)) findings.push({ file, path: `${p}/${id}`, kind: 'missing', model: x, code: null })
        else diff(x, mapB.get(id), file, `${p}/${id}`)
      }
      for (const [id, x] of mapB) if (!mapA.has(id)) findings.push({ file, path: `${p}/${id}`, kind: 'extra', model: null, code: x })
      return
    }
    // 有序数组（steps 等）：逐位比较
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (i >= a.length) findings.push({ file, path: `${p}/${i}`, kind: 'extra', model: null, code: b[i] })
      else if (i >= b.length) findings.push({ file, path: `${p}/${i}`, kind: 'missing', model: a[i], code: null })
      else diff(a[i], b[i], file, `${p}/${i}`)
    }
    return
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const inStep = /\/steps\/\d+$/.test(p)
    const inPurpose = /\/purpose$/.test(p)
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !IGNORE.has(k) && k !== '__codeText' && !(inStep && DESIGN_ONLY_IN_STEPS.has(k)) && !(inPurpose && k === 'traces')))
    for (const k of keys) {
      if (!(k in a) && optionalInModel(k, p)) continue
      // 步骤上的集合（throws、raises、changes）写成空数组和不写是一回事
      if (inStep && SET_KEYS.has(k) && ((!(k in a) && Array.isArray(b[k]) && !b[k].length) || (!(k in b) && Array.isArray(a[k]) && !a[k].length))) continue
      if (!(k in a)) findings.push({ file, path: `${p}/${k}`, kind: 'extra', model: null, code: b[k] })
      else if (!(k in b)) findings.push({ file, path: `${p}/${k}`, kind: 'missing', model: a[k], code: null })
      else diff(a[k], b[k], file, `${p}/${k}`)
    }
    return
  }
  if (a !== b && !(isTypeSlot(p) && sameCrossModuleType(a, b))) findings.push({ file, path: p, kind: 'changed', model: a, code: b })
}

const modelFiles = walk(modelDir)
const decodedFiles = walk(decodedDir)
const codedModules = new Set(decodedFiles.filter((f) => f.endsWith('/module.json')).map((f) => f.split('/')[0]))
function trimUnbuilt(m) { if (!m || !Array.isArray(m.modules)) return m; return { ...m, modules: m.modules.filter((x) => codedModules.has(x.name)) } }
for (const f of modelFiles) {
  if (!decodedFiles.includes(f)) findings.push({ file: f, path: '', kind: 'missing-file', model: null, code: null })
  else if (f === 'modules.json') diff(trimUnbuilt(load(modelDir, f)), load(decodedDir, f), f, '')
  else diff(load(modelDir, f), load(decodedDir, f), f, '')
}
for (const f of decodedFiles) if (!modelFiles.includes(f)) findings.push({ file: f, path: '', kind: 'extra-file', model: null, code: null })

const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v))
const LABEL = { 'missing-file': '模型有、代码无（文件）', 'extra-file': '代码有、模型无（文件）', missing: '模型有、代码无', extra: '代码有、模型无', changed: '不一致' }
if (!findings.length) console.log(`设计模型与解码模型一致：${modelFiles.length} 个文件，0 处差异。`)
else {
  let cur = null
  for (const f of findings) {
    if (f.file !== cur) {
      cur = f.file
      console.log(`\n${f.file}`)
    }
    const detail = f.kind === 'changed' ? `模型 ${show(f.model)} ｜ 代码 ${show(f.code)}` : f.kind === 'missing' ? show(f.model) : f.kind === 'extra' ? show(f.code) : ''
    console.log(`  [${LABEL[f.kind]}] ${f.path || '(文件)'} ${detail}`)
  }
  console.log(`\n共 ${findings.length} 处差异，涉及 ${new Set(findings.map((f) => f.file)).size} 个文件。`)
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ modelDir, decodedDir, comparedAt: new Date().toISOString(), findings }, null, 2) + '\n')
process.exit(findings.length ? 1 : 0)
