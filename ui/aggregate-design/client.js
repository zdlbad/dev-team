// 聚合设计页：每个聚合两个页签——属性、生命周期（状态图、时序图）。数据来自 aggregate-design/<聚合>.json
let DATA = null          // { designs, statements }
let cur = null           // 当前这份设计 { file, version, data, state }
// 地址上的 ?tab=life&view=ln 先于本机记的：发给人的链接打开就是那一页
const QP = new URLSearchParams(location.search)
let tab = QP.get('tab') || store.get('agg-tab') || 'attr'
let view = QP.get('view') || store.get('agg-view') || 'sd'
let picked = null        // 状态图上点中的那条转移

const app = document.getElementById('app')

async function load() {
  DATA = await getJson('agg/data')
  const want = decodeURIComponent(location.hash.slice(1)) || store.get('agg-file')
  cur = DATA.designs.find((d) => d.file === want) || DATA.designs[0] || null
  render()
}

function render() {
  if (!DATA.designs.length) {
    app.innerHTML = `<div class="empty-page"><h2>还没有聚合设计</h2><p>模型师照业务写的生命周期整理出 <code>aggregate-design/&lt;聚合&gt;.json</code>，这里就有了。</p></div>`
    return
  }
  app.innerHTML = `<div class="wrap">
    <aside><h3>聚合</h3><div class="muted">先看聚合，模块等业务范围清楚了再划（「模块」页）。</div><div id="aggs">${sideList()}</div></aside>
    <main id="main"></main></div>`
  app.querySelector('#aggs').addEventListener('toggle', (e) => {
    const g = e.target.closest('details'); if (!g) return
    const open = new Set(JSON.parse(store.get('agg-open') || '[]'))
    g.open ? open.add(g.dataset.g) : open.delete(g.dataset.g)
    store.set('agg-open', JSON.stringify([...open]))
  }, true)
  app.querySelector('#aggs').addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return
    cur = DATA.designs.find((d) => d.file === li.dataset.f); picked = null
    store.set('agg-file', cur.file); history.replaceState(null, '', '#' + encodeURIComponent(cur.file))
    render()
  })
  renderMain()
}

/** 左边的聚合按模块收起、展开：当前这个所在的模块总是开着，别的照本机记的 */
function sideList() {
  const byName = Object.fromEntries(DATA.designs.filter((d) => d.data).map((d) => [d.data.aggregate, d]))
  const listed = new Set()
  const groups = (DATA.groups ?? []).map((g) => ({ name: g.name, items: g.aggregates.map((n) => byName[n]).filter(Boolean) }))
  for (const g of groups) for (const d of g.items) listed.add(d)
  const rest = DATA.designs.filter((d) => !listed.has(d))
  if (rest.length) { const un = groups.find((g) => !g.name); un ? un.items.push(...rest) : groups.push({ name: '', items: rest }) }
  const open = new Set(JSON.parse(store.get('agg-open') || '[]'))
  const item = (d) => `<li data-f="${esc(d.file)}" class="${d === cur ? 'on' : ''}"><span class="t">${esc(d.data?.aggregate ?? d.file)}<small>${esc(d.data?.title ?? d.error ?? '')}</small></span><span class="badge ${esc(d.state ?? '未定')}">${esc(d.state ?? '读不了')}</span></li>`
  return groups.filter((g) => g.items.length).map((g) => {
    const key = g.name || '_'
    const done = g.items.filter((d) => d.state === '已定').length
    const isOpen = g.items.includes(cur) || open.has(key)
    return `<details data-g="${esc(key)}" ${isOpen ? 'open' : ''}><summary><span>${esc(g.name || '未划')}</span><small>${done}/${g.items.length} 定下</small></summary><ul>${g.items.map(item).join('')}</ul></details>`
  }).join('')
}

