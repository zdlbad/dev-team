/**
 * 故事、概念、聚合设计、模块四页的服务端：工作台 require 进来，认得的地址交给 handle。
 *
 *   /stories          故事页：业务里真实发生的一段事，跨聚合、不分聚合（business/故事/*.json）
 *   /stories/data     全部故事
 *   POST /stories/confirm {file, version}        人按「定下」
 *   /concepts         概念页：业务里的一个概念一张——定义、大白话的解释、它跟别的东西什么关系（business/概念/*.json）
 *   /concepts/data    全部概念，加上故事步骤的去处（线的补充里指着故事的那一步）
 *   POST /concepts/confirm {file, version}       人按「定下」
 *   /agg              聚合设计页（每个聚合两个页签：属性、生命周期）
 *   /agg/data         全部聚合设计 + 它们挂的业务语句原话
 *   POST /agg/confirm {file, version}            人按「定下」；四处 confirm 都可带 undo: true 撤销（手误按了）
 *   /modules          模块页
 *   /modules/data     聚合、它们引用谁、眼下的模块划分
 *   POST /modules/save {version, division}       拖动、改名后存
 *   POST /modules/confirm {version}              人按「定下」
 *   /agg/stamp、/modules/stamp、/stories/stamp、/concepts/stamp                    页面轮询：文件变了就重取
 *
 * 写回都带 version（读到时那份文件的指纹）：文件在这期间被别人改过就回 409、不写，页面重取后再按。
 * 整份覆盖会把模型师刚写的盖掉。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { loadBusiness, loadModel, folderOf, UNASSIGNED } = require('../tools/lib/project')
const { date, hm } = require('../tools/lib/time')

const DIR = 'aggregate-design'
const STORY_DIR = path.join('business', '故事')
const CONCEPT_DIR = path.join('business', '概念')
const DIVISION = 'modules.json'

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
/** 定下时记的指纹：除 confirmed 以外的内容 */
function contentStamp(data) {
  const { confirmed, ...rest } = data
  return sha(JSON.stringify(rest))
}
function stateOf(data) {
  if (!data.confirmed) return '未定'
  return data.confirmed.stamp === contentStamp(data) ? '已定' : '改过'
}
const now = () => { const t = new Date(); return `${date(t)} ${hm(t)}` }

function readDesigns(root) {
  return readJsonDir(root, DIR, [DIVISION])
}

function readJsonDir(root, rel, skip = []) {
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !skip.includes(f) && !f.startsWith('_')).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    try {
      const data = JSON.parse(text)
      return { file: f, version: sha(text), data, state: stateOf(data) }
    } catch (e) {
      return { file: f, version: sha(text), error: `JSON 读不了：${e.message}` }
    }
  })
}
const readStories = (root) => readJsonDir(root, STORY_DIR)
const readConcepts = (root) => readJsonDir(root, CONCEPT_DIR)
/** 故事的步骤编号 → 那一步：「从入册到退出 #5」。概念的线、聚合设计都指着它，页面上摆出标题，点得过去 */
function storyTargets(root) {
  const out = {}
  for (const st of readStories(root)) for (const step of st.data?.steps ?? []) out[`${st.data.title} #${step.id}`] = { page: 'stories', file: st.file, id: step.id, title: step.title }
  return out
}
const MAP_FILE = path.join('business', '全局图.json')
const TOPIC_STEP_X = 580, TOPIC_STEP_Y = 420   // 主题块的格子：块宽 360 隔 220，块高 190 隔 230
/**
 * 全局图的数据：上一层照 business/全局图.json（业务分析写：分几块、各块主要做什么、块与块之间主要交流什么），
 * 下一层从 business/概念/*.json 合并——概念里 kind=data 的节点是数据（同名并成一个），
 * 两头都是数据的线是主题里的线（同一对只取先出现的那条，线上的角色 by、树 tree 照概念里写的），
 * 角色 → 数据的线把角色贴到那个数据框上（谁出的、谁管的）；数据 → 角色、角色 → 角色的线不进全局图，去概念页看。
 */
