/**
 * 依赖方向：扫代码库 src 下每一条 import，按编码规范第二节的格子判它越没越界。
 *
 * 每个文件先定格子：
 *   modules/<模块>/{domain,application,ports,adapters}/…、modules/<模块>/module.ts
 *   shared/building-block/{domain,application,ports,proto}/…
 *   infras/<技术件>/…
 *   bootstrap/…，或没有前端工程的原型用的 proto/…——外壳：依赖所有，谁都不依赖它
 *   别的都是不认得的地方：报一次，里面的 import 不查方向（查了也没有格子可对）。
 * 再把每条 import 解析到文件：相对路径照文件位置找，别名照代码库 tsconfig 的 paths 找，
 * 两样都不是的当外部包（express、node:crypto 这类）。
 *
 * 只出机器判得出的对错，不出判断项。
 */
const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')

let ts = null
try { ts = require('typescript') } catch { /* 没有 typescript 就用正则取 import，tsconfig 当 JSON 读 */ }

const MODULE_LAYERS = ['domain', 'application', 'ports', 'adapters']
const SHARED_LAYERS = ['domain', 'application', 'ports', 'proto']
const SHELLS = { bootstrap: 'bootstrap', proto: '原型宿主入口 proto/' }

/** 模块里一层能依赖本模块的哪几层 */
const IN_MODULE = {
  domain: ['domain'],
  application: ['domain', 'application', 'ports'],
  ports: ['domain', 'ports'],
  adapters: ['domain', 'ports', 'application', 'adapters'],
  module: ['domain', 'application', 'ports', 'adapters'],
}
/** 模块里一层能依赖构建块的哪几层（构建块的 proto 只给外壳用） */
const TO_SHARED = {
  domain: ['domain'],
  application: ['application', 'ports'],
  ports: ['domain', 'application', 'ports'],
  adapters: ['domain', 'application', 'ports'],
  module: ['domain', 'application', 'ports'],
}
/** 构建块里一层能依赖构建块的哪几层：domain ← application ← ports，proto 在最外面 */
const SHARED_INSIDE = {
  domain: ['domain'],
  application: ['domain', 'application'],
  ports: ['domain', 'application', 'ports'],
  proto: ['domain', 'application', 'ports', 'proto'],
}
/** 每一层为什么只能依赖那几样：报错时照这句说 */
const WHY_LAYER = {
  domain: 'domain 只依赖本模块的 domain/ 与构建块的 domain',
  application: 'application 依赖本模块的 domain/、ports/（处理器之间可以互相引类型）与构建块的 application、ports',
  ports: 'ports 只用领域类型或标量：依赖本模块的 domain/ 与构建块的 domain、application、ports',
  adapters: 'adapters 依赖本模块的 domain/、ports/、application/ 与构建块的 domain、application、ports',
  module: 'module.ts 只装配本模块：new 本模块的适配器、处理器，外面给的东西认构建块或本模块 ports/ 里的接口',
}
const WHY = {
  moduleInfras: '模块里只有 adapters/ 可以依赖 infras',
  crossModule: '模块之间不互相 import（跨模块走端口：本模块 ports/ 里写接口，adapters/ 里的直连适配器收一个形状对得上的函数或对象，由 bootstrap 把对方的处理器递进来）',
  infrasModule: 'infras 不含业务：只 import 各模块 application/ 里的处理器与命令、查询类型',
  sharedOut: '构建块不含业务：不 import 模块、infras、bootstrap',
  sharedInside: '构建块里 domain ← application ← ports，proto 在最外面，里层不依赖外层',
  sharedProto: '构建块的 proto/ 是原型宿主与进程内事件总线，只给外壳（bootstrap/、proto/）用，模块里认 ports 里的接口',
  domainExternal: 'domain 不 import 外部包',
  sharedExternal: '构建块的外部包只用 node 自带的',
  unknownTarget: 'src 底下只认 modules/、shared/building-block/、infras/、bootstrap/（没有前端工程的原型用 proto/）',
}
const whyShell = (shell) => (shell === 'bootstrap' ? '谁都不依赖 bootstrap，它是组合根，只有它依赖别人' : '原型宿主入口 proto/ 跟 bootstrap 一样是外壳，谁都不依赖它')

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(p, out) }
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** 代码库 tsconfig 的 paths：[{ prefix, suffix, star, targets[] }]，targets 是绝对路径模板 */
function readAliases(codebase) {
  const file = path.join(codebase, 'tsconfig.json')
  if (!fs.existsSync(file)) return []
  let paths = {}
  let base = codebase
  try {
    if (ts) {
      const cfg = ts.readConfigFile(file, ts.sys.readFile)
      const opts = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, codebase).options
      paths = opts.paths ?? {}
      base = opts.baseUrl ?? opts.pathsBasePath ?? codebase
    } else {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      paths = raw.compilerOptions?.paths ?? {}
      base = path.resolve(codebase, raw.compilerOptions?.baseUrl ?? '.')
    }
  } catch { return [] }
  return Object.entries(paths).map(([alias, targets]) => {
    const star = alias.indexOf('*')
    return {
      prefix: star < 0 ? alias : alias.slice(0, star),
      suffix: star < 0 ? '' : alias.slice(star + 1),
      star: star >= 0,
      targets: (targets ?? []).map((t) => path.resolve(base, t)),
    }
  })
}

