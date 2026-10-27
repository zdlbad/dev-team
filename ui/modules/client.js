// 模块页：几个模块同时摆着，模块里是成簇的聚合；拖聚合换模块、改模块名与职责，存进 aggregate-design/modules.json
let D = null            // { aggregates, division, version, state, source }
let showAll = store.get('mod-all') === '1'
const app = document.getElementById('app')

async function load() {
  D = await getJson('modules/data')
  render()
}

/** 改了就存：带着读到时的版本号，被别人改过就拒，重取 */
async function save() {
  const r = await postJson('modules/save', { version: D.version, division: D.division })
  if (r.ok) { D.version = r.version; D.state = r.state; renderHead() } else load()
}

const moduleOf = (agg) => D.division.modules.find((m) => m.aggregates.includes(agg))?.name ?? null

function render() {
  const names = Object.keys(D.aggregates)
  app.innerHTML = `<div class="page">
    <header id="head"></header>
    <div class="bar" id="bar"></div>
    <div class="legend" style="margin-bottom:12px"><span>指着一个聚合：</span><span><i class="out"></i>它引用谁</span><span><i class="ext"></i>谁引用它</span><span>指着模块名：看这个模块往外引用的全部</span><span>点线框：还没做聚合设计，引用是从模型字段推的</span></div>
    <div class="stage" id="stage"><svg id="wires"></svg>
      <div class="tray" data-m=""><div class="h">未划<span>还没归进模块的聚合（模型里住在占位模块 Unassigned）</span></div><div class="cards"></div></div>
      <div class="mods" id="mods"></div>
    </div></div>`
  renderHead()
  const mods = document.getElementById('mods')
  mods.innerHTML = D.division.modules.map((m, i) => `<div class="mod" data-m="${esc(m.name)}" data-i="${i}">
      <div class="h"><b contenteditable="plaintext-only" spellcheck="false" data-edit="name">${esc(m.name)}</b><span class="n"></span><button class="del" title="删掉这个空模块">✕</button></div>
      <div class="r" contenteditable="plaintext-only" data-edit="responsibility">${esc(m.responsibility)}</div>
      <div class="cards"></div><div class="deps"></div></div>`).join('') + `<div class="mod add" id="add">＋ 加一个模块</div>`
  const cardHtml = (n) => {
    const a = D.aggregates[n]
    return `<div class="ag${a.designed ? '' : ' nodesign'}" draggable="true" data-a="${esc(n)}">${a.designed ? '<span class="open">↗</span>' : ''}<b>${esc(n)}</b><span>${esc(a.title || '（还没设计）')}</span></div>`
  }
  for (const n of D.division.unassigned) document.querySelector('.tray .cards').insertAdjacentHTML('beforeend', cardHtml(n))
  D.division.modules.forEach((m, i) => { const box = mods.querySelector(`.mod[data-i="${i}"] .cards`); for (const n of m.aggregates) if (D.aggregates[n]) box.insertAdjacentHTML('beforeend', cardHtml(n)) })
  document.querySelectorAll('.cards').forEach((c) => { if (!c.children.length) c.innerHTML = '<div class="empty">空</div>' })
  stats()
  bind()
  requestAnimationFrame(() => draw())
}

function renderHead() {
  const gate = { 未定: '还没定下', 已定: `${esc(D.division.confirmed?.at ?? '')} 定下`, 改过: `${esc(D.division.confirmed?.at ?? '')} 定下以后又改过` }[D.state] ?? ''
  const from = { file: '', model: '照模型里现有的模块摆的，还没存过。', none: '还没有模块，聚合都在「未划」里。' }[D.source]
  document.getElementById('head').innerHTML = `<h1>模块 <span class="badge ${esc(D.state)}">${esc(D.state)}</span></h1>
    <div class="sub">聚合设计做完、业务范围清楚了，把成簇的聚合圈进模块。模块里面引用多、模块之间引用少，就是划得好。${from}</div>
    <div style="display:flex;gap:10px;align-items:center;font-size:12px;color:var(--ink-3)"><button class="act${D.state === '已定' ? ' undo' : ''}" id="confirm">${D.state === '已定' ? '撤销定下' : '定下'}</button><span>${gate}</span></div>`
  document.getElementById('confirm').onclick = async () => {
    const undo = D.state === '已定'
    const r = await postJson('modules/confirm', { version: D.version, undo })
    if (r.ok) toast(undo ? '撤销了，回到没定下' : '模块定下了')
    load()
  }
}