function mapData(root) {
  const p = path.join(root, MAP_FILE)
  if (!fs.existsSync(p)) return { missing: `业务分析还没写 ${MAP_FILE}（业务分几块、各块主要做什么、块与块之间主要交流什么，形状见 dev-team agents/business/concepts.md「全局图」）`, topics: [], topEdges: [], nodes: [], edges: [], unassigned: [] }
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return { missing: `${MAP_FILE} 读不了：${e.message}`, topics: [], topEdges: [], nodes: [], edges: [], unassigned: [] } }
  const topics = (cfg.topics ?? []).map((t, i) => ({ id: t.id, title: t.title, does: t.does ?? [], c: (i % 8) + 1, tx: 40 + (t.x ?? 0) * TOPIC_STEP_X, ty: 40 + (t.y ?? 0) * TOPIC_STEP_Y, nodes: t.nodes ?? [] }))
  const topicOf = {}, orderIn = {}
  for (const t of topics) t.nodes.forEach((title, i) => { topicOf[title] ??= t.id; orderIn[title] ??= i })
  const nodes = {}, edges = {}
  const concepts = readConcepts(root).filter((c) => c.data)
  const pageOf = Object.fromEntries(concepts.map((c) => [c.data.title, c.file]))
  const node = (title, sub) => {
    nodes[title] ??= { id: title, title, sub: null, by: [], page: pageOf[title] ?? null, g: topicOf[title] ?? null, y: (orderIn[title] ?? 99) * 10, x: 0 }
    if (sub && !nodes[title].sub) nodes[title].sub = sub
    return nodes[title]
  }
  for (const c of concepts) {
    const byIdC = Object.fromEntries((c.data.nodes ?? []).map((n) => [n.id, n]))
    for (const n of c.data.nodes ?? []) if (n.kind === 'data') node(n.title, n.side === 'center' ? null : n.sub)
    for (const e of c.data.edges ?? []) {
      const a = byIdC[e.from], b = byIdC[e.to]
      if (!a || !b) continue
      if (a.kind === 'data' && b.kind === 'data') {
        const k = a.title + '>' + b.title
        edges[k] ??= { id: k, from: a.title, to: b.title, label: e.label, text: e.text ?? null, by: e.by ?? [], tree: !!e.tree, ref: `${c.data.title} #${e.id}`, file: c.file, edge: e.id }
      } else if (a.kind === 'role' && b.kind === 'data') {
        const n = node(b.title, b.sub)
        if (!n.by.includes(a.title)) n.by.push(a.title)
      }
    }
  }
  for (const n of Object.values(nodes)) if (cfg.nudge?.[n.title]) n.nudge = cfg.nudge[n.title]
  const unassigned = Object.values(nodes).filter((n) => !n.g).map((n) => n.title)
  // 主题里点了名、概念里还没有的数据：图上画不出来，提醒业务分析去写那张概念
  const unknown = topics.flatMap((t) => t.nodes.filter((title) => !nodes[title]).map((title) => `${title}（${t.title}）`))
  const placed = Object.values(nodes).filter((n) => n.g)
  const has = new Set(placed.map((n) => n.id))
  return {
    topics, topEdges: cfg.edges ?? [], nodes: placed,
    edges: Object.values(edges).filter((e) => has.has(e.from) && has.has(e.to)),
    unassigned, unknown, missing: null,
  }
}
function mapStamp(root) {
  let t = ''
  try { t = sha(fs.readFileSync(path.join(root, MAP_FILE), 'utf8')) } catch { /* 还没有 */ }
  return sha(t + readConcepts(root).map((d) => d.file + d.version).join())
}
/** 出处编号 → 它指的那一步或那一条线：故事的步骤，或概念的线「参与者 #4」。聚合设计页上摆出标题，点得过去 */
function refTargets(root) {
  const out = storyTargets(root)
  for (const c of readConcepts(root)) for (const e of c.data?.edges ?? []) {
    const name = (id) => c.data.nodes.find((n) => n.id === id)?.title ?? id
    out[`${c.data.title} #${e.id}`] = { page: 'concepts', file: c.file, id: e.id, title: `${name(e.from)} → ${name(e.to)}${e.label ? '（' + e.label + '）' : ''}` }
  }
  return out
}