function renderMain() {
  const main = document.getElementById('main')
  if (cur.error) { main.innerHTML = `<div class="card">${esc(cur.file)}：${esc(cur.error)}</div>`; return }
  const d = cur.data
  const gateText = { 未定: '还没定下', 已定: `${esc(d.confirmed?.at ?? '')} 定下`, 改过: `${esc(d.confirmed?.at ?? '')} 定下以后又改过，再看一遍再按` }[cur.state]
  main.innerHTML = `<header>
      <h1>${esc(d.title)} <code>${esc(d.aggregate)}</code> <span class="badge ${esc(cur.state)}">${esc(cur.state)}</span></h1>
      <div class="sub">${esc(d.summary)}</div>
      <div class="gate"><button class="act${cur.state === '已定' ? ' undo' : ''}" id="confirm">${cur.state === '已定' ? '撤销定下' : '定下'}</button><span>${gateText}</span></div>
    </header>
    <nav class="tabs" id="tabs"><button data-t="attr">属性</button><button data-t="life">生命周期</button></nav>
    <section class="pane card" id="pane-attr"></section>
    <section class="pane card" id="pane-life"></section>`
  main.querySelector('#confirm').onclick = confirmIt
  main.querySelector('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.t) }
  renderAttr(d)
  renderLife(d)
  showTab(tab)
}

async function confirmIt() {
  const undo = cur.state === '已定'
  const r = await postJson('agg/confirm', { file: cur.file, version: cur.version, undo })
  if (r.ok) toast(undo ? '撤销了，回到没定下' : '定下了')
  load()
}

function showTab(t) {
  tab = t; store.set('agg-tab', t)
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t))
  document.getElementById('pane-attr').hidden = t !== 'attr'
  document.getElementById('pane-life').hidden = t !== 'life'
  requestAnimationFrame(() => { wireAttr(); wireLanes() })
}
function showView(v) {
  view = v; store.set('agg-view', v)
  document.querySelectorAll('#subtabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v))
  document.getElementById('view-sd').hidden = v !== 'sd'
  document.getElementById('view-ln').hidden = v !== 'ln'
  requestAnimationFrame(wireLanes)
}

/* ---------- 属性 ---------- */
const GROUP_ORDER = ['身份', '业务属性', '状态', '外部关联', '成员', '审计']
const SCALARS = ['string', 'number', 'boolean', 'date']
const baseType = (t) => String(t).replace(/\[\]$/, '')

function renderAttr(d) {
  const src = d.sources ?? { stages: [], entities: [], facts: [] }
  const stage = (id) => src.stages.find((s) => s.id === id) ?? { id, title: id }
  const entity = (id) => src.entities.find((s) => s.id === id) ?? { id, title: id }
  let flow = `<div class="hd">阶段</div><div class="hd">实体<span>事实装在哪里</span></div><div class="hd">来源<span>什么事发生了、带来哪份事实</span></div>`
  let lastSt = null
  const seenEnt = new Set()
  src.facts.forEach((f, i) => {
    const st = stage(f.stage)
    flow += f.stage !== lastSt ? `<div class="stage first"><b>${esc(st.title)}</b><span>${esc(st.note ?? '')}</span></div>` : `<div class="stage"></div>`
    lastSt = f.stage
    if (!seenEnt.has(f.entity)) { seenEnt.add(f.entity); const en = entity(f.entity); flow += `<div class="ent" data-ent="${esc(f.entity)}"><b>${esc(en.title)}</b><span>${esc(en.note ?? '')}</span></div>` }
    else flow += `<div></div>`
    flow += `<div class="src" data-i="${i}"><div class="t"><i>事件</i>${esc(f.event)}</div><div class="f"><i>事实</i>${esc(f.fact)}${(f.refs ?? []).length ? `<div class="refs">${refLinks(f.refs)}</div>` : ''}</div></div>`
  })
  if (!src.facts.length) flow += `<div></div><div></div><div class="note">来源还没整理：什么事发生了、带来哪份事实、落在哪几个属性上</div>`

  // 推荐的六组照次序排；别起的组跟在业务属性后面
  const rank = (x) => (GROUP_ORDER.includes(x) ? GROUP_ORDER.indexOf(x) : 1.5)
  const groups = [...(d.attributes ?? [])].sort((a, b) => rank(a.group) - rank(b.group))
  const partNames = (d.parts ?? []).map((p) => p.name)
  let cls = `<div class="h"><small>聚合根</small><b>${esc(d.aggregate)}</b><span class="cn">${esc(d.title)}</span></div>`
  groups.forEach((g, gi) => {
    cls += `<div class="g ${gi ? '' : 'first'}">${esc(g.group)}${g.aspect ? ' · ' + esc(g.aspect) : ''}</div>`
    if (g.none) cls += `<div class="none">${esc(g.none)}</div>`
    for (const f of g.fields ?? []) {
      const cx = !SCALARS.includes(baseType(f.type)) && !String(f.type).startsWith('→')
      cls += `<div class="row" data-f="${esc(f.name)}" title="${esc(f.from ?? '')}"><span class="n">${esc(f.name)}</span><span class="m">${esc(f.meaning)}</span><span class="ty${cx ? ' cx' : ''}">${esc(f.type)}</span></div>`
    }
  })
  cls += `<div class="pad"></div>`

  // 状态那一组的类型画成一个值对象，列出生命周期里的状态
  const statusField = groups.find((g) => g.group === '状态')?.fields?.[0]
  let parts = ''
  if (statusField && !partNames.includes(baseType(statusField.type))) {
    parts += `<div class="vo" data-part="${esc(baseType(statusField.type))}"><div class="h"><small>值对象</small><b>${esc(baseType(statusField.type))}</b><span class="cn">状态</span></div>`
      + (d.lifecycle?.states ?? []).map((s) => `<div class="row">${esc(s.name)}${s.title && s.title !== s.name ? `<span>${esc(s.title)}</span>` : ''}</div>`).join('')
      + `<div class="ft">怎么转，见「生命周期」</div></div>`
  }
  for (const p of d.parts ?? []) {
    parts += `<div class="vo" data-part="${esc(p.name)}"><div class="h"><small>${p.kind === 'entity' ? '实体' : '值对象'}</small><b>${esc(p.name)}</b><span class="cn">${esc(p.title)}</span></div>`
      + p.fields.map((f) => `<div class="row">${esc(f.name)}<span>${esc(f.type)}</span></div>`).join('') + `<div class="pad"></div></div>`
  }

  document.getElementById('pane-attr').innerHTML = `
    <div class="who">业务里什么事发生了、带来哪份事实，事实落在聚合的哪个属性上 · 模型师整理，你看过定 · 指着一张卡看它连到哪几个属性</div>
    <div class="scroll"><div class="attr" id="attr"><svg class="wires" id="wires"></svg>
      <div class="flow" id="flow">${flow}</div>
      <div><div class="agg"><div class="cap">聚合 ${esc(d.aggregate)}（${esc(d.title)}）</div><div class="cls" id="cls">${cls}</div><div class="parts">${parts}</div></div></div>
    </div></div>`
  document.getElementById('flow').addEventListener('mouseover', (e) => {
    const c = e.target.closest('.src'); const on = c ? src.facts[+c.dataset.i].fields : []
    document.querySelectorAll('#cls .row').forEach((r) => r.classList.toggle('on', on.includes(r.dataset.f)))
    document.querySelectorAll('#wires path[data-i]').forEach((p) => { const hit = c && p.dataset.i === c.dataset.i; p.style.stroke = hit ? 'var(--accent)' : ''; p.style.strokeWidth = hit ? 2 : '' })
  })
}

function wireAttr() {
  const root = document.getElementById('attr'); const svg = document.getElementById('wires')
  if (!root || !cur?.data) return
  const R = root.getBoundingClientRect(); if (!R.width) return
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - R.left, r: r.right - R.left, t: r.top - R.top, b: r.bottom - R.top, m: (r.top + r.bottom) / 2 - R.top } }
  const facts = cur.data.sources?.facts ?? []
  const cls = box(document.getElementById('cls'))
  let p = ''
  facts.forEach((f, i) => {
    const en = root.querySelector(`.ent[data-ent="${CSS.escape(f.entity)}"]`), c = root.querySelector(`.src[data-i="${i}"]`)
    if (!en || !c) return
    const e = box(en), s = box(c), mx = e.r + 12
    p += `<path d="M ${e.r} ${e.t + 18} L ${mx} ${e.t + 18} L ${mx} ${s.t + 14} L ${s.l} ${s.t + 14}"/>`
    const bx = cls.l - 14 - i * 4
    for (const fn of f.fields) {
      const row = root.querySelector(`.row[data-f="${CSS.escape(fn)}"]`); if (!row) continue
      const r = box(row)
      p += `<path data-i="${i}" d="M ${s.r} ${s.t + 14} L ${bx} ${s.t + 14} L ${bx} ${r.m} L ${cls.l} ${r.m}"/>`
    }
  })
  // 属性的类型连到它的值对象、实体
  root.querySelectorAll('.vo[data-part]').forEach((vo, k) => {
    const name = vo.dataset.part
    const fieldName = [...(cur.data.attributes ?? [])].flatMap((g) => g.fields ?? []).find((f) => baseType(f.type) === name)?.name
    const row = fieldName && root.querySelector(`.row[data-f="${CSS.escape(fieldName)}"]`); if (!row) return
    // 从属性那一行的右边出去，绕到聚合根框外、再落到值对象框顶上：框是不透明的，线走框里看不见
    const r = box(row), v = box(vo), xo = cls.r + 14 + k * 8, y = (cls.b + v.t) / 2 + k * 4
    p += `<path style="stroke:var(--ink-2)" d="M ${cls.r} ${r.m} L ${xo} ${r.m} L ${xo} ${y} L ${(v.l + v.r) / 2} ${y} L ${(v.l + v.r) / 2} ${v.t}"/>`
  })
  svg.setAttribute('width', R.width); svg.setAttribute('height', R.height)
  svg.innerHTML = p
}

