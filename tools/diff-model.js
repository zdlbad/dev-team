#!/usr/bin/env node
/**
 * 比对设计模型与解码模型（方向 ②）。
 * 用法：node tools/diff-model.js <model 目录> <model-decoded/<版本> 目录> [--json <输出文件>]
 * 退出码：0 无差异；1 有差异。
 *
 * 规则：
 * - 忽略 questions / decisions / denylist / writesNote / system（设计侧独有）
 * - 集合型数组（traces、throws、writes、reads、coordinates、members、raises）无序比较
 * - 命名型数组（fields、behaviors、methods、operations、input、result、payload、aggregates、modules、invariants、aggregateInvariants、idRefs、steps）按 name/text/顺序匹配
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

const IGNORE = new Set(['questions', 'decisions', 'denylist', 'writesNote', 'system'])
const SET_KEYS = new Set(['traces', 'throws', 'writes', 'reads', 'coordinates', 'members', 'raises'])
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
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = p.split('/').pop()
    if (SET_KEYS.has(key)) {
      const ka = a.map(raiseKey)
      const kb = b.map(raiseKey)
      for (const x of ka) if (!kb.includes(x)) findings.push({ file, path: p, kind: 'missing', model: x, code: null })
      for (const x of kb) if (!ka.includes(x)) findings.push({ file, path: p, kind: 'extra', model: null, code: x })
      return
    }
    if (KEYED[key]) {
      const k = KEYED[key]
      const mapA = new Map(a.map((x) => [x[k], x]))
      const mapB = new Map(b.map((x) => [x[k], x]))
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
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !IGNORE.has(k)))
    for (const k of keys) {
      if (!(k in a)) findings.push({ file, path: `${p}/${k}`, kind: 'extra', model: null, code: b[k] })
      else if (!(k in b)) findings.push({ file, path: `${p}/${k}`, kind: 'missing', model: a[k], code: null })
      else diff(a[k], b[k], file, `${p}/${k}`)
    }
    return
  }
  if (a !== b) findings.push({ file, path: p, kind: 'changed', model: a, code: b })
}

const modelFiles = walk(modelDir)
const decodedFiles = walk(decodedDir)
for (const f of modelFiles) {
  if (!decodedFiles.includes(f)) findings.push({ file: f, path: '', kind: 'missing-file', model: null, code: null })
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
