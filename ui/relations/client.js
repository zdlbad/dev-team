// 关系页：一份事实怎么推出另一份，没有先后。数据来自 business/关系/<nn>-<关系名>.json，业务分析写
let DATA = null      // { relations }
let cur = null       // 当前这一张 { file, version, data, state }
let ex = ''          // 亮出哪个例子；'#<线>' 是从别的页点过来、只亮那一条线
let pinned = null

const app = document.getElementById('app')
const W = 168, H = 46, COLW = 340, GAPY = 22, PADX = 30, PADY = 30

async function load() {
  DATA = await getJson('relations/data')
  const [want, edge] = decodeURIComponent(location.hash.slice(1)).split('#')
  cur = DATA.relations.find((d) => d.file === (want || store.get('relation-file'))) || DATA.relations[0] || null
  if (edge) ex = '#' + edge
  render()
}

function render() {
  if (!DATA.relations.length) {
    app.innerHTML = `<div class="empty-page"><h2>还没有关系图</h2><p>业务分析把「一份事实怎么推出另一份」写成 <code>business/关系/&lt;nn&gt;-&lt;关系名&gt;.json</code>，这里就有了。</p></div>`
    return
  }
  const list = DATA.relations.map((d) => `<li data-f="${esc(d.file)}" class="${d === cur ? 'on' : ''}"><span class="t">${esc(d.data?.title ?? d.file)}</span><span class="badge ${esc(d.state ?? '未定')}">${esc(d.state ?? '读不了')}</span></li>`).join('')
  app.innerHTML = `<div class="wrap">
    <aside><h3>关系</h3><div class="muted">业务里一份事实怎么推出另一份，没有先后。业务分析写，你看过定；后面的聚合设计、模型拿它的线当出处。</div><ul id="list">${list}</ul></aside>
    <main id="main"></main></div><div class="detail" id="detail" hidden></div>`
  document.getElementById('list').onclick = (e) => {
    const li = e.target.closest('li'); if (!li) return
    cur = DATA.relations.find((d) => d.file === li.dataset.f); ex = ''; pinned = null
    store.set('relation-file', cur.file); history.replaceState(null, '', '#' + encodeURIComponent(cur.file))
    render()
  }
  renderMain()
}

function renderMain() {
  const main = document.getElementById('main')
  if (cur.error) { main.innerHTML = `<div class="card">${esc(cur.file)}：${esc(cur.error)}</div>`; return }
  const d = cur.data
  const gate = { 未定: '还没定下', 已定: `${esc(d.confirmed?.at ?? '')} 定下`, 改过: `${esc(d.confirmed?.at ?? '')} 定下以后又改过，再看一遍再按` }[cur.state]
  const exs = d.examples ?? []
  main.innerHTML = `<header>
      <h1>${esc(d.title)} <span class="badge ${esc(cur.state)}">${esc(cur.state)}</span></h1>
      <div class="sub">${esc(d.summary)}</div>
      <div class="gate"><button class="act${cur.state === '已定' ? ' undo' : ''}" id="confirm">${cur.state === '已定' ? '撤销定下' : '定下'}</button><span>${gate}</span></div>
    </header>
    ${exs.length ? `<div class="bar" id="bar"><span>拿例子看：</span><button data-ex="">不看例子</button>${exs.map((x) => `<button data-ex="${esc(x.id)}">${esc(x.title)}</button>`).join('')}<span class="note" id="exnote"></span></div>` : '<div style="height:12px"></div>'}
    <div class="diagram"><svg id="svg"></svg></div>
    <div class="legend">
      <span><span class="sw" style="background:var(--paper);border-color:var(--paper-line)"></span>原料里的纸</span>
      <span><span class="sw" style="background:var(--derived);border-color:var(--derived-line)"></span>推出来的</span>
      <span><span class="sw" style="background:var(--fixed);border-color:var(--fixed-line)"></span>政府定死的清单</span>
      <span><i></i>推出</span><span><i class="also"></i>也能</span><span><i class="narrow"></i>再缩小</span>
      <span>指着节点或线看解释，点一下钉住</span>
    </div>
    ${d.note ? `<div class="text">${esc(d.note)}</div>` : ''}`
  document.getElementById('confirm').onclick = async () => {
    const undo = cur.state === '已定'
    const r = await postJson('relations/confirm', { file: cur.file, version: cur.version, undo })
    if (r.ok) toast(undo ? '撤销了，回到没定下' : '定下了')
    load()
  }
  document.getElementById('bar')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ex = b.dataset.ex; draw() } })
  bindSvg()
  draw()
}

