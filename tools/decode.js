#!/usr/bin/env node
/**
 * 解码器：从代码库的核心圈（domain / application / ports）还原模型 JSON。
 * 依据：agents/code/coding-standard.md「解码规则汇总」。
 *
 * 用法：node tools/decode.js <代码库目录> <输出目录> [--system <系统名>]
 * 输出：与 model/ 同结构的 JSON；另有 _decode-issues.json 记录解码期发现的违规。
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// ---------- 参数 ----------
const args = process.argv.slice(2)
const codebase = args[0] && path.resolve(args[0])
const outDir = args[1] && path.resolve(args[1])
const sysIdx = args.indexOf('--system')
const systemName = sysIdx >= 0 ? args[sysIdx + 1] : ''
if (!codebase || !outDir) {
  console.error('用法：node tools/decode.js <代码库目录> <输出目录> [--system <系统名>]')
  process.exit(2)
}
const srcDir = fs.existsSync(path.join(codebase, 'src')) ? path.join(codebase, 'src') : codebase

// ---------- 常量 ----------
const PREFIX_SUFFIX = {
  'aggregate-root': 'AggregateRoot',
  entity: 'Entity',
  'value-object': 'ValueObject',
  event: 'Event',
  error: 'Error',
  service: 'Service',
  repository: 'Interface',
  'command-handler': 'CommandHandler',
  'query-handler': 'QueryHandler',
  'event-handler': 'EventHandler',
  port: 'Interface',
}
const DOMAIN_OBJECT = new Set(['aggregate-root', 'entity', 'value-object'])
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'delete', 'clear', 'fill'])
const READ_PREFIX = /^(find|exists|count)/

const issues = []
function issue(file, text) {
  issues.push({ file: rel(file), text })
}
function rel(p) {
  return path.relative(srcDir, p).replaceAll('\\', '/')
}

// ---------- 文件登记：路径 → 种类 ----------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** @type {Map<string, Entry>} 绝对路径 → 登记项 */
const registry = new Map()
/** 每个模块：{ name, dir, aggregates: Map<folder, {root, members: []}> } */
const modules = new Map()

/** 文件夹名 → 模块名（agents/common/project-layout.md「名字的两套写法」：文件夹全小写连字符，模块名 PascalCase）。
 *  组合根 module.ts 里 export function build<Module>Module 写的是真名，先信它；没有就按词换算（service-agreements → ServiceAgreements） */
function moduleNameOfFolder(folder, modDir) {
  const modFile = path.join(modDir, 'module.ts')
  if (fs.existsSync(modFile)) {
    const m = fs.readFileSync(modFile, 'utf8').match(/export\s+function\s+build([A-Za-z0-9]+)Module\s*\(/)
    if (m) return m[1]
  }
  return folder.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}
for (const folder of fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'shared' && e.name !== 'proto').map((e) => e.name)) {
  const modDir = path.join(srcDir, folder)
  const modName = moduleNameOfFolder(folder, modDir)
  if (folder !== folder.toLowerCase()) issue(modDir, `模块文件夹应全小写、多词连字符：${folder} → ${folder.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`)
  modules.set(modName, { name: modName, dir: modDir, aggregates: new Map() })
  for (const file of walk(modDir)) {
    const relPath = path.relative(modDir, file).replaceAll('\\', '/')
    const parts = relPath.split('/')
    const layer = parts[0]
    const base = path.basename(file, '.ts')
    const m = base.match(/^([a-z-]+)\.([A-Za-z0-9]+)$/)
    if (layer === 'adapters' || base === 'module') continue
    if (!m || !PREFIX_SUFFIX[m[1]]) {
      if (['domain', 'application', 'ports'].includes(layer)) issue(file, '文件名不符合 <种类>.<类名>.ts')
      continue
    }
    const [, prefix, className] = m
    const suffix = PREFIX_SUFFIX[prefix]
    if (!className.endsWith(suffix)) {
      issue(file, `类名应以 ${suffix} 结尾：${className}`)
      continue
    }
    const modelName = className.slice(0, -suffix.length)
    const aggregateFolder = layer === 'domain' && parts.length === 3 ? parts[1] : null
    const entry = { file, prefix, className, modelName, module: modName, layer, aggregateFolder, aggregate: null }
    registry.set(path.normalize(file), entry)
    if (aggregateFolder) {
      const mod = modules.get(modName)
      if (!mod.aggregates.has(aggregateFolder)) mod.aggregates.set(aggregateFolder, { root: null, members: [] })
      const agg = mod.aggregates.get(aggregateFolder)
      if (prefix === 'aggregate-root') agg.root = entry
      else if (prefix === 'entity' || prefix === 'value-object') agg.members.push(entry)
    }
  }
}
// 每个域对象所属的聚合（根的模型名）
for (const mod of modules.values()) {
  for (const [folder, agg] of mod.aggregates) {
    if (!agg.root) {
      issue(path.join(mod.dir, 'domain', folder), '聚合文件夹没有 aggregate-root 文件')
      continue
    }
    for (const e of registry.values()) if (e.module === mod.name && e.aggregateFolder === folder) e.aggregate = agg.root.modelName
  }
}

