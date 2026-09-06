#!/usr/bin/env node
/**
 * 代码盘点：给解读角色一张地图。不读逻辑，只列结构。
 *
 *   node tools/inventory.js <代码库> [--out <md 文件>] [--max-files 4000]
 *
 * 输出（Markdown）：语言与规模；目录树（按文件数）；疑似入口（路由 / 控制器 / 处理器 / 定时 / 消费者）；
 * 疑似持久化（实体 / 模型 / 表 / 仓储 / schema）；每个源文件的类、函数、导出；目录之间的引用（import 计数）。
 * TS / JS 用编译器 AST；其它语言用正则粗扫（class / def / func / struct）。
 */
const fs = require('node:fs')
const path = require('node:path')
let ts = null
try { ts = require('typescript') } catch (e) { /* 没有就用正则 */ }

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
if (!root || !fs.existsSync(root)) { console.error('用法：node tools/inventory.js <代码库> [--out <md>]'); process.exit(2) }
const maxFiles = Number(opt('--max-files') ?? 4000)
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.proto-build', 'vendor', 'target', 'bin', 'obj', '__pycache__', '.next', '.venv', 'venv'])
const LANG = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.go': 'Go', '.rb': 'Ruby', '.php': 'PHP', '.rs': 'Rust', '.scala': 'Scala', '.sql': 'SQL', '.prisma': 'Prisma', '.proto': 'Protobuf', '.graphql': 'GraphQL', '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON' }
const SOURCE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.cs', '.go', '.rb', '.php', '.rs', '.scala'])

// ---------- 走目录 ----------
const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (files.length >= maxFiles) return
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(p) }
    else files.push(p)
  }
})(root)
const rel = (p) => path.relative(root, p).split(path.sep).join('/')
const byLang = {}
for (const f of files) { const l = LANG[path.extname(f)] ?? '其它'; byLang[l] = (byLang[l] ?? 0) + 1 }
const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').length } catch (e) { return 0 } }