/**
 * 排位置：列照推出的先后（从没有来路的节点数起，走得最远的那条路定第几列；写了 col 的照它）；
 * 同一列里照前后两列的位置来回排几趟，让线少交叉。
 */
function layout(d) {
  const ids = d.nodes.map((n) => n.id)
  const preds = Object.fromEntries(ids.map((i) => [i, []])), succs = Object.fromEntries(ids.map((i) => [i, []]))
  for (const e of d.edges) if (preds[e.to] && succs[e.from]) { preds[e.to].push(e.from); succs[e.from].push(e.to) }
  const col = {}
  const depth = (i, seen = new Set()) => {
    if (col[i] !== undefined) return col[i]
    const n = d.nodes.find((x) => x.id === i)
    if (n.col !== undefined) return (col[i] = n.col)
    if (seen.has(i)) return 0 // 绕成圈的不往回数
    seen.add(i)
    return (col[i] = preds[i].length ? Math.max(...preds[i].map((p) => depth(p, seen) + 1)) : 0)
  }
  ids.forEach((i) => depth(i))
  // 没有来路的节点挨着它推出的那一列放（支持计划直接推到服务组，就放在服务组前一列），线不横穿别的列
  for (const i of ids) {
    const n = d.nodes.find((x) => x.id === i)
    if (n.col === undefined && !preds[i].length && succs[i].length) col[i] = Math.max(0, Math.min(...succs[i].map((x) => col[x])) - 1)
  }
  const cols = {}
  for (const i of ids) (cols[col[i]] ??= []).push(i)
  const keys = Object.keys(cols).map(Number).sort((a, b) => a - b)
  const rank = {}
  const reindex = () => { for (const k of keys) cols[k].forEach((i, r) => { rank[i] = r }) }
  reindex()
  const bary = (i, nb) => nb.length ? nb.reduce((s, x) => s + rank[x], 0) / nb.length : rank[i]
  for (let pass = 0; pass < 4; pass++) {
    for (const k of keys.slice(1)) { cols[k].sort((a, b) => bary(a, preds[a]) - bary(b, preds[b])); reindex() }
    for (const k of keys.slice(0, -1).reverse()) { cols[k].sort((a, b) => bary(a, succs[a]) - bary(b, succs[b])); reindex() }
  }
  const tallest = Math.max(...keys.map((k) => cols[k].length))
  const fullH = tallest * (H + GAPY) - GAPY
  const pos = {}
  for (const k of keys) {
    const list = cols[k], h = list.length * (H + GAPY) - GAPY, y0 = PADY + (fullH - h) / 2
    list.forEach((i, r) => { pos[i] = { x: PADX + k * COLW, y: y0 + r * (H + GAPY) } })
  }
  return { pos, width: PADX * 2 + Math.max(...keys) * COLW + W, height: PADY * 2 + fullH + 14 }
}

function lit(d) {
  if (!ex) return null
  if (ex.startsWith('#')) {
    const e = d.edges.find((x) => x.id === ex.slice(1)); if (!e) return null
    return { note: `从别处点过来：${d.title} #${e.id}`, nodes: { [e.from]: '', [e.to]: '' }, edges: [e.id] }
  }
  return (d.examples ?? []).find((x) => x.id === ex) ?? null
}