// ---------- TypeScript 程序 ----------
const configPath = ts.findConfigFile(codebase, ts.sys.fileExists, 'tsconfig.json')
let options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true }
let rootNames = walk(srcDir)
if (configPath) {
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(configPath))
  options = { ...parsed.options, noEmit: true }
  rootNames = parsed.fileNames.length ? parsed.fileNames : rootNames
}
// 基础构建块的别名：项目未配置或配置指向不存在的目录时，回退到 dev-team 自带的构建块
{
  const alias = '@shared/building-block/*'
  const baseUrl = options.baseUrl ?? codebase
  const mapped = options.paths?.[alias]?.[0]
  const mappedDir = mapped ? path.resolve(baseUrl, mapped.replace(/\*$/, '')) : null
  const projectBB = path.join(srcDir, 'shared', 'building-block')
  const fallback = fs.existsSync(projectBB) ? projectBB : path.join(__dirname, '..', 'building-block')
  if (!mappedDir || !fs.existsSync(mappedDir)) {
    options.baseUrl = baseUrl
    options.paths = { ...(options.paths ?? {}), [alias]: [path.join(fallback, '*')] }
  }
  // 确保构建块源码进入程序，类型才能解析
  for (const f of walk(fallback)) if (!rootNames.includes(f)) rootNames.push(f)
}
const program = ts.createProgram(rootNames, options)
const checker = program.getTypeChecker()

function entryOfFile(fileName) {
  return registry.get(path.normalize(fileName)) ?? null
}
/** 节点所在文件的登记项；若节点是一个具名声明，必须是该文件的主类 / 主接口，否则不算 */
function entryOfNode(node) {
  if (!node) return null
  const entry = entryOfFile(node.getSourceFile().fileName)
  if (!entry) return null
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeLiteralNode(node)) {
    const name = node.name?.text
    if (name !== entry.className) return null
  }
  return entry
}
/** 标识符 → 其声明（解析 import 别名） */
function declOf(identifierNode) {
  const sym = checker.getSymbolAtLocation(identifierNode)
  if (!sym) return null
  const real = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
  return real.declarations?.[0] ?? null
}
function isBuildingBlock(fileName) {
  return /building-block/.test(fileName.replaceAll('\\', '/'))
}

// ---------- JSDoc 标签解析（自写，支持带连字符的标签名） ----------
function docTags(node) {
  const sf = node.getSourceFile()
  const text = sf.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const tags = []
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    const raw = text.slice(r.pos, r.end)
    if (!raw.startsWith('/**')) continue
    const body = raw.slice(3, -2)
    const lines = body.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    let cur = null
    for (const line of lines) {
      const m = line.match(/^\s*@([\w-]+)\s*(.*)$/)
      if (m) {
        // 同一行可能有多个标签：@trace R-005 @rule ...
        const segs = line.split(/\s(?=@[\w-]+\s)/)
        for (const seg of segs) {
          const mm = seg.match(/^\s*@([\w-]+)\s*(.*)$/)
          if (!mm) continue
          cur = { tag: mm[1], text: mm[2].trim() }
          tags.push(cur)
        }
      } else if (cur && line.trim()) {
        cur.text = (cur.text + ' ' + line.trim()).trim()
      }
    }
  }
  return tags
}
function tagValues(tags, name) {
  return tags.filter((t) => t.tag === name).map((t) => t.text)
}
function traceTags(tags) {
  const out = []
  for (const t of tagValues(tags, 'trace')) for (const id of t.split(/[\s,]+/).filter(Boolean)) if (!out.includes(id)) out.push(id)
  return out
}
/** `[R-001 R-002] 文本 {ErrA ErrB}` → { text, traces, throws } */
function parseInvariant(text) {
  let traces = []
  let throwsList = []
  let t = text.trim()
  const lead = t.match(/^\[([^\]]*)\]\s*(.*)$/)
  if (lead) {
    traces = lead[1].split(/[\s,]+/).filter(Boolean)
    t = lead[2]
  }
  const tail = t.match(/^(.*?)\s*\{([^}]*)\}\s*$/)
  if (tail) {
    t = tail[1]
    throwsList = tail[2].split(/[\s,]+/).filter(Boolean)
  }
  const inv = { text: t.trim(), traces }
  if (throwsList.length) inv.throws = throwsList
  return inv
}
/** 语句上方最后一行 // 注释 */
function lineComment(node) {
  const sf = node.getSourceFile()
  const text = sf.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const singles = ranges.filter((r) => r.kind === ts.SyntaxKind.SingleLineCommentTrivia)
  if (!singles.length) return null
  const r = singles[singles.length - 1]
  return text.slice(r.pos + 2, r.end).trim()
}

