#!/usr/bin/env node
/**
 * 解码器：从代码库的核心圈（domain / application / ports）还原模型 JSON。模块都在 src/modules/<module-folder>/ 底下。
 * 依据：agents/code/coding-standard.md 第九节「结构化注释」、第十一节「解码规则汇总」。
 *
 * 读出来的：类型 → 字段、入参、出参；JSDoc 标签 → traces、规则、不变量……；方法说明那段话 → purpose；
 * 静态工厂 CREATE → create；方法体里的 // 注释 → 步骤（处理器、领域服务操作必有，行为与创建可有可无），
 * 每一步改了哪几栏（changes）、抛什么、发什么都从这一步的几句代码里算（含所调方法的闭包）；
 * 本模块里另写的一份别的模块的类型（标 @ref Module.Type）→「Module.Type」；事件处理器收的别的模块的事件同理。
 *
 * 用法：node tools/decode.js <代码库目录> <输出目录> [--system <系统名>]
 * 输出：与 model/ 同结构的 JSON；另有 _decode-issues.json 记录解码期发现的违规。
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { moduleOfFolder, modulesDirOf, NON_MODULE_SRC_FOLDERS } = require('./lib/project')

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
const srcDir = path.join(codebase, 'src')
const modulesDir = modulesDirOf(codebase)

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
const READ_PREFIX = /^(find|list|exists|count)/

const issues = []
function issue(file, text) {
  issues.push({ file: rel(file), text })
}
// 报出来的路径相对代码库（src/modules/…），人照着就能找到文件
function rel(p) {
  return path.relative(codebase, p).replaceAll('\\', '/')
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
  return moduleOfFolder(folder)
}
// 模块只从 src/modules/ 底下找。src/ 底下别的文件夹：shared 是构建块，proto 是原型宿主入口，
// bootstrap 是整个后端的组合根与起服务，infras 是技术件（HTTP 入口、事件总线；都是外壳，不解码）；
// 除了这四样还有别的，就是放错了地方的模块，报出来让它挪进去
const srcFolders = fs.existsSync(srcDir) ? fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
for (const folder of srcFolders.filter((f) => f !== 'modules' && !NON_MODULE_SRC_FOLDERS.includes(f))) {
  issue(path.join(srcDir, folder), `模块要放在 src/modules/ 底下：src/${folder} → src/modules/${folder}`)
}
const moduleFolders = fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
for (const folder of moduleFolders) {
  const modDir = path.join(modulesDir, folder)
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
// 基础构建块的别名：构建块是代码库自己的（src/shared/building-block）。tsconfig 配了且目录在就用配的；
// 没配或指到不存在的目录，就指到代码库里的那一份；两处都没有就不补，别名解析不出来由编译错误报出
{
  const alias = '@shared/building-block/*'
  const baseUrl = options.baseUrl ?? codebase
  const mapped = options.paths?.[alias]?.[0]
  const mappedDir = mapped ? path.resolve(baseUrl, mapped.replace(/\*$/, '')) : null
  const projectBB = path.join(srcDir, 'shared', 'building-block')
  let bbDir = null
  if (mappedDir && fs.existsSync(mappedDir)) bbDir = mappedDir
  else if (fs.existsSync(projectBB)) {
    bbDir = projectBB
    options.baseUrl = baseUrl
    options.paths = { ...(options.paths ?? {}), [alias]: [path.join(projectBB, '*')] }
  }
  // 确保构建块源码进入程序，类型才能解析
  if (bbDir) for (const f of walk(bbDir)) if (!rootNames.includes(f)) rootNames.push(f)
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
/**
 * JSDoc 第一个标签之前的那段说明文字（几行拼成一句）。方法上的这段就是模型的 `purpose.text`（作用：调用它做了什么、改了什么），
 * 编码规范第九节。没有就返回 null
 */
function docLead(node) {
  const sf = node.getSourceFile()
  const text = sf.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  for (const r of ranges.slice().reverse()) {
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    const raw = text.slice(r.pos, r.end)
    if (!raw.startsWith('/**')) continue
    const lead = []
    for (const line of raw.slice(3, -2).split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim())) {
      if (/^@[\w-]+/.test(line)) break
      if (line) lead.push(line)
    }
    return lead.length ? lead.join(' ') : null
  }
  return null
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
/**
 * 语句上方的 // 注释。一句话折成几行写的（紧挨着的几行 //，中间没有空行）拼回一句；
 * 隔着空行的上一段注释不算。只拿最后一行的话，折行写的步骤只剩后半句
 */
function lineComment(node) {
  const sf = node.getSourceFile()
  const text = sf.getFullText()
  const ranges = (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []).filter((r) => r.kind === ts.SyntaxKind.SingleLineCommentTrivia)
  if (!ranges.length) return null
  const run = [ranges[ranges.length - 1]]
  for (let i = ranges.length - 2; i >= 0; i--) {
    const gap = text.slice(ranges[i].end, run[0].pos)
    if (/\S/.test(gap) || (gap.match(/\n/g) ?? []).length > 1) break
    run.unshift(ranges[i])
  }
  return run.map((r) => text.slice(r.pos + 2, r.end).trim()).join(' ')
}

