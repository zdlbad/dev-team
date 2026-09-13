/**
 * 白天 / 黑夜：把一张页面的配色明暗翻过来。
 *
 * 为什么这么做：给人看的页面有五个工具在生成，每个都有自己的一套颜色，
 * 还有几十处写死的色值（#fff、#f6f8fa、#fff7e6…）。挨个改成变量再写两套主题，
 * 要动五个文件上百处，且以后每加一句样式都得记得写两遍。
 * 换个办法：颜色的**色相不动、明度翻过来**（L → 1-L）。
 * 近白的底变成近黑的底，深色的字变成浅色的字，中间调的强调色（蓝、琥珀、绿）基本不动——
 * 这正是深浅两套主题该有的关系。一处实现，所有页面都管，新写的样式自动跟着走。
 */

function hexToRgb(h) {
  let s = h.slice(1)
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** 一个色值翻面：色相不动，明度翻过来，两头留一点余量免得纯黑纯白刺眼 */
function flipColor(hex) {
  const [r, g, b] = hexToRgb(hex)
  let [h, s, l] = rgbToHsl(r, g, b)
  l = 1 - l
  // 翻到很亮的（原来是很深的字）压一点，翻到很暗的（原来是纸白的底）抬一点
  if (l > 0.92) l = 0.92
  if (l < 0.07) l = 0.07
  // 极浅的底翻过去要是还很艳，读起来晃眼，收一收
  if (l < 0.3 && s > 0.5) s = 0.5
  const [R, G, B] = hslToRgb(h, s, l)
  return '#' + toHex(R) + toHex(G) + toHex(B)
}

const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g

/** 把一段 CSS 里的色值全部翻面 */
function flipCss(css) {
  return css.replace(HEX, (m) => flipColor(m))
}

/**
 * 把整张 HTML 翻面：只动 <style> 块与行内 style="…"，正文一个字不碰。
 * 再补一句 color-scheme，让滚动条、输入框这些浏览器自己画的东西也跟着换。
 */
function flipHtml(html, scheme) {
  let out = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => `<style${attrs}>${flipCss(css)}</style>`)
  out = out.replace(/style="([^"]*)"/gi, (m, css) => (HEX.test(css) ? `style="${flipCss(css)}"` : m))
  const inject = `<style data-theme-scheme>:root{color-scheme:${scheme}}</style>`
  return out.includes('</head>') ? out.replace('</head>', inject + '</head>') : inject + out
}

module.exports = { flipColor, flipCss, flipHtml }