// ---------- 类型映射 ----------
function stripSuffix(name) {
  for (const suffix of Object.values(PREFIX_SUFFIX)) if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length)
  return name
}
function isNullish(t) {
  return (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
}
/** 返回 { type: string|null, nullable: boolean }；type 为 null 表示 void */
function mapType(t, currentModule) {
  let nullable = false
  if (t.isUnion()) {
    const parts = t.types.filter((x) => !isNullish(x))
    if (parts.length !== t.types.length) nullable = true
    if (parts.length === 0) return { type: null, nullable }
    if (parts.every((x) => x.flags & ts.TypeFlags.StringLiteral)) return { type: 'string', nullable }
    if (parts.every((x) => x.flags & ts.TypeFlags.BooleanLiteral)) return { type: 'boolean', nullable }
    if (parts.length === 1) {
      const inner = mapType(parts[0], currentModule)
      return { type: inner.type, nullable: nullable || inner.nullable }
    }
    if (t.aliasSymbol) return { type: t.aliasSymbol.name, nullable }
    return { type: checker.typeToString(t), nullable }
  }
  if (t.flags & ts.TypeFlags.Void || t.flags & ts.TypeFlags.Undefined) return { type: null, nullable }
  if (t.flags & ts.TypeFlags.StringLike) return { type: 'string', nullable }
  if (t.flags & ts.TypeFlags.NumberLike) return { type: 'number', nullable }
  if (t.flags & ts.TypeFlags.BooleanLike) return { type: 'boolean', nullable }
  const sym = t.getSymbol()
  const name = sym?.name
  if (name === 'Promise') {
    const inner = checker.getTypeArguments(t)[0]
    return inner ? mapType(inner, currentModule) : { type: null, nullable }
  }
  if (name === 'Date') return { type: 'date', nullable }
  if (checker.isArrayType(t) || name === 'ReadonlyArray' || name === 'Array') {
    const inner = checker.getTypeArguments(t)[0]
    const m = inner ? mapType(inner, currentModule) : { type: 'unknown' }
    return { type: `${m.type}[]`, nullable }
  }
  if (sym && sym.declarations?.length) {
    const decl = sym.declarations[0]
    const entry = entryOfNode(decl)
    if (entry) {
      const q = entry.module !== currentModule ? `${entry.module}.${entry.modelName}` : entry.modelName
      return { type: q, nullable }
    }
    if (t.aliasSymbol) return { type: t.aliasSymbol.name, nullable }
    if (name && name !== '__type' && name !== '__object') return { type: stripSuffix(name), nullable }
  }
  if (t.aliasSymbol) return { type: t.aliasSymbol.name, nullable }
  return { type: checker.typeToString(t), nullable }
}
function paramsOf(sig, currentModule) {
  return sig.parameters.map((p) => {
    const decl = p.valueDeclaration
    const t = checker.getTypeOfSymbolAtLocation(p, decl)
    return { name: p.name, type: mapType(t, currentModule).type ?? 'unknown' }
  })
}
function membersOfType(t, currentModule) {
  const fields = []
  const refs = []
  for (const p of t.getProperties()) {
    const decl = p.valueDeclaration ?? p.declarations?.[0]
    const pt = checker.getTypeOfSymbolAtLocation(p, decl)
    const m = mapType(pt, currentModule)
    const f = { name: p.name, type: m.type ?? 'unknown' }
    if (m.nullable || (decl && decl.questionToken)) f.nullable = true
    if (decl) {
      const tags = docTags(decl)
      const note = tagValues(tags, 'note')[0]
      if (note) f.note = note
      // 字段本身也在承载业务语句（一栏照抄纸上印的名目、供人查），带了追溯就读回来
      const fieldTraces = traceTags(tags)
      if (fieldTraces.length) f.traces = fieldTraces
      const ref = tagValues(tags, 'ref')[0]
      if (ref) refs.push({ field: p.name, to: ref })
    }
    fields.push(f)
  }
  return { fields, refs }
}

// ---------- 类与方法 ----------
function classesIn(sf) {
  return sf.statements.filter(ts.isClassDeclaration)
}
function interfacesIn(sf) {
  return sf.statements.filter(ts.isInterfaceDeclaration)
}
function mainClass(sf, className) {
  return classesIn(sf).find((c) => c.name?.text === className) ?? null
}
function isPublic(member) {
  const mods = ts.getCombinedModifierFlags(member)
  return !(mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected))
}
function isStatic(member) {
  return (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0
}
function methodsOf(cls) {
  return cls.members.filter((m) => ts.isMethodDeclaration(m) && m.body)
}
function behaviorsOf(cls) {
  return methodsOf(cls).filter((m) => isPublic(m) && !isStatic(m))
}
function factoriesOf(cls) {
  return methodsOf(cls).filter((m) => isStatic(m))
}
function propsTypeOf(cls, currentModule) {
  const ctor = cls.members.find(ts.isConstructorDeclaration)
  if (!ctor) return null
  const propsParam = ctor.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === 'props')
  if (propsParam) return membersOfType(checker.getTypeAtLocation(propsParam), currentModule)
  // 值对象：readonly 参数属性
  const fields = []
  for (const p of ctor.parameters) {
    const mods = ts.getCombinedModifierFlags(p)
    if (!(mods & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Public | ts.ModifierFlags.Private))) continue
    const m = mapType(checker.getTypeAtLocation(p), currentModule)
    const f = { name: p.name.getText(), type: m.type ?? 'unknown' }
    if (m.nullable || p.questionToken) f.nullable = true
    fields.push(f)
  }
  return { fields, refs: [] }
}

// ---------- 调用解析 ----------
function unwrap(expr) {
  let e = expr
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression
      continue
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const sym = checker.getSymbolAtLocation(e.expression)
      const decl = sym && (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym).declarations?.[0]
      if (decl && isBuildingBlock(decl.getSourceFile().fileName) && e.arguments.length) {
        e = e.arguments[0]
        continue
      }
    }
    return e
  }
}
/**
 * 解析一次调用：返回 { entry, method, isStatic, skip } 或 null（不是可识别的调用）。
 * skip=true 表示构建块里的机械调用（publish、断言）。
 */
