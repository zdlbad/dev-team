// 「谁在干什么」页的脚本：取数据、角色的颜色与简称、时间格式、把日志的笔归成一趟一趟的派工、回答问题。
// 数据来自 scene.js 的 /feed（日志里的每一笔按本地日期分，加上看板上的问题与这一步）；页面三秒取一次。
window.Scene = (function () {
  const ROLES = {
    '开发指挥': { short: '指挥', color: '#57606a', desc: '派活、记看板' },
    '业务分析': { short: '业务', color: '#0969da', desc: '读原料，答原料上怎么说' },
    '模型师': { short: '模型', color: '#8250df', desc: '照场景建模，陪你按原型' },
    '编码': { short: '编码', color: '#1a7f37', desc: '写草稿原型，攒够了正式化' },
    '审查': { short: '审查', color: '#cf222e', desc: '只读，判模型和代码' },
    '文职': { short: '文职', color: '#bf8700', desc: '校对，只改字不改意' },
    '分身': { short: '分身', color: '#1b7c83', desc: '替指挥查东西，只带结论回来' },
    '人': { short: '你', color: '#e16f24', desc: '拍板、答问题' },
  }
  const ORDER = ['开发指挥', '业务分析', '模型师', '编码', '审查', '文职', '分身', '人']
  const role = (n) => ROLES[n] || { short: String(n || '—').slice(0, 2), color: '#6e7781' }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const hm = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) }
  const dur = (ms) => {
    if (ms == null || isNaN(ms)) return ''
    const s = Math.round(ms / 1000)
    if (s < 60) return s + ' 秒'
    const m = Math.floor(s / 60)
    if (m < 60) return m + ' 分' + (s % 60 ? ' ' + (s % 60) + ' 秒' : '')
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分'
  }
  const k = (n) => (n == null ? '' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))

  async function load(date) {
    const r = await fetch('/feed' + (date ? '?date=' + encodeURIComponent(date) : ''))
    return r.json()
  }

  // 发问的选项、偏向在看板的问题里，日志那一笔只有题目；按编号接上
  function events(d) {
    const qs = new Map((d.questions || []).map((q) => [q.id, q]))
    return (d.entries || []).map((e, i) => ({ ...e, i, q: e.id ? qs.get(e.id) || null : null }))
  }

  // 一趟派工：dispatch 起，到同一角色的 back 止；中间这个角色的细步、发问都挂进来
  function trips(evs) {
    const open = new Map()
    const out = []
    for (const e of evs) {
      if (e.kind === 'dispatch') {
        const t = { who: e.who, text: e.text, start: e, steps: [], asks: [], plan: null, end: null }
        open.set(e.who, t); out.push(t)
      } else if (e.kind === 'back' && open.has(e.who)) {
        open.get(e.who).end = e; open.delete(e.who)
      } else if (e.kind === 'plan' && open.has(e.who)) {
        open.get(e.who).plan = e // 计划变了再报一次，取最后一份
      } else if ((e.kind === 'progress' || e.kind === 'ask') && open.has(e.who)) {
        open.get(e.who)[e.kind === 'ask' ? 'asks' : 'steps'].push(e)
      }
    }
    return out
  }
  // 计划走到哪了：第 k 步有细步、或后面的步有细步，就算做过；最大那一步在跑的趟里是「正在做」
  function planState(t) {
    if (!t?.plan) return null
    const n = (t.plan.steps || []).length
    const marks = t.steps.map((p) => p['步']).filter((x) => Number.isInteger(x))
    const max = marks.length ? Math.max(...marks) : 0
    const state = (t.plan.steps || []).map((_, i) => { const k = i + 1; return k < max || (k === max && t.end) ? 'done' : k === max ? 'now' : 'todo' })
    return { n, at: max, state }
  }
  // 现在还在干的角色：有派工、还没交回
  const busy = (evs) => new Set(trips(evs).filter((t) => !t.end).map((t) => t.who))
  // 还没答的问题
  const pending = (d) => (d.questions || []).filter((q) => !q.answeredAt)

  // 日期挑选：?date= 跟着走；「今天」就是日志里最近的一天
  function datePicker(d, el) {
    el.innerHTML = '<select>' + (d.dates || []).map((x) => '<option value="' + x.date + '"' + (x.date === d.date ? ' selected' : '') + '>' + x.date + '（' + x.n + ' 笔）</option>').join('') + '</select>'
    el.querySelector('select').onchange = (ev) => { const u = new URL(location.href); u.searchParams.set('date', ev.target.value); location.href = u.toString() }
  }
  function toast(msg) {
    let t = document.getElementById('scene-toast')
    if (!t) { t = document.createElement('div'); t.id = 'scene-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#24292f;color:#fff;padding:8px 14px;border-radius:6px;font:13px system-ui;z-index:99;opacity:0;transition:opacity .2s'; document.body.appendChild(t) }
    t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => (t.style.opacity = 0), 2400)
  }
  // 回答：选项按第几个取原文（-1 是自己写一句），POST 给看板的 /answer，记上之后立刻重取一次
  let last = null, kick = null
  async function answer(btn, id, idx) {
    const q = (last?.questions || []).find((x) => x.id === id)
    if (!q) return toast('找不到问题 ' + id)
    const text = idx >= 0 ? q.options[idx] : prompt(id + '：' + q.question + '\n\n你怎么答？')
    if (!text || !String(text).trim()) return
    const box = btn.parentNode; box.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      const r = await (await fetch('/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, text: String(text).trim() }) })).json()
      if (!r.ok) { toast('没记上：' + (r.error || '不知道为什么')); box.querySelectorAll('button').forEach((b) => (b.disabled = false)); return }
      toast(id + ' 记上了：' + String(text).trim()); kick && kick()
    } catch (e) { toast('没记上：' + e.message); box.querySelectorAll('button').forEach((b) => (b.disabled = false)) }
  }

  // 三秒取一次；数据没变就不重画（按最后一笔的时间与笔数判）
  function boot(render) {
    const date = new URLSearchParams(location.search).get('date')
    let sig = ''
    async function tick() {
      try {
        const d = await load(date)
        last = d
        const s = d.date + '|' + d.entries.length + '|' + (d.entries.at(-1)?.ts || '') + '|' + (d.questions || []).length
        if (s !== sig) { const first = !sig; sig = s; render(d, first) }
      } catch (e) { console.error(e) }
    }
    kick = tick
    tick(); setInterval(tick, 3000)
  }

  const refresh = () => kick && kick()
  return { ROLES, ORDER, role, esc, hm, dur, k, load, events, trips, planState, busy, pending, datePicker, toast, answer, refresh, boot }
})()
