// 概念页：业务里的一个概念一张——定义、大白话的解释、一张图说它跟别的东西什么关系。数据来自 business/概念/<nn>-<概念>.json，业务分析写
let DATA = null      // { concepts }
let cur = null       // 当前这一张 { file, version, data, state }
let lit = ''         // 从别的页点过来、要亮出的那条线
let pinned = null

const app = document.getElementById('app')
const W = 170, H = 48, CENTER_W = 270, GAPY = 26, PADX = 24, PADY = 24, COLGAP = 190

async function load() {
  DATA = await getJson('concepts/data')
  const [want, edge] = decodeURIComponent(location.hash.slice(1)).split('#')
  cur = DATA.concepts.find((d) => d.file === (want || store.get('concept-file'))) || DATA.concepts[0] || null
  lit = edge || ''
  pinned = null
  render()
}

function render() {
  if (!DATA.concepts.length) {
    app.innerHTML = `<div class="empty-page"><h2>还没有概念</h2><p>业务分析把业务里的一个概念写成 <code>business/概念/&lt;nn&gt;-&lt;概念&gt;.json</code>，这里就有了。</p></div>`
    return
  }
  const list = DATA.concepts.map((d) => `<li data-f="${esc(d.file)}" class="${d === cur ? 'on' : ''}"><span class="t">${esc(d.data?.title ?? d.file)}</span><span class="badge ${esc(d.state ?? '未定')}">${esc(d.state ?? '读不了')}</span></li>`).join('')
  app.innerHTML = `<div class="wrap">
    <aside><h3>概念</h3><div class="muted">业务里的一个概念一张：它的定义、用大白话说它是什么、它跟别的东西什么关系。静态的；怎么一步步发生的在「故事」。业务分析写，你看过定；聚合设计拿它的线当出处。</div><ul id="list">${list}</ul></aside>
    <main id="main"></main></div><div class="detail" id="detail" hidden></div>`
  document.getElementById('list').onclick = (e) => {
    const li = e.target.closest('li'); if (!li) return
    cur = DATA.concepts.find((d) => d.file === li.dataset.f); lit = ''; pinned = null
    store.set('concept-file', cur.file); history.replaceState(null, '', '#' + encodeURIComponent(cur.file))
    render()
  }
  renderMain()
}

function renderMain() {
  const main = document.getElementById('main')
  if (cur.error) { main.innerHTML = `<div class="card">${esc(cur.file)}：${esc(cur.error)}</div>`; return }
  const d = cur.data
  const gate = { 未定: '还没定下', 已定: `${esc(d.confirmed?.at ?? '')} 定下`, 改过: `${esc(d.confirmed?.at ?? '')} 定下以后又改过，再看一遍再按` }[cur.state]
  main.innerHTML = `<header>
      <h1>${esc(d.title)} <span class="badge ${esc(cur.state)}">${esc(cur.state)}</span><button class="act${cur.state === '已定' ? ' undo' : ''}" id="confirm">${cur.state === '已定' ? '撤销定下' : '定下'}</button><span class="gate">${gate}</span></h1>
      <div class="def"><span class="k">定义</span>${esc(d.definition)}${d.definitionSource ? `<span class="src">${esc(d.definitionSource)}</span>` : ''}</div>
      <div class="exp">${esc(d.explain)}</div>
    </header>
    <div class="diagram"><svg id="svg"></svg></div>
    <div class="legend">
      <span><span class="sw round" style="background:var(--role);border-color:var(--role-line)"></span>角色（圆角）</span>
      <span><span class="sw" style="background:var(--data);border-color:var(--data-line)"></span>数据（偏直角）</span>
    </div>`
  document.getElementById('confirm').onclick = async () => {
    const undo = cur.state === '已定'
    const r = await postJson('concepts/confirm', { file: cur.file, version: cur.version, undo })
    if (r.ok) toast(undo ? '撤销了，回到没定下' : '定下了')
    load()
  }
  bindSvg()
  draw()
}

/** 三列：左边跟它有关系的角色和数据、中间它本身、右边它牵出的；各列上下居中 */
function layout(d) {
  const left = d.nodes.filter((x) => x.side === 'left'), right = d.nodes.filter((x) => x.side === 'right')
  const center = d.nodes.find((x) => x.side === 'center') ?? d.nodes[0]
  const centerH = 40 + 18 * (center.facts?.length ?? 0) + 10
  const tall = Math.max(left.length * (H + GAPY) - GAPY, right.length * (H + GAPY) - GAPY, centerH)
  const pos = {}
  const stack = (list, x) => { const h = list.length * (H + GAPY) - GAPY, y0 = PADY + (tall - h) / 2; list.forEach((n, r) => { pos[n.id] = { x, y: y0 + r * (H + GAPY), w: W, h: H } }) }
  stack(left, PADX)
  pos[center.id] = { x: PADX + W + COLGAP, y: PADY + (tall - centerH) / 2, w: CENTER_W, h: centerH }
  stack(right, PADX + W + COLGAP + CENTER_W + COLGAP)
  return { pos, width: PADX * 2 + W * 2 + COLGAP * 2 + CENTER_W, height: PADY * 2 + tall }
}