function resolveCall(call) {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  const method = callee.name.text
  const obj = callee.expression
  // 静态调用：X.CREATE
  const objSym = checker.getSymbolAtLocation(obj)
  if (objSym) {
    const real = objSym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(objSym) : objSym
    const decl = real.declarations?.[0]
    if (decl && ts.isClassDeclaration(decl)) {
      const entry = entryOfNode(decl)
      return entry ? { entry, method, isStatic: true } : null
    }
  }
  let t = checker.getTypeAtLocation(obj)
  if (t.isUnion()) t = checker.getNonNullableType(t)
  const sym = t.getSymbol()
  const decl = sym?.declarations?.[0]
  if (!decl) return null
  const fileName = decl.getSourceFile().fileName
  if (isBuildingBlock(fileName)) return { entry: null, method, isStatic: false, skip: true }
  const entry = entryOfFile(fileName)
  return entry ? { entry, method, isStatic: false } : null
}
function nodeId(entry, method) {
  return `${rel(entry.file)}#${method}`
}

// ---------- 方法体分析：直接 raises / throws / 调用边 / 是否修改状态 ----------
const graph = new Map() // nodeId → { raises: [], throws: [], calls: Set, mutates: boolean }
function ensureNode(id) {
  if (!graph.has(id)) graph.set(id, { raises: [], throws: [], calls: new Set(), mutates: false })
  return graph.get(id)
}
function whenOf(node, methodNode) {
  // 最近的 if 祖先（不越过方法边界）
  let cur = node.parent
  let child = node
  while (cur && cur !== methodNode) {
    if (ts.isIfStatement(cur)) {
      const inElse = cur.elseStatement && (child === cur.elseStatement || isDescendant(child, cur.elseStatement))
      if (inElse) return '否则'
      return lineComment(cur) ?? cur.expression.getText()
    }
    child = cur
    cur = cur.parent
  }
  return null
}
function isDescendant(node, ancestor) {
  let c = node
  while (c) {
    if (c === ancestor) return true
    c = c.parent
  }
  return false
}
function analyzeMethod(entry, method) {
  const id = nodeId(entry, method.name.getText())
  const g = ensureNode(id)
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && callee.name.text === 'raise') {
        const arg = n.arguments[0]
        if (arg && ts.isNewExpression(arg)) {
          const evEntry = entryOfNode(declOf(arg.expression))
          if (evEntry?.prefix === 'event') {
            const when = whenOf(n, method)
            g.raises.push(when ? { event: evEntry.modelName, when } : evEntry.modelName)
          } else issue(entry.file, `${method.name.getText()}：raise 的不是 DomainEvent 子类`)
        }
        g.mutates = true
        if (isStatic(method)) issue(entry.file, `${method.name.getText()}：静态工厂不得 raise 事件`)
      } else if (ts.isPropertyAccessExpression(callee) && callee.expression.getText().startsWith('this.props') && MUTATORS.has(callee.name.text)) {
        g.mutates = true
      } else {
        const r = resolveCall(n)
        if (r && r.entry) {
          const k = r.entry.prefix
          if (DOMAIN_OBJECT.has(k) || k === 'service' || k === 'command-handler') g.calls.add(nodeId(r.entry, r.method))
        }
      }
    }
    if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression)) {
      const sym = checker.getSymbolAtLocation(n.expression.expression)
      const real = sym && (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym)
      const decl = real?.declarations?.[0]
      const errEntry = entryOfNode(decl)
      if (errEntry?.prefix === 'error') {
        if (!g.throws.includes(errEntry.modelName)) g.throws.push(errEntry.modelName)
      } else if (decl && !isBuildingBlock(decl.getSourceFile().fileName) && entry.layer === 'domain') {
        issue(entry.file, `${method.name.getText()}：抛出的不是 DomainError 子类`)
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText().startsWith('this.props')) g.mutates = true
    ts.forEachChild(n, visit)
  }
  visit(method.body)
  return g
}
// 步骤级 throws：调工厂 / 行为的那一步，把被调节点闭包里的 throws 挂上；仓储、端口、服务的调用不挂（模型也不在那些步骤上写）
function attachStepThrows(steps) {
  for (const st of steps ?? []) {
    const id = st.call?._callee
    if (!id) continue
    delete st.call._callee
    const g = graph.get(id)
    if (g?.throws?.length) st.throws = [...g.throws]
  }
}
function propagate() {
  let changed = true
  while (changed) {
    changed = false
    for (const [, g] of graph) {
      for (const calleeId of g.calls) {
        const c = graph.get(calleeId)
        if (!c) continue
        for (const r of c.raises) {
          const key = JSON.stringify(r)
          if (!g.raises.some((x) => JSON.stringify(x) === key)) {
            g.raises.push(r)
            changed = true
          }
        }
        for (const e of c.throws) {
          if (!g.throws.includes(e)) {
            g.throws.push(e)
            changed = true
          }
        }
      }
    }
  }
}
function mutatesTransitively(id, seen = new Set()) {
  if (seen.has(id)) return false
  seen.add(id)
  const g = graph.get(id)
  if (!g) return false
  if (g.mutates) return true
  for (const c of g.calls) {
    const ce = graph.get(c)
    // 只沿同一个类的方法传播「修改状态」
    if (ce && c.split('#')[0] === id.split('#')[0] && mutatesTransitively(c, seen)) return true
  }
  return false
}