/* ---------- 生命周期 ---------- */
function renderLife(d) {
  document.getElementById('pane-life').innerHTML = `
    <div class="subtabs" id="subtabs"><button data-v="sd">状态图：它自己怎么变</button><button data-v="ln">时序图：流程和参与者</button></div>
    <div id="view-sd">
      <div class="who">只看聚合内部：有哪些状态、怎么转、转之前要满足什么、转了里面跟着变什么、发出什么事件；不写谁来做 · 业务分析写生命周期（右边的原话），模型师整理成图 · 点箭头看这一条转移</div>
      <div class="sdwrap"><div class="sdl"><div class="diagram"><svg class="sd" id="svg"></svg></div>
        <div class="legend"><span>箭头上：<span class="ev">发出的领域事件</span></span><span><i class="ext"></i>别的聚合的事件引起的转移</span><span>双框：终态</span><span>没画箭头的转移不许走</span></div></div>
        <div class="cols"><div class="detail" id="detail"></div><div><h4 class="sec">业务写的生命周期（原话）</h4><ol class="biz" id="biz"></ol></div></div>
      </div>
      <div class="events"><div><b>它发出的</b><ul id="out"></ul></div><div><b>它听的（别的聚合发来）</b><ul id="in"></ul></div></div>
    </div>
    <div id="view-ln" hidden>
      <div class="who">只看流程与参与者：谁在什么时候做了什么；时间从上往下走。卡底的状态与事件用来跟状态图对上</div>
      <div class="diagram"><div class="lanes" id="lanes"><svg class="lw" id="lw"></svg></div></div>
      <div class="legend"><span><i></i>往下走</span><span><i class="cond"></i>红字：过得去要满足的</span><span><i class="back"></i>退回去</span></div>
    </div>`
  document.getElementById('subtabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.v) }
  if (!(d.lifecycle?.states ?? []).length) document.querySelector('#view-sd .sdwrap').outerHTML = '<p class="note">状态图还没整理：业务分析写生命周期，模型师整理成图。</p>'
  else drawStates(d)
  if (!(d.sequence?.steps ?? []).length) document.querySelector('#view-ln .diagram').outerHTML = '<p class="note">时序图还没整理。</p>'
  else renderLanes(d)
  showView(view)
}

const W = 124, H = 44, RANK = 110, TOP = 110, GAPX = 220
const textW = (s) => [...String(s ?? '')].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 12 : 6.6), 0)

