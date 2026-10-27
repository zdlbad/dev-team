// 故事页：业务里真实发生的一段事，按参与方分道、时间从左往右。数据来自 business/故事/<nn>-<故事名>.json，业务分析写
let DATA = null      // { stories }
let cur = null       // 当前这个故事 { file, version, data, state }
let at = 0           // 当前这一步的下标
let pinned = null, shown = null

const app = document.getElementById('app')
const LEFT = 150, STEP = 206, CARD = 184, HEAD = 46, PAD = 14

async function load() {
  DATA = await getJson('stories/data')
  const want = decodeURIComponent(location.hash.slice(1)).split('#')[0] || store.get('story-file')
  cur = DATA.stories.find((d) => d.file === want) || DATA.stories[0] || null
  render()
}

function render() {
  if (!DATA.stories.length) {
    app.innerHTML = `<div class="empty-page"><h2>还没有故事</h2><p>业务分析把业务里真实发生的一段事写成 <code>business/故事/&lt;nn&gt;-&lt;故事名&gt;.json</code>，这里就有了。</p></div>`
    return
  }
  const list = DATA.stories.map((d) => `<li data-f="${esc(d.file)}" class="${d === cur ? 'on' : ''}"><span class="t">${esc(d.data?.title ?? d.file)}</span><span class="badge ${esc(d.state ?? '未定')}">${esc(d.state ?? '读不了')}</span></li>`).join('')
  app.innerHTML = `<div class="wrap">
    <aside><h3>故事</h3><div class="muted">业务里真实发生的一段事，不分聚合，也有不在系统里的。业务分析写，你看过定；后面的聚合设计、模型拿它的步骤当出处。</div><ul id="list">${list}</ul></aside>
    <main id="main"></main></div><div class="detail" id="detail" hidden></div>`
  document.getElementById('list').onclick = (e) => {
    const li = e.target.closest('li'); if (!li) return
    cur = DATA.stories.find((d) => d.file === li.dataset.f); at = 0; pinned = null
    store.set('story-file', cur.file); history.replaceState(null, '', '#' + encodeURIComponent(cur.file))
    render()
  }
  renderMain()
}

function renderMain() {
  const main = document.getElementById('main')
  if (cur.error) { main.innerHTML = `<div class="card">${esc(cur.file)}：${esc(cur.error)}</div>`; return }
  const d = cur.data
  const gate = { 未定: '还没定下', 已定: `${esc(d.confirmed?.at ?? '')} 定下`, 改过: `${esc(d.confirmed?.at ?? '')} 定下以后又改过，再看一遍再按` }[cur.state]
  const branches = (d.branches ?? []).map((b) => `<div class="ways"><b>${esc(b.title)}</b><div class="chips">${b.items.map((w) => `<span class="chip${w.shown ? ' on' : ''}" title="${esc([w.detail, w.source && '（' + w.source + '）'].filter(Boolean).join(''))}"><i>${esc(w.key)}</i>${esc(w.title)}</span>`).join('')}</div></div>`).join('')
  main.innerHTML = `<header>
      <h1>${esc(d.title)} <span class="badge ${esc(cur.state)}">${esc(cur.state)}</span></h1>
      <div class="sub">${esc(d.summary)}</div>
      <div class="gate"><button class="act${cur.state === '已定' ? ' undo' : ''}" id="confirm">${cur.state === '已定' ? '撤销定下' : '定下'}</button><span>${gate}</span></div>
    </header>
    ${branches ? `<section class="card" style="margin-top:14px">${branches}</section>` : ''}
    <div class="nav"><button id="prev">← 上一步</button><button id="next">下一步 →</button><span id="where"></span><span class="note">点卡片、键盘左右键、按住画布拖都行</span></div>
    <div class="diagram" id="scroller"><div class="lanes" id="lanes"><svg id="lw"></svg></div></div>
    <div class="legend"><span>时间从左往右；按谁来做分道</span><span><span class="sid">${esc(d.title)} #5</span> 步骤的编号，聚合设计拿它当出处</span><span><span class="pend">待你定</span> 还没定的</span>${(d.loops ?? []).length ? '<span><i class="loop"></i>打转的一段</span>' : ''}</div>`
  document.getElementById('confirm').onclick = async () => {
    const undo = cur.state === '已定'
    const r = await postJson('stories/confirm', { file: cur.file, version: cur.version, undo })
    if (r.ok) toast(undo ? '撤销了，回到没定下' : '定下了')
    load()
  }
  document.getElementById('prev').onclick = () => go(at - 1)
  document.getElementById('next').onclick = () => go(at + 1)
  drawLanes(d)
  bindCanvas(d)
  // 地址上带着步骤（#<文件>#<步骤>）就直接走到那一步：聚合设计页点出处过来的
  const stepWant = decodeURIComponent(location.hash.slice(1)).split('#')[1]
  const i = stepWant ? d.steps.findIndex((s) => s.id === stepWant) : -1
  go(i >= 0 ? i : Math.min(at, d.steps.length - 1))
}