/** 一个路径落到哪个文件：原样、补 .ts、.js 换 .ts、目录下的 index.ts */
function toFile(p) {
  const cands = [p, `${p}.ts`, `${p}.tsx`, `${p}.d.ts`, path.join(p, 'index.ts'), path.join(p, 'index.tsx')]
  if (/\.(c|m)?js$/.test(p)) cands.push(p.replace(/\.(c|m)?js$/, '.ts'), p.replace(/\.(c|m)?js$/, '.tsx'))
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  return null
}

/** 解析一条 import：{ file } 落到代码库里的文件；{ external } 外部包；{ missing } 找不到 */
function resolveSpec(fromFile, spec, aliases) {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const f = toFile(path.resolve(path.dirname(fromFile), spec))
    return f ? { file: f } : { missing: true }
  }
  // 别名照 TypeScript 的挑法：前缀最长的那条先试，targets 按顺序试
  const hits = aliases
    .filter((a) => (a.star ? spec.startsWith(a.prefix) && spec.endsWith(a.suffix) && spec.length >= a.prefix.length + a.suffix.length : spec === a.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  if (hits.length) {
    const a = hits[0]
    const mid = a.star ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : ''
    for (const t of a.targets) {
      const f = toFile(a.star ? t.replace('*', mid) : t)
      if (f) return { file: f }
    }
    return { missing: true }
  }
  return { external: spec }
}

/** 一个文件在哪一格 */
function placeOf(src, file) {
  const rel = path.relative(src, file)
  if (rel.startsWith('..')) return { area: 'outside', folder: rel }
  const parts = rel.split(path.sep)
  const unknown = (n) => ({ area: 'unknown', folder: ['src', ...parts.slice(0, n)].join('/') })
  if (parts.length === 1) return unknown(1)
  if (parts[0] === 'modules') {
    if (parts.length === 2) return unknown(2)
    if (parts.length === 3) return parts[2].replace(/\.tsx?$/, '') === 'module' ? { area: 'module', module: parts[1], layer: 'module' } : unknown(3)
    return MODULE_LAYERS.includes(parts[2]) ? { area: 'module', module: parts[1], layer: parts[2] } : unknown(3)
  }
  if (parts[0] === 'shared') {
    if (parts[1] !== 'building-block') return unknown(2)
    if (parts.length < 4) return unknown(3)
    return SHARED_LAYERS.includes(parts[2]) ? { area: 'shared', layer: parts[2] } : unknown(3)
  }
  if (parts[0] === 'infras') return { area: 'infras', part: parts.length > 2 ? parts[1] : null }
  if (SHELLS[parts[0]]) return { area: 'shell', shell: parts[0] }
  return unknown(1)
}

/** 给人读的「谁」 */
function describe(pl) {
  if (pl.area === 'module') return pl.layer === 'module' ? `${pl.module} 模块的 module.ts` : `${pl.module} 模块的 ${pl.layer}/`
  if (pl.area === 'shared') return `构建块的 ${pl.layer}/`
  if (pl.area === 'infras') return pl.part ? `infras/${pl.part}` : 'infras'
  if (pl.area === 'shell') return SHELLS[pl.shell]
  if (pl.area === 'outside') return `src 外面的 ${pl.folder}`
  return `${pl.folder}/`
}

/** 这条 import 引进来的名字（import { A, type B as C } from …）：给报错读的，取不出就不说 */
function importedNames(text, pos) {
  const start = Math.max(text.lastIndexOf('import', pos), text.lastIndexOf('export', pos))
  if (start < 0) return []
  const head = text.slice(start, pos)
  const braces = head.match(/\{([^}]*)\}/)
  if (braces) return braces[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean)
  const star = head.match(/\*\s+as\s+([\w$]+)/)
  if (star) return [star[1]]
  const def = head.match(/^import\s+(?:type\s+)?([\w$]+)\s*(?:,|from)/)
  return def ? [def[1]] : []
}

