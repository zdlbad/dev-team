#!/usr/bin/env node
/**
 * 草稿原型：把代码库跑起来，挂上项目自己的产品页面，让人按身份在上面操作。有两种做法，看代码库旁边有没有前端工程：
 *
 * 一、有前端工程（lib/frontend.js 的找法：project.json 的 "frontend"，或代码库旁边的 frontend/，里面有 package.json）
 *   node tools/proto.js serve <项目> --code <代码库> [--port 4872] [--proto-port <后端口>]
 *       在代码库里 `npm run dev` 起后端（PORT 指好，开发口 /api/_dev/… 开着），
 *       再在前端目录里 `npm run dev -- --port <--port> --strictPort` 起前端开发服务（PORT、BACKEND_URL 指好）。
 *       页面就是 Vite 本身：人直接开 http://127.0.0.1:<--port>/，/api/… 由 Vite 自己转给后端（前端工程的 vite.config 里写着）。
 *       工作台不把它套进页签里，点「草稿原型」在新标签页打开这个地址。
 *       没给后端口就挑一个空闲的。改了代码不用重起：后端的 dev 自己重启，前端自己热替换。
 *   node tools/proto.js check <项目> --code <代码库> [--slice <切片>]
 *       起后端，读 /api/_dev/manifest 对模型：模型里的命令、查询、聚合的仓储都登记了没有；再看前端目录在不在、装没装依赖。
 *       代码库有 typecheck 脚本就先跑它。退出码非 0 表示缺。
 *
 * 二、没有前端工程（原型宿主那一套，样例 example/order-code 就是）
 *   node tools/proto.js serve <项目> --code <代码库> [--port 4872] [--proto-port 4875]
 *       编译（tsc → <代码库>/.proto-build），启动 src/proto/main.ts 的原型宿主，
 *       把 <代码库>/src/proto/web/ 当静态页面挂出来；页面里的 /api/… 转给宿主（/manifest、/run、/state、/events、/reset）
 *   node tools/proto.js check <项目> --code <代码库> [--slice <切片>]
 *       只编译、启动、对照模型：模型里的命令、查询、聚合都登记进宿主了没有；再看 src/proto/web/index.html 在不在
 *
 * 宿主的写法见代码库里的 src/shared/building-block/proto/README.md（样例在 example/order-code）；前端工程与后端开发口的放法见 agents/code/coding-standard.md。
 * 产品页面由编码写：按身份分，一个按钮调一个命令，一栏对应模型的一个字段，领域错误按类名回来、对照模型里错误的 condition 翻成人话。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const codebase = opt('--code') && path.resolve(opt('--code'))
const port = Number(opt('--port') ?? 4872)
let protoPort = Number(opt('--proto-port') ?? 4875)
if (!['serve', 'check'].includes(cmd) || !root || !fs.existsSync(path.join(root, 'project.json')) || !codebase) {
  console.error('用法：node tools/proto.js <serve|check> <项目> --code <代码库> [--port 4872] [--proto-port 4875]')
  process.exit(2)
}
const { loadModel } = require('./lib/project')
const { frontendOf } = require('./lib/frontend')
const frontendDir = frontendOf(root, codebase)

function portBusy(p) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(true))
    s.once('listening', () => s.close(() => resolve(false)))
    s.listen(p, '127.0.0.1')
  })
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject).listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => resolve(pt)) })
  })
}
function getJson(p, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: protoPort, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
}

/** 模型里的命令、查询、仓储，manifest 里没登记的 */
function missingAgainstModel(m) {
  const model = loadModel(root)
  const sliceId = opt('--slice')
  let mods = null
  if (sliceId) { try { const s = JSON.parse(fs.readFileSync(path.join(root, 'slices', `${sliceId}.json`), 'utf8')); if (s.modules?.length) mods = new Set(s.modules) } catch { /* 读不到就全看 */ } }
  const inScope = (mod) => !mods || mods.has(mod)
  const missing = []
  for (const el of model.elements) {
    if (!inScope(el.module)) continue
    if (el.kind === 'command-handler' && !m.commands.includes(`${el.module}.${el.data.name}`)) missing.push(`命令 ${el.module}.${el.data.name}`)
    if (el.kind === 'query-handler' && !m.queries.includes(`${el.module}.${el.data.name}`)) missing.push(`查询 ${el.module}.${el.data.name}`)
  }
  for (const mf of model.moduleFiles) for (const a of mf.data.aggregates ?? []) if (inScope(mf.module) && !m.repositories.includes(`${mf.module}.${a.name}`)) missing.push(`仓储 ${mf.module}.${a.name}`)
  return missing
}

// ================= 一、有前端工程 =================