/** 排状态图：从开出来那一下起一层层往下（广度优先），同一层的并排；回到上面的转移走左边，自环在右边 */
function layoutStates(d) {
  const states = d.lifecycle?.states ?? []
  const trans = d.lifecycle?.transitions ?? []
  const names = states.map((s) => s.name)
  const rank = {}
  const starts = trans.filter((t) => t.from === null).map((t) => t.to)
  const queue = [...new Set(starts.length ? starts : names.slice(0, 1))]
  queue.forEach((n) => { rank[n] = 0 })
  while (queue.length) {
    const n = queue.shift()
    for (const t of trans) if (t.from === n && t.to !== n && rank[t.to] === undefined) { rank[t.to] = rank[n] + 1; queue.push(t.to) }
  }
  let maxR = Math.max(0, ...Object.values(rank))
  for (const n of names) if (rank[n] === undefined) rank[n] = ++maxR // 走不到的状态排在最后，看得出来是孤的
  const byRank = {}
  for (const n of names) (byRank[rank[n]] ??= []).push(n)
  const widest = Math.max(1, ...Object.values(byRank).map((a) => a.length))
  const cx0 = 300 + (widest - 1) * GAPX / 2
  const pos = {}
  for (const [r, list] of Object.entries(byRank)) list.forEach((n, i) => { pos[n] = { x: cx0 + (i - (list.length - 1) / 2) * GAPX, y: TOP + r * RANK, r: +r } })
  return { states, trans, pos, hasStart: starts.length > 0, cx0 }
}