// ---------- 类型映射 ----------
function stripSuffix(name) {
  for (const suffix of Object.values(PREFIX_SUFFIX)) if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length)
  return name
}
function isNullish(t) {
  return (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
}
/**
 * 别的模块的类型在本模块里另写的那一份（模块之间不许 import，编码规范第二节）：类型声明上标 `@ref Module.Type`，
 * 就认它是那个模块的那一样，解码成「Module.Type」。没标的照本名解码，比对再按「同名 / 模块名 + 类型名」认（diff-model.js）
 */
function refOfType(t) {
  for (const s of [t.aliasSymbol, t.getSymbol()]) {
    const d = s?.declarations?.[0]
    if (!d || isBuildingBlock(d.getSourceFile().fileName)) continue
    if (!(ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d))) continue
    const ref = tagValues(docTags(d), 'ref')[0]
    if (ref) return ref.split(/\s+/)[0]
  }
  return null
}
function isAnonymousObject(t) {
  const n = t.getSymbol()?.name
  return !t.aliasSymbol && (n === '__type' || n === '__object')
}
/** 返回 { type: string|null, nullable: boolean }；type 为 null 表示 void */
function mapType(t, currentModule) {
  let nullable = false
  if (t.isUnion()) {
    const parts = t.types.filter((x) => !isNullish(x))
    if (parts.length !== t.types.length) nullable = true
    if (parts.length === 0) return { type: null, nullable }
    const ref = refOfType(t)
    if (ref) return { type: ref, nullable }
    // type Participant = { … } | null：名字在整个联合上，里面那一半是匿名对象，读成 Participant（可空），不读成一串字面量
    if (parts.length === 1 && t.aliasSymbol && isAnonymousObject(parts[0])) return { type: t.aliasSymbol.name, nullable }
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
    const ref = refOfType(t)
    if (ref) return { type: ref, nullable }
    if (t.aliasSymbol) return { type: t.aliasSymbol.name, nullable }
    if (name && name !== '__type' && name !== '__object') return { type: stripSuffix(name), nullable }
  }
  const ref = refOfType(t)
  if (ref) return { type: ref, nullable }
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
  const refs = []
  for (const p of ctor.parameters) {
    const mods = ts.getCombinedModifierFlags(p)
    if (!(mods & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Public | ts.ModifierFlags.Private))) continue
    const m = mapType(checker.getTypeAtLocation(p), currentModule)
    const f = { name: p.name.getText(), type: m.type ?? 'unknown' }
    if (m.nullable || p.questionToken) f.nullable = true
    const tags = docTags(p)
    const note = tagValues(tags, 'note')[0]
    if (note) f.note = note
    const fieldTraces = traceTags(tags)
    if (fieldTraces.length) f.traces = fieldTraces
    const ref = tagValues(tags, 'ref')[0]
    if (ref) refs.push({ field: f.name, to: ref })
    fields.push(f)
  }
  return { fields, refs }
}