// ---------- 步骤解码（处理器与领域服务操作） ----------
function stepsOf(body, currentModule, ctx) {
  const steps = []
  const domainOutputs = new Set() // 前面步骤中来自领域调用的 output 变量名
  const handle = (stmts, when) => {
    for (const s of stmts) {
      if (ts.isIfStatement(s)) {
        const w = lineComment(s) ?? s.expression.getText()
        // 分流条件只能引用某次领域调用的返回值
        const idents = []
        const collect = (n) => {
          if (ts.isIdentifier(n)) idents.push(n.text)
          ts.forEachChild(n, collect)
        }
        collect(s.expression)
        if (ctx.handler && !idents.some((id) => domainOutputs.has(id))) issue(ctx.file, `处理器体内的业务判断（条件未引用领域调用的结果）：if (${s.expression.getText()})`)
        handle(blockStmts(s.thenStatement), w)
        if (s.elseStatement) handle(blockStmts(s.elseStatement), '否则')
        continue
      }
      if (ts.isThrowStatement(s) && ctx.handler) {
        issue(ctx.file, `处理器体内不得直接 throw（技术守卫写成调用）：${s.getText().slice(0, 60)}`)
        continue
      }
      const comment = lineComment(s)
      let expr = null
      let output = null
      if (ts.isVariableStatement(s)) {
        const d = s.declarationList.declarations[0]
        if (d?.initializer) {
          expr = unwrap(d.initializer)
          if (ts.isIdentifier(d.name)) output = d.name.text
        }
      } else if (ts.isExpressionStatement(s)) {
        expr = unwrap(s.expression)
      } else if (ts.isReturnStatement(s) && s.expression) {
        expr = unwrap(s.expression)
      }
      let call = null
      let skipped = false
      let each = false
      // 「对一批东西逐个做一次」：代码里是 xs.map(x => …) / forEach / flatMap，
      // 外层那个 map 本身不是业务调用，要读的是循环体里的那一次。
      const inner = eachCallOf(expr)
      if (inner) { each = true; expr = inner }
      if (expr && ts.isCallExpression(expr)) {
        const r = resolveCall(expr)
        if (r?.skip) skipped = true
        else if (r?.entry) {
          const e = r.entry
          const target = e.module !== currentModule ? `${e.module}.${e.modelName}` : e.modelName
          let kind = null
          if (DOMAIN_OBJECT.has(e.prefix)) kind = r.isStatic ? 'factory' : 'behavior'
          else if (e.prefix === 'service') kind = 'service'
          else if (e.prefix === 'repository') kind = 'repository'
          else if (e.prefix === 'port') kind = 'port'
          else if (e.prefix === 'command-handler') kind = 'command'
          if (kind) {
            call = { kind, target, method: r.method }
            // 记下被调节点：处理器算完 raises / throws 闭包后，把被调工厂 / 行为会抛的错挂回这一步（agents/model/shapes.md「步骤语法」的步骤级 throws；2026-09-13 之前从不产出，方向 ② 永远差一条）
            if (kind === 'factory' || kind === 'behavior' || kind === 'service') call._callee = nodeId(e, r.method) // service：交给领域服务那一步，服务操作会抛的错也挂回这一步
            ctx.onCall?.(e, r, kind)
            if (output && ['behavior', 'factory', 'service'].includes(kind)) domainOutputs.add(output)
          }
        }
      }
      if (skipped) continue
      if (!comment && !call) continue
      const step = { text: comment ?? `(${expr?.getText().slice(0, 40) ?? s.getText().slice(0, 40)})` }
      if (!comment) issue(ctx.file, `步骤缺少 // 注释：${step.text}`)
      if (call) step.call = call
      if (each) step.each = true
      if (when) step.when = when
      if (output) step.output = output
      steps.push(step)
    }
  }
  handle(blockStmts(body), undefined)
  return steps
}
/**
 * 这一句是不是「对一批东西逐个做一次」？是就返回循环体里那一次调用，不是就返回 null。
 * 认得出：xs.map(x => f(x))、xs.forEach(…)、xs.flatMap(…)，以及套在 Promise.all(…) 里的同一批。
 */
function eachCallOf(expr) {
  if (!expr || !ts.isCallExpression(expr)) return null
  let e = expr
  // Promise.all(xs.map(…)) 剥一层
  if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'all' && e.arguments.length === 1) {
    const first = unwrap(e.arguments[0])
    if (first && ts.isCallExpression(first)) e = first
  }
  if (!ts.isPropertyAccessExpression(e.expression)) return null
  if (!['map', 'forEach', 'flatMap'].includes(e.expression.name.text)) return null
  const fn = e.arguments[0]
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null
  const body = fn.body
  // 箭头直接返回一个调用
  if (!ts.isBlock(body)) {
    const one = unwrap(body)
    return one && ts.isCallExpression(one) ? one : null
  }
  // 带花括号的：取里面第一句能认出来的调用
  for (const s of body.statements) {
    let ex = null
    if (ts.isVariableStatement(s)) ex = s.declarationList.declarations[0]?.initializer
    else if (ts.isExpressionStatement(s)) ex = s.expression
    else if (ts.isReturnStatement(s)) ex = s.expression
    if (!ex) continue
    const one = unwrap(ex)
    if (one && ts.isCallExpression(one)) return one
  }
  return null
}
function blockStmts(node) {
  return ts.isBlock(node) ? [...node.statements] : [node]
}

// ---------- 主流程 ----------
const out = {} // 相对路径 → 对象
function emit(relPath, obj) {
  out[relPath] = obj
}
function sortUniq(arr) {
  return [...new Set(arr)]
}

// 第一遍：分析所有领域方法与服务操作，建图
for (const entry of registry.values()) {
  if (!(DOMAIN_OBJECT.has(entry.prefix) || entry.prefix === 'service' || entry.prefix === 'command-handler')) continue
  const sf = program.getSourceFile(entry.file)
  const cls = mainClass(sf, entry.className)
  if (!cls) {
    issue(entry.file, `没有导出与文件名一致的类 ${entry.className}`)
    continue
  }
  for (const m of methodsOf(cls)) analyzeMethod(entry, m)
}
propagate()