function drawStates(d) {
  const { states, trans, pos, hasStart, cx0 } = layoutStates(d)
  const outgoing = new Set(trans.filter((t) => t.from && t.from !== t.to).map((t) => t.from))
  const label = (n) => states.find((s) => s.name === n)?.title || n
  let g = `<defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)"/></marker>
    <marker id="ahx" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--ext)"/></marker>
    <marker id="aha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/></marker></defs>`
  let minX = cx0 - W / 2 - 20, maxX = cx0 + W / 2 + 20, maxY = 0
  const grow = (x, w, anchor) => { const l = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x; minX = Math.min(minX, l - 8); maxX = Math.max(maxX, l + w + 8) }
  if (hasStart) g += `<circle class="start" cx="${pos[trans.find((t) => t.from === null).to].x}" cy="30" r="9"/>`
  for (const s of states) {
    const p = pos[s.name], x = p.x - W / 2, y = p.y - H / 2
    const final = !outgoing.has(s.name)
    g += `<g class="st">${final ? `<rect class="outer" x="${x - 4}" y="${y - 4}" width="${W + 8}" height="${H + 8}" rx="10"/>` : ''}<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="8"/><text x="${p.x}" y="${p.y + 5}" text-anchor="middle">${esc(label(s.name))}</text></g>`
    minX = Math.min(minX, x - 8); maxX = Math.max(maxX, x + W + 8); maxY = Math.max(maxY, y + H + 8)
  }
  const backN = {}, loopN = {}
  trans.forEach((t, i) => {
    const b = pos[t.to]; if (!b) return
    let dpath, lx, ly, anchor = 'start'
    if (t.from === null) {
      dpath = `M ${b.x} 39 L ${b.x} ${b.y - H / 2 - 2}`; lx = b.x + 12; ly = (39 + b.y - H / 2) / 2 + 4
    } else {
      const a = pos[t.from]; if (!a) return
      if (t.from === t.to) {
        const k = loopN[t.to] = (loopN[t.to] ?? 0) + 1
        const x0 = a.x + W / 2, y0 = a.y - 12 + (k - 1) * 6
        dpath = `M ${x0} ${y0} C ${x0 + 58 + k * 10} ${y0 - 12}, ${x0 + 58 + k * 10} ${y0 + 34}, ${x0 + 2} ${y0 + 22}`; lx = x0 + 64 + k * 10; ly = y0 + 15
      } else if (b.r > a.r) {
        const y1 = a.y + H / 2, y2 = b.y - H / 2 - 2
        if (Math.abs(a.x - b.x) < 2 && b.r === a.r + 1) { dpath = `M ${a.x} ${y1} L ${b.x} ${y2}`; lx = a.x + 12; ly = (y1 + y2) / 2 + 4 }
        else if (Math.abs(a.x - b.x) < 2) { const cx = a.x + W / 2 + 40; dpath = `M ${a.x + 30} ${y1} C ${cx} ${y1 + 40}, ${cx} ${y2 - 40}, ${b.x + 30} ${y2}`; lx = cx + 6; ly = (y1 + y2) / 2 }
        else {
          const sx = a.x + (b.x > a.x ? 30 : -30)
          dpath = `M ${sx} ${y1} C ${sx} ${y1 + 38}, ${b.x} ${y2 - 38}, ${b.x} ${y2}`
          // 字摆在离中线远的那一侧：两条线从左右汇到一个状态时，字各在外面，不叠在一起
          const outerLeft = (sx + b.x) / 2 < cx0
          anchor = outerLeft ? 'end' : 'start'; lx = (sx + b.x) / 2 + (outerLeft ? -14 : 14); ly = (y1 + y2) / 2 + 2
        }
      } else if (b.r < a.r) {
        const k = backN[t.to] = (backN[t.to] ?? 0) + 1
        const cx = Math.min(a.x, b.x) - W / 2 - 34 - (a.r - b.r) * 18 - k * 6
        const y1 = a.y + 4 + k * 3, y2 = b.y - 6 + k * 5
        dpath = `M ${a.x - W / 2} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${b.x - W / 2 - 2} ${y2}`
        anchor = 'end'; lx = cx + (Math.min(a.x, b.x) - W / 2 - cx) * 0.25 - 4; ly = (y1 + y2) / 2 + 4
      } else {
        const dir = b.x > a.x ? 1 : -1
        dpath = `M ${a.x + dir * W / 2} ${a.y} L ${b.x - dir * (W / 2 + 2)} ${b.y}`; anchor = 'middle'; lx = (a.x + b.x) / 2; ly = a.y - 8
      }
    }
    const ev = t.event?.title ?? ''
    grow(lx, textW(ev), anchor)
    if (t.trigger) grow(lx, textW(`〔${t.trigger.aggregate}〕${t.trigger.event}`), anchor)
    g += `<g class="tr${t.trigger ? ' ext' : ''}" data-i="${i}"><path class="vis" d="${dpath}" marker-end="url(#${t.trigger ? 'ahx' : 'ah'})"/><path class="hit" d="${dpath}"/>
      ${t.trigger ? `<text class="srcl" x="${lx}" y="${ly - 16}" text-anchor="${anchor}">〔${esc(t.trigger.aggregate)}〕${esc(t.trigger.event)}</text>` : ''}
      <text x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(ev)}</text></g>`
  })
  const svg = document.getElementById('svg')
  const w = maxX - minX, h = maxY + 20
  svg.setAttribute('viewBox', `${minX} 0 ${w} ${h}`); svg.setAttribute('width', w); svg.setAttribute('height', h)
  svg.innerHTML = g
  svg.onclick = (e) => { const n = e.target.closest('.tr'); if (n) pick(d, +n.dataset.i) }

  // 原话：按在转移里第一次出现的先后排
  const ids = [...new Set(trans.flatMap((t) => t.traces ?? []))]
  document.getElementById('biz').innerHTML = ids.length
    ? ids.map((id) => `<li data-id="${esc(id)}" class="${DATA.statements[id] ? '' : 'miss'}"><b>${esc(id)}</b>${esc(DATA.statements[id] ?? '业务里找不到这个编号')}</li>`).join('')
    : '<li class="miss">转移上还没挂业务编号</li>'
  const outs = [...new Map(trans.map((t) => [t.event?.title, t])).values()]
  document.getElementById('out').innerHTML = outs.map((t) => `<li><span class="ev">${esc(t.event?.title)}</span>${t.event?.name ? `<span class="tag">${esc(t.event.name)}</span>` : ''}<span class="tag">${t.from ? esc(label(t.from)) : '●'} → ${esc(label(t.to))}</span></li>`).join('')
  const ins = trans.filter((t) => t.trigger)
  document.getElementById('in').innerHTML = ins.length ? ins.map((t) => `<li><span class="srcl">〔${esc(t.trigger.aggregate)}〕${esc(t.trigger.event)}</span><span class="tag">${esc(label(t.from))} → ${esc(label(t.to))}</span></li>`).join('') : '<li class="note">没有</li>'
  pick(d, picked ?? (trans.findIndex((t) => t.from !== null) >= 0 ? trans.findIndex((t) => t.from !== null) : 0))
}