function stats() {
  let inner = 0, cross = 0
  const deps = {}
  for (const [n, a] of Object.entries(D.aggregates)) for (const r of a.refs) {
    if (!D.aggregates[r]) continue
    const m1 = moduleOf(n), m2 = moduleOf(r)
    if (m1 && m1 === m2) inner++
    else if (m1 && m2) { cross++; (deps[m1] ??= {})[m2] = (deps[m1][m2] ?? 0) + 1 }
  }
  document.getElementById('bar').innerHTML = `
    <span>模块 <b>${D.division.modules.length}</b></span><span>聚合 <b>${Object.keys(D.aggregates).length}</b></span><span>未划 <b>${D.division.unassigned.length}</b></span>
    <span>模块里面的引用 <b>${inner}</b></span><span>跨模块的引用 <b>${cross}</b></span>
    <label><input type="checkbox" id="all" ${showAll ? 'checked' : ''}> 画出全部引用</label>`
  document.getElementById('all').onchange = (e) => { showAll = e.target.checked; store.set('mod-all', showAll ? '1' : '0'); draw() }
  D.division.modules.forEach((m, i) => {
    const el = document.querySelector(`.mod[data-i="${i}"]`)
    el.querySelector('.n').textContent = `${m.aggregates.length} 个聚合`
    el.querySelector('.del').hidden = m.aggregates.length > 0
    el.querySelector('.deps').innerHTML = Object.entries(deps[m.name] ?? {}).sort((x, y) => y[1] - x[1]).map(([t, c]) => `<span>→ ${esc(t)} ${c}</span>`).join('')
  })
}

