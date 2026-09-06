#!/usr/bin/env node
/**
 * 原型启动器：在 tsc 编译出的 CommonJS 目录里跑 src/proto/main.js，
 * 并把 tsconfig 的 paths 别名（如 @shared/building-block/*）解析到编译产物里。
 *
 * 用法：node tools/lib/proto-run.js <代码库在编译产物里的目录> <tsconfig.json> [入口，缺省 src/proto/main.js]
 * paths 别名相对代码库解析，所以第一个参数是代码库在编译产物里对应的目录（构建块在代码库之外时它不是编译根）
 */
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const [buildDir, tsconfigPath, entryRel = 'src/proto/main.js'] = process.argv.slice(2).map((p, i) => (i < 2 && p ? path.resolve(p) : p))
if (!buildDir || !tsconfigPath) { console.error('用法：proto-run <编译目录> <tsconfig.json> [入口]'); process.exit(2) }

// 用 TypeScript 自己读 tsconfig（允许注释与 extends），只取 paths
let paths = {}
try { const ts = require('typescript'); const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile); paths = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, path.dirname(tsconfigPath)).options.paths ?? {} } catch (e) { /* 没有 paths 就不映射 */ }
const rules = Object.entries(paths).map(([alias, targets]) => ({ prefix: alias.replace(/\*$/, ''), star: alias.endsWith('*'), target: String(targets[0]).replace(/\*$/, '').replace(/\.ts$/, '') }))

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  for (const r of rules) {
    if (r.star ? request.startsWith(r.prefix) : request === r.prefix) {
      const tail = r.star ? request.slice(r.prefix.length) : ''
      const mapped = path.join(buildDir, r.target + tail)
      return origResolve.call(this, mapped, parent, ...rest)
    }
  }
  return origResolve.call(this, request, parent, ...rest)
}

const entry = path.join(buildDir, entryRel)
if (!fs.existsSync(entry)) { console.error(`原型入口不存在：${entry}（原型角色应写 src/proto/main.ts）`); process.exit(3) }
require(entry)
