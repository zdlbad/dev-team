/**
 * 聚合设计页与模块页的服务端：工作台 require 进来，认得的地址交给 handle。
 *
 *   /stories          故事页：业务里真实发生的一段事，跨聚合、不分聚合（business/故事/*.json）
 *   /stories/data     全部故事
 *   POST /stories/confirm {file, version}        人按「定下」
 *   /relations        关系页：一份事实怎么推出另一份，没有先后（business/关系/*.json）
 *   /relations/data   全部关系
 *   POST /relations/confirm {file, version}      人按「定下」
 *   /agg              聚合设计页（每个聚合两个页签：属性、生命周期）
 *   /agg/data         全部聚合设计 + 它们挂的业务语句原话
 *   POST /agg/confirm {file, version}            人按「定下」
 *   /modules          模块页
 *   /modules/data     聚合、它们引用谁、眼下的模块划分
 *   POST /modules/save {version, division}       拖动、改名后存
 *   POST /modules/confirm {version}              人按「定下」
 *   /agg/stamp、/modules/stamp、/stories/stamp、/relations/stamp                    页面轮询：文件变了就重取
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
const RELATION_DIR = path.join('business', '关系')
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
const readRelations = (root) => readJsonDir(root, RELATION_DIR)
/** 出处编号 → 它指的那一步或那一条线：「从入册到退出 #5」「每个账户能买什么 #12」。聚合设计页上摆出标题，点得过去 */
function refTargets(root) {
  const out = {}
  for (const st of readStories(root)) for (const step of st.data?.steps ?? []) out[`${st.data.title} #${step.id}`] = { page: 'stories', file: st.file, id: step.id, title: step.title }
  for (const rl of readRelations(root)) for (const e of rl.data?.edges ?? []) {
    const name = (id) => rl.data.nodes.find((n) => n.id === id)?.title ?? id
    out[`${rl.data.title} #${e.id}`] = { page: 'relations', file: rl.file, id: e.id, title: `${name(e.from)} → ${name(e.to)}${e.label ? '（' + e.label + '）' : ''}` }
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
  '/stories': { title: '故事', dir: 'stories' },
  '/relations': { title: '关系', dir: 'relations' },
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
  if (url === '/relations/data') { send(res, 200, { relations: readRelations(root) }); return true }
  if (url === '/relations/stamp') { send(res, 200, { t: sha(readRelations(root).map((d) => d.file + d.version).join()) }); return true }
  if (url === '/stories/data') { send(res, 200, { stories: readStories(root) }); return true }
  if (url === '/stories/stamp') { send(res, 200, { t: sha(readStories(root).map((d) => d.file + d.version).join()) }); return true }
  if (url === '/agg/stamp') { send(res, 200, { t: sha(readDesigns(root).map((d) => d.file + d.version).join()) }); return true }
  if (url === '/modules/stamp') {
    const p = path.join(root, DIR, DIVISION)
    send(res, 200, { t: sha((fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '') + readDesigns(root).map((d) => d.file + d.version).join()) })
    return true
  }
  if (url === '/modules/data') { send(res, 200, modulesData(root)); return true }

  if (req.method === 'POST' && ['/agg/confirm', '/stories/confirm', '/relations/confirm'].includes(url)) {
    readBody(req).then((b) => {
      const file = path.basename(String(b.file ?? ''))
      const p = path.join(root, { '/agg/confirm': DIR, '/stories/confirm': STORY_DIR, '/relations/confirm': RELATION_DIR }[url], file)
      if (!file.endsWith('.json') || file === DIVISION || !fs.existsSync(p)) return send(res, 404, { error: `没有这一份：${file}` })
      const bad = guard(p, b.version)
      if (bad) return send(res, 409, bad)
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      data.confirmed = { at: now(), stamp: contentStamp(data) }
      send(res, 200, { version: writeJson(p, data), state: '已定' })
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
        if ((data.unassigned ?? []).length) return send(res, 400, { error: `还有 ${data.unassigned.length} 个聚合没划进模块` })
        data.confirmed = { at: now(), stamp: contentStamp(data) }
      }
      const version = writeJson(p, data)
      send(res, 200, { version, state: stateOf(data) })
    }).catch((e) => send(res, 400, { error: e.message }))
    return true
  }
  return false
}

module.exports = { handle, readDesigns, readStories, readRelations, refTargets, contentStamp, stateOf, refsOfDesign, UNASSIGNED, DIR, DIVISION, folderOf }
