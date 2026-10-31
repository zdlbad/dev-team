// 全局图：两层——上一层业务主题之间，下一层一个主题里面。画法 2026-10-31 定下（ui/guideline.md）。
// 数据来自 /map/data：工具把 business/概念/*.json 合并成数据、角色、线；主题怎么分、位置、主题间的交流、哪一样手挪，业务分析写在 business/全局图.json
let GROUPS = [], TOP_EDGES = [], NODES = [], EDGES = [], UNASSIGNED = [], UNKNOWN = [], MISSING = null
let byId = {}, grpOf = {}
const TW = 360, TH = 190
const W = 180, H = 50
let view = ''      // '' 是上一层；主题 id 是下一层
let focus = null
let pinnedEdge = null
const app = document.getElementById('app')

async function load() {
  const d = await getJson('map/data')
  GROUPS = d.topics; TOP_EDGES = d.topEdges; NODES = d.nodes; EDGES = d.edges; UNASSIGNED = d.unassigned; UNKNOWN = d.unknown ?? []; MISSING = d.missing
  byId = Object.fromEntries(NODES.map((n) => [n.id, n]))
  grpOf = Object.fromEntries(GROUPS.map((g) => [g.id, g]))
  const want = decodeURIComponent(location.hash.slice(1))
  view = grpOf[want] ? want : ''
  render()
}

/** 两个框之间的线：目标在右边就从右边出、左边进；往回的从左边出、右边进；上下的从底边出、顶边进 */
function path(a, b) {
  const ax2 = a.x + a.w, bx1 = b.x
  if (bx1 - ax2 >= 40) { const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, dx = (bx1 - ax2) * 0.5; return { d: `M ${ax2} ${y1} C ${ax2 + dx} ${y1}, ${bx1 - dx} ${y2}, ${bx1 - 2} ${y2}`, lx: (ax2 + bx1) / 2, ly: (y1 + y2) / 2 } }
  if (a.x - (b.x + b.w) >= 40) { const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, dx = (a.x - b.x - b.w) * 0.5; return { d: `M ${a.x} ${y1} C ${a.x - dx} ${y1}, ${b.x + b.w + dx} ${y2}, ${b.x + b.w + 2} ${y2}`, lx: (a.x + b.x + b.w) / 2, ly: (y1 + y2) / 2 } }
  const down = b.y > a.y
  const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2, y1 = down ? a.y + a.h : a.y, y2 = down ? b.y - 2 : b.y + b.h + 2, dy = (y2 - y1) * 0.5
  return { d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 }
}
const MARK = `<defs><marker id="la" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-3)"/></marker>
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)"/></marker>
  <marker id="aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/></marker></defs>`

