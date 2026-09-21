/**
 * 一条竖着的时间轴：左边一栏日子与谁、中间一条线一颗点、右边一张卡片。
 *
 * 为什么抽出来（2026-09-21，项目所有者问「演示那一页可以和走查合并么」）：两页干的不是一回事——走查是一道关，
 * 要勾语句、点同意、裁卡、存回故事文件；演示是一份拿给别人看的稿，没有这些机件。页面不合，**画法合**：
 * 从前两边各写了一套时间轴的样式，同一天里两页各改了一遍才对齐。往后改一次，两页一起变。
 *
 * 用法：
 *   const tl = require('./timeline')
 *   CSS += tl.css({ sel: '.step' })                       // 走查页：步骤本身就是 .step
 *   CSS += tl.css({ sel: '.demo .st', line: '#e6e8eb' })   // 演示页
 *   html += tl.row({ date, who, card })                    // 三个格子：.when / .dot / .card
 * 出的三个格子固定叫 `.when`、`.dot`、`.card`，两页的别的样式都挂在这三个上面。
 * 一段轴的头一行加 `tl-first`、末一行加 `tl-last`，线才收在头尾两颗点上、不出头
 *（用 :first-of-type 不行：那一段轴的上面还有别的 div，第一个 div 不是第一步）。
 */

/**
 * @param {object} o
 * @param {string} o.sel      一行的选择器，例如 '.step' 或 '.demo .st'
 * @param {number} o.when     左边日子那一栏多宽（px）。名字长的（Services Australia）要 118 才装得下
 * @param {number} o.gap      栏与栏之间的间距（px）
 * @param {number} o.dotCol   点那一栏多宽（px）
 * @param {number} o.dot      点的直径（px，不含边）
 * @param {number} o.ring     点的边多粗（px）
 * @param {number} o.top      点的圆心离这一行顶上多远（px）；卡片抬头在哪一行，点就对到哪一行
 * @param {string} o.line     线的颜色
 * @param {number} o.narrow   窄到多少 px 就不画轴、改成一栏
 */
function css(o = {}) {
  const sel = o.sel ?? '.step'
  const when = o.when ?? 118, gap = o.gap ?? 12, dotCol = o.dotCol ?? 28
  const dot = o.dot ?? 14, ring = o.ring ?? 3, top = o.top ?? 25
  const line = o.line ?? '#dfe3e8', narrow = o.narrow ?? 900
  const outer = dot + ring * 2
  const pad = Math.max(0, Math.round((dotCol - outer) / 2)) // 点在它那一栏里居中
  const center = when + gap + pad + outer / 2               // 圆心离这一行左边多远——线要画在这儿
  return `
  ${sel} { display:grid; grid-template-columns:${when}px ${dotCol}px minmax(0,1fr); gap:0 ${gap}px; position:relative; }
  ${sel}::before { content:""; position:absolute; left:${center - 1}px; top:-12px; bottom:-12px; border-left:2px solid ${line}; }
  ${sel}.tl-first::before { top:${top}px; }
  ${sel}.tl-last::before { bottom:auto; height:${top}px; }
  ${sel} > .when { text-align:right; color:var(--muted,#57606a); font-size:12.5px; line-height:1.4; padding-top:${top - 12}px; word-break:break-word; }
  ${sel} > .when b { display:block; color:var(--fg,#1f2328); font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
  ${sel} > .dot { width:${dot}px; height:${dot}px; border-radius:50%; background:#fff; border:${ring}px solid #cfd6dd; margin:${top - outer / 2}px 0 0 ${pad}px; position:relative; z-index:1; transition:border-color .12s, box-shadow .12s; }
  ${sel} > .card { border:1px solid var(--line,#e6e8eb); border-radius:10px; padding:14px 16px; background:#fff; min-width:0; box-shadow:0 1px 2px rgba(31,35,40,.05); transition:box-shadow .12s, border-color .12s; }
  ${sel} > .card:hover { box-shadow:0 1px 3px rgba(31,35,40,.09), 0 6px 16px rgba(31,35,40,.05); }
  @media (max-width:${narrow}px) {
    ${sel} { grid-template-columns:minmax(0,1fr); }
    ${sel}::before, ${sel} > .dot { display:none; }
    ${sel} > .when { text-align:left; padding:0 0 2px; }
  }`
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

/**
 * 一行：日子与谁、点、卡片。`card` 是已经拼好的 HTML（调用的人自己出），别的都当文字转义。
 * @param {object} o
 * @param {string} o.date  日子（粗体那一行）
 * @param {string} o.who   谁做的
 * @param {string} o.card  卡片里的 HTML
 * @param {string} o.cls   这一行的 class，要与 css() 的 sel 对得上（例如 `step agree tl-first`、`st tl-last`）
 * @param {string} o.attrs 加在这一行上的属性，例如 `id="step-3" data-i="2"`
 * @param {string} o.extra 卡片后面再摆一个格子（演示页的留言就摆在这儿），自己用 grid-column 指到第几栏
 */
function row(o = {}) {
  return `<div class="${o.cls ?? ''}"${o.attrs ? ' ' + o.attrs : ''}>` +
    `<div class="when"><b>${esc(o.date)}</b>${esc(o.who)}</div><div class="dot"></div>` +
    `<div class="card">${o.card ?? ''}</div>${o.extra ?? ''}</div>`
}

module.exports = { css, row }
