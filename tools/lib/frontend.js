/**
 * 前端目录：草稿原型的页面写在一个单独的前端工程里（React 这类，有自己的 package.json 和开发服务）时，
 * 工具从这里找它、读它上面挂的 @trace。
 *
 * 找法（agents/common/project-layout.md「前端」）：
 *   1. project.json 里写了 "frontend"（相对项目目录，跟 "codebase" 一样）就用它；写 false 表示这个项目没有前端工程；
 *   2. 没写就看代码库旁边的 frontend（<代码库>/../frontend）。
 * 两种都要那个目录里有 package.json 才算数；没有就当这个项目的页面还是原型宿主那一套（src/proto/web/）。
 */
const fs = require('node:fs')
const path = require('node:path')

function readProjectJson(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')) } catch { return {} }
}

/** 代码库：命令行给了就用，否则读 project.json 的 codebase（相对项目目录） */
function codebaseOf(root, given = null) {
  if (given) return path.resolve(given)
  const p = readProjectJson(root)
  return p.codebase ? path.resolve(root, p.codebase) : null
}

/** 前端目录的绝对路径，没有就是 null */
function frontendOf(root, codebase = null) {
  const p = readProjectJson(root)
  if (p.frontend === false) return null
  const candidates = []
  if (typeof p.frontend === 'string' && p.frontend) candidates.push(path.resolve(root, p.frontend))
  else {
    const cb = codebaseOf(root, codebase)
    if (cb) candidates.push(path.join(path.dirname(cb), 'frontend'))
  }
  return candidates.find((d) => fs.existsSync(path.join(d, 'package.json'))) ?? null
}

const SOURCE = /\.(ts|tsx|js|jsx|mts|mjs)$/
function sources(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (SOURCE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * 前端源码里的 @trace：只读 /** … *\/ 注释块（跟后端解码读的是同一种写法），一块里可以有几个编号。
 * 每一处记：编号、文件（相对 relativeTo，缺省相对前端目录）、@trace 所在行、注释下面挂着的那个组件或函数名、
 * 注释里除标签以外的那段话（给审查读：这个组件管的是什么）。
 */
function frontendTraces(frontendDir, relativeTo = frontendDir) {
  const out = []
  for (const f of sources(path.join(frontendDir, 'src'))) {
    const text = fs.readFileSync(f, 'utf8')
    const file = path.relative(relativeTo, f).replaceAll('\\', '/')
    const re = /\/\*\*([\s\S]*?)\*\//g
    let m
    while ((m = re.exec(text))) {
      const body = m[1]
      if (!/@trace\b/.test(body)) continue
      const startLine = text.slice(0, m.index).split('\n').length
      const lines = body.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim())
      const ids = []
      let traceLine = startLine
      const words = []
      lines.forEach((l, i) => {
        const t = l.match(/@trace\s+(.*)$/)
        if (t) {
          if (!ids.length) traceLine = startLine + i
          for (const id of t[1].split(/\s(?=@[\w-]+)/)[0].split(/[\s,，、]+/).filter(Boolean)) if (!ids.includes(id)) ids.push(id)
          return
        }
        if (l && !l.startsWith('@')) words.push(l)
      })
      const after = text.slice(m.index + m[0].length)
      const own = after.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/)
      const owner = own ? own[1] ?? own[2] : null
      for (const id of ids) out.push({ id, file, line: traceLine, owner, note: words.join(' ') })
    }
  }
  return out
}

module.exports = { frontendOf, codebaseOf, frontendTraces }
