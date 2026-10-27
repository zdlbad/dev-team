// 跟人交流的页面共用的小工具：转义、本机记忆、取数、写回、轮询
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
}
// 地址都写相对的：页面挂在工作台底下哪一层都找得到
async function getJson(u) {
  const r = await fetch(u, { cache: 'no-store' })
  return r.json()
}
/** 写回：409 是文件在这期间被改过，提示一句、交给调用方重取 */
async function postJson(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) { toast(d.error || `没成（${r.status}）`); return { ok: false, status: r.status, ...d } }
  return { ok: true, ...d }
}
let toastTimer = null
function toast(text) {
  let el = document.querySelector('.toast')
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el) }
  el.textContent = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 4000)
}
/** 文件变了就叫 onChange：模型师改了文件，开着的页面自己跟上 */
function poll(u, onChange, ms = 4000) {
  let last = null
  setInterval(async () => {
    try {
      const { t } = await getJson(u)
      if (last !== null && t !== last) onChange()
      last = t
    } catch {}
  }, ms)
  getJson(u).then(({ t }) => { last = t }).catch(() => {})
}