function center(n) {
  const stage = document.getElementById('stage')
  const S = stage.getBoundingClientRect(), el = stage.querySelector(`.ag[data-a="${CSS.escape(n)}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: (r.left + r.right) / 2 - S.left, y: (r.top + r.bottom) / 2 - S.top }
}
function curve(a, b) {
  const p = center(a), q = center(b); if (!p || !q) return null
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1, bend = Math.min(80, len / 3) * 0.4
  return `M ${p.x} ${p.y} Q ${(p.x + q.x) / 2 - dy / len * bend} ${(p.y + q.y) / 2 + dx / len * bend} ${q.x} ${q.y}`
}
function draw(focus) {
  const stage = document.getElementById('stage'), svg = document.getElementById('wires')
  if (!stage) return
  const S = stage.getBoundingClientRect()
  svg.setAttribute('width', S.width); svg.setAttribute('height', S.height)
  stage.querySelectorAll('.ag').forEach((n) => n.classList.remove('on', 'ref-out', 'ref-in'))
  stage.querySelectorAll('.mod').forEach((n) => n.classList.remove('on'))
  const mark = (n, c) => stage.querySelector(`.ag[data-a="${CSS.escape(n)}"]`)?.classList.add(c)
  const line = (a, b, c) => { const d = curve(a, b); return d ? `<path class="${c}" d="${d}"/>` : '' }
  let p = ''
  const A = D.aggregates
  if (showAll && !focus) for (const [n, a] of Object.entries(A)) for (const r of a.refs) if (A[r]) p += line(n, r, 'all' + (moduleOf(n) !== moduleOf(r) ? ' x' : ''))
  if (focus?.agg) {
    const n = focus.agg
    mark(n, 'on')
    for (const r of A[n].refs) if (A[r]) { p += line(n, r, 'out'); mark(r, 'ref-out') }
    for (const [o, a] of Object.entries(A)) if (a.refs.includes(n)) { p += line(o, n, 'in'); mark(o, 'ref-in') }
  }
  if (focus?.mod) {
    stage.querySelector(`.mod[data-m="${CSS.escape(focus.mod)}"]`)?.classList.add('on')
    for (const [n, a] of Object.entries(A)) if (moduleOf(n) === focus.mod) for (const r of a.refs) if (A[r] && moduleOf(r) !== focus.mod) { p += line(n, r, 'out'); mark(r, 'ref-out') }
  }
  svg.innerHTML = p
}

function bind() {
  const stage = document.getElementById('stage')
  stage.addEventListener('mouseover', (e) => {
    const ag = e.target.closest('.ag'); if (ag) return draw({ agg: ag.dataset.a })
    const h = e.target.closest('.mod .h'); if (h) return draw({ mod: h.closest('.mod').dataset.m })
    draw()
  })
  stage.addEventListener('mouseleave', () => draw())
  stage.addEventListener('click', (e) => {
    if (e.target.closest('.open')) { const n = e.target.closest('.ag').dataset.a; location.href = 'agg#' + encodeURIComponent(D.aggregates[n].file) ; return }
    const del = e.target.closest('.del')
    if (del) { const i = +del.closest('.mod').dataset.i; D.division.modules.splice(i, 1); save().then(render); return }
    if (e.target.closest('#add')) {
      let k = 1; while (D.division.modules.some((m) => m.name === 'NewModule' + (k > 1 ? k : ''))) k++
      D.division.modules.push({ name: 'NewModule' + (k > 1 ? k : ''), responsibility: '', aggregates: [] })
      save().then(render)
    }
  })
  // 改模块名、职责：离开那一格就存
  stage.addEventListener('focusout', (e) => {
    const f = e.target.closest('[data-edit]'); if (!f) return
    const m = D.division.modules[+f.closest('.mod').dataset.i]
    const v = f.textContent.trim()
    if (m[f.dataset.edit] === v) return
    m[f.dataset.edit] = v
    save().then(render)
  })
  stage.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-edit]')) { e.preventDefault(); e.target.blur() } })

  let dragId = null
  stage.addEventListener('dragstart', (e) => { const ag = e.target.closest('.ag'); if (!ag) return; dragId = ag.dataset.a; ag.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; document.getElementById('wires').innerHTML = '' })
  stage.addEventListener('dragend', (e) => { e.target.closest('.ag')?.classList.remove('dragging'); stage.querySelectorAll('.drop-on').forEach((n) => n.classList.remove('drop-on')) })
  stage.addEventListener('dragover', (e) => {
    const t = e.target.closest('[data-m]'); if (!t || !dragId || t.id === 'add') return
    e.preventDefault()
    stage.querySelectorAll('.drop-on').forEach((n) => n !== t && n.classList.remove('drop-on'))
    t.classList.add('drop-on')
  })
  stage.addEventListener('drop', (e) => {
    const t = e.target.closest('[data-m]'); if (!t || !dragId) return
    e.preventDefault()
    const div = D.division
    div.unassigned = div.unassigned.filter((n) => n !== dragId)
    for (const m of div.modules) m.aggregates = m.aggregates.filter((n) => n !== dragId)
    if (t.dataset.m) div.modules[+t.dataset.i].aggregates.push(dragId)
    else div.unassigned.push(dragId)
    dragId = null
    render()
    save()
  })
}

window.addEventListener('resize', () => draw())
// 自己存的那一下也会让指纹变；正在改字时不重取，免得把光标冲掉
poll('modules/stamp', () => { if (!document.activeElement?.closest?.('[data-edit]')) load() })
load()