// ---------- 每个源文件的符号 ----------
const ENTRY = /(controller|route|router|handler|resolver|endpoint|api|command|job|cron|scheduler|consumer|listener|subscriber|worker|webhook)/i
const PERSIST = /(entity|entities|model|models|schema|repository|repositories|dao|table|migration|orm|prisma|mongoose|sequelize|typeorm)/i
const info = [] // { file, lang, lines, classes[], functions[], exports[], imports[] , entry, persist }
function scanTs(p, text) {
  const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true)
  const out = { classes: [], functions: [], exports: [], imports: [], decorators: new Set() }
  const isExported = (n) => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export)
  const decos = (n) => (ts.canHaveDecorators?.(n) ? ts.getDecorators?.(n) ?? [] : n.decorators ?? []).map((d) => d.expression.getText(sf).replace(/\(.*$/s, ''))
  ts.forEachChild(sf, function visit(n) {
    if (ts.isImportDeclaration(n)) out.imports.push(n.moduleSpecifier.text)
    else if (ts.isClassDeclaration(n) && n.name) { const d = decos(n); d.forEach((x) => out.decorators.add(x)); out.classes.push({ name: n.name.text, exported: isExported(n), decorators: d, methods: n.members.filter((m) => ts.isMethodDeclaration(m) && m.name).map((m) => m.name.getText(sf)), extends: n.heritageClauses?.flatMap((h) => h.types.map((t) => t.expression.getText(sf))) ?? [] }) }
    else if (ts.isFunctionDeclaration(n) && n.name) out.functions.push({ name: n.name.text, exported: isExported(n) })
    else if (ts.isInterfaceDeclaration(n) && isExported(n)) out.exports.push('interface ' + n.name.text)
    else if (ts.isTypeAliasDeclaration(n) && isExported(n)) out.exports.push('type ' + n.name.text)
    else if (ts.isEnumDeclaration(n) && isExported(n)) out.exports.push('enum ' + n.name.text)
    else if (ts.isVariableStatement(n) && isExported(n)) for (const d of n.declarationList.declarations) out.exports.push('const ' + d.name.getText(sf))
    else if (ts.isExportDeclaration(n)) out.exports.push('export ' + (n.moduleSpecifier ? 'from ' + n.moduleSpecifier.text : '{…}'))
    ts.forEachChild(n, visit)
  })
  // 表达式里的路由注册：app.get('/x'), router.post(...)
  for (const m of text.matchAll(/\b(?:app|router|server|fastify|koa)\.(get|post|put|patch|delete|use)\(\s*['"`]([^'"`]+)['"`]/g)) out.exports.push(`route ${m[1].toUpperCase()} ${m[2]}`)
  return out
}
function scanRegex(p, text, ext) {
  const out = { classes: [], functions: [], exports: [], imports: [], decorators: new Set() }
  const rules = {
    '.py': { cls: /^\s*class\s+(\w+)/gm, fn: /^\s*(?:async\s+)?def\s+(\w+)/gm, imp: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm, deco: /^\s*@(\w+)/gm },
    '.java': { cls: /\b(?:class|interface|enum|record)\s+(\w+)/g, fn: /\b(?:public|protected|private|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\([^)]*\)\s*(?:throws[^{]+)?\{/g, imp: /^import\s+([\w.]+)/gm, deco: /@(\w+)/g },
    '.kt': { cls: /\b(?:class|interface|object|data class)\s+(\w+)/g, fn: /\bfun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?(\w+)\s*\(/g, imp: /^import\s+([\w.]+)/gm, deco: /@(\w+)/g },
    '.cs': { cls: /\b(?:class|interface|record|struct|enum)\s+(\w+)/g, fn: /\b(?:public|protected|private|internal|static|async|override|virtual|\s)+[\w<>\[\],?\s]+\s+(\w+)\s*\([^)]*\)\s*\{/g, imp: /^using\s+([\w.]+)/gm, deco: /\[(\w+)/g },
    '.go': { cls: /\btype\s+(\w+)\s+(?:struct|interface)/g, fn: /\bfunc\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/g, imp: /^\s*"([^"]+)"$/gm, deco: /$^/g },
    '.rb': { cls: /^\s*(?:class|module)\s+([\w:]+)/gm, fn: /^\s*def\s+([\w.?!]+)/gm, imp: /^\s*require(?:_relative)?\s+['"]([^'"]+)/gm, deco: /$^/g },
    '.php': { cls: /\b(?:class|interface|trait|enum)\s+(\w+)/g, fn: /\bfunction\s+(\w+)\s*\(/g, imp: /^use\s+([\w\\]+)/gm, deco: /#\[(\w+)/g },
    '.rs': { cls: /\b(?:struct|enum|trait)\s+(\w+)/g, fn: /\bfn\s+(\w+)\s*[<(]/g, imp: /^use\s+([\w:]+)/gm, deco: /#\[(\w+)/g },
    '.scala': { cls: /\b(?:class|object|trait|case class)\s+(\w+)/g, fn: /\bdef\s+(\w+)/g, imp: /^import\s+([\w.]+)/gm, deco: /@(\w+)/g },
  }
  const r = rules[ext] ?? rules['.java']
  for (const m of text.matchAll(r.cls)) out.classes.push({ name: m[1], exported: true, decorators: [], methods: [], extends: [] })
  for (const m of text.matchAll(r.fn)) out.functions.push({ name: m[1], exported: true })
  for (const m of text.matchAll(r.imp)) out.imports.push(m[1] ?? m[2])
  for (const m of text.matchAll(r.deco)) out.decorators.add(m[1])
  return out
}
for (const f of files) {
  const ext = path.extname(f)
  if (!SOURCE.has(ext)) continue
  let text = ''; try { text = fs.readFileSync(f, 'utf8') } catch (e) { continue }
  const r = rel(f)
  const sym = ts && ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext) ? scanTs(f, text) : scanRegex(f, text, ext)
  const decoText = [...sym.decorators].join(' ')
  info.push({ file: r, lang: LANG[ext], lines: text.split('\n').length, ...sym, decorators: [...sym.decorators], entry: ENTRY.test(r) || /(Controller|Get|Post|Put|Delete|Cron|EventPattern|MessagePattern|Route|RequestMapping|GetMapping|PostMapping|HttpGet|HttpPost|Scheduled|KafkaListener|RabbitListener|SqsListener|api_view|route|app\.route)/.test(decoText) || sym.exports.some((e) => e.startsWith('route ')), persist: PERSIST.test(r) || /(Entity|Table|Column|Document|Schema|Model|Repository|Embeddable|OneToMany|ManyToOne)/.test(decoText) })
}

// ---------- 目录统计与引用 ----------
const dirCount = {}
for (const f of files) { const d = path.dirname(rel(f)); const top = d.split('/').slice(0, 3).join('/') || '.'; dirCount[top] = (dirCount[top] ?? 0) + 1 }
const dirOf = (f) => { const d = path.dirname(f).split('/'); return d.slice(0, Math.min(3, d.length)).join('/') || '.' }
const refs = {}
for (const i of info) {
  const from = dirOf(i.file)
  for (const imp of i.imports) {
    if (!imp.startsWith('.') && !imp.startsWith('/') && !imp.startsWith('@/') && !imp.startsWith('src/')) continue
    const target = imp.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(i.file), imp)) : imp.replace(/^@\//, 'src/')
    const to = dirOf(target)
    if (to === from) continue
    const k = from + ' → ' + to; refs[k] = (refs[k] ?? 0) + 1
  }
}

// ---------- 输出 ----------
const L = []
L.push(`# 代码盘点：${path.basename(root)}`, '', `路径：${root}`, '')
L.push('## 规模', '', `文件 ${files.length}（源文件 ${info.length}，共 ${info.reduce((a, i) => a + i.lines, 0)} 行）。语言：` + Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，'), '')
L.push('## 目录（前三层，按文件数）', '', '| 目录 | 文件 |', '|---|---|', ...Object.entries(dirCount).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([d, n]) => `| ${d} | ${n} |`), '')
const entries = info.filter((i) => i.entry), persist = info.filter((i) => i.persist)
L.push(`## 疑似入口（${entries.length}）`, '', '路由、控制器、处理器、定时、消费者。每个入口 = 一个候选的命令 / 查询。', '')
for (const i of entries.slice(0, 200)) L.push(`- \`${i.file}\`（${i.lines} 行）：` + [...i.classes.map((c) => `${c.name}${c.decorators.length ? ' @' + c.decorators.join(' @') : ''}${c.methods.length ? ' { ' + c.methods.slice(0, 12).join(', ') + (c.methods.length > 12 ? ', …' : '') + ' }' : ''}`), ...i.functions.map((f) => f.name + '()'), ...i.exports.filter((e) => e.startsWith('route '))].join('；'))
L.push('', `## 疑似持久化（${persist.length}）`, '', '实体、表、schema、仓储。每张表 / 每个实体 = 候选的聚合或实体；同一次保存写到的几张表 = 候选的聚合边界。', '')
for (const i of persist.slice(0, 200)) L.push(`- \`${i.file}\`（${i.lines} 行）：` + [...i.classes.map((c) => `${c.name}${c.extends.length ? ' extends ' + c.extends.join(', ') : ''}${c.decorators.length ? ' @' + c.decorators.join(' @') : ''}`), ...i.exports.filter((e) => !e.startsWith('route '))].join('；'))
L.push('', '## 目录之间的引用（import 次数，前三层目录）', '', '箭头多的方向是依赖方向；互相引用的两个目录多半该是同一个模块，或者边界划错了。', '', '| 从 → 到 | 次数 |', '|---|---|', ...Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, n]) => `| ${k} | ${n} |`), '')
L.push('## 全部源文件的符号', '')
for (const i of info.sort((a, b) => a.file.localeCompare(b.file))) {
  const syms = [...i.classes.map((c) => `${c.name}${c.methods.length ? '{' + c.methods.length + '}' : ''}`), ...i.functions.map((f) => f.name + '()'), ...i.exports.filter((e) => !e.startsWith('export '))]
  L.push(`- \`${i.file}\` ${i.lines} 行${i.entry ? ' 【入口】' : ''}${i.persist ? ' 【持久化】' : ''}${syms.length ? '：' + syms.slice(0, 20).join(', ') + (syms.length > 20 ? ', …' : '') : ''}`)
}
const md = L.join('\n') + '\n'
const out = opt('--out')
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, md); console.log(`已写出 ${out}（源文件 ${info.length}，入口 ${entries.length}，持久化 ${persist.length}）`) }
else process.stdout.write(md)