function drawLanes(d) {
  const el = document.getElementById('lanes')
  const laneIdx = (id) => Math.max(0, d.participants.findIndex((p) => p.id === id))
  let h = ''
  d.steps.forEach((s, col) => {
    const li = laneIdx(s.by)
    const who = (d.participants[li]?.title ?? s.by) + (s.to ? ' → ' + s.to : '')
    h += `<div class="sc${s.pending ? ' pending' : ''}" id="sc-${esc(s.id)}" data-id="${esc(s.id)}" style="--c:var(--lane-${(li % 5) + 1});left:${LEFT + col * STEP}px;top:0;width:${CARD}px">
      <div class="w">${esc(who)}</div><span class="k">${esc(s.id)}</span><b>${esc(s.title)}</b>
      ${s.date || s.due ? `<div class="d">${s.date ? `<span class="date">${esc(s.date)}</span>` : ''}${s.due ? `<span class="due">${esc(s.due)}</span>` : ''}</div>` : ''}
      ${s.pending ? '<span class="pend">待你定</span>' : ''}</div>`
  })
  el.insertAdjacentHTML('beforeend', h)
  layout(d)
}

function layout(d) {
  const el = document.getElementById('lanes'); if (!el) return
  const card = (id) => document.getElementById('sc-' + id)
  // 每条道的高度照道里最高的那张卡
  const laneH = d.participants.map((p) => Math.max(60, ...d.steps.filter((s) => s.by === p.id).map((s) => card(s.id).offsetHeight)) + PAD * 2)
  const laneTop = []; { let y = HEAD; laneH.forEach((hh) => { laneTop.push(y); y += hh }) }
  d.steps.forEach((s) => { const li = Math.max(0, d.participants.findIndex((p) => p.id === s.by)); card(s.id).style.top = (laneTop[li] + PAD) + 'px' })
  const loops = d.loops ?? []
  const width = LEFT + d.steps.length * STEP + 10, height = laneTop[laneTop.length - 1] + laneH[laneH.length - 1] + (loops.length ? 40 : 10)
  el.style.width = width + 'px'; el.style.height = height + 'px'
  el.querySelectorAll('.phase,.stub,.lane-line,.phase-line').forEach((n) => n.remove())
  let stub = `<div class="stub" style="width:${LEFT - 12}px;height:${height}px">`
  let p = ''
  d.participants.forEach((pt, i) => {
    stub += `<div class="lane-h" style="--c:var(--lane-${(i % 5) + 1});top:${laneTop[i] + PAD}px;left:0;width:128px"><b>${esc(pt.title)}</b><span>${esc(pt.note ?? '')}</span></div>`
    if (i) p += `<div class="lane-line" style="top:${laneTop[i]}px;left:0;width:${width}px"></div>`
  })
  d.phases.forEach((ph, i) => {
    const cols = d.steps.map((s, c) => s.phase === ph.id ? c : -1).filter((c) => c >= 0); if (!cols.length) return
    const x0 = LEFT + cols[0] * STEP, x1 = LEFT + cols[cols.length - 1] * STEP + CARD
    p += `<div class="phase" style="left:${x0}px;width:${x1 - x0}px">${esc(ph.title)}<span>${esc(ph.note ?? '')}</span></div>`
    if (i) p += `<div class="phase-line" style="left:${x0 - (STEP - CARD) / 2}px;top:0;height:${height}px"></div>`
  })
  el.insertAdjacentHTML('afterbegin', p)
  el.insertAdjacentHTML('afterbegin', stub + '</div>')

  const box = (id) => { const n = card(id); return n && { l: n.offsetLeft, r: n.offsetLeft + n.offsetWidth, t: n.offsetTop, b: n.offsetTop + n.offsetHeight, cx: n.offsetLeft + n.offsetWidth / 2, my: n.offsetTop + 22 } }
  let svg = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)"/></marker>
    <marker id="al" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-3)"/></marker></defs>`
  for (let i = 0; i < d.steps.length - 1; i++) {
    const a = box(d.steps[i].id), b = box(d.steps[i + 1].id)
    const x1 = a.r, y1 = a.my, x2 = b.l - 2, y2 = b.my
    svg += `<path d="${Math.abs(y1 - y2) < 2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1 + 14} ${y1}, ${x2 - 14} ${y2}, ${x2} ${y2}`}" marker-end="url(#a)"/>`
  }
  // 打转的一段：从后一步底下绕回前一步
  loops.forEach((lp, k) => {
    const a = box(lp.from), b = box(lp.to); if (!a || !b) return
    const y = height - 22 + k * 0
    svg += `<path class="loop" d="M ${a.cx} ${a.b} L ${a.cx} ${y} L ${b.cx} ${y} L ${b.cx} ${b.b + 2}" marker-end="url(#al)"/>`
    svg += `<text x="${(a.cx + b.cx) / 2}" y="${y - 4}" text-anchor="middle">${esc(lp.label)}</text>`
  })
  const sv = document.getElementById('lw'); sv.setAttribute('width', width); sv.setAttribute('height', height); sv.innerHTML = svg
}

