/**
 * 把项目里的 Markdown（业务、导读）转成 HTML，给工作台「业务」页用。
 * 只认这几样：标题、段落、有序/无序列表（可嵌套）、表格、引用、代码块、分隔线；行内的粗体、斜体、代码、链接。
 * ```mermaid 代码块原样交给页面，页面上画成流程图。
 * 顶层每一块带 data-b：这一块原文的指纹（同样的原文出现几次就加 -2、-3）。页面上的留言挂在指纹上，
 * 原文改了指纹就变，留言退到它前面那个标题底下。
 * 语句标签「(业务抽象-能力)」这种换成小色块，看的时候一眼分得出层。
 *
 *   const { render } = require('./lib/markdown')
 *   const { html, outline } = render(text)   // outline：[{ level, id, text }]，给左栏目录用
 */
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const LAYERS = { '业务抽象': 'l-abs', '业务落地': 'l-land', '应用行为': 'l-app' }
const KINDS = '能力|事实|约束|公式|触发|流程|情形'
const TAG = new RegExp('[(（](业务抽象|业务落地|应用行为)-(' + KINDS + ')[)）]', 'g')

function inline(src) {
  const codes = []
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => /^https?:\/\//.test(u) ? '<a href="' + u + '" target="_blank" rel="noreferrer">' + t + '</a>' : t)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
  s = s.replace(TAG, (_, l, k) => '<span class="tag ' + LAYERS[l] + '">' + l + '-' + k + '</span>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>')
}

// 中文断行接起来不加空格，英文加一个
const joinLines = (ls) => ls.reduce((a, l) => !a ? l : /[\u3000-\u9fff\uff00-\uffef]$/.test(a) || /^[\u3000-\u9fff\uff00-\uffef]/.test(l) ? a + l : a + ' ' + l, '')

const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
const isRule = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

// FNV-1a，八位十六进制；只拿来认「这一块原文变没变」，不防碰撞
function fingerprint(src) {
  let h = 0x811c9dc5
  for (const ch of String(src).replace(/\s+/g, ' ').trim()) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

function render(text, { mark = true } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const out = [], outline = []
  let i = 0
  const para = []
  const seen = new Map()
  const push = (html, src) => {
    if (!mark) return out.push(html)
    const fp = fingerprint(src), n = (seen.get(fp) ?? 0) + 1
    seen.set(fp, n)
    out.push(html.replace(/^<([a-z0-9]+)/, '<$1 data-b="' + fp + (n > 1 ? '-' + n : '') + '"'))
  }
  const flush = () => { if (para.length) { push('<p>' + inline(joinLines(para)) + '</p>', para.join('\n')); para.length = 0 } }

  function list(base) {
    // 从第 i 行起收一整段列表：缩进比 base 深的归到上一项底下
    const first = LIST.exec(lines[i])
    const ordered = /\d/.test(first[2])
    const start = ordered ? parseInt(first[2], 10) : 1
    const items = []
    while (i < lines.length) {
      const m = LIST.exec(lines[i])
      if (m && m[1].length === base) {
        items.push({ text: [m[3]], sub: [] }); i++; continue
      }
      if (m && m[1].length > base && items.length) { items.at(-1).sub.push(list(m[1].length)); continue }
      if (!m && lines[i].trim() && /^\s+/.test(lines[i]) && items.length) { items.at(-1).text.push(lines[i].trim()); i++; continue }
      break
    }
    const tag = ordered ? 'ol' : 'ul'
    return '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>'
      + items.map((it) => '<li>' + inline(joinLines(it.text)) + it.sub.join('') + '</li>').join('') + '</' + tag + '>'
  }

  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) {
      flush()
      const lang = l.slice(3).trim()
      const body = []
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i])
      i++
      push(lang === 'mermaid' ? '<pre class="mermaid">' + esc(body.join('\n')) + '</pre>' : '<pre><code>' + esc(body.join('\n')) + '</code></pre>', body.join('\n'))
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)
    if (h) {
      flush()
      const level = h[1].length, id = 'h-' + outline.length
      outline.push({ level, id, text: h[2].replace(/\*\*|`/g, '') })
      push('<h' + level + ' id="' + id + '">' + inline(h[2]) + '</h' + level + '>', l)
      i++; continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush()
      const head = cells(l)
      const rows = [], from = i
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]))
      push('<div class="tw"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => '<td' + ((r[k] ?? '').replace(/\*\*|`/g, '').length <= 6 ? ' class="nw"' : '') + '>' + inline(r[k] ?? '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>', lines.slice(from, i).join('\n'))
      continue
    }
    if (/^\s*>/.test(l)) {
      flush()
      const body = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''))
      push('<blockquote>' + render(body.join('\n'), { mark: false }).html + '</blockquote>', body.join('\n'))
      continue
    }
    const m = LIST.exec(l)
    if (m) { flush(); const from = i, html = list(m[1].length); push(html, lines.slice(from, i).join('\n')); continue }
    if (!l.trim()) { flush(); i++; continue }
    para.push(l.trim()); i++
  }
  flush()
  return { html: out.join('\n'), outline }
}

module.exports = { render, esc }