// ---------- 调用解析 ----------
function unwrap(expr) {
  let e = expr
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression
      continue
    }
    // [await x.get()]：只装一样东西的数组，看里面那一次调用（取一份文件、装成一份清单）
    if (ts.isArrayLiteralExpression(e) && e.elements.length === 1 && !ts.isSpreadElement(e.elements[0])) {
      e = e.elements[0]
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
  // 静态调用：X.CREATE（this.x(…) 不算：this 的符号也是类本身）
  const objSym = obj.kind === ts.SyntaxKind.ThisKeyword ? null : checker.getSymbolAtLocation(obj)
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

// ---------- 方法体分析：直接 raises / throws / 改了哪几栏 / 调用边 / 是否修改状态 ----------
// nodeId → { raises, throws, calls: Set, mutates, changes: Set<栏>, aliasCalls: [{ field, callee }] }
// 节点有三种：类的方法（文件#方法名）、模块里的普通函数（文件#fn:函数名，领域服务、实体常把一段检查写成文件里的小函数）
const graph = new Map()
function emptyScan() {
  return { raises: [], throws: [], calls: new Set(), mutates: false, changes: new Set(), aliasCalls: [] }
}
function ensureNode(id) {
  if (!graph.has(id)) graph.set(id, emptyScan())
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
function isThisProps(e) {
  return !!e && ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && e.name.text === 'props'
}
/** this.props.X、this.props.X.Y、this.props.X[i] → 'X'（改的是哪一栏）；不是 this.props 底下的返回 null */
function propsFieldOfTarget(e) {
  let cur = e
  while (cur) {
    if (ts.isPropertyAccessExpression(cur) && isThisProps(cur.expression)) return cur.name.text
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression
      continue
    }
    return null
  }
  return null
}
/** 表达式里第一处 this.props.<栏> 的栏名：const line = this.props.lines.find(…) → 'lines' */
function propsFieldIn(node) {
  let found = null
  const visit = (n) => {
    if (found) return
    if (ts.isPropertyAccessExpression(n) && isThisProps(n.expression)) {
      found = n.name.text
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}
/**
 * 方法里从 this.props.<栏> 取出来的变量：const line = this.props.lines.find(…)、for (const item of this.props.items)、
 * this.props.lines.forEach((l) => …) 的参数。对它调会改状态的行为（line.amend(…)），就算改了那一栏
 */
function aliasesIn(body) {
  const alias = new Map()
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const f = propsFieldIn(n.initializer)
      if (f) alias.set(n.name.text, f)
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)) {
      const f = propsFieldIn(n.expression)
      const d = n.initializer.declarations[0]
      if (f && d && ts.isIdentifier(d.name)) alias.set(d.name.text, f)
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const f = propsFieldOfTarget(n.expression.expression)
      if (f) for (const a of n.arguments) if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0] && ts.isIdentifier(a.parameters[0].name)) alias.set(a.parameters[0].name.text, f)
    }
    ts.forEachChild(n, visit)
  }
  if (body) visit(body)
  return alias
}
/** 调的是模块里的普通函数（readColumns(…)、sumOf(…)）：返回它的声明，好跟进去看它抛什么；构建块与库函数不算 */
function localFunctionOf(call) {
  if (!ts.isIdentifier(call.expression)) return null
  const decl = declOf(call.expression)
  if (!decl) return null
  const file = path.normalize(decl.getSourceFile().fileName)
  if (isBuildingBlock(file) || !file.startsWith(path.normalize(modulesDir) + path.sep)) return null
  if (ts.isFunctionDeclaration(decl) && decl.body) return { node: decl, body: decl.body, name: decl.name?.text ?? '?' }
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
    return { node: decl.initializer, body: decl.initializer.body, name: decl.name.getText() }
  }
  return null
}
function fnId(fn) {
  return `${rel(fn.node.getSourceFile().fileName)}#fn:${fn.name}`
}
const ASSIGN = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
])
/**
 * 扫一段代码：直接 raise / throw 的、改了自己哪几栏、调了谁。建调用图（整个方法）和解码步骤（一步里的几句）都用它。
 * ctx：{ entry 所在类的登记项, method 方法节点（算 raise 的 when）, alias 别名表, label 报违规时的名字, isStatic, quiet 不报违规 }
 */
function scan(node, ctx, out) {
  const report = (text) => {
    if (!ctx.quiet && ctx.entry) issue(ctx.entry.file, `${ctx.label}：${text}`)
  }
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && callee.name.text === 'raise') {
        const arg = n.arguments[0]
        if (arg && ts.isNewExpression(arg)) {
          const evEntry = entryOfNode(declOf(arg.expression))
          if (evEntry?.prefix === 'event') {
            const when = ctx.method ? whenOf(n, ctx.method) : null
            out.raises.push(when ? { event: evEntry.modelName, when } : evEntry.modelName)
          } else report('raise 的不是 DomainEvent 子类')
        }
        out.mutates = true
        if (ctx.isStatic) report('静态工厂不得 raise 事件')
      } else if (ts.isPropertyAccessExpression(callee) && propsFieldOfTarget(callee.expression) && MUTATORS.has(callee.name.text)) {
        out.mutates = true
        out.changes.add(propsFieldOfTarget(callee.expression))
      } else {
        const r = resolveCall(n)
        if (r && r.entry) {
          const k = r.entry.prefix
          if (DOMAIN_OBJECT.has(k) || k === 'service' || k === 'command-handler') {
            const id = nodeId(r.entry, r.method)
            out.calls.add(id)
            // 对 this.props.<栏> 本身或从它取出来的东西调行为：那个行为改了状态，就算改了这一栏（改一行 → 改了 lines）
            if (DOMAIN_OBJECT.has(k) && !r.isStatic && ts.isPropertyAccessExpression(callee)) {
              const target = callee.expression
              const f = propsFieldOfTarget(target) ?? (ts.isIdentifier(target) ? ctx.alias?.get(target.text) : null)
              if (f) out.aliasCalls.push({ field: f, callee: id })
            }
          }
        } else if (!r) {
          const fn = localFunctionOf(n)
          if (fn) {
            analyzeFunction(fn)
            out.calls.add(fnId(fn))
          }
        }
      }
    }
    if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression)) {
      const decl = declOf(n.expression.expression)
      const errEntry = entryOfNode(decl)
      if (errEntry?.prefix === 'error') {
        if (!out.throws.includes(errEntry.modelName)) out.throws.push(errEntry.modelName)
      } else if (decl && !isBuildingBlock(decl.getSourceFile().fileName) && ctx.entry?.layer === 'domain') {
        report('抛出的不是 DomainError 子类')
      }
    }
    // 赋值：this.props.<栏> = / += …；this.props = { …this.props, a, b } 整份换掉时，算字面量里列出来的几栏
    if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind)) {
      const f = propsFieldOfTarget(n.left)
      if (f) {
        out.mutates = true
        out.changes.add(f)
      } else if (isThisProps(n.left)) {
        out.mutates = true
        if (ts.isObjectLiteralExpression(n.right)) for (const p of n.right.properties) if (p.name && !ts.isSpreadAssignment(p)) out.changes.add(p.name.getText())
      }
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      const f = propsFieldOfTarget(n.operand)
      if (f) {
        out.mutates = true
        out.changes.add(f)
      }
    }
    // 创建：new 自己这个类(…, { a, b, … }) 交给构造的那几栏，就是创建这一步记下的几栏；
    // 某一栏直接用前面算好的变量（{ price } 或 price: price），记下来，收尾时算到算它的那一步上
    if (ctx.create && ts.isNewExpression(n) && ctx.entry && entryOfNode(declOf(n.expression)) === ctx.entry) {
      for (const a of n.arguments ?? []) {
        if (!ts.isObjectLiteralExpression(a)) continue
        for (const p of a.properties) {
          if (!p.name || ts.isSpreadAssignment(p)) continue
          const field = p.name.getText()
          out.changes.add(field)
          const v = ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) ? p.initializer.text : null
          if (v && out.propsFrom) out.propsFrom.set(field, v)
        }
      }
    }
    if (out.declared && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) out.declared.add(n.name.text)
    ts.forEachChild(n, visit)
  }
  if (node) visit(node)
  return out
}
function analyzeMethod(entry, method) {
  const id = nodeId(entry, method.name.getText())
  const g = ensureNode(id)
  scan(method.body, { entry, method, alias: aliasesIn(method.body), label: method.name.getText(), isStatic: isStatic(method) }, g)
  return g
}
const analyzedFns = new Set()
function analyzeFunction(fn) {
  const id = fnId(fn)
  if (analyzedFns.has(id)) return
  analyzedFns.add(id)
  scan(fn.body, { entry: entryOfFile(fn.node.getSourceFile().fileName), method: fn.node, alias: new Map(), label: fn.name }, ensureNode(id))
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
function sameClass(a, b) {
  return a.split('#')[0] === b.split('#')[0]
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
    if (ce && sameClass(c, id) && mutatesTransitively(c, seen)) return true
  }
  // 对自己 props 里的实体 / 值对象调了会改状态的行为，也算改了自己
  for (const a of g.aliasCalls) if (mutatesTransitively(a.callee, new Set(seen))) return true
  return false
}
/** 一个方法改了自己哪几栏：直接改的，对 props 里的东西调了会改状态的行为的那一栏，再沿同类方法传 */
function changesOf(id, seen = new Set()) {
  const out = new Set()
  if (seen.has(id)) return out
  seen.add(id)
  const g = graph.get(id)
  if (!g) return out
  for (const f of g.changes) out.add(f)
  for (const a of g.aliasCalls) if (mutatesTransitively(a.callee)) out.add(a.field)
  for (const c of g.calls) if (sameClass(c, id) && !c.includes('#fn:')) for (const f of changesOf(c, seen)) out.add(f)
  return out
}
function entryOfId(id) {
  return entryOfFile(path.join(codebase, id.split('#')[0]))
}

