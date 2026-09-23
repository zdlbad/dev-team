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
    // 点开头的目录不进：.git、.proto-build，还有走查页每次保存前留旧版的 slices/.history/。
    // 那些备份是纯拷贝、不是工件，扫进来会被当成切片文件校验（2026-09-18 真出过，check-schema 报 1 个不合规）。
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, out) }
    else out.push(p)
  }
  return out
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** 业务语句的标签：层（业务抽象 / 业务落地）与种类（能力 / 事实 / 约束 / 公式 / 触发 / 流程 / 情形）。形状：- [R-001] (业务落地-约束) 文本 */
const LAYERS = ['业务抽象', '业务落地']
const KINDS = { 能力: 'G', 事实: 'R', 约束: 'R', 公式: 'R', 触发: 'R', 流程: 'R', 情形: 'R' }
// 旧标签自动对上新名。「使用」是已停发的 U 类：老项目里还有，整体迁移时逐条过五问——公司事实改写成 R，软件行为作废
const LEGACY_KINDS = { 目标: '能力', 不变量: '约束', 推导: '公式', 反应: '触发', 使用: '使用' }
const LAYER_FILES = { 'abstraction.md': '业务抽象', 'practice.md': '业务落地' }
const LEGACY_LAYER_FILES = { '业务抽象.md': '业务抽象', '业务落地.md': '业务落地', '领域.md': '业务抽象', '公司.md': '业务落地' }
/** 给人看的标签：层-种类，缺哪样省哪样 */
const labelOf = (s) => [s.layer, s.ruleKind].filter(Boolean).join('-')

/** 业务描述：- [G-001] (层-种类) 文本。层与种类都可省：层省了从文件位置推（business/<Module>/<层>.md），老布局（business/<主题>.md）没有层 */
function loadBusiness(root) {
  const dir = path.join(root, 'business')
  const statements = []
  for (const f of walk(dir).filter((p) => p.endsWith('.md'))) {
    const rel = path.relative(root, f).replaceAll('\\', '/')
    const base = path.basename(f)
    const stem = base.replace(/\.md$/, '')
    const fileLayer = rel.split('/').length === 3 ? (LAYER_FILES[base] ?? LEGACY_LAYER_FILES[base] ?? null) : null
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    let inFence = false
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return
      }
      if (inFence) return // 围栏代码块里的示例不是业务语句
      const m = line.match(/^\s*-\s*\[([GRU]-\d{3,})\]\s*(?:\(([^)]*)\))?\s*(.*)$/)
      if (!m) return
      // G = 能力（谁能做到什么）；R = 规则（事实 / 约束 / 公式 / 触发 / 流程 / 情形）；U = 旧的使用语句，不再新发
      const letter = m[1][0]
      const kind = letter === 'G' ? 'goal' : letter === 'U' ? 'usage' : 'rule'
      let labelLayer = null, kindWord = null, rawKind = null, legacy = false
      const unknown = []
      for (const tok of (m[2] ?? '').split(/[-・·／/\s]+/).filter(Boolean)) {
        if (LAYERS.includes(tok)) labelLayer = tok
        else if (KINDS[tok]) { kindWord = tok; rawKind = tok }
        else if (LEGACY_KINDS[tok]) { kindWord = LEGACY_KINDS[tok]; rawKind = tok; legacy = true }
        else unknown.push(tok)
      }
      if (!kindWord && kind === 'usage') { kindWord = '使用'; legacy = true }
      if (!kindWord && kind === 'goal' && labelLayer) kindWord = '能力'
      statements.push({ id: m[1], kind, ruleKind: kindWord, rawKind, layer: labelLayer ?? fileLayer, labelLayer, fileLayer, legacy, unknownLabel: unknown.length ? unknown : null, text: m[3].trim(), file: rel, line: i + 1 })
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
    .filter((p) => p.endsWith('.json') && !path.basename(p).startsWith('_')) // 下划线开头的不是切片记录
    .map((p) => ({ file: path.relative(root, p).replaceAll('\\', '/'), data: readJson(p) }))
}
function loadProject(root) {
  return { root, business: loadBusiness(root), glossary: loadGlossary(root), model: loadModel(root), slices: loadSlices(root) }
}