const WIN = process.platform === 'win32'
const running = []
/** 在 dir 里跑 npm run <script>；自成一个进程组，关的时候连它拉起来的 tsx、vite 一起关 */
function npmRun(label, dir, script, extra, env) {
  const argv = ['run', script, ...(extra.length ? ['--', ...extra] : [])]
  // Windows 上 npm 是 npm.cmd，要经 shell 才起得来；进程组那一套在 Windows 上没有，关的时候改用 taskkill 连子进程一起关
  const c = spawn(WIN ? 'npm.cmd' : 'npm', argv, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN, shell: WIN, windowsHide: true })
  const rec = { label, child: c, log: '', exited: null }
  const take = (d) => { rec.log = (rec.log + d).slice(-20000); for (const line of String(d).split('\n')) if (line.trim()) console.log(`[${label}] ${line}`) }
  c.stdout.on('data', take); c.stderr.on('data', take)
  c.on('exit', (code) => { rec.exited = code ?? 0; if (code) console.error(`[${label}] 退出，代码 ${code}`) })
  running.push(rec)
  return rec
}
function stopRunning() {
  for (const r of running) {
    if (r.exited !== null) continue
    try {
      if (WIN) spawnSync('taskkill', ['/pid', String(r.child.pid), '/T', '/F'])
      else process.kill(-r.child.pid, 'SIGTERM')
    } catch { /* 已经退了 */ }
  }
}
// 不管从哪条路退出（check 中途出错、被 Ctrl+C），拉起来的开发服务都一起关掉，别留着占口
process.on('exit', stopRunning)
async function waitFor(rec, probe, seconds) {
  for (let i = 0; i < seconds * 5; i++) {
    if (rec.exited !== null) return false
    try { if (await probe()) return true } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}
function reachable(p, pth) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: pth }, (res) => { res.resume(); resolve(res.statusCode < 500) })
    req.on('error', () => resolve(false)); req.setTimeout(1500, () => { req.destroy(); resolve(false) })
  })
}
async function pickBackendPort() {
  if (opt('--proto-port')) { while (await portBusy(protoPort)) protoPort++ } // 别的项目的后端可能占着这个口，连过去会张冠李戴
  else protoPort = await freePort()
}
/** 开发口开着的后端：NODE_ENV 是 production 时后端不挂 /api/_dev/…，这里明着设成 development */
function startBackend() {
  return npmRun('后端', codebase, 'dev', [], { PORT: String(protoPort), NODE_ENV: 'development' })
}
const backendUp = () => getJson('/api/_dev/manifest').then((m) => Array.isArray(m.commands))

async function checkWithFrontend() {
  const pkg = JSON.parse(fs.readFileSync(path.join(codebase, 'package.json'), 'utf8'))
  if (pkg.scripts?.typecheck) {
    const t = spawnSync(WIN ? 'npm.cmd' : 'npm', ['run', 'typecheck'], { cwd: codebase, encoding: 'utf8', shell: WIN })
    if (t.status !== 0) { console.error('后端类型检查没过：\n' + (t.stdout + t.stderr).trim()); process.exit(1) }
    console.log('后端类型检查：过')
  }
  if (!pkg.scripts?.dev) { console.error(`后端的 package.json 里没有 dev 脚本（${codebase}）`); process.exit(1) }
  await pickBackendPort()
  const b = startBackend()
  if (!(await waitFor(b, backendUp, 60))) { stopRunning(); console.error('后端起不来，或者 /api/_dev/manifest 读不到：\n' + b.log); process.exit(1) }
  const m = await getJson('/api/_dev/manifest')
  stopRunning()
  const missing = missingAgainstModel(m)
  console.log(`后端登记：命令 ${m.commands.length}，查询 ${m.queries.length}，仓储 ${m.repositories.length}`)
  const rel = path.relative(process.cwd(), frontendDir) || frontendDir
  const hasSrc = fs.existsSync(path.join(frontendDir, 'src'))
  const fpkg = JSON.parse(fs.readFileSync(path.join(frontendDir, 'package.json'), 'utf8'))
  const problems = []
  if (!hasSrc) problems.push(`前端目录 ${rel} 里还没有 src/`)
  if (!fpkg.scripts?.dev) problems.push(`前端的 package.json 里没有 dev 脚本`)
  if (!fs.existsSync(path.join(frontendDir, 'node_modules'))) problems.push(`前端还没装依赖：在 ${rel} 里 npm install`)
  console.log(problems.length ? '前端：' + problems.join('；') : `前端：${rel} 在（src/、dev 脚本、依赖都有）`)
  if (missing.length) console.log('模型有、后端没登记：\n  ' + missing.join('\n  '))
  process.exit(missing.length || problems.length ? 1 : 0)
}