function draw() {
  const d = cur.data
  const { pos, width, height } = layout(d)
  const E = lit(d)
  document.querySelectorAll('#bar button').forEach((b) => b.classList.toggle('on', b.dataset.ex === ex || (!ex && !b.dataset.ex)))
  const note = document.getElementById('exnote'); if (note) note.textContent = E?.note ?? ''
  const outDeg = {}, inDeg = {}
  for (const e of d.edges) { outDeg[e.from] = (outDeg[e.from] ?? 0) + 1; inDeg[e.to] = (inDeg[e.to] ?? 0) + 1 }
  let g = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)"/></marker>
    <marker id="aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/></marker></defs>`
  for (const e of d.edges) {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, dx = (x2 - x1) * 0.45
    const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    // 一处分出好几条线的，字靠终点；好几条线汇到一处的，字靠起点：字各在各的线上，不挤在一头
    const t = outDeg[e.from] > 1 && outDeg[e.from] >= inDeg[e.to] ? 0.74 : 0.28, mt = 1 - t
    const lx = mt ** 3 * x1 + 3 * mt * mt * t * (x1 + dx) + 3 * mt * t * t * (x2 - dx) + t ** 3 * x2
    const ly = mt ** 3 * y1 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * y2
    const on = E && E.edges.includes(e.id)
    g += `<g class="ed ${esc(e.kind)}${E ? (on ? ' ex' : ' dim') : ''}" data-e="${esc(e.id)}"><path class="vis" d="${path}" marker-end="url(#${on ? 'aa' : 'a'})"/><path class="hit" d="${path}"/>${e.label ? `<text x="${lx}" y="${ly - 6}" text-anchor="middle">${esc(e.label)}</text>` : ''}</g>`
  }
  for (const n of d.nodes) {
    const p = pos[n.id], on = E && n.id in E.nodes
    g += `<g class="nd ${esc(n.kind)}${E ? (on ? ' ex' : ' dim') : ''}" data-n="${esc(n.id)}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="${n.kind === 'derived' ? 8 : 3}"/>
      <text x="${p.x + W / 2}" y="${p.y + (n.sub ? 19 : 28)}" text-anchor="middle">${esc(n.title)}</text>${n.sub ? `<text class="sub" x="${p.x + W / 2}" y="${p.y + 36}" text-anchor="middle">${esc(n.sub)}</text>` : ''}
      ${on && E.nodes[n.id] ? `<text class="amt" x="${p.x + W / 2}" y="${p.y + H + 14}" text-anchor="middle">${esc(E.nodes[n.id])}</text>` : ''}</g>`
  }
  const svg = document.getElementById('svg')
  svg.setAttribute('width', width); svg.setAttribute('height', height); svg.innerHTML = g
}

/* ---------- 解释浮在指着的节点或线旁边 ---------- */
const KIND = { paper: '原料里的纸', derived: '推出来的', fixed: '政府定死的清单' }
const EKIND = { derive: '推出', also: '也能', narrow: '再缩小' }
function fill(key) {
  const d = cur.data, pop = document.getElementById('detail')
  const row = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : ''
  if (key.n) {
    const n = d.nodes.find((x) => x.id === key.n)
    pop.innerHTML = `<h4>${esc(n.title)}</h4><div class="w">${KIND[n.kind]}${n.sub ? ' · ' + esc(n.sub) : ''}</div><dl>${(n.facts ?? []).map((f) => row(f.name, f.text)).join('')}${row('出处', n.source)}</dl>`
  } else {
    const e = d.edges.find((x) => x.id === key.e)
    const name = (id) => d.nodes.find((x) => x.id === id)?.title ?? id
    pop.innerHTML = `<h4>${esc(name(e.from))} → ${esc(name(e.to))}</h4><div class="w">${EKIND[e.kind]}${e.label ? ' · ' + esc(e.label) : ''}</div>
      <dl>${row('说的是', e.text)}${row('出处', e.source)}${row('业务', (e.traces ?? []).join('、'))}<dt>编号</dt><dd><span class="sid">${esc(d.title)} #${esc(e.id)}</span></dd></dl>`
  }
}
function place(ev) {
  const pop = document.getElementById('detail')
  pop.hidden = false
  const w = pop.offsetWidth, ht = pop.offsetHeight
  let x = ev.clientX + 16
  if (x + w > innerWidth - 8) x = ev.clientX - w - 16
  pop.style.left = Math.max(8, x) + 'px'
  pop.style.top = Math.max(8, Math.min(ev.clientY - 20, innerHeight - ht - 8)) + 'px'
}
const keyOf = (t) => { const n = t.closest('.nd'), e = t.closest('.ed'); return n ? { n: n.dataset.n } : e ? { e: e.dataset.e } : null }
function bindSvg() {
  const svg = document.getElementById('svg'), pop = () => document.getElementById('detail')
  svg.addEventListener('mousemove', (ev) => { if (pinned) return; const k = keyOf(ev.target); if (!k) { pop().hidden = true; return } fill(k); place(ev) })
  svg.addEventListener('mouseleave', () => { if (!pinned) pop().hidden = true })
  svg.addEventListener('click', (ev) => {
    const k = keyOf(ev.target); if (!k) return
    ev.stopPropagation()
    const id = JSON.stringify(k)
    document.querySelectorAll('.on-sel').forEach((n) => n.classList.remove('on-sel'))
    if (pinned === id) { pinned = null; pop().hidden = true; return }
    pinned = id; fill(k); place(ev)
    ev.target.closest('.nd,.ed').classList.add('on-sel')
  })
}
document.addEventListener('click', (ev) => {
  if (pinned && !ev.target.closest('.detail')) { pinned = null; document.getElementById('detail').hidden = true; document.querySelectorAll('.on-sel').forEach((n) => n.classList.remove('on-sel')) }
})
window.addEventListener('hashchange', load)
poll('relations/stamp', load)
load()
