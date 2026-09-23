#!/usr/bin/env node
/**
 * 草稿原型：把代码库编译了跑起来，挂上项目自己的产品页面，让人按身份在上面操作。
 *
 *   node tools/proto.js serve <项目> --code <代码库> [--port 4872] [--proto-port 4875] [--no-open]
 *       编译（tsc → <代码库>/.proto-build），启动 src/proto/main.ts 的原型宿主，
 *       把 <代码库>/src/proto/web/ 当静态页面挂出来；页面里的 /api/… 转给宿主（/manifest、/run、/state、/events、/reset）
 *   node tools/proto.js check <项目> --code <代码库> [--slice <切片>]
 *       只编译、启动、对照模型：模型里的命令、查询、聚合都登记进宿主了没有；退出码非 0 表示缺
 *
 * 宿主的写法见 building-block/proto/README.md。产品页面由编码写：按身份分，一个按钮调一个命令，
 * 一栏对应模型的一个字段，领域错误按类名回来、对照模型里错误的 condition 翻成人话。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

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
const { compile } = require('./lib/compile')
const tsconfig = path.join(codebase, 'tsconfig.json')
const webDir = path.join(codebase, 'src', 'proto', 'web')

let codebaseInBuild = null
function build() {
  const r = compile(codebase)
  codebaseInBuild = r.codebaseInBuild
  return r
}
function portBusy(p) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(true))
    s.once('listening', () => s.close(() => resolve(false)))
    s.listen(p, '127.0.0.1')
  })
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
    try { await hostJson('GET', '/manifest'); return { ok: true, log } } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  return { ok: false, log }
}
function hostJson(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: protoPort, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
}

async function check() {
  const b = build()
  if (!b.ok) { console.error('编译失败：\n' + b.output); process.exit(1) }
  const h = await startHost()
  if (!h.ok) { console.error('原型宿主起不来：\n' + h.log); process.exit(1) }
  const m = await hostJson('GET', '/manifest')
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
  console.log(`宿主登记：命令 ${m.commands.length}，查询 ${m.queries.length}，仓储 ${m.repositories.length}`)
  console.log(fs.existsSync(path.join(webDir, 'index.html')) ? '产品页面：src/proto/web/index.html 在' : '产品页面：还没有 src/proto/web/index.html')
  if (missing.length) console.log('模型有、宿主没登记：\n  ' + missing.join('\n  '))
  if (child) child.kill()
  process.exit(missing.length || !fs.existsSync(path.join(webDir, 'index.html')) ? 1 : 0)
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
async function serve() {
  const b = build()
  if (!b.ok) console.error('编译失败，页面会说明：\n' + b.output)
  const h = b.ok ? await startHost() : { ok: false, log: b.output }
  http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
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

if (cmd === 'check') check()
else serve()
