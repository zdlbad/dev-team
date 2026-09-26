// 「业务」页的留言：浏览器里跑。business-page.js 把下面 DOC 的占位换成这一篇的文件名。
// 每一块正文（lib/markdown.js 打的 data-b）右边浮一个 💬；留言、答复排在那一块下面。
// 原文改了、指纹对不上的，退到原来那个标题底下；标题也没了的，排在这一篇最前面。
(function () {
  var DOC = __KEY__
  var md = document.querySelector('.md')
  if (!md || DOC === 'glossary') return
  var all = []
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  var when = function (at) { try { return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (e) { return at } }
  var waiting = function (c) { var m = c.thread[c.thread.length - 1]; return m && m.who === '人' }
  var blocks = function () { return Array.prototype.filter.call(md.children, function (el) { return el.hasAttribute('data-b') }) }
  function headingOf(el) {
    if (/^H[1-6]$/.test(el.tagName)) return el.textContent.trim()
    for (var p = el.previousElementSibling; p; p = p.previousElementSibling) if (/^H[1-6]$/.test(p.tagName)) return p.textContent.trim()
    return ''
  }

  // 有人正在写，页面先不自动刷新
  window.Comments = { busy: function () {
    var ae = document.activeElement
    if (ae && ae.tagName === 'TEXTAREA') return true
    return Array.prototype.some.call(md.querySelectorAll('.thread textarea'), function (t) { return t.value.trim() })
  } }

  function card(c, moved) {
    var h = '<div class="cm" id="cm-' + c.id + '">'
    if (moved) h += '<div class="moved">原来那一段改过了，这条原本挂在：' + esc(c.snippet || '（空）') + '</div>'
    c.thread.forEach(function (m, i) {
      h += '<div class="msg' + (i ? ' r' : '') + '"><span class="who">' + (m.who === '人' ? '你' : esc(m.who)) + '</span><time>' + esc(when(m.at)) + '</time><div class="tx">' + esc(m.text) + '</div></div>'
    })
    h += '<div class="ft"><span class="' + (waiting(c) ? 'wait">等业务分析答' : 'done">答过了') + '</span><a data-follow="' + c.id + '">' + (waiting(c) ? '补一句' : '接着问') + '</a><span class="st"></span></div></div>'
    return h
  }

  function paint() {
    Array.prototype.forEach.call(md.querySelectorAll('.thread,.csum'), function (x) { x.remove() })
    blocks().forEach(function (el) { el.classList.remove('has-c') })
    var mine = all.filter(function (c) { return c.doc === DOC })
    var hs = Array.prototype.filter.call(md.children, function (el) { return /^H[1-6]$/.test(el.tagName) })
    var groups = [], orphans = []
    mine.forEach(function (c) {
      var el = c.block ? md.querySelector(':scope > [data-b="' + c.block + '"]') : null, moved = false
      if (!el) { moved = true; el = hs.filter(function (h) { return h.textContent.trim() === c.heading })[0] || null }
      if (!el) return orphans.push(c)
      var g = groups.filter(function (x) { return x.el === el })[0]
      if (!g) groups.push(g = { el: el, items: [] })
      g.items.push({ c: c, moved: moved })
    })
    groups.forEach(function (g) {
      g.el.classList.add('has-c')
      g.el.insertAdjacentHTML('afterend', '<div class="thread">' + g.items.map(function (x) { return card(x.c, x.moved) }).join('') + '</div>')
    })
    var open = mine.filter(waiting).length
    var sum = mine.length ? '<div class="csum">这一篇 ' + mine.length + ' 条留言' + (open ? '，' + open + ' 条等业务分析答 · <a data-jump="' + mine.filter(waiting)[0].id + '">去看第一条</a>' : '，都答过了') + '</div>' : ''
    var top = md.querySelector(':scope > p.meta') || md.firstElementChild
    if (orphans.length) sum += '<div class="thread"><div class="moved">这几条原来的段落和标题都找不到了：</div>' + orphans.map(function (c) { return card(c, true) }).join('') + '</div>'
    if (sum && top) top.insertAdjacentHTML('afterend', sum)
    // 左栏每篇的等答条数
    Array.prototype.forEach.call(document.querySelectorAll('nav a.doc'), function (a) {
      var k = decodeURIComponent((a.getAttribute('href') || '').replace(/^\?doc=/, ''))
      var n = all.filter(function (c) { return c.doc === k && waiting(c) }).length
      var b = a.querySelector('.nb'); if (b) b.remove()
      if (n) a.insertAdjacentHTML('beforeend', '<span class="nb" title="等业务分析答">' + n + '</span>')
    })
  }

  function post(url, body, st) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || '没存上'); return d }) })
      .then(function (d) { all = d.comments || []; window.T = d.t; paint() })
      .catch(function (e) { if (st) st.textContent = e.message })
  }

  function composer(after, onSend, hint) {
    var old = md.querySelector('.thread.compose'); if (old) old.remove()
    after.insertAdjacentHTML('afterend', '<div class="thread compose"><textarea placeholder="' + esc(hint) + '"></textarea><div class="bt"><button data-send>留言</button><button class="x" data-cancel>算了</button><span class="st"></span></div></div>')
    var box = after.nextElementSibling, ta = box.querySelector('textarea')
    ta.focus()
    box.querySelector('[data-cancel]').onclick = function () { box.remove() }
    box.querySelector('[data-send]').onclick = function () {
      var text = ta.value.trim(); if (!text) return
      this.disabled = true
      onSend(text, box.querySelector('.st')).then(function () { box.remove() })
    }
  }

  // 浮在正文右边的 💬：跟着鼠标所在的那一块走
  var btn = document.createElement('button')
  btn.id = 'cbtn'; btn.type = 'button'; btn.textContent = '💬'; btn.title = '对这一段留言'
  md.appendChild(btn)
  var cur = null
  md.addEventListener('mouseover', function (ev) {
    var el = ev.target.closest && ev.target.closest('.md > [data-b]')
    if (!el) return
    // 每次都重算：上面插进留言后，这一块的位置会往下挪
    cur = el; btn.style.top = el.offsetTop + 'px'; btn.style.display = 'block'
  })
  btn.addEventListener('click', function () {
    if (!cur) return
    var el = cur, after = el.nextElementSibling && el.nextElementSibling.classList.contains('thread') ? el.nextElementSibling : el
    composer(after, function (text, st) {
      return post('business/comments', { doc: DOC, block: el.getAttribute('data-b'), heading: headingOf(el), snippet: el.textContent, text: text }, st)
    }, '对这一段有什么问题？业务分析会查原料，答在下面')
  })

  md.addEventListener('click', function (ev) {
    var f = ev.target.closest('[data-follow]')
    if (f) {
      var id = f.getAttribute('data-follow')
      composer(f.closest('.cm'), function (text, st) { return post('business/comments/reply', { id: id, text: text }, st) }, '接着问，或者补一句')
      return
    }
    var j = ev.target.closest('[data-jump]')
    if (j) { var c = document.getElementById('cm-' + j.getAttribute('data-jump')); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
  })

  fetch('business/comments').then(function (r) { return r.json() }).then(function (d) { all = d.comments || []; paint() }).catch(function () {})
})()