const modulesJson = { system: systemName, modules: [], questions: [] }

for (const mod of modules.values()) {
  const M = mod.name
  // module.ts
  const modFile = path.join(mod.dir, 'module.ts')
  let responsibility = ''
  let modTraces = []
  if (fs.existsSync(modFile)) {
    const sf = program.getSourceFile(modFile)
    const first = sf.statements.find((s) => ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isVariableStatement(s))
    if (first) {
      const tags = docTags(first)
      responsibility = tagValues(tags, 'responsibility')[0] ?? ''
      modTraces = traceTags(tags)
    }
  } else issue(mod.dir, '模块没有 module.ts 组合根')
  modulesJson.modules.push({ name: M, responsibility, traces: modTraces })

  const moduleJson = { module: M, aggregates: [], denylist: [], questions: [] }

  // 领域对象
  for (const [, agg] of mod.aggregates) {
    if (!agg.root) continue
    const rootEntry = agg.root
    const rootSf = program.getSourceFile(rootEntry.file)
    const rootCls = mainClass(rootSf, rootEntry.className)
    let idRefs = []
    let rootTraces = []
    if (rootCls) {
      const tags = docTags(rootCls)
      rootTraces = traceTags(tags)
      const props = propsTypeOf(rootCls, M) ?? { fields: [], refs: [] }
      idRefs = props.refs
      const obj = {
        name: rootEntry.modelName,
        module: M,
        aggregateNarrative: tagValues(tags, 'narrative').join(' '),
        aggregateInvariants: tagValues(tags, 'aggregate-invariant').map(parseInvariant),
        fields: props.fields,
        invariants: tagValues(tags, 'invariant').map(parseInvariant),
        behaviors: decodeBehaviors(rootEntry, rootCls, M),
        traces: rootTraces,
        questions: [],
      }
      if (!rootTraces.length) issue(rootEntry.file, '缺少 @trace')
      checkBase(rootCls, 'AggregateRoot', rootEntry)
      emit(`${M}/domain/${rootEntry.aggregateFolder}/${path.basename(rootEntry.file, '.ts')}.json`, obj)
    }
    moduleJson.aggregates.push({
      name: rootEntry.modelName,
      members: agg.members.map((e) => e.modelName),
      idRefs,
      traces: rootTraces,
    })
    for (const e of agg.members) {
      const sf = program.getSourceFile(e.file)
      const cls = mainClass(sf, e.className)
      if (!cls) continue
      const tags = docTags(cls)
      const props = propsTypeOf(cls, M) ?? { fields: [], refs: [] }
      const obj = {
        name: e.modelName,
        aggregate: e.aggregate,
        fields: props.fields,
        invariants: tagValues(tags, 'invariant').map(parseInvariant),
        behaviors: decodeBehaviors(e, cls, M),
        traces: traceTags(tags),
      }
      checkBase(cls, e.prefix === 'entity' ? 'Entity' : 'ValueObject', e)
      emit(`${M}/domain/${e.aggregateFolder}/${path.basename(e.file, '.ts')}.json`, obj)
    }
  }
  // 事件、错误、仓储
  for (const e of registry.values()) {
    if (e.module !== M || e.layer !== 'domain') continue
    const sf = program.getSourceFile(e.file)
    const relOut = `${M}/domain/${e.aggregateFolder ? e.aggregateFolder + '/' : ''}${path.basename(e.file, '.ts')}.json`
    if (e.prefix === 'event') {
      const cls = mainClass(sf, e.className)
      if (!cls) continue
      const tags = docTags(cls)
      const ctor = cls.members.find(ts.isConstructorDeclaration)
      const payloadParam = ctor?.parameters.find((p) => p.name.getText() === 'payload')
      const payload = payloadParam ? membersOfType(checker.getTypeAtLocation(payloadParam), M).fields.map(({ name, type }) => ({ name, type })) : []
      checkBase(cls, 'DomainEvent', e)
      emit(relOut, { name: e.modelName, aggregate: e.aggregate, payload, traces: traceTags(tags) })
    } else if (e.prefix === 'error') {
      const cls = mainClass(sf, e.className)
      if (!cls) continue
      const tags = docTags(cls)
      checkBase(cls, 'DomainError', e)
      emit(relOut, { name: e.modelName, aggregate: e.aggregate, condition: tagValues(tags, 'condition').join('；') /* 多条 @condition 用「；」拼，与 diff-model 把模型侧数组拼平用的是同一个符号；用空格拼过，每个多条件的错误都会被提成一条「文字差异」判断（2026-09-14 s-002） */, traces: traceTags(tags) })
    } else if (e.prefix === 'repository') {
      const itf = interfacesIn(sf).find((i) => i.name.text === e.className)
      if (!itf) {
        issue(e.file, `没有导出接口 ${e.className}`)
        continue
      }
      const methods = itf.members.filter(ts.isMethodSignature).map((m) => {
        const sig = checker.getSignatureFromDeclaration(m)
        const name = m.name.getText()
        const o = { name, kind: READ_PREFIX.test(name) ? 'read' : 'write', input: paramsOf(sig, M) }
        const ret = mapType(sig.getReturnType(), M).type
        if (ret) o.output = ret
        return o
      })
      emit(relOut, { name: e.modelName, aggregate: e.aggregate, methods })
    } else if (e.prefix === 'service') {
      const cls = mainClass(sf, e.className)
      if (!cls) continue
      const ctor = cls.members.find(ts.isConstructorDeclaration)
      if (ctor && ctor.parameters.length) issue(e.file, '领域服务不得有构造注入')
      const coordinates = []
      const operations = behaviorsOf(cls).map((m) => {
        const sig = checker.getSignatureFromDeclaration(m)
        const tags = docTags(m)
        const input = paramsOf(sig, M)
        const reads = []
        const writes = []
        // 参数中的聚合根：直接是聚合根，或聚合根的数组（existing: Participant[]、ReadonlyArray<FundingAllocation>——
        // 处理器查出来的一批已有档案 / 已有拨款递进来比对，领域服务的形状），数组就看里面那个元素
        for (const p of m.parameters) {
          let t = checker.getNonNullableType(checker.getTypeAtLocation(p))
          const elem = checker.getIndexTypeOfType(t, ts.IndexKind.Number)
          if (elem) t = checker.getNonNullableType(elem)
          const pe = entryOfNode(t.getSymbol()?.declarations?.[0])
          if (pe?.prefix === 'aggregate-root') {
            reads.push(pe.modelName)
            if (!coordinates.includes(pe.modelName)) coordinates.push(pe.modelName)
          }
        }
        const steps = stepsOf(m.body, M, {
          file: e.file,
          onCall: (te, r, kind) => {
            if (kind === 'behavior' && te.prefix === 'aggregate-root' && mutatesTransitively(nodeId(te, r.method))) if (!writes.includes(te.modelName)) writes.push(te.modelName)
          },
        })
        const g = graph.get(nodeId(e, m.name.getText())) ?? { raises: [], throws: [] }
        attachStepThrows(steps)
        const op = { name: m.name.getText(), input }
        const ret = mapType(sig.getReturnType(), M).type
        if (ret) op.output = ret
        Object.assign(op, { reads, writes, steps, rules: tagValues(tags, 'rule'), raises: g.raises, throws: g.throws, traces: traceTags(tags) })
        // 操作的说明文字（模型里 operation.note：为什么住服务里、管不了什么、真保证在哪儿）
        const opNote = tagValues(tags, 'note')[0]
        if (opNote) op.note = opNote
        if (!op.traces.length) issue(e.file, `${op.name}：缺少 @trace`)
        return op
      })
      emit(`${M}/domain/${path.basename(e.file, '.ts')}.json`, { name: e.modelName, module: M, coordinates, operations, questions: [] })
    }
  }
  // 应用层
  for (const e of registry.values()) {
    if (e.module !== M || e.layer !== 'application') continue
    const sf = program.getSourceFile(e.file)
    const cls = mainClass(sf, e.className)
    if (!cls) {
      issue(e.file, `没有导出与文件名一致的类 ${e.className}`)
      continue
    }
    const relOut = `${M}/application/${path.basename(e.file, '.ts')}.json`
    const clsTags = docTags(cls)
    const actor = tagValues(clsTags, 'actor')[0] ?? ''
    const entryMethodName = e.prefix === 'event-handler' ? 'handle' : 'execute'
    const entryMethod = methodsOf(cls).find((m) => m.name.getText() === entryMethodName)
    if (!entryMethod) {
      issue(e.file, `没有 ${entryMethodName} 方法`)
      continue
    }
    const mTags = docTags(entryMethod)
    const traces = traceTags(mTags).length ? traceTags(mTags) : traceTags(clsTags)
    if (!traces.length) issue(e.file, '缺少 @trace')
    const writes = []
    const called = []
    let published = false
    let wroteRepo = false
    const steps = stepsOf(entryMethod.body, M, {
      file: e.file,
      handler: true,
      onCall: (te, r, kind) => {
        called.push(nodeId(te, r.method))
        if (kind === 'repository' && !READ_PREFIX.test(r.method)) {
          wroteRepo = true
          if (te.aggregate && !writes.includes(te.aggregate)) writes.push(te.aggregate)
        }
        if (kind === 'behavior' && te.prefix === 'aggregate-root' && mutatesTransitively(nodeId(te, r.method))) if (!writes.includes(te.modelName)) writes.push(te.modelName)
        if (kind === 'service') {
          const opWrites = serviceWrites(te, r.method)
          for (const w of opWrites) if (!writes.includes(w)) writes.push(w)
        }
        if (kind === 'repository' && e.prefix === 'query-handler' && !READ_PREFIX.test(r.method)) issue(e.file, `查询调用了写方法 ${r.method}`)
        if (kind !== 'repository' && e.prefix === 'query-handler') issue(e.file, `查询只能调用仓储：${kind} ${te.modelName}.${r.method}`)
      },
    })
    // 最后一步是否 publish
    const stmts = blockStmts(entryMethod.body)
    const last = stmts[stmts.length - 1]
    if (last && ts.isExpressionStatement(last)) {
      const ex = unwrap(last.expression)
      if (ts.isCallExpression(ex) && ts.isPropertyAccessExpression(ex.expression) && ex.expression.name.text === 'publish') published = true
    }
    if ((wroteRepo || writes.length) && !published) issue(e.file, '写处理器的最后一步必须是 publish')
    // 处理器的 raises/throws = 所调节点之并集
    const hid = nodeId(e, entryMethodName)
    const hg = ensureNode(hid)
    for (const c of called) hg.calls.add(c)
    propagate()
    const raises = hg.raises
    const throwsList = hg.throws
    attachStepThrows(steps)

    if (e.prefix === 'command-handler') {
      const cmd = mainClass(sf, `${e.modelName}Command`)
      const input = cmd ? ctorParams(cmd, M) : []
      if (!cmd) issue(e.file, `缺少伴随导出 ${e.modelName}Command`)
      const obj = { name: e.modelName, module: M, actor, input, writes, steps, raises, throws: throwsList, traces, questions: [] }
      if (writes.length > 1) obj.writesNote = ''
      emit(relOut, obj)
    } else if (e.prefix === 'query-handler') {
      const q = mainClass(sf, `${e.modelName}Query`)
      const res = mainClass(sf, `${e.modelName}Result`)
      if (!q) issue(e.file, `缺少伴随导出 ${e.modelName}Query`)
      if (!res) issue(e.file, `缺少伴随导出 ${e.modelName}Result`)
      emit(relOut, { name: e.modelName, module: M, actor, input: q ? ctorParams(q, M) : [], result: res ? ctorParams(res, M) : [], steps, traces, questions: [] })
    } else if (e.prefix === 'event-handler') {
      const p = entryMethod.parameters[0]
      let trigger = ''
      if (p) {
        const t = checker.getTypeAtLocation(p)
        const te = entryOfNode(t.getSymbol()?.declarations?.[0])
        if (te?.prefix === 'event') trigger = te.module !== M ? `${te.module}.${te.modelName}` : te.modelName
        else issue(e.file, 'handle 的参数不是领域事件')
      }
      const expected = e.modelName.split('On').pop()
      if (trigger && !trigger.endsWith(expected)) issue(e.file, `类名中的事件 ${expected} 与 handle 参数 ${trigger} 不一致`)
      const obj = { name: e.modelName, module: M, trigger, writes, steps, raises, throws: throwsList, traces, questions: [] }
      if (writes.length > 1) obj.writesNote = ''
      emit(relOut, obj)
    }
  }
  // 端口
  for (const e of registry.values()) {
    if (e.module !== M || e.layer !== 'ports') continue
    const sf = program.getSourceFile(e.file)
    const itf = interfacesIn(sf).find((i) => i.name.text === e.className)
    if (!itf) {
      issue(e.file, `没有导出接口 ${e.className}`)
      continue
    }
    const tags = docTags(itf)
    let kind = 'external-system'
    let target = tagValues(tags, 'external-system')[0] ?? ''
    const modTag = tagValues(tags, 'module')[0]
    if (modTag) {
      kind = 'module'
      target = modTag
    }
    if (!target) issue(e.file, '端口缺少 @external-system 或 @module 标签')
    const operations = itf.members.filter(ts.isMethodSignature).map((m) => {
      const sig = checker.getSignatureFromDeclaration(m)
      const o = { name: m.name.getText(), input: paramsOf(sig, M) }
      const ret = mapType(sig.getReturnType(), M).type
      if (ret) o.output = ret
      const note = tagValues(docTags(m), 'note')[0]
      if (note) o.note = note
      return o
    })
    emit(`${M}/ports/${path.basename(e.file, '.ts')}.json`, { name: e.modelName, module: M, kind, target, operations, traces: traceTags(tags) })
  }
  emit(`${M}/module.json`, moduleJson)
}
emit('modules.json', modulesJson)