// ---------- 步骤解码（处理器、领域服务操作、领域对象的行为与创建） ----------
/** 一次已解析的调用在步骤里记成什么：{ kind, target, method }；认不出种类的返回 null */
function callOf(r, currentModule) {
  const e = r.entry
  const target = e.module !== currentModule ? `${e.module}.${e.modelName}` : e.modelName
  let kind = null
  if (DOMAIN_OBJECT.has(e.prefix)) kind = r.isStatic ? 'factory' : 'behavior'
  else if (e.prefix === 'service') kind = 'service'
  else if (e.prefix === 'repository') kind = 'repository'
  else if (e.prefix === 'port') kind = 'port'
  else if (e.prefix === 'command-handler') kind = 'command'
  return kind ? { kind, target, method: r.method } : null
}
/**
 * 调的是自己类上的私有方法（或不是方法）：那是这个类自己的小帮手，不算一步的调用。
 * 调自己类上公开的行为 / 操作照样算（领域服务的一个操作先调自己另一个操作检查）
 */
function isOwnHelper(r, self) {
  if (!self || r.entry !== self) return false
  const cls = mainClass(program.getSourceFile(self.file), self.className)
  const m = cls && methodsOf(cls).find((x) => x.name.getText() === r.method)
  return !m || !isPublic(m)
}
/** 这一段里第一处能认出来的核心圈调用（不算自己类上的小帮手） */
function firstCoreCall(node, self, currentModule) {
  let hit = null
  const visit = (n) => {
    if (hit) return
    if (ts.isCallExpression(n)) {
      const r = resolveCall(n)
      if (r?.entry && !isOwnHelper(r, self)) {
        const call = callOf(r, currentModule)
        if (call) {
          hit = { r, call }
          return
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return hit
}
const STATEMENT_KINDS = (n) =>
  ts.isVariableStatement(n) || ts.isExpressionStatement(n) || ts.isReturnStatement(n) || ts.isIfStatement(n) || ts.isThrowStatement(n) ||
  ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isBlock(n)
/** 这一段里有没有自己带 // 注释的句子（不进回调函数里看） */
function hasCommentedStatement(node) {
  let found = false
  const visit = (n) => {
    if (found || ts.isFunctionLike(n)) return
    if (STATEMENT_KINDS(n) && !ts.isBlock(n) && lineComment(n)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  for (const s of blockStmts(node)) visit(s)
  return found
}
/** { xxxId: … } 或 { xxxIds: […] }：只有一栏、名字以 Id / Ids 结尾 */
function isIdOnly(expr) {
  const e = unwrap(expr)
  return ts.isObjectLiteralExpression(e) && e.properties.length === 1 && /Ids?$/.test(e.properties[0].name?.getText?.() ?? '')
}
/** return 交回的是什么：一个变量就是它的名字；只有一栏的对象字面量（return { lineId }）就是那一栏的名字 */
function returnedName(expr) {
  const e = unwrap(expr)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isObjectLiteralExpression(e) && e.properties.length === 1 && e.properties[0].name) return e.properties[0].name.getText()
  return null
}
const LOOP = (s) => ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isForStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s)
/**
 * 把一段方法体读成步骤（编码规范第十一节）。
 * - 一条 // 注释开一步；它下面没有注释的句子并进这一步：这一步改了哪几栏、抛什么、发什么、调了谁都算上。
 *   这一步还没有调用时，下面没注释的那一句调用就是这一步的调用（output 跟着取那一句的变量）。
 * - if：里面的句子各带注释时是分流，注释（没有就用条件源码）当 when；里面没有带注释的句子时，整个 if 就是一步
 *   （守卫「找不到就抛错、找到放行」写成一句 if (…) throw，挑中了就拿掉）。处理器里的 if 照旧只当分流。
 * - 循环（for…of 等）：是一步，标 each；循环体里的句子各带注释时，每一句各是一步，都标 each。
 * - return：带注释就是「交回」那一步，output 是交回的变量名（或只有一栏的 { lineId } 的那一栏）。
 * mode：handler（处理器）、service（领域服务操作）、object（领域对象的行为与创建：步骤可有可无，不报缺注释）
 */
function stepsOf(body, currentModule, ctx) {
  const mode = ctx.mode ?? (ctx.handler ? 'handler' : 'service')
  const report = (text) => {
    if (!ctx.quiet) issue(ctx.file, text)
  }
  const scanCtx = { entry: ctx.entry ?? null, method: null, alias: aliasesIn(body), label: '', quiet: true, create: !!ctx.create }
  const steps = []
  const domainOutputs = new Set() // 前面步骤中来自领域调用的 output 变量名
  let open = null // 当前这一步：后面没注释的句子并进来
  const newStep = (text, when, each) => {
    const st = { text, _scan: { ...emptyScan(), declared: new Set(), propsFrom: new Map() } }
    if (each) st.each = true
    if (when) st.when = when
    steps.push(st)
    return st
  }
  const absorb = (st, node) => scan(node, scanCtx, st._scan)
  const setCall = (st, hit, output) => {
    st.call = hit.call
    // 记下被调的是谁：处理器算完 raises / throws 闭包后，被调工厂 / 行为 / 服务会抛的错、会发的事件挂回这一步（agents/model/shapes.md「步骤语法」）
    ctx.onCall?.(hit.r.entry, hit.r, hit.call.kind)
    if (output && ['behavior', 'factory', 'service'].includes(hit.call.kind)) domainOutputs.add(output)
  }
  // 复合的一句（if、循环、花括号块）里面没有自己带注释的句子：整句是一步，或者没注释时并进上一步
  const wholeStatement = (s, comment, when, each, callNode) => {
    const st = comment ? newStep(comment, when, each) : open
    if (st) {
      absorb(st, s)
      if (!st.call) {
        const hit = firstCoreCall(callNode ?? s, ctx.entry ?? null, currentModule)
        if (hit) setCall(st, hit, null)
      }
    }
    if (comment) open = st
  }
  const handle = (stmts, when, each) => {
    for (const s of stmts) {
      const comment = lineComment(s)
      if (ts.isIfStatement(s)) {
        const inner = hasCommentedStatement(s.thenStatement) || (s.elseStatement && hasCommentedStatement(s.elseStatement))
        if (mode !== 'handler' && !inner) {
          wholeStatement(s, comment, when, each)
          // 注释写在 if 上，说的就是这个 if；后面没注释的句子不并进它
          if (comment) open = null
          continue
        }
        const w = comment ?? s.expression.getText()
        // 分流条件只能引用某次领域调用的返回值
        const idents = []
        const collect = (n) => {
          if (ts.isIdentifier(n)) idents.push(n.text)
          ts.forEachChild(n, collect)
        }
        collect(s.expression)
        if (ctx.handler && !idents.some((id) => domainOutputs.has(id))) report(`处理器体内的业务判断（条件未引用领域调用的结果）：if (${s.expression.getText()})`)
        open = null
        handle(blockStmts(s.thenStatement), w, each)
        if (s.elseStatement) handle(blockStmts(s.elseStatement), '否则', each)
        open = null
        continue
      }
      if (LOOP(s)) {
        if (hasCommentedStatement(s.statement)) {
          if (comment) newStep(comment, when, true)
          open = null
          handle(blockStmts(s.statement), when, true)
          open = null
        } else wholeStatement(s, comment, when, true, s.statement)
        continue
      }
      if (ts.isBlock(s)) {
        if (hasCommentedStatement(s)) {
          if (comment) newStep(comment, when, each)
          open = null
          handle([...s.statements], when, each)
          open = null
        } else wholeStatement(s, comment, when, each)
        continue
      }
      if (ts.isThrowStatement(s)) {
        if (ctx.handler) {
          report(`处理器体内不得直接 throw（技术守卫写成调用）：${s.getText().slice(0, 60)}`)
          continue
        }
        wholeStatement(s, comment, when, each)
        continue
      }
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
        // reading = this.check.flag(reading, …)：给已有的变量重新赋值，同 const reading = …
        if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
          output = expr.left.text
          expr = unwrap(expr.right)
        }
      } else if (ts.isReturnStatement(s) && s.expression) {
        // 新建命令 publish 之后只交回新编号（return { lineId }）：不是一步，模型也不写
        if (mode === 'handler' && isIdOnly(s.expression)) continue
        expr = unwrap(s.expression)
        output = returnedName(s.expression)
      }
      let hit = null
      let skipped = false
      let eachHere = each
      // 「对一批东西逐个做一次」：代码里是 xs.map(x => …) / forEach / flatMap，
      // 外层那个 map 本身不是业务调用，要读的是循环体里的那一次。
      const inner = eachCallOf(expr)
      if (inner) {
        eachHere = true
        expr = inner
      }
      if (expr && ts.isCallExpression(expr)) {
        const r = resolveCall(expr)
        if (r?.skip) skipped = true
        else if (r?.entry && !isOwnHelper(r, ctx.entry ?? null)) {
          const call = callOf(r, currentModule)
          if (call) hit = { r, call }
        }
      }
      if (skipped) continue
      // 主调用不是核心圈的（this.props.messages.push(UploadMessage.CREATE(…))、xs.filter(…).sort(…)），看句子里头第一处核心圈调用
      if (!hit && expr) hit = firstCoreCall(expr, ctx.entry ?? null, currentModule)
      if (comment) {
        const st = newStep(comment, when, eachHere)
        if (hit) setCall(st, hit, output)
        if (output) st.output = output
        absorb(st, s)
        open = st
      } else if (hit && open && !open.call) {
        // 注释下面那一步还没有调用：这一句没注释的调用就是它的调用
        setCall(open, hit, output)
        if (output) open.output = output
        if (eachHere) open.each = true
        absorb(open, s)
      } else if (hit && mode !== 'object') {
        const st = newStep(`(${expr.getText().slice(0, 40)})`, when, eachHere)
        report(`步骤缺少 // 注释：${st.text}`)
        setCall(st, hit, output)
        if (output) st.output = output
        absorb(st, s)
        open = st
      } else if (open) absorb(open, s)
    }
  }
  handle(blockStmts(body), undefined, false)
  return steps
}
/**
 * 步骤收尾：一步里各句调到的（行为、工厂、领域服务操作、模块里的小函数）会抛的错、会发的事件挂回这一步（闭包），
 * 改了哪几栏也挂上：领域对象里写自己的栏名；处理器、领域服务里写「对象.栏」。处理器调命令那一步不挂（命令自己记）。
 * 要在 propagate() 之后调。
 */
function finishSteps(steps, mode, self) {
  // 创建里交给构造的某一栏是前面哪一步算出来的变量：那一栏算那一步改的，不算 new 那一步的
  const movedTo = new Map() // 步骤 → 挪过来的栏
  const movedFrom = new Map() // 步骤 → 挪走的栏
  steps.forEach((st, i) => {
    for (const [field, v] of st._scan.propsFrom ?? []) {
      const from = steps.slice(0, i).reverse().find((x) => x._scan.declared?.has(v))
      if (!from) continue
      if (!movedTo.has(from)) movedTo.set(from, [])
      movedTo.get(from).push(field)
      if (!movedFrom.has(st)) movedFrom.set(st, new Set())
      movedFrom.get(st).add(field)
    }
  })
  for (const st of steps) {
    const sc = st._scan
    delete st._scan
    const throwsList = [...sc.throws]
    const raises = sc.raises.map((r) => (typeof r === 'string' ? r : r.event))
    const changes = new Set()
    if (mode === 'object') {
      for (const f of sc.changes) changes.add(f)
      for (const a of sc.aliasCalls) if (mutatesTransitively(a.callee)) changes.add(a.field)
    }
    for (const c of sc.calls) {
      const ce = entryOfId(c)
      if (ce?.prefix === 'command-handler') continue
      const g = graph.get(c)
      if (!g) continue
      for (const e of g.throws) if (!throwsList.includes(e)) throwsList.push(e)
      for (const r of g.raises) {
        const name = typeof r === 'string' ? r : r.event
        if (!raises.includes(name)) raises.push(name)
      }
      if (c.includes('#fn:')) continue
      if (mode === 'object') {
        if (self && ce === self) for (const f of changesOf(c)) changes.add(f)
      } else if (ce && DOMAIN_OBJECT.has(ce.prefix)) for (const f of changesOf(c)) changes.add(`${ce.modelName}.${f}`)
    }
    for (const f of movedTo.get(st) ?? []) changes.add(f)
    for (const f of movedFrom.get(st) ?? []) changes.delete(f)
    if (throwsList.length) st.throws = throwsList
    if (raises.length) st.raises = [...new Set(raises)]
    if (changes.size) st.changes = [...changes]
  }
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
        create: decodeCreate(rootEntry, rootCls, M),
        behaviors: decodeBehaviors(rootEntry, rootCls, M),
        traces: rootTraces,
        questions: [],
      }
      if (!obj.create) delete obj.create
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
        create: decodeCreate(e, cls, M),
        behaviors: decodeBehaviors(e, cls, M),
        traces: traceTags(tags),
      }
      if (!obj.create) delete obj.create
      // 实体、值对象 props 上的 @ref 也是这个聚合持有的别的聚合的编号（module.json 的 idRefs 记在聚合上）
      const aggItem = moduleJson.aggregates[moduleJson.aggregates.length - 1]
      for (const ref of props.refs) if (!aggItem.idRefs.some((x) => x.field === ref.field && x.to === ref.to)) aggItem.idRefs.push(ref)
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
          entry: e,
          onCall: (te, r, kind) => {
            if (kind === 'behavior' && te.prefix === 'aggregate-root' && mutatesTransitively(nodeId(te, r.method))) if (!writes.includes(te.modelName)) writes.push(te.modelName)
            // 工厂建出来的聚合：这个操作建了它，算它写的、它协调的
            if (kind === 'factory' && te.prefix === 'aggregate-root' && te.module === M) {
              if (!writes.includes(te.modelName)) writes.push(te.modelName)
              if (!coordinates.includes(te.modelName)) coordinates.push(te.modelName)
            }
          },
        })
        const g = graph.get(nodeId(e, m.name.getText())) ?? { raises: [], throws: [] }
        finishSteps(steps, 'service', e)
        const op = { name: m.name.getText() }
        const purpose = docLead(m)
        if (purpose) op.purpose = { text: purpose }
        op.input = input
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
      entry: e,
      onCall: (te, r, kind) => {
        called.push(nodeId(te, r.method))
        if (kind === 'repository' && !READ_PREFIX.test(r.method)) {
          wroteRepo = true
          if (te.aggregate && !writes.includes(te.aggregate)) writes.push(te.aggregate)
        }
        if (kind === 'behavior' && te.prefix === 'aggregate-root' && mutatesTransitively(nodeId(te, r.method))) if (!writes.includes(te.modelName)) writes.push(te.modelName)
        if (kind === 'factory' && te.prefix === 'aggregate-root' && te.module === M && e.prefix !== 'query-handler' && !writes.includes(te.modelName)) writes.push(te.modelName)
        if (kind === 'service') {
          const opWrites = serviceWrites(te, r.method)
          for (const w of opWrites) if (!writes.includes(w)) writes.push(w)
        }
        if (kind === 'repository' && e.prefix === 'query-handler' && !READ_PREFIX.test(r.method)) issue(e.file, `查询调用了写方法 ${r.method}`)
        if (kind === 'service' && e.prefix === 'query-handler' && serviceWrites(te, r.method).length) issue(e.file, `查询不许引起改变，调用了会写的领域服务操作 ${te.modelName}.${r.method}`)
        if (kind === 'port' && e.prefix === 'query-handler' && !portOpReadOnly(te, r.method)) issue(e.file, `查询只能调端口上标了 @readOnly 的操作：${te.modelName}.${r.method}`)
        if (kind !== 'repository' && kind !== 'service' && kind !== 'port' && e.prefix === 'query-handler') issue(e.file, `查询只能调用仓储的读方法、不写的领域服务与端口的只读操作：${kind} ${te.modelName}.${r.method}`)
      },
    })
    // 最后一步是否 publish
    const stmts = blockStmts(entryMethod.body)
    // 新建命令 publish 之后可以只交回新编号：return { xxxId: ... } 或一次建几条时 return { xxxIds: [...] }（一个属性、名字以 Id 或 Ids 结尾），那一句不算步骤
    const returnsIdOnly = (st) => st && ts.isReturnStatement(st) && st.expression && ts.isObjectLiteralExpression(unwrap(st.expression)) &&
      unwrap(st.expression).properties.length === 1 && /Ids?$/.test(unwrap(st.expression).properties[0].name?.getText?.() ?? '')
    const last = returnsIdOnly(stmts[stmts.length - 1]) ? stmts[stmts.length - 2] : stmts[stmts.length - 1]
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
    finishSteps(steps, 'handler', e)

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
        const t = checker.getNonNullableType(checker.getTypeAtLocation(p))
        const te = entryOfNode(t.getSymbol()?.declarations?.[0])
        if (te?.prefix === 'event') trigger = te.module !== M ? `${te.module}.${te.modelName}` : te.modelName
        else {
          const foreign = foreignEventOf(t, mod)
          if (foreign) trigger = foreign
          else issue(e.file, 'handle 的参数不是领域事件')
        }
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
      if (docTags(m).some((t) => t.tag === 'readOnly')) o.readOnly = true
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
    const b = { name: m.name.getText() }
    const purpose = docLead(m)
    if (purpose) b.purpose = { text: purpose }
    b.input = paramsOf(sig, M)
    const ret = mapType(sig.getReturnType(), M).type
    if (ret) b.output = ret
    // 做法：方法体里的 // 注释一句一步（可有可无：模型没写步骤的不比）
    const steps = finishSteps(stepsOf(m.body, M, { file: entry.file, entry, mode: 'object', quiet: true }), 'object', entry)
    if (steps.length) b.steps = steps
    Object.assign(b, { rules: tagValues(tags, 'rule'), raises: g.raises, throws: g.throws, traces: traceTags(tags) })
    if (!b.traces.length) issue(entry.file, `${b.name}：缺少 @trace`)
    return b
  })
}
/**
 * 创建（模型的 create）：静态工厂 CREATE。只收一个叫 input 的参数时，把它的各栏摊开当入参（模型照一栏一项写）；
 * 作用是方法说明那段话，做法是方法体里的 // 注释，规则是 @rule，会抛的错是工厂的闭包。没有 CREATE 的返回 null
 */