const tint = (g) => `fill:var(--c${g.c});stroke:var(--c${g.c}l)`
/** 三次贝塞尔上 t 处的点 */
const bez = (p0, p1, p2, p3, t) => { const m = 1 - t; return { x: m ** 3 * p0.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t ** 3 * p3.x, y: m ** 3 * p0.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t ** 3 * p3.y } }
/** 线的几何：路径字符串加上四个控制点 */
function curve(a, b) {
  const ax2 = a.x + a.w, bx1 = b.x
  let p0, p1, p2, p3
  if (bx1 - ax2 >= 40) { const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, dx = (bx1 - ax2) * 0.5; p0 = { x: ax2, y: y1 }; p1 = { x: ax2 + dx, y: y1 }; p2 = { x: bx1 - dx, y: y2 }; p3 = { x: bx1 - 2, y: y2 } }
  else if (a.x - (b.x + b.w) >= 40) { const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, dx = (a.x - b.x - b.w) * 0.5; p0 = { x: a.x, y: y1 }; p1 = { x: a.x - dx, y: y1 }; p2 = { x: b.x + b.w + dx, y: y2 }; p3 = { x: b.x + b.w + 2, y: y2 } }
  else { const down = b.y > a.y; const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2, y1 = down ? a.y + a.h : a.y, y2 = down ? b.y - 2 : b.y + b.h + 2, dy = (y2 - y1) * 0.5; p0 = { x: x1, y: y1 }; p1 = { x: x1, y: y1 + dy }; p2 = { x: x2, y: y2 - dy }; p3 = { x: x2, y: y2 } }
  return { d: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`, at: (t) => bez(p0, p1, p2, p3, t) }
}
const textW = (s) => s.replace(/[^\x00-\xff]/g, 'xx').length * 6
/** 文字框：中心在 (cx, cy)，几行字；给了 anchor 就画一条短虚线指过去。返回 svg 和它占的矩形 */
function wrap(lines, max = 10) {
  const out = []
  for (const l of lines) {
    let s = l
    while (s.length > max) {
      // 在逗号、顿号后面断，断不了就硬断
      let cut = -1
      for (let i = Math.min(max, s.length - 1); i >= 6; i--) if ('，、；：'.includes(s[i - 1])) { cut = i; break }
      if (cut < 0) cut = max
      out.push(s.slice(0, cut)); s = s.slice(cut)
    }
    if (s) out.push(s)
  }
  return out
}
function labelBox(cx, cy, lines0, anchor) {
  const lines = wrap(lines0)
  const w = Math.max(...lines.map(textW)) + 18, hh = lines.length * 16 + 8
  const x = cx - w / 2, y = cy - hh / 2
  let s = '', lead = null
  if (anchor) {
    // 从框边上离锚点最近的那一点连过去
    const ex = Math.max(x, Math.min(anchor.x, x + w)), ey = Math.max(y, Math.min(anchor.y, y + hh))
    lead = { x: ex, y: ey }
    s += `<path d="M ${ex} ${ey} L ${anchor.x} ${anchor.y}" marker-end="url(#la)"/>`
  }
  s += `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="6"/>` + lines.map((l, i) => `<text x="${cx}" y="${y + 16 + i * 16}" text-anchor="middle">${esc(l)}</text>`).join('')
  return { svg: `<g class="lb">${s}</g>`, box: { x, y, w, h: hh }, lead, anchor }
}
const overlaps = (a, b) => !(a.x + a.w < b.x - 8 || b.x + b.w < a.x - 8 || a.y + a.h < b.y - 8 || b.y + b.h < a.y - 8)
/** 给一条线挑文字框的位置：先试线的中点，挡住了往两头挪、往上下挪，直到不跟已经摆好的框和主题框碰 */
const TRIES_ON = [[0.5, 0, -44], [0.5, 0, 44], [0.35, 0, -44], [0.65, 0, -44], [0.35, 0, 44], [0.65, 0, 44], [0.5, 0, -80], [0.5, 0, 80]]
// 下一层：字不压在线上，有虚线指着，上下左右哪儿空放哪儿
const TRIES_AROUND = [[0.5, -90, -44], [0.5, 90, -44], [0.5, -90, 44], [0.5, 90, 44], [0.35, -90, -44], [0.65, 90, -44], [0.35, -90, 44], [0.65, 90, 44], [0.5, -140, -60], [0.5, 140, -60], [0.5, -140, 60], [0.5, 140, 60], [0.2, -90, -44], [0.8, 90, -44], [0.2, -90, 44], [0.8, 90, 44], [0.5, 0, -80], [0.5, 0, 80]]
/** 这一点是不是贴着别的线（交叉处附近）：别的线每隔一小段取点比距离 */
function nearOther(p, others, dist = 26) {
  for (const o of others ?? []) for (let t = 0.05; t < 1; t += 0.05) { const q = o.at(t); if (Math.hypot(q.x - p.x, q.y - p.y) < dist) return true }
  return false
}
/** 线上中间附近、不挨着别的线的那一点；都挨着就取正中 */
function anchorT(cv, others, prefer = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
  return prefer.find((t) => !nearOther(cv.at(t), others)) ?? 0.5
}
/** 框有没有被哪条线穿过：每条线每隔一小段取点，落进框（外扩 6）就算穿过 */
function lineHits(box, curves) {
  const b = { x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12 }
  for (const c of curves ?? []) for (let t = 0.02; t < 1; t += 0.03) { const q = c.at(t); if (q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h) return true }
  return false
}
const RINGS = [[-90, -50], [90, -50], [-90, 50], [90, 50], [0, -60], [0, 60], [-140, 0], [140, 0], [-150, -80], [150, -80], [-150, 80], [150, 80], [0, -110], [0, 110], [-220, 0], [220, 0], [-220, -100], [220, -100], [-220, 100], [220, 100], [0, -170], [0, 170], [-300, 0], [300, 0], [-300, -140], [300, -140], [-300, 140], [300, 140], [0, -230], [0, 230], [-150, -200], [150, -200], [-150, 200], [150, 200]]
const TS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]
/** 线上离这个框最近、又不挨着别的线的那一点：虚线就连到这儿 */
function nearestAnchor(cv, box, others) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2
  let best = null
  for (let t = 0.12; t <= 0.88; t += 0.04) {
    const p = cv.at(t)
    if (nearOther(p, others)) continue
    const d = Math.hypot(p.x - cx, p.y - cy)
    if (!best || d < best.d) best = { p, d }
  }
  return best?.p ?? cv.at(0.5)
}
/** 虚线这一段有没有穿过别的线：别的线取点，看离线段多近 */
function leaderCrosses(a, b, others) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1
  for (const c of others ?? []) for (let t = 0.02; t < 1; t += 0.03) {
    const q = c.at(t), u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2))
    if (Math.hypot(q.x - (a.x + u * dx), q.y - (a.y + u * dy)) < 9) return true
  }
  return false
}
function placeLabel(cv, lines, taken, tries = TRIES_ON, reserveAbove = 0, others = []) {
  let best = null
  const all = [cv, ...others]
  const cands = [...tries]
  for (const [dx, dy] of RINGS) for (const t of TS) cands.push([t, dx, dy])
  for (const [t, dx, dy] of cands) {
    const p = cv.at(t)
    const probe = labelBox(p.x + dx, p.y + dy, lines, null)
    const lb = labelBox(p.x + dx, p.y + dy, lines, nearestAnchor(cv, probe.box, others))
    const need = reserveAbove ? { x: lb.box.x, y: lb.box.y - reserveAbove, w: lb.box.w, h: lb.box.h + reserveAbove } : lb.box
    const boxes = taken.filter((b) => overlaps(b, need)).length
    const hits = lineHits(need, all) ? 1 : 0
    const cross = lb.lead && leaderCrosses(lb.lead, lb.anchor, others) ? 1 : 0
    if (!boxes && !hits && !cross) { taken.push(need); return lb }
    const score = boxes * 10 + hits * 4 + cross * 3 + Math.hypot(dx, dy) / 100
    if (!best || score < best.score) best = { lb, need, score }
  }
  taken.push(best.need)
  return best.lb
}

// ---------- 页面 ----------
// ---------- 上一层：主题之间 ----------
function topEdges() {
  const map = {}
  for (const e of EDGES) {
    const a = byId[e.from].g, b = byId[e.to].g
    if (a === b) continue
    const k = a + '>' + b
    ;(map[k] ??= { from: a, to: b, items: [] }).items.push(e)
  }
  return Object.values(map)
}
function drawTop() {
  const rect = (g) => ({ x: g.tx, y: g.ty, w: TW, h: TH })
  const tes = TOP_EDGES
  let s = MARK
  const taken = GROUPS.map(rect)
  let labels = ''
  const geo = tes.map((t) => curve(rect(grpOf[t.from]), rect(grpOf[t.to])))
  tes.forEach((t, i) => {
    const cv = geo[i], k = t.from + '>' + t.to, others = geo.filter((_, j) => j !== i)
    s += `<g class="ed" data-t="${k}"><path class="vis" d="${cv.d}" marker-end="url(#a)"/><path class="hit" d="${cv.d}"/></g>`
    const A = rect(grpOf[t.from]), B = rect(grpOf[t.to])
    const horizontal = Math.abs(A.y - B.y) < 100, vertical = Math.abs(A.x - B.x) < 100
    const tries = horizontal ? [[0.5, 0, -50], [0.5, 0, 50], [0.3, 0, -50], [0.7, 0, -50], [0.3, 0, 50], [0.7, 0, 50], [0.5, 0, -100], [0.5, 0, 100], [0.3, 0, 100], [0.7, 0, 100], [0.3, 0, -100], [0.7, 0, -100]]
      : vertical ? [[0.5, -130, 0], [0.5, 130, 0], [0.3, -130, 0], [0.7, -130, 0], [0.3, 130, 0], [0.7, 130, 0], [0.5, -220, 0], [0.5, 220, 0]]
      : [[0.25, -150, 0], [0.25, 150, 0], [0.75, -150, 0], [0.75, 150, 0], [0.2, 0, -70], [0.8, 0, 70], [0.25, -220, 0], [0.25, 220, 0], [0.75, -220, 0], [0.75, 220, 0], [0.5, -260, 0], [0.5, 260, 0]]
    labels += placeLabel(cv, t.label.split('；'), taken, tries, 0, others).svg
  })
  for (const g of GROUPS) {
    const n = NODES.filter((x) => x.g === g.id).length
    s += `<g class="tp" data-g="${g.id}"><rect x="${g.tx}" y="${g.ty}" width="${TW}" height="${TH}" rx="10" style="${tint(g)}"/>
      <text class="t" x="${g.tx + 18}" y="${g.ty + 34}">${esc(g.title)}</text>
      ${g.does.map((d, i) => `<text class="d" x="${g.tx + 18}" y="${g.ty + 66 + i * 24}">· ${esc(d)}</text>`).join('')}
      <text class="c" x="${g.tx + 18}" y="${g.ty + TH - 16}">${n} 样数据 · 点进去看</text></g>`
  }
  s += labels
  const svg = document.getElementById('svg')
  svg.setAttribute('width', Math.max(...GROUPS.map((g) => g.tx)) + TW + 40); svg.setAttribute('height', Math.max(...GROUPS.map((g) => g.ty)) + TH + 40)
  svg.innerHTML = s
}

// ---------- 下一层：一个主题里面 ----------
function pill(role, x, y, on) {
  const w = role.replace(/[^\x00-\xff]/g, 'xx').length * 5.6 + 14
  return { w, svg: `<g class="rl${on ? ' lit' : ''}" data-r="${esc(role)}"><rect x="${x}" y="${y}" width="${w}" height="20" rx="10"/><text x="${x + w / 2}" y="${y + 14}" text-anchor="middle">${esc(role)}</text></g>` }
}
function pills(roles, x, y, isLit) {
  let out = '', cx = x
  for (const r of roles ?? []) { const p = pill(r, cx, y, isLit(r)); out += p.svg; cx += p.w + 4 }
  return out
}
/** 做这件事的角色骑在线的中点上；占的地方记进 taken，文字框绕开它 */
function rolesOnLine(e, cv, taken, others = []) {
  if (!e.by?.length) return ''
  const total = e.by.reduce((t, r) => t + pill(r, 0, 0).w + 4, -4)
  let box = null
  for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
    const p = cv.at(t)
    const b = { x: p.x - total / 2, y: p.y - 10, w: total, h: 20 }
    box ??= b
    if (nearOther(p, others)) continue
    if (!taken.some((o) => overlaps(o, b))) { box = b; break }
  }
  taken.push(box)
  return pills(e.by, box.x, box.y, () => false)
}
function drawLocal(g) {
  const mine = NODES.filter((n) => n.g === g.id)
  const edges = EDGES.filter((e) => byId[e.from].g === g.id || byId[e.to].g === g.id)
  const inG = (id) => byId[id].g === g.id
  const ROW = 130, COLW = 380, TROW = 140, STUB_ROW = 105, Y0 = 110, GAP = 240, PAD = 70
  const pos = {}
  const place = (id, x, y, k, stub) => { pos[id] = { x, y, w: W, h: stub ? 40 : H, stub, k } }

  // 一、主题里上下层级的（tree 线连着的）画成树：上一层在上、下一层在下，同一层横着排
  const treeEdges = edges.filter((e) => e.tree && inG(e.from) && inG(e.to))
  const treeIds = new Set(treeEdges.flatMap((e) => [e.from, e.to]))
  const level = {}
  const roots = [...treeIds].filter((id) => !treeEdges.some((e) => e.to === id))
  const walk = (id, l) => { level[id] = Math.max(level[id] ?? 0, l); treeEdges.filter((e) => e.from === id).forEach((e) => walk(e.to, l + 1)) }
  roots.forEach((r) => walk(r, 0))
  const rows = []
  for (const id of treeIds) (rows[level[id]] ??= []).push(id)
  const treeW = rows.length ? Math.max(...rows.map((r) => r.length)) * (W + 40) - 40 : 0

  // 二、别的数据按先后分列，摆在树的右边
  const rest = mine.filter((n) => !treeIds.has(n.id))
  const depth = {}
  const dep = (id, seen = new Set()) => {
    if (depth[id] !== undefined) return depth[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const preds = edges.filter((e) => e.to === id && inG(e.from) && !treeIds.has(e.from)).map((e) => e.from)
    return (depth[id] = preds.length ? Math.max(...preds.map((p) => dep(p, seen) + 1)) : 0)
  }
  rest.forEach((n) => dep(n.id))
  const cols = []
  for (const n of rest) (cols[depth[n.id]] ??= []).push(n.id)
  cols.forEach((c) => c.sort((a, b) => byId[a].y - byId[b].y))

  // 三、别的主题里连着的：只连进来的在左，其余在右
  const outside = [...new Set(edges.flatMap((e) => [e.from, e.to]).filter((id) => !inG(id)))]
  const leftIds = outside.filter((id) => edges.some((e) => e.from === id) && !edges.some((e) => e.to === id))
  const rightIds = outside.filter((id) => !leftIds.includes(id))

  // 摆：左虚框 | 树 | 几列 | 右虚框。主题框只包住自己的数据，不跟着虚框撑高
  const X_IN = leftIds.length ? 40 + W + GAP : rightIds.length ? 40 + (W + GAP) / 2 : 60
  const extraRight = !rightIds.length && leftIds.length ? (W + GAP) / 2 : 0
  const treeH = rows.length ? rows.length * TROW - (TROW - H) : 0
  const colsH = cols.length ? Math.max(...cols.map((c) => c.length)) * ROW - (ROW - H) : 0
  const innerH = Math.max(treeH, colsH, H)
  let x = X_IN, k = 1
  if (rows.length) {
    rows.forEach((r, l) => {
      const rw = r.length * (W + 40) - 40, x0 = x + (treeW - rw) / 2
      r.forEach((id, i) => place(id, x0 + i * (W + 40), Y0 + (innerH - treeH) / 2 + l * TROW, k, false))
    })
    x += treeW + 200; k++
  }
  cols.forEach((c, ci) => {
    const ch = c.length * ROW - (ROW - H)
    const dy = cols.length > 1 ? (ci % 2 ? 1 : -1) * 70 : 0
    const y0 = Y0 + (innerH - ch) / 2 + dy
    // nudge：人手指定的上下挪动，让开压在它身上的线；只动上下，先后（左右）不动
    c.forEach((id, i) => place(id, x + (cols.length === 1 && c.length > 1 ? (i % 2) * 140 : 0), y0 + i * ROW + (byId[id].nudge || 0), k, false))
    x += COLW; k++
  })
  const innerIds = mine.map((n) => n.id)
  const bx1 = Math.min(...innerIds.map((id) => pos[id].x)), by1 = Math.min(...innerIds.map((id) => pos[id].y)), bx2 = Math.max(...innerIds.map((id) => pos[id].x + W)), by2 = Math.max(...innerIds.map((id) => pos[id].y + H))
  // 左右留 44，顶上留出写主题名的地方，底下 40
  const frame = { x: bx1 - 44, y: by1 - 58, w: bx2 - bx1 + 88, h: by2 - by1 + 98 }
  const column = (ids, cx, kk) => {
    if (!ids.length) return
    const anchor = (id) => { const ns = edges.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? e.to : e.from)).filter(inG); return ns.length ? ns.reduce((s, n) => s + pos[n].y, 0) / ns.length : 0 }
    ids.sort((a, b) => anchor(a) - anchor(b))
    const hgt = ids.length * STUB_ROW - (STUB_ROW - 40), y0 = frame.y + (frame.h - hgt) / 2
    ids.forEach((id, i) => place(id, cx, Math.max(16, y0) + i * STUB_ROW, kk, true))
  }
  column(leftIds, 40, 0)
  column(rightIds, frame.x + frame.w + GAP - 40, k)
  const minY = Math.min(frame.y, ...Object.values(pos).map((p) => p.y - 14))
  if (minY < 24) { const dy = 24 - minY; frame.y += dy; for (const p of Object.values(pos)) p.y += dy }

  // 几条线汇到同一个框、或从同一个框分出去，端点在框的边上错开
  const inTo = {}, outFrom = {}
  for (const e of edges) { (inTo[e.to] ??= []).push(e); (outFrom[e.from] ??= []).push(e) }
  for (const list of Object.values(outFrom)) list.sort((a, b) => pos[a.to].y - pos[b.to].y)
  for (const list of Object.values(inTo)) list.sort((a, b) => pos[a.from].y - pos[b.from].y)
  // 同一个框同一边上的线（进来的、出去的一起算）串着排：按对面那头的高低，从上到下占这条边上的位置
  const sideOf = (e, id) => (e.from === id ? (pos[e.to].x > pos[e.from].x ? 'r' : 'l') : (pos[e.to].x > pos[e.from].x ? 'l' : 'r'))
  const farY = (e, id) => pos[e.from === id ? e.to : e.from].y
  const onSide = {}
  for (const e of edges) if (!e.tree) for (const id of [e.from, e.to]) (onSide[id + sideOf(e, id)] ??= []).push(e)
  for (const [key, list] of Object.entries(onSide)) list.sort((a, b) => farY(a, key.slice(0, -1)) - farY(b, key.slice(0, -1)))
  const slot = (e, id, p) => { const list = onSide[id + sideOf(e, id)]; return list.length > 1 ? p.y + p.h * (list.indexOf(e) + 1) / (list.length + 1) : p.y + p.h / 2 }
  let s = MARK
  s += `<g class="grp"><rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="12" style="${tint(g)};fill-opacity:.45"/><text x="${frame.x + 14}" y="${frame.y + 20}">${esc(g.title)}</text></g>`
  const taken = mine.map((n) => pos[n.id]).concat(outside.map((id) => pos[id]))
  for (const n of mine) if (n.by?.length) taken.push({ x: pos[n.id].x, y: pos[n.id].y - 12, w: W, h: 14 })
  let labels = ''
  const geo = []
  for (const e of edges) {
    const a = pos[e.from], b = pos[e.to]
    let d, cv
    if (e.tree) {
      // 树的连线：从上一层底边中间下来，拐到下一层顶边中间
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y - 2, ym = (y1 + y2) / 2
      d = `M ${x1} ${y1} L ${x1} ${ym} L ${x2} ${ym} L ${x2} ${y2}`
      cv = { at: () => ({ x: x2, y: ym }) }
    } else {
      const y1 = slot(e, e.from, a)
      const y2 = slot(e, e.to, b)
      if (b.x > a.x) {
        const x1 = a.x + a.w, x2 = b.x - 2, dx = (x2 - x1) * 0.5
        const skip = b.k - a.k > 1
        const off = skip ? (y2 >= y1 ? 1 : -1) * (ROW * 0.75 + (inTo[e.to].length > 1 ? inTo[e.to].indexOf(e) * 18 : 0)) : 0
        const p0 = { x: x1, y: y1 }, p1 = { x: x1 + dx * (skip ? 0.7 : 1), y: y1 + off }, p2 = { x: x2 - dx * (skip ? 0.7 : 1), y: y2 + off * 0.6 }, p3 = { x: x2, y: y2 }
        d = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`
        cv = { at: (t) => bez(p0, p1, p2, p3, t) }
      } else {
        const x1 = a.x, x2 = b.x + b.w + 2, dx = (x1 - x2) * 0.5
        const bulge = -60
        const p0 = { x: x1, y: y1 }, p1 = { x: x1 - dx, y: y1 + bulge }, p2 = { x: x2 + dx, y: y2 + bulge }, p3 = { x: x2, y: y2 }
        d = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`
        cv = { at: (t) => bez(p0, p1, p2, p3, t) }
      }
    }
    s += `<g class="ed" data-e="${e.id}"><path class="vis" d="${d}" marker-end="url(#a)"/><path class="hit" d="${d}"/></g>`
    geo.push({ e, cv })
  }
  for (const { e, cv } of geo) {
    const others = geo.filter((x) => x.e !== e).map((x) => x.cv)
    labels += rolesOnLine(e, cv, taken, others)
    labels += placeLabel(cv, [e.label], taken, e.tree ? [[0.5, 110, 0], [0.5, -110, 0], [0.5, 130, 0]] : TRIES_AROUND, 0, others).svg
  }
  for (const n of mine) {
    const p = pos[n.id]
    s += `<g class="nd${n.page ? ' has' : ''}" data-n="${n.id}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="3"/>
      <text x="${p.x + W / 2}" y="${p.y + (n.sub ? 21 : 30)}" text-anchor="middle" style="${n.page ? 'font-weight:600' : ''}">${esc(n.title)}</text>${n.sub ? `<text class="sub" x="${p.x + W / 2}" y="${p.y + 38}" text-anchor="middle">${esc(n.sub.length > 22 ? n.sub.slice(0, 21) + '…' : n.sub)}</text>` : ''}</g>`
    if (n.by?.length) s += pills(n.by, p.x + 6, p.y - 10, () => false)
  }
  for (const id of outside) {
    const p = pos[id], n = byId[id]
    s += `<g class="stub" data-g="${n.g}" data-n="${id}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${p.h}" rx="3" style="${tint(grpOf[n.g])};fill-opacity:.5"/>
      <text x="${p.x + W / 2}" y="${p.y + 17}" text-anchor="middle">${esc(n.title)}</text><text class="sub" x="${p.x + W / 2}" y="${p.y + 32}" text-anchor="middle">${esc(grpOf[n.g].title)} ›</text></g>`
  }
  s += labels
  const svg = document.getElementById('svg')
  svg.setAttribute('width', Math.max(frame.x + frame.w, ...Object.values(pos).map((p) => p.x + p.w)) + 30 + extraRight)
  svg.setAttribute('height', Math.max(frame.y + frame.h, ...Object.values(pos).map((p) => p.y + p.h)) + 30)
  svg.innerHTML = s
}

// ---------- 页面 ----------
function render() {
  const g = grpOf[view]
  const nav = `<aside><h3>全局图</h3><div class="muted">业务分成几个主题，一块一个；点一块看里面的数据、角色和线。</div>
    <ul><li class="${!view ? 'on' : ''}" data-g="">主题之间</li>${GROUPS.map((x) => `<li class="sub${x.id === view ? ' on' : ''}" data-g="${esc(x.id)}">${esc(x.title)}</li>`).join('')}</ul></aside>`
  if (MISSING) {
    app.innerHTML = `<div class="wrap">${nav}<main><div class="empty-page"><h2>还没有全局图</h2><p>${esc(MISSING)}</p></div></main></div>`
    bindNav(); return
  }
  const unassigned = (UNASSIGNED.length ? `<p class="warn">概念里有、还没划进任何主题的数据：${UNASSIGNED.map(esc).join('、')}——业务分析在 <code>business/全局图.json</code> 的主题里加上。</p>` : '')
    + (UNKNOWN.length ? `<p class="warn">主题里点了名、概念里还没有的数据：${UNKNOWN.map(esc).join('、')}——图上画不出来，等业务分析写那张概念。</p>` : '')
  const main = g
    ? `<h1><a href="#" data-g="">全局图</a><span class="sep">›</span>${esc(g.title)}</h1>
       <p class="sub">${esc(g.does.join('；'))}。这一块里的数据和角色，线上写的是关系；虚框是别的主题里跟它连着的数据，点了过去；有自己一张概念的框边粗一点，点了去看。</p>
       <div class="diagram"><svg id="svg"></svg></div>
       <div class="legend"><span><span class="sw round" style="background:var(--role);border-color:var(--role-line)"></span>角色</span><span><span class="sw" style="background:var(--data);border-color:var(--data-line)"></span>数据</span><span><span class="sw dash" style="border-color:var(--topic-line)"></span>别的主题里的数据</span></div>`
    : `<h1>全局图</h1>
       <p class="sub">业务分成几个主题，一个主题一块；块与块之间的线上写主要的业务交流，指着看是底下哪几条。点一块进去看这一块里的数据和角色。</p>
       <div class="diagram"><svg id="svg"></svg></div>${unassigned}`
  app.innerHTML = `<div class="wrap">${nav}<main id="main">${main}</main></div><div class="detail" id="detail" hidden></div>`
  focus = null; pinnedEdge = null
  if (g) drawLocal(g); else drawTop()
  bind(); bindNav()
}
function go(id) { view = grpOf[id] ? id : ''; history.replaceState(null, '', view ? '#' + encodeURIComponent(view) : location.pathname); render() }
function bindNav() {
  app.querySelectorAll('[data-g]').forEach((el) => el.addEventListener('click', (ev) => { ev.preventDefault(); go(el.dataset.g) }))
}

// ---------- 指着、点 ----------
function bind() {
  const svg = document.getElementById('svg'), pop = document.getElementById('detail')
  if (!svg) return
  svg.addEventListener('mousemove', (ev) => {
    const ed = ev.target.closest('.ed[data-t]'), nd = ev.target.closest('.nd'), edl = ev.target.closest('.ed[data-e]')
    if (ed && !view) {
      // 主题之间的线：浮出底下是哪几条细线
      const [a, b] = ed.dataset.t.split('>')
      const items = EDGES.filter((e) => (byId[e.from].g === a && byId[e.to].g === b) || (byId[e.from].g === b && byId[e.to].g === a))
      pop.innerHTML = `<h4>${esc(grpOf[a].title)} ↔ ${esc(grpOf[b].title)}</h4>` + (items.length ? items.map((e) => `<div>${esc(byId[e.from].title)} → ${esc(byId[e.to].title)}：${esc(e.label)}</div>`).join('') : '<div class="muted">概念里还没有连着这两块的线</div>')
    } else if (edl && view) {
      const e = EDGES.find((x) => x.id === edl.dataset.e)
      pop.innerHTML = `<h4>${esc(byId[e.from].title)} → ${esc(byId[e.to].title)}</h4><div>${esc(e.label)}</div>${e.text ? `<div class="muted">${esc(e.text)}</div>` : ''}<div class="muted">出自概念「${esc(e.ref)}」</div>`
    } else if (nd) {
      const n = byId[nd.dataset.n]
      pop.innerHTML = `<h4>${esc(n.title)}</h4>${n.sub ? `<div>${esc(n.sub)}</div>` : ''}<div class="muted">${n.page ? '有自己的一张概念，点了去看' : '还没有自己的一张概念'}</div>`
    } else { pop.hidden = true; return }
    pop.hidden = false
    let x = ev.clientX + 16; if (x + pop.offsetWidth > innerWidth - 8) x = ev.clientX - pop.offsetWidth - 16
    pop.style.left = Math.max(8, x) + 'px'; pop.style.top = Math.max(8, Math.min(ev.clientY - 20, innerHeight - pop.offsetHeight - 8)) + 'px'
  })
  svg.addEventListener('mouseleave', () => { pop.hidden = true })
  svg.addEventListener('click', (ev) => {
    const tp = ev.target.closest('.tp'), stub = ev.target.closest('.stub'), nd = ev.target.closest('.nd')
    if (tp) { go(tp.dataset.g); return }
    if (stub) { go(stub.dataset.g); return }
    if (nd) {
      const n = byId[nd.dataset.n]
      if (!n.page) { toast(`「${n.title}」还没有自己的一张概念`); return }
      // 去概念页：告诉外面的业务页签换到「概念」，自己跳过去
      try { parent.postMessage({ sub: 'concepts' }, '*') } catch (e) {}
      location.href = '/concepts#' + encodeURIComponent(n.page)
    }
  })
}

window.addEventListener('hashchange', () => { const want = decodeURIComponent(location.hash.slice(1)); if ((grpOf[want] ? want : '') !== view) { view = grpOf[want] ? want : ''; render() } })
poll('map/stamp', load)
load()