/** 外部关联里写成「→ 聚合名」的属性就是它引用的聚合 */
function refsOfDesign(d) {
  const out = []
  for (const g of d.attributes ?? []) for (const f of g.fields ?? []) {
    const m = /^→\s*([A-Z][A-Za-z0-9]*)/.exec(f.type)
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** 模块页要的：聚合（有设计的用设计，模型里有、还没设计的也列上）、引用、眼下的划分 */
function modulesData(root) {
  const designs = readDesigns(root).filter((d) => d.data)
  const aggs = {}
  for (const d of designs) aggs[d.data.aggregate] = { title: d.data.title, refs: refsOfDesign(d.data), designed: true, file: d.file }
  const model = loadModel(root)
  const modelModule = {}
  for (const e of model.elements ?? []) {
    if (e.kind !== 'aggregate-root') continue
    const name = e.data?.name
    if (!name) continue
    modelModule[name] = e.module
    if (!aggs[name]) aggs[name] = { title: '', refs: [], designed: false }
  }
  // 还没设计的聚合，引用从模型字段推：participantId → Participant
  const names = Object.keys(aggs)
  for (const e of model.elements ?? []) {
    const name = e.data?.name
    if (!name || !aggs[name] || aggs[name].designed || e.kind !== 'aggregate-root') continue
    for (const f of e.data.fields ?? []) {
      const m = /^([a-z][A-Za-z0-9]*?)Ids?$/.exec(f.name)
      if (!m) continue
      const target = names.find((n) => n.toLowerCase() === m[1].toLowerCase())
      if (target && target !== name && !aggs[name].refs.includes(target)) aggs[name].refs.push(target)
    }
    aggs[name].guessed = true
  }

  const file = path.join(root, DIR, DIVISION)
  let division, version = null, source
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    division = JSON.parse(text)
    version = sha(text)
    source = 'file'
  } else {
    // 还没存过：照模型里现有的模块摆出来，模型里也没有的进「未划」
    const resp = Object.fromEntries((model.modules?.data?.modules ?? []).map((m) => [m.name, m.responsibility ?? '']))
    const byModule = {}
    for (const n of names) (byModule[modelModule[n] && modelModule[n] !== UNASSIGNED ? modelModule[n] : UNASSIGNED] ??= []).push(n)
    const order = [...(model.modules?.data?.modules ?? []).map((m) => m.name), ...Object.keys(byModule)].filter((v, i, a) => a.indexOf(v) === i && v !== UNASSIGNED && byModule[v])
    division = { modules: order.map((m) => ({ name: m, responsibility: firstClause(resp[m] ?? ''), aggregates: byModule[m] })), unassigned: byModule[UNASSIGNED] ?? [] }
    source = model.modules ? 'model' : 'none'
  }
  // 划分里没提到的聚合（新设计的）补进「未划」
  const placed = new Set([...(division.unassigned ?? []), ...division.modules.flatMap((m) => m.aggregates)])
  division.unassigned = [...(division.unassigned ?? []), ...names.filter((n) => !placed.has(n))]
  return { aggregates: aggs, division, version, source, state: source === 'file' ? stateOf(division) : '未定' }
}
const firstClause = (s) => String(s).split(/[；。（(]/)[0].slice(0, 60)

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) }
    }).on('error', reject)
  })
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const text = JSON.stringify(data, null, 2) + '\n'
  fs.writeFileSync(p, text, 'utf8')
  return sha(text)
}
/** 指纹对不上就是有人在这期间改过：回 409，不写 */
function guard(p, version) {
  const cur = fs.existsSync(p) ? sha(fs.readFileSync(p, 'utf8')) : null
  return cur === (version ?? null) ? null : { error: '这份文件刚被别人改过，页面已重取，看一眼再按', current: cur }
}