/** 出处编号（故事的步骤、关系的线）→ 一个点得过去的链接；找不到的照原样标出来 */
function refLinks(refs) {
  return (refs ?? []).map((r) => {
    const t = DATA.refTargets?.[r]
    return t ? `<a href="${t.page}#${encodeURIComponent(t.file)}#${encodeURIComponent(t.id)}">${esc(r)} ${esc(t.title)}</a>` : `<span class="miss">${esc(r)}（故事、关系里都找不到）</span>`
  }).join('<br>')
}

function pick(d, i) {
  const trans = d.lifecycle?.transitions ?? []
  const t = trans[i]
  const det = document.getElementById('detail')
  if (!t) { det.innerHTML = '<h4>还没有转移</h4>'; return }
  picked = i
  const svg = document.getElementById('svg')
  svg.querySelectorAll('.tr').forEach((n) => {
    const on = +n.dataset.i === i
    n.classList.toggle('on', on)
    n.querySelector('path.vis').setAttribute('marker-end', `url(#${on ? 'aha' : (trans[+n.dataset.i].trigger ? 'ahx' : 'ah')})`)
  })
  const label = (n) => d.lifecycle.states.find((s) => s.name === n)?.title || n
  document.querySelectorAll('#biz li').forEach((li) => li.classList.toggle('hl', (t.traces ?? []).includes(li.dataset.id)))
  const row = (k, v, cls = '') => v ? `<dt>${k}</dt><dd class="${cls}">${esc(v)}</dd>` : ''
  det.innerHTML = `<h4>${t.from ? esc(label(t.from)) : '●'} → ${esc(label(t.to))}</h4><dl>
    ${t.trigger ? row('引起它的', `〔${t.trigger.aggregate}〕${t.trigger.event}`, 'srcl') : ''}
    ${row('要满足', t.requires || '—')}
    ${row('带来的变化', t.changes)}
    ${row('发出', t.event?.title + (t.event?.name ? `（${t.event.name}）` : ''), 'ev')}
    ${row('业务编号', (t.traces ?? []).join('、') || '—')}
    ${(t.refs ?? []).length ? `<dt>出处</dt><dd>${refLinks(t.refs)}</dd>` : ''}</dl>`
}