function draw() {
  const d = cur.data, { pos, width, height } = layout(d)
  let g = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)"/></marker>
    <marker id="aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/></marker></defs>`
  // 同一个框分出几条线、或几条线汇到同一个框时，端点在框上错开，字各在各的线上
  const inTo = {}, outFrom = {}
  for (const e of d.edges) { (inTo[e.to] ??= []).push(e); (outFrom[e.from] ??= []).push(e) }
  const slot = (list, e, p) => { const i = list.indexOf(e), n = list.length; return p.y + p.h * (i + 1) / (n + 1) }
  for (const e of d.edges) {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue
    const y1 = outFrom[e.from].length > 1 ? slot(outFrom[e.from], e, a) : a.y + a.h / 2
    const y2 = inTo[e.to].length > 1 ? slot(inTo[e.to], e, b) : b.y + b.h / 2
    const x1 = a.x + a.w, x2 = b.x - 2, dx = (x2 - x1) * 0.45
    const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2
    const on = lit && e.id === lit
    g += `<g class="ed${on ? ' lit' : ''}" data-e="${esc(e.id)}"><path class="vis" d="${path}" marker-end="url(#${on ? 'aa' : 'a'})"/><path class="hit" d="${path}"/>
      <text class="lab" x="${lx}" y="${ly - 5}" text-anchor="middle">${esc(e.label)}</text></g>`
  }
  for (const n of d.nodes) {
    const p = pos[n.id]; if (!p) continue
    const rx = n.kind === 'role' ? 20 : 3
    let inner
    if (n.side === 'center') {
      inner = `<text x="${p.x + p.w / 2}" y="${p.y + 24}" text-anchor="middle" style="font-size:15px;font-weight:600">${esc(n.title)}</text>`
        + (n.facts ?? []).map((f, i) => `<text class="fact" x="${p.x + 14}" y="${p.y + 46 + i * 18}">· ${esc(f.name)}</text>`).join('')
    } else {
      inner = `<text x="${p.x + p.w / 2}" y="${p.y + (n.sub ? 20 : 29)}" text-anchor="middle">${esc(n.title)}</text>${n.sub ? `<text class="sub" x="${p.x + p.w / 2}" y="${p.y + 37}" text-anchor="middle">${esc(n.sub)}</text>` : ''}`
    }
    g += `<g class="nd ${esc(n.kind)}${n.side === 'center' ? ' center' : ''}" data-n="${esc(n.id)}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${rx}"/>${inner}</g>`
  }
  const svg = document.getElementById('svg')
  svg.setAttribute('width', width); svg.setAttribute('height', height); svg.innerHTML = g
}

/* ---------- 补充浮在指着的线或框旁边 ---------- */
const KIND = { role: '角色', data: '数据' }
function fill(key) {
  const d = cur.data, pop = document.getElementById('detail')
  const row = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : ''
  if (key.n) {
    const n = d.nodes.find((x) => x.id === key.n)
    pop.innerHTML = `<h4>${esc(n.title)}</h4><div class="w">${KIND[n.kind] ?? ''}${n.sub ? ' · ' + esc(n.sub) : ''}</div><dl>${(n.facts ?? []).map((f) => row(f.name, esc(f.text))).join('')}${row('出处', esc(n.source))}</dl>`
  } else {
    const e = d.edges.find((x) => x.id === key.e), name = (id) => d.nodes.find((x) => x.id === id)?.title ?? id
    const story = e.story ? storyLink(e.story) : ''
    pop.innerHTML = `<h4>${esc(name(e.from))} → ${esc(name(e.to))}</h4><div class="w">${esc(e.label)}</div>
      <dl>${row('说的是', esc(e.text))}${row('故事', story)}${row('出处', esc(e.source))}${row('业务', esc((e.traces ?? []).join('、')))}<dt>编号</dt><dd><span class="sid">${esc(d.title)} #${esc(e.id)}</span></dd></dl>`
  }
}
/** 「<故事名> #<步骤>」→ 故事页那一步的链接；故事文件名是 <nn>-<故事名>.json，这里只认标题，让故事页自己去找 */
function storyLink(ref) {
  const m = /^(.+) #([0-9]+[a-z]?)$/.exec(ref)
  if (!m) return esc(ref)
  const t = DATA.storyTargets?.[ref]
  return t ? `<a href="stories#${encodeURIComponent(t.file)}#${encodeURIComponent(t.id)}">${esc(ref)}${t.title ? ' ' + esc(t.title) : ''}</a>` : esc(ref)
}
function place(ev) {
  const pop = document.getElementById('detail'); pop.hidden = false
  const w = pop.offsetWidth, ht = pop.offsetHeight
  let x = ev.clientX + 16; if (x + w > innerWidth - 8) x = ev.clientX - w - 16
  pop.style.left = Math.max(8, x) + 'px'; pop.style.top = Math.max(8, Math.min(ev.clientY - 20, innerHeight - ht - 8)) + 'px'
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
poll('concepts/stamp', load)
load()