/** 取一个文件里所有 import 的原文与位置：import / export … from / import() / require() */
function importsOf(text) {
  if (ts) {
    const info = ts.preProcessFile(text, true, true)
    return info.importedFiles.map((f) => ({ spec: f.fileName, pos: f.pos }))
  }
  const out = []
  const res = [/\bfrom\s+(['"])([^'"]+)\1/g, /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, /^\s*import\s+(['"])([^'"]+)\1/gm, /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g]
  for (const re of res) for (const m of text.matchAll(re)) out.push({ spec: m[2], pos: m.index + m[0].lastIndexOf(m[2]) })
  return out
}

const lineAt = (text, pos) => text.slice(0, pos).split('\n').length
const isNodeBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])

/**
 * 查一个代码库的依赖方向。
 * 返回 { files, imports, problems: [{ check, target, text }] }；target 是「src/…/文件.ts:行」，text 是人话。
 * 代码库没有 src 就什么都不查。
 */
function checkDependencies(codebase) {
  const src = path.join(codebase, 'src')
  const problems = []
  if (!fs.existsSync(src)) return { files: 0, imports: 0, problems }
  const aliases = readAliases(codebase)
  const files = walk(src)
  const unknownFolders = new Set()
  let imports = 0
  for (const file of files) {
    const me = placeOf(src, file)
    if (me.area === 'unknown') { unknownFolders.add(me.folder); continue }
    const text = fs.readFileSync(file, 'utf8')
    const relFile = path.relative(codebase, file).split(path.sep).join('/')
    for (const { spec, pos } of importsOf(text)) {
      imports++
      const target = `${relFile}:${lineAt(text, pos)}`
      const r = resolveSpec(file, spec, aliases)
      if (r.missing) {
        problems.push({ check: 'deps.unresolved', target, text: `${describe(me)} 引的 ${spec} 找不到文件（相对路径照文件位置找，别名照 tsconfig 的 paths 找）` })
        continue
      }
      if (r.external) {
        if (me.area === 'module' && me.layer === 'domain') problems.push({ check: 'deps.direction', target, text: `${describe(me)} 引了外部包 ${spec}：${WHY.domainExternal}` })
        if (me.area === 'shared' && !isNodeBuiltin(spec)) problems.push({ check: 'deps.direction', target, text: `${describe(me)} 引了外部包 ${spec}：${WHY.sharedExternal}` })
        continue
      }
      if (me.area === 'shell') continue // 外壳依赖所有
      const to = placeOf(src, r.file)
      const toRel = path.relative(src, r.file).split(path.sep).join('/').replace(/\.tsx?$/, '').replace(/\/index$/, '')
      const names = importedNames(text, pos)
      const what = `${/^[A-Za-z]/.test(describe(to)) ? ' ' : ''}${describe(to)}（${toRel}）${names.length ? `里的 ${names.join('、')}` : ''}`
      const say = (why) => problems.push({ check: 'deps.direction', target, text: `${describe(me)} 引了${what}：${why}` })
      if (to.area === 'unknown' || to.area === 'outside') { say(WHY.unknownTarget); continue }
      if (to.area === 'shell') { say(whyShell(to.shell)); continue }
      if (me.area === 'module') {
        if (to.area === 'infras') { if (me.layer !== 'adapters') say(WHY.moduleInfras); continue }
        if (to.area === 'module' && to.module !== me.module) { say(WHY.crossModule); continue }
        if (to.area === 'module' && !IN_MODULE[me.layer].includes(to.layer)) { say(WHY_LAYER[me.layer]); continue }
        if (to.area === 'shared' && !TO_SHARED[me.layer].includes(to.layer)) { say(to.layer === 'proto' ? WHY.sharedProto : WHY_LAYER[me.layer]); continue }
      } else if (me.area === 'infras') {
        if (to.area === 'module' && to.layer !== 'application') say(WHY.infrasModule)
      } else if (me.area === 'shared') {
        if (to.area !== 'shared') say(WHY.sharedOut)
        else if (!SHARED_INSIDE[me.layer].includes(to.layer)) say(WHY.sharedInside)
      }
    }
  }
  for (const folder of [...unknownFolders].sort()) {
    problems.push({ check: 'deps.unknown-folder', target: folder, text: `${folder} 不是认得的地方：${WHY.unknownTarget}；里面的文件不知道算哪一格，它们的 import 没查方向` })
  }
  return { files: files.length, imports, problems }
}

module.exports = { checkDependencies }