function decodeBehaviors(entry, cls, M) {
  return behaviorsOf(cls).map((m) => {
    const sig = checker.getSignatureFromDeclaration(m)
    const tags = docTags(m)
    const g = graph.get(nodeId(entry, m.name.getText())) ?? { raises: [], throws: [] }
    const b = { name: m.name.getText(), input: paramsOf(sig, M) }
    const ret = mapType(sig.getReturnType(), M).type
    if (ret) b.output = ret
    Object.assign(b, { rules: tagValues(tags, 'rule'), raises: g.raises, throws: g.throws, traces: traceTags(tags) })
    if (!b.traces.length) issue(entry.file, `${b.name}：缺少 @trace`)
    return b
  })
}
function ctorParams(cls, M) {
  const ctor = cls.members.find(ts.isConstructorDeclaration)
  if (!ctor) return []
  return ctor.parameters.map((p) => ({ name: p.name.getText(), type: mapType(checker.getTypeAtLocation(p), M).type ?? 'unknown' }))
}
function serviceWrites(entry, method) {
  const sf = program.getSourceFile(entry.file)
  const cls = mainClass(sf, entry.className)
  const m = cls && methodsOf(cls).find((x) => x.name.getText() === method)
  if (!m) return []
  const writes = []
  stepsOf(m.body, entry.module, {
    file: entry.file,
    onCall: (te, r, kind) => {
      if (kind === 'behavior' && te.prefix === 'aggregate-root' && mutatesTransitively(nodeId(te, r.method))) if (!writes.includes(te.modelName)) writes.push(te.modelName)
    },
  })
  return writes
}
function checkBase(cls, baseName, entry) {
  const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
  const name = ext?.types[0]?.expression.getText()
  if (name !== baseName) issue(entry.file, `${entry.className} 应继承 ${baseName}`)
}

// ---------- 写出 ----------
fs.rmSync(outDir, { recursive: true, force: true })
for (const [relPath, obj] of Object.entries(out)) {
  const p = path.join(outDir, relPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}
fs.writeFileSync(path.join(outDir, '_decode-issues.json'), JSON.stringify({ codebase, decodedAt: new Date().toISOString(), issues }, null, 2) + '\n')
console.log(`已解码 ${Object.keys(out).length} 个文件 → ${outDir}；解码期发现 ${issues.length} 处违规。`)
for (const i of issues) console.log(`  ! ${i.file}: ${i.text}`)