/* ---------- 时序图 ---------- */
const LEFT = 230, SLOT = 236, HEAD = 56, GAP = 46

function laneLayout(d) {
  const seq = d.sequence ?? { participants: [], phases: [], steps: [], links: [] }
  const steps = seq.steps
  const row = {}, slot = {}
  let r = -1
  for (const s of steps) {
    if (s.alongside && row[s.alongside] !== undefined) { row[s.id] = row[s.alongside]; slot[s.id] = 1 + steps.filter((x) => x.alongside === s.alongside && steps.indexOf(x) < steps.indexOf(s)).length }
    else { row[s.id] = ++r; slot[s.id] = 0 }
  }
  const slots = {}
  for (const s of steps) slots[s.by] = Math.max(slots[s.by] ?? 1, slot[s.id] + 1)
  const laneX = {}
  let x = LEFT
  seq.participants.forEach((p) => { laneX[p.id] = x; x += SLOT * (slots[p.id] ?? 1) })
  return { seq, row, slot, slots, laneX, width: x, rows: r + 1 }
}

function renderLanes(d) {
  const L = laneLayout(d)
  const el = document.getElementById('lanes')
  const color = (i) => `var(--lane-${(i % 5) + 1})`
  let h = ''
  L.seq.participants.forEach((p, i) => {
    h += `<div class="lane-h" style="--c:${color(i)};left:${L.laneX[p.id]}px;width:${SLOT * ((L.slots[p.id] ?? 1) - 1) + 200}px"><b>${esc(p.title)}</b><span>${esc(p.note ?? '')}</span></div>`
  })
  const stateTitle = (n) => d.lifecycle?.states?.find((s) => s.name === n)?.title || n
  for (const s of L.seq.steps) {
    const li = L.seq.participants.findIndex((p) => p.id === s.by)
    const who = (L.seq.participants[li]?.title ?? s.by) + (s.to ? ' → ' + s.to : '')
    h += `<div class="lc" id="lc-${esc(s.id)}" style="--c:${color(Math.max(li, 0))};left:${(L.laneX[s.by] ?? LEFT) + L.slot[s.id] * SLOT}px;top:0">
      <div class="w">${esc(who)}</div><span class="k">${esc(s.id)}</span><b>${esc(s.title)}</b>
      ${s.state || s.event ? `<div class="s">${s.state ? `<span class="state">${esc(stateTitle(s.state))}</span>` : ''}${s.event ? `<span class="ev">${esc(s.event)}</span>` : '<span class="ev" style="color:var(--ink-3)">状态不变</span>'}</div>` : ''}</div>`
  }
  el.querySelectorAll('.lane-h,.lc,.phase,.phase-line,.lane-line').forEach((n) => n.remove())
  el.insertAdjacentHTML('beforeend', h)
  el._layout = L
}