function decodeCreate(entry, cls, M) {
  const m = factoriesOf(cls).find((x) => x.name.getText() === 'CREATE')
  if (!m) return null
  const sig = checker.getSignatureFromDeclaration(m)
  const tags = docTags(m)
  const c = {}
  const purpose = docLead(m)
  if (purpose) c.purpose = { text: purpose }
  const only = m.parameters.length === 1 && ts.isIdentifier(m.parameters[0].name) && m.parameters[0].name.text === 'input' ? m.parameters[0] : null
  c.input = only ? membersOfType(checker.getNonNullableType(checker.getTypeAtLocation(only)), M).fields.map(({ name, type }) => ({ name, type })) : paramsOf(sig, M)
  const steps = finishSteps(stepsOf(m.body, M, { file: entry.file, entry, mode: 'object', quiet: true, create: true }), 'object', entry)
  if (steps.length) c.steps = steps
  const g = graph.get(nodeId(entry, 'CREATE')) ?? { throws: [] }
  Object.assign(c, { rules: tagValues(tags, 'rule'), throws: g.throws, traces: traceTags(tags) })
  return c
}
function ctorParams(cls, M) {
  const ctor = cls.members.find(ts.isConstructorDeclaration)
  if (!ctor) return []
  return ctor.parameters.map((p) => ({ name: p.name.getText(), type: mapType(checker.getTypeAtLocation(p), M).type ?? 'unknown' }))
}
/** 端口上这个方法标了 @readOnly 没有（只交回结果、对外什么都不改；查询只能调这种） */
function portOpReadOnly(entry, method) {
  const sf = program.getSourceFile(entry.file)
  const itf = sf && interfacesIn(sf).find((i) => i.name.text === entry.className)
  const m = itf && itf.members.filter(ts.isMethodSignature).find((x) => x.name.getText() === method)
  return !!m && docTags(m).some((t) => t.tag === 'readOnly')
}
function serviceWrites(entry, method) {
  const sf = program.getSourceFile(entry.file)
  const cls = mainClass(sf, entry.className)
  const m = cls && methodsOf(cls).find((x) => x.name.getText() === method)
  if (!m) return []
  const writes = []
  stepsOf(m.body, entry.module, {
    file: entry.file,
    entry,
    quiet: true,
    onCall: (te, r, kind) => {
      if (kind === 'behavior' && te.prefix === 'aggregate-root' && mutatesTransitively(nodeId(te, r.method))) if (!writes.includes(te.modelName)) writes.push(te.modelName)
      if (kind === 'factory' && te.prefix === 'aggregate-root' && te.module === entry.module && !writes.includes(te.modelName)) writes.push(te.modelName)
    },
  })
  return writes
}
/**
 * 别的模块的事件：模块之间不许 import，处理器所在模块里另写一份它的样子（领域事件的几栏加 payload）。
 * 认法：那份类型声明在本模块里、带 payload；标了 @ref Module.Event 就是它，没标就看名字——以 Event 结尾，
 * 去掉 Event 在别的模块里恰好有一个同名事件，就是那一个。认不出返回 null
 */
function foreignEventOf(t, mod) {
  const s = t.aliasSymbol ?? t.getSymbol()
  const decl = s?.declarations?.[0]
  if (!decl || !path.normalize(decl.getSourceFile().fileName).startsWith(path.normalize(mod.dir) + path.sep)) return null
  if (!t.getProperty('payload')) return null
  const ref = refOfType(t)
  if (ref) return ref
  const name = s.name
  if (!/Event$/.test(name)) return null
  const modelName = name.slice(0, -'Event'.length)
  const found = [...registry.values()].filter((x) => x.prefix === 'event' && x.module !== mod.name && x.modelName === modelName)
  return found.length === 1 ? `${found[0].module}.${modelName}` : null
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
