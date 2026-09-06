/**
 * 读取一个项目：业务描述、词汇表、模型、切片。供校验器与看板共用。
 */
const fs = require('node:fs')
const path = require('node:path')

const PREFIXES = ['aggregate-root', 'entity', 'value-object', 'event', 'error', 'repository', 'service', 'command-handler', 'query-handler', 'event-handler', 'port']

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** 业务描述：[G-001] / [R-001] (种类) 文本 */
function loadBusiness(root) {
  const dir = path.join(root, 'business')
  const statements = []
  for (const f of walk(dir).filter((p) => p.endsWith('.md'))) {
    const rel = path.relative(root, f).replaceAll('\\', '/')
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    let inFence = false
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return
      }
      if (inFence) return // 围栏代码块里的示例不是业务语句
      const m = line.match(/^\s*-\s*\[([GR]-\d{3,})\]\s*(?:\((不变量|反应|推导)\))?\s*(.*)$/)
      if (!m) return
      statements.push({ id: m[1], kind: m[1].startsWith('G') ? 'goal' : 'rule', ruleKind: m[2] ?? null, text: m[3].trim(), file: rel, line: i + 1 })
    })
  }
  return statements
}

/** 模型：按种类分组，每个元素带 file（相对项目）与 module */
function loadModel(root) {
  const dir = path.join(root, 'model')
  const model = { modules: null, moduleFiles: [], elements: [], byFile: new Map() }
  for (const f of walk(dir).filter((p) => p.endsWith('.json') && !path.basename(p).startsWith('_'))) {
    const rel = path.relative(root, f).replaceAll('\\', '/')
    const parts = rel.split('/') // model/<Module>/...
    const base = path.basename(f, '.json')
    let data
    try {
      data = readJson(f)
    } catch (e) {
      model.elements.push({ kind: 'invalid', file: rel, error: e.message })
      continue
    }
    if (base === 'modules' && parts.length === 2) {
      model.modules = { file: rel, data }
      continue
    }
    const moduleName = parts[1]
    if (base === 'module' && parts.length === 3) {
      model.moduleFiles.push({ file: rel, module: moduleName, data })
      continue
    }
    const m = base.match(/^([a-z-]+)\.([A-Za-z0-9]+)$/)
    if (!m || !PREFIXES.includes(m[1])) continue
    const el = { kind: m[1], className: m[2], file: rel, module: moduleName, layer: parts[2], aggregateFolder: parts[2] === 'domain' && parts.length === 5 ? parts[3] : null, data }
    model.elements.push(el)
    model.byFile.set(rel, el)
  }
  return model
}

function loadGlossary(root) {
  const p = path.join(root, 'glossary.json')
  return fs.existsSync(p) ? readJson(p) : { terms: [] }
}
function loadSlices(root) {
  return walk(path.join(root, 'slices'))
    .filter((p) => p.endsWith('.json') && !p.endsWith('.story.json')) // *.story.json 是故事，不是切片记录
    .map((p) => ({ file: path.relative(root, p).replaceAll('\\', '/'), data: readJson(p) }))
}
function loadProject(root) {
  return { root, business: loadBusiness(root), glossary: loadGlossary(root), model: loadModel(root), slices: loadSlices(root) }
}

module.exports = { loadProject, loadBusiness, loadModel, loadGlossary, loadSlices, walk, readJson, PREFIXES }