function wireLanes() {
  const el = document.getElementById('lanes'), svg = document.getElementById('lw')
  if (!el || !el._layout || !el.getBoundingClientRect().width) return
  const L = el._layout, steps = L.seq.steps
  if (!steps.length) { el.style.height = '80px'; svg.innerHTML = ''; return }
  const card = (id) => document.getElementById('lc-' + id)
  const rowH = Array(L.rows).fill(0)
  for (const s of steps) rowH[L.row[s.id]] = Math.max(rowH[L.row[s.id]], card(s.id).offsetHeight)
  const rowTop = []; { let y = HEAD + 14; for (let r = 0; r < L.rows; r++) { rowTop.push(y); y += rowH[r] + GAP } }
  for (const s of steps) card(s.id).style.top = rowTop[L.row[s.id]] + 'px'
  const width = L.width, height = rowTop[L.rows - 1] + rowH[L.rows - 1] + 20
  el.style.width = width + 'px'; el.style.height = height + 'px'

  el.querySelectorAll('.phase,.phase-line,.lane-line').forEach((n) => n.remove())
  let h = ''
  L.seq.phases.forEach((ph, i) => {
    const rows = steps.filter((s) => s.phase === ph.id).map((s) => L.row[s.id])
    if (!rows.length) return
    const r0 = Math.min(...rows), r1 = Math.max(...rows)
    const top = rowTop[r0] - GAP / 2 + 4, bot = rowTop[r1] + rowH[r1] + GAP / 2 - 4
    h += `<div class="phase" style="top:${top}px;height:${bot - top}px">${esc(ph.title)}<span>${esc(ph.note ?? '')}</span></div>`
    if (r0) h += `<div class="phase-line" style="top:${rowTop[r0] - GAP / 2}px;width:${width}px"></div>`
  })
  Object.values(L.laneX).slice(1).forEach((x) => { h += `<div class="lane-line" style="left:${x - 18}px;top:0;height:${height}px"></div>` })
  el.insertAdjacentHTML('afterbegin', h)

  const box = (id) => { const n = card(id); return n && { l: n.offsetLeft, r: n.offsetLeft + n.offsetWidth, t: n.offsetTop, b: n.offsetTop + n.offsetHeight, cx: n.offsetLeft + n.offsetWidth / 2 } }
  let p = `<defs>
    <marker id="la" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)"/></marker>
    <marker id="lac" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--cond)"/></marker>
    <marker id="lab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-3)"/></marker></defs>`
  let backN = 0
  for (const k of L.seq.links) {
    const a = box(k.from), b = box(k.to); if (!a || !b) continue
    if (k.kind === 'back') {
      backN++
      const x = Math.min(a.l, b.l) - 8 - backN * 10, y1 = a.t + 20 + backN * 12, y2 = b.t + 20 + backN * 12
      p += `<path class="back" d="M ${a.l} ${y1} L ${x} ${y1} L ${x} ${y2} L ${b.l - 2} ${y2}" marker-end="url(#lab)"/>`
      if (k.label) p += `<text x="${x - 4}" y="${y1 - 4}" text-anchor="end">${esc(k.label)}</text>`
      continue
    }
    const x1 = a.cx, y1 = a.b, x2 = b.cx, y2 = b.t - 2
    const dpath = Math.abs(x1 - x2) < 2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${y1 + 30}, ${x2} ${y2 - 30}, ${x2} ${y2}`
    const cond = k.kind === 'condition'
    p += `<path class="${cond ? 'cond' : ''}" d="${dpath}" marker-end="url(#${cond ? 'lac' : 'la'})"/>`
    if (k.label) p += `<text class="${cond ? 'cond' : ''}" x="${x1 + 8}" y="${(y1 + y2) / 2 + 4}">${esc(k.label)}</text>`
  }
  svg.setAttribute('width', width); svg.setAttribute('height', height)
  svg.innerHTML = p
}

window.addEventListener('resize', () => { wireAttr(); wireLanes() })
window.addEventListener('hashchange', load)
poll('agg/stamp', load)
load()