/** 故事一步的走法名字里可能写了不止一个动作（「A + B」，按写的顺序做），逐个拆出来 */
function walkNames(name) {
  return String(name ?? '').split('+').map((x) => x.trim()).filter(Boolean)
}

/** 一条规则可以是一句话，也可以是 { text, traces, carries }（标明它管哪几个编号）；给人看的时候只要那句话 */
function ruleText(r) {
  return r && typeof r === 'object' ? String(r.text ?? '') : String(r ?? '')
}
/** 错误的 condition 可以是一句话，也可以是一句一标的数组；给人看的时候拼回一段 */
function conditionText(c) {
  if (Array.isArray(c)) return c.map(ruleText).filter(Boolean).join('；')
  return ruleText(c)
}

/**
 * 按对照换词：从左到右一次扫过，每一处只换一次，keys 要先按长的排前面。
 * 不能用逐条 split/join——那是扫好几遍，换出来的结果会被后一条再换一次
 * （「录入日」改名前后都叫录入日，可 split 到「录入」那一条时又被换成「登记日」）。
 * 对照里写「录入日: 录入日」这种原地不动的，就是靠这个一次扫过才保得住。
 */
function applyWordMap(text, pairs, keys) {
  const s = String(text ?? '')
  let out = ''
  let i = 0
  while (i < s.length) {
    let hit = null
    for (const k of keys) if (k && s.startsWith(k, i)) { hit = k; break }
    if (hit) { out += pairs[hit]; i += hit.length } else { out += s[i]; i++ }
  }
  return out
}

/**
 * 模块名 ↔ 代码文件夹名（agents/common/project-layout.md「名字的两套写法」）：模块名是 PascalCase（Participants、ServiceAgreements），
 * 代码库里的文件夹全小写、多词连字符（participants、service-agreements）；模型目录 model/<Module>/ 仍用模块名。
 * 模块名只允许「每个词首字母大写、其余小写」这样才能来回换算；HCPBilling 这种全大写缩写会换不回来，规范里不许。
 */
function folderOf(moduleName) {
  return String(moduleName).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()
}
function moduleOfFolder(folder) {
  return String(folder).split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}
/** model/<Module>/x/y.json → src/<folder>/x/y.ts（或 tests/…/y.test.ts） */
function codePathOf(modelRel, kind = 'src') {
  const parts = String(modelRel).replaceAll('\\', '/').split('/')
  if (parts[0] === 'model') parts.shift()
  parts[0] = folderOf(parts[0])
  const p = parts.join('/')
  return kind === 'tests' ? 'tests/' + p.replace(/\.json$/, '.test.ts') : 'src/' + p.replace(/\.json$/, '.ts')
}
/** src/<folder>/x/y.ts 或 tests/<folder>/x/y.test.ts → <Module>/x/y.json；moduleNames 给了就按它对回真名，没给就换算 */
function modelKeyOf(codeRel, moduleNames) {
  const f = String(codeRel).replaceAll('\\', '/')
  let rest = null
  if (f.startsWith('src/') && f.endsWith('.ts')) rest = f.slice(4, -3)
  else if (f.startsWith('tests/') && f.endsWith('.test.ts')) rest = f.slice(6, -8)
  if (!rest) return null
  const parts = rest.split('/')
  const byFolder = moduleNames ? [...moduleNames].find((m) => folderOf(m) === parts[0]) : null
  parts[0] = byFolder ?? moduleOfFolder(parts[0])
  return parts.join('/') + '.json'
}

/**
 * 看板上这条切片还没答的问题。模型师开工与派工都看它；`scene` 递进来就不再读文件。
 */
function openQuestions(root, sliceId, scene = null) {
  const fsx = require('node:fs'), px = require('node:path')
  let sc = scene
  if (!sc) { try { sc = JSON.parse(fsx.readFileSync(px.join(root, 'reports', '_scene.json'), 'utf8')) } catch { return [] } }
  return (sc.questions ?? []).filter((q) => q.slice === sliceId && !q.answeredAt)
}
module.exports = { openQuestions, folderOf, moduleOfFolder, codePathOf, modelKeyOf, applyWordMap, loadProject, loadBusiness, loadModel, loadGlossary, loadSlices, walk, readJson, walkNames, ruleText, conditionText, PREFIXES, LAYERS, KINDS, labelOf }