/* ---------- 当前这一步：高亮、放中间 ---------- */
function mark() {
  const d = cur.data, st = d.steps[at]
  document.querySelectorAll('.sc').forEach((n) => n.classList.toggle('cur', n.dataset.id === st.id))
  document.getElementById('where').textContent = `第 ${at + 1} / ${d.steps.length} 步`
  document.getElementById('prev').disabled = at === 0
  document.getElementById('next').disabled = at === d.steps.length - 1
}
function go(i) {
  const d = cur.data, scroller = document.getElementById('scroller')
  at = Math.max(0, Math.min(d.steps.length - 1, i))
  // 放在参与方一栏右边那一块的正中间；头尾几步挪不到中间就停在边上。不用平滑滚动，一下就到
  const view = scroller.clientWidth - LEFT
  scroller.scrollLeft = Math.max(0, at * STEP + CARD / 2 - view / 2)
  mark()
  if (shown) place(shown)
}

/* ---------- 解释浮在卡旁边 ---------- */
function fill(id) {
  const d = cur.data, s = d.steps.find((x) => x.id === id)
  const li = Math.max(0, d.participants.findIndex((p) => p.id === s.by))
  const row = (k, v, cls = '') => v ? `<dt>${k}</dt><dd class="${cls}">${v}</dd>` : ''
  document.getElementById('detail').innerHTML = `<h4>${esc(s.id)}. ${esc(s.title)}</h4>
    <div class="w">${esc((d.participants[li]?.title ?? s.by) + (s.to ? ' → ' + s.to : ''))}${d.phases.find((p) => p.id === s.phase) ? ' · ' + esc(d.phases.find((p) => p.id === s.phase).title) : ''}</div>
    <dl>
      ${row('例子', esc(s.date))}
      ${row('期限', esc(s.due), 'due')}
      ${row('多久', esc(s.every))}
      ${row('出处', esc(s.source))}
      ${row('业务', esc((s.traces ?? []).join('、')))}
      ${row('编号', `<span class="sid">${esc(d.title)} #${esc(s.id)}</span>`)}
      ${row('待定', s.pending ? `<span class="pend">${esc(s.pending)}</span>` : '')}
    </dl>`
}
function place(id) {
  const n = document.getElementById('sc-' + id), pop = document.getElementById('detail'); if (!n) return
  const r = n.getBoundingClientRect()
  pop.hidden = false
  const w = pop.offsetWidth, ht = pop.offsetHeight
  let x = r.right + 10
  if (x + w > innerWidth - 8) x = r.left - w - 10
  pop.style.left = Math.max(8, x) + 'px'
  pop.style.top = Math.max(8, Math.min(r.top, innerHeight - ht - 8)) + 'px'
}
function show(id) { shown = id; fill(id); place(id) }
function hide() { shown = null; document.getElementById('detail').hidden = true }

function bindCanvas(d) {
  const scroller = document.getElementById('scroller'), el = document.getElementById('lanes')
  el.addEventListener('mouseover', (e) => { const c = e.target.closest('.sc'); if (c && !pinned && !drag && shown !== c.dataset.id) show(c.dataset.id) })
  el.addEventListener('mouseout', (e) => { if (!pinned && e.target.closest('.sc') && !e.relatedTarget?.closest?.('.sc')) hide() })
  el.addEventListener('click', (e) => {
    const c = e.target.closest('.sc'); if (!c) return
    e.stopPropagation()
    // 点一张卡就走到那一步，解释钉在旁边；再点一下收起解释
    pinned = pinned === c.dataset.id ? null : c.dataset.id
    go(d.steps.findIndex((s) => s.id === c.dataset.id))
    if (pinned) show(pinned); else hide()
  })
  scroller.addEventListener('scroll', () => { if (shown) place(shown) })
  // 按住画布左右拖；松手后正中间那一步成为当前这一步，上一步、下一步接着从这里走
  scroller.addEventListener('pointerdown', (e) => { if (e.button === 0) { drag = { x: e.clientX, left: scroller.scrollLeft }; dragged = false } })
  scroller.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); dragged = false } }, true)
}
let drag = null, dragged = false
window.addEventListener('pointermove', (e) => {
  if (!drag) return
  const scroller = document.getElementById('scroller')
  const dx = e.clientX - drag.x
  if (!dragged && Math.abs(dx) < 4) return // 手抖几个像素还算点击
  if (!dragged) { dragged = true; scroller.classList.add('dragging'); if (!pinned) hide() }
  scroller.scrollLeft = drag.left - dx
})
window.addEventListener('pointerup', () => {
  if (!drag) return
  drag = null
  const scroller = document.getElementById('scroller')
  scroller.classList.remove('dragging')
  if (!dragged) return
  const view = scroller.clientWidth - LEFT
  at = Math.max(0, Math.min(cur.data.steps.length - 1, Math.round((scroller.scrollLeft + view / 2 - CARD / 2) / STEP)))
  mark()
})
document.addEventListener('click', (e) => { if (pinned && !e.target.closest('.detail')) { pinned = null; hide() } })
document.addEventListener('keydown', (e) => { if (!cur?.data) return; if (e.key === 'ArrowLeft') go(at - 1); if (e.key === 'ArrowRight') go(at + 1) })
window.addEventListener('scroll', () => { if (shown) place(shown) })
window.addEventListener('resize', () => { if (cur?.data) { layout(cur.data); go(at) } })
window.addEventListener('hashchange', load)
poll('stories/stamp', load)
load()