const PAGES = {
  '/map': { title: '全局图', dir: 'map' },
  '/stories': { title: '故事', dir: 'stories' },
  '/concepts': { title: '概念', dir: 'concepts' },
  '/agg': { title: '聚合设计', dir: 'aggregate-design' },
  '/modules': { title: '模块', dir: 'modules' },
}
function page(key) {
  const p = PAGES[key]
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${p.title}</title>
<style>${read('common/theme.css')}\n${read(p.dir + '/style.css')}</style></head><body>
<div id="app"><p class="note" style="padding:20px">载入中…</p></div>
<script>${read('common/client.js')}</script><script>${read(p.dir + '/client.js')}</script></body></html>`
}

/** 认得的地址处理掉并返回 true；别的返回 false，交还工作台 */
function handle(root, req, res, url) {
  const html = (b) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(b) }
  if (req.method === 'GET' && PAGES[url]) { html(page(url)); return true }

  if (url === '/agg/data') {
    const designs = readDesigns(root)
    const want = new Set(designs.flatMap((d) => [
      ...(d.data?.lifecycle?.transitions ?? []).flatMap((t) => t.traces ?? []),
      ...(d.data?.sources?.facts ?? []).flatMap((f) => f.traces ?? []),
    ]))
    const statements = {}
    for (const s of loadBusiness(root)) if (want.has(s.id)) statements[s.id] = s.text
    // 左边的聚合按模块分组：模块页上划过的照它，没划过的照模型里现有的
    const { division } = modulesData(root)
    const groups = [...division.modules.map((m) => ({ name: m.name, aggregates: m.aggregates })), { name: '', aggregates: division.unassigned }]
    send(res, 200, { designs, statements, groups, refTargets: refTargets(root) })
    return true
  }
  if (url === '/map/data') { send(res, 200, mapData(root)); return true }
  if (url === '/map/stamp') { send(res, 200, { t: mapStamp(root) }); return true }
  if (url === '/concepts/data') { send(res, 200, { concepts: readConcepts(root), storyTargets: storyTargets(root) }); return true }
  if (url === '/concepts/stamp') { send(res, 200, { t: sha(readConcepts(root).map((d) => d.file + d.version).join()) }); return true }
  if (url === '/stories/data') { send(res, 200, { stories: readStories(root) }); return true }
  if (url === '/stories/stamp') { send(res, 200, { t: sha(readStories(root).map((d) => d.file + d.version).join()) }); return true }
  if (url === '/agg/stamp') { send(res, 200, { t: sha(readDesigns(root).map((d) => d.file + d.version).join()) }); return true }
  if (url === '/modules/stamp') {
    const p = path.join(root, DIR, DIVISION)
    send(res, 200, { t: sha((fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '') + readDesigns(root).map((d) => d.file + d.version).join()) })
    return true
  }
  if (url === '/modules/data') { send(res, 200, modulesData(root)); return true }

  if (req.method === 'POST' && ['/agg/confirm', '/stories/confirm', '/concepts/confirm'].includes(url)) {
    readBody(req).then((b) => {
      const file = path.basename(String(b.file ?? ''))
      const p = path.join(root, { '/agg/confirm': DIR, '/stories/confirm': STORY_DIR, '/concepts/confirm': CONCEPT_DIR }[url], file)
      if (!file.endsWith('.json') || file === DIVISION || !fs.existsSync(p)) return send(res, 404, { error: `没有这一份：${file}` })
      const bad = guard(p, b.version)
      if (bad) return send(res, 409, bad)
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (b.undo) delete data.confirmed
      else data.confirmed = { at: now(), stamp: contentStamp(data) }
      send(res, 200, { version: writeJson(p, data), state: stateOf(data) })
    }).catch((e) => send(res, 400, { error: e.message }))
    return true
  }
  if (req.method === 'POST' && (url === '/modules/save' || url === '/modules/confirm')) {
    readBody(req).then((b) => {
      const p = path.join(root, DIR, DIVISION)
      const bad = guard(p, b.version)
      if (bad) return send(res, 409, bad)
      let data
      if (url === '/modules/save') {
        const d = b.division ?? {}
        const old = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
        data = { modules: (d.modules ?? []).map((m) => ({ name: String(m.name), responsibility: String(m.responsibility ?? ''), aggregates: [...(m.aggregates ?? [])] })), unassigned: [...(d.unassigned ?? [])] }
        if (old.confirmed) data.confirmed = old.confirmed
        const badName = data.modules.find((m) => !/^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)*$/.test(m.name) || m.name === UNASSIGNED)
        if (badName) return send(res, 400, { error: `模块名要英文大驼峰、每个词首字母大写：${badName.name}` })
        const dup = data.modules.map((m) => m.name).find((n, i, a) => a.indexOf(n) !== i)
        if (dup) return send(res, 400, { error: `模块重名：${dup}` })
      } else {
        if (!fs.existsSync(p)) return send(res, 400, { error: '还没存过划分，先拖一下或改个名再定' })
        data = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (b.undo) delete data.confirmed
        else if ((data.unassigned ?? []).length) return send(res, 400, { error: `还有 ${data.unassigned.length} 个聚合没划进模块` })
        else data.confirmed = { at: now(), stamp: contentStamp(data) }
      }
      const version = writeJson(p, data)
      send(res, 200, { version, state: stateOf(data) })
    }).catch((e) => send(res, 400, { error: e.message }))
    return true
  }
  return false
}

module.exports = { handle, readDesigns, readStories, readConcepts, refTargets, contentStamp, stateOf, refsOfDesign, UNASSIGNED, DIR, DIVISION, folderOf }