async function serveWithFrontend() {
  await pickBackendPort()
  const stop = () => { stopRunning(); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  // 起不来就把那一段的输出打出来再退：工作台把这里的输出记进 reports/_workbench/proto.log，点「草稿原型」时照着说
  const fail = (msg) => { console.error(msg); stopRunning(); process.exit(1) }
  const backend = startBackend()
  if (!(await waitFor(backend, backendUp, 60))) fail('后端起不来，或者 /api/_dev/manifest 读不到：\n' + backend.log)
  const frontend = npmRun('前端', frontendDir, 'dev', ['--port', String(port), '--strictPort'], { PORT: String(port), BACKEND_URL: `http://127.0.0.1:${protoPort}` })
  if (!(await waitFor(frontend, () => reachable(port, '/'), 60))) fail('前端开发服务起不来：\n' + frontend.log)
  console.log(`草稿原型：http://127.0.0.1:${port}/　（后端 ${protoPort}）`)
  // 哪一个中途退了（改坏了代码、依赖没装），整个退出：工作台看得出这一页没了，不让人对着一个打不开的页面等
  for (const r of [backend, frontend]) r.child.on('exit', (code) => fail(`${r.label}退出了（代码 ${code}），重起工作台或 proto.js 再来：\n${r.log}`))
}

// ================= 二、没有前端工程：原型宿主 =================

const { compile } = require('./lib/compile')
const tsconfig = path.join(codebase, 'tsconfig.json')
const webDir = path.join(codebase, 'src', 'proto', 'web')

let codebaseInBuild = null
function build() {
  const r = compile(codebase)
  codebaseInBuild = r.codebaseInBuild
  return r
}
let child = null
async function startHost() {
  if (child) { child.kill(); child = null }
  while (await portBusy(protoPort)) protoPort++ // 别的项目的宿主可能占着这个口，连过去会张冠李戴
  const c = spawn(process.execPath, [path.join(__dirname, 'lib', 'proto-run.js'), codebaseInBuild, tsconfig], { env: { ...process.env, PROTO_PORT: String(protoPort) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  c.stdout.on('data', (d) => { log += d; process.stdout.write('[宿主] ' + d) })
  c.stderr.on('data', (d) => { log += d; process.stderr.write('[宿主] ' + d) })
  c.on('exit', (code) => { if (child === c) child = null; if (code) console.error(`[宿主] 退出，代码 ${code}`) })
  child = c
  for (let i = 0; i < 50 && child; i++) {
    try { await getJson('/manifest'); return { ok: true, log } } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  return { ok: false, log }
}

async function check() {
  const b = build()
  if (!b.ok) { console.error('编译失败：\n' + b.output); process.exit(1) }
  const h = await startHost()
  if (!h.ok) { console.error('原型宿主起不来：\n' + h.log); process.exit(1) }
  const m = await getJson('/manifest')
  const missing = missingAgainstModel(m)
  console.log(`宿主登记：命令 ${m.commands.length}，查询 ${m.queries.length}，仓储 ${m.repositories.length}`)
  console.log(fs.existsSync(path.join(webDir, 'index.html')) ? '产品页面：src/proto/web/index.html 在' : '产品页面：还没有 src/proto/web/index.html')
  if (missing.length) console.log('模型有、宿主没登记：\n  ' + missing.join('\n  '))
  if (child) child.kill()
  process.exit(missing.length || !fs.existsSync(path.join(webDir, 'index.html')) ? 1 : 0)
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
// 代码里最新的改动时间：每批答案回来编码都会改代码，打开页面时比一比，改过就重编、重起宿主
function newestSrc(dir = path.join(codebase, 'src')) {
  let t = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (p !== webDir) t = Math.max(t, newestSrc(p)) } else if (e.name.endsWith('.ts')) t = Math.max(t, fs.statSync(p).mtimeMs)
  }
  return t
}
let h = { ok: false, log: '' }, builtAt = 0
async function refresh() {
  builtAt = Date.now()
  const b = build()
  if (!b.ok) console.error('编译失败，页面会说明：\n' + b.output)
  h = b.ok ? await startHost() : { ok: false, log: b.output }
}
async function serve() {
  await refresh()
  http.createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    // 打开页面时：代码比上次编译新，或宿主已经没了，就重来一次（页面上的数据会清空，跟「从头按」一样）
    if (url === '/' && (newestSrc() > builtAt || !child)) await refresh()
    if (url.startsWith('/api/')) {
      const up = http.request({ host: '127.0.0.1', port: protoPort, method: req.method, path: url.slice(4), headers: req.headers }, (ur) => { res.writeHead(ur.statusCode ?? 200, ur.headers); ur.pipe(res) })
      up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('宿主连不上：' + e.message) })
      return req.pipe(up)
    }
    if (!h.ok) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('草稿原型没跑起来：\n' + h.log) }
    const f = path.resolve(webDir, '.' + (url === '/' ? '/index.html' : url))
    if (!f.startsWith(webDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(url === '/' ? '<p>宿主跑起来了，可编码还没写产品页面：<code>src/proto/web/index.html</code>。</p>' : '没有这一页')
    }
    res.writeHead(200, { 'content-type': (TYPES[path.extname(f)] ?? 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' })
    fs.createReadStream(f).pipe(res)
  }).listen(port, '127.0.0.1', () => console.log(`草稿原型：http://127.0.0.1:${port}/`))
  const stop = () => { if (child) child.kill(); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
}

if (frontendDir) {
  if (!fs.existsSync(path.join(codebase, 'package.json'))) { console.error(`有前端目录（${frontendDir}），可代码库里没有 package.json，后端起不来：${codebase}`); process.exit(2) }
  if (cmd === 'check') checkWithFrontend()
  else serveWithFrontend()
} else if (cmd === 'check') check()
else serve()
