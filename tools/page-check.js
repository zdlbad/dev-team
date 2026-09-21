#!/usr/bin/env node
/**
 * 页面体检：把「人打开页面能不能用」变成一条能跑的检查。
 *
 * 用法：
 *   node tools/page-check.js [--port 4870] [--browser]
 *
 * 查三样：
 *   1. 每一页拿不拿得到（状态码、有没有正文）
 *   2. **页面里的每段脚本解析得过吗**——页面 HTML 是工具用字符串拼出来的，
 *      少一个 `+'` 这种错，Node 自己 `--check` 查不出来（它只看得见那是个字符串），
 *      人打开页面却是整段脚本不跑、永远停在「连接中…」。2026-09-13 就这么坏过一次。
 *   3. 页面开头取数的那几条路（/data 这类）通不通
 *
 * 加 --browser：本机有 Edge 时再用无头浏览器真跑一遍，抓 Uncaught 错误。最准，但慢。
 *
 * 退出码：0 全过；1 有页面不好用。
 */
const http = require('node:http')
const vm = require('node:vm')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const port = Number(opt('--port', 4870))

// 工作台上人点得到的每一页（顶上那一排页签，加上页签里点得进去的几页）
const PAGES = ['/', '/p/scene/', '/p/scene/questions', '/slices', '/journal', '/demo', '/source', '/p/story/', '/p/story/story', '/p/story/model', '/p/story/glossary', '/p/review/', '/p/codemodel/', '/p/prepr/', '/p/proto/', '/plan', '/delta']
// 页面一打开就取的数据：这几条不通，页面就是空的
const DATA = ['/state', '/todo', '/p/scene/data', '/p/story/data', '/p/story/data-map', '/p/review/data', '/p/codemodel/data', '/p/proto/data', '/p/proto/tree']

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000 }, (r) => {
      let d = ''
      r.setEncoding('utf8')
      r.on('data', (c) => (d += c)).on('end', () => resolve({ code: r.statusCode, body: d, headers: r.headers }))
    })
    req.on('error', (e) => resolve({ error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ error: '超时' }) })
  })
}

/** 把页面里的每段行内脚本抠出来解析一遍。解析不过＝人打开就是一页死的。 */
function scriptErrors(html) {
  const out = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  let n = 0
  while ((m = re.exec(html))) {
    n++
    if (/\bsrc=/.test(m[1])) continue // 外链的这里不管
    const code = m[2]
    if (!code.trim()) continue
    try { new vm.Script(code, { filename: `inline-${n}.js` }) } catch (e) {
      // 报出错的那一行原文，方便直接去工具里找
      const line = Number((e.stack?.match(/inline-\d+\.js:(\d+)/) ?? [])[1] ?? 0)
      const text = line ? (code.split('\n')[line - 1] ?? '').trim().slice(0, 140) : ''
      out.push({ n, message: e.message, line, text })
    }
  }
  return out
}

;(async () => {
  let bad = 0
  console.log(`页面体检 · http://localhost:${port}`)
  for (const p of PAGES) {
    const r = await get(p)
    if (r.error) { console.log(`  ✘ ${p.padEnd(26)} 连不上：${r.error}`); bad++; continue }
    if (r.code !== 200) { console.log(`  ✘ ${p.padEnd(26)} 状态 ${r.code}`); bad++; continue }
    const errs = scriptErrors(r.body)
    if (errs.length) {
      bad++
      console.log(`  ✘ ${p.padEnd(26)} 页面里的脚本解析不过（人打开就是一页死的）`)
      for (const e of errs) console.log(`      第 ${e.n} 段 第 ${e.line} 行 ${e.message}\n      ${e.text}`)
      continue
    }
    console.log(`  ✔ ${p.padEnd(26)} ${String(r.body.length).padStart(7)} 字符`)
  }
  console.log('页面一打开就取的数：')
  for (const p of DATA) {
    const r = await get(p)
    if (r.error || r.code !== 200) { console.log(`  ✘ ${p.padEnd(26)} ${r.error ?? '状态 ' + r.code}`); bad++; continue }
    // 子服务还没起来时，工作台回的是一页「这一页要有什么才有」的说明（HTML），不是数据。
    // 那不算坏，是这一关还没走到——报告还没写出来、原型还没编译。别报成假警报（2026-09-15 三条都是这样）
    if (/text\/html/.test(String(r.headers?.['content-type'] ?? ''))) { console.log(`  · ${p.padEnd(26)} 这一页还没起来（报告或原型还没有），跳过`); continue }
    try { JSON.parse(r.body) } catch { console.log(`  ✘ ${p.padEnd(26)} 不是能解析的 JSON`); bad++; continue }
    console.log(`  ✔ ${p.padEnd(26)} ${String(r.body.length).padStart(7)} 字符`)
  }

  if (args.includes('--browser')) {
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((x) => fs.existsSync(x))
    if (!edge) console.log('无头浏览器：本机没找到 Edge，跳过')
    else {
      console.log('用无头浏览器真跑一遍（抓 Uncaught）：')
      for (const p of PAGES) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagecheck-'))
        const r = spawnSync(edge, ['--headless=new', '--disable-gpu', `--user-data-dir=${dir}`, '--enable-logging=stderr', '--v=1', '--virtual-time-budget=8000', '--dump-dom', `http://127.0.0.1:${port}${p}`], { encoding: 'utf8', timeout: 60000 })
        const uncaught = (r.stderr ?? '').split('\n').filter((l) => /CONSOLE.*Uncaught/.test(l)).map((l) => l.replace(/^.*CONSOLE:\d+\]\s*/, ''))
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录留着也无妨 */ }
        if (uncaught.length) { bad++; console.log(`  ✘ ${p.padEnd(26)} ${uncaught[0]}`) }
        else console.log(`  ✔ ${p.padEnd(26)} ${String((r.stdout ?? '').length).padStart(7)} 字符（脚本跑完之后的样子）`)
      }
    }
  }

  console.log(bad ? `\n${bad} 处不好用。` : '\n全过。')
  process.exit(bad ? 1 : 0)
})()
