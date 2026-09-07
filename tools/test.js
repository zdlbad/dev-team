#!/usr/bin/env node
/**
 * 测试运行器。依据 seed/03-coding-standard.md 第八节：tests/ 镜像 src/，文件名 = 源文件名 + .test.ts，用 node:test。
 *
 * 用法：node tools/test.js <代码库> [<子路径或文件名片段>…]
 *   编译代码库（tsc → .proto-build，与原型共用），然后 node --test 跑 tests/ 下编译出的 *.test.js；
 *   带片段时只跑路径含该片段的文件（如 `order`、`ConfirmOrder`）——一次只跑一小批，不整套跑。
 * 退出码：0 全部通过；1 有失败或编译不过；2 用法错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { compile } = require('./lib/compile')

const [cbArg, ...filters] = process.argv.slice(2)
if (!cbArg) { console.error('用法：node tools/test.js <代码库> [<片段>…]'); process.exit(2) }
const codebase = path.resolve(cbArg)
if (!fs.existsSync(path.join(codebase, 'tsconfig.json'))) { console.error(`代码库没有 tsconfig.json：${codebase}`); process.exit(2) }

const c = compile(codebase)
if (!c.ok) { console.error('编译不过：\n' + c.output); process.exit(1) }
const testsDir = path.join(c.codebaseInBuild, 'tests')
if (!fs.existsSync(testsDir)) { console.log(`没有测试：${path.relative(process.cwd(), path.join(codebase, 'tests'))} 不存在（tsconfig include 要含 tests/**/*.ts）`); process.exit(0) }
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.test.js')) out.push(p) } return out }
const files = walk(testsDir).filter((f) => !filters.length || filters.some((k) => f.replaceAll('\\', '/').includes(k)))
if (!files.length) { console.log(`没有匹配的测试文件${filters.length ? `（片段：${filters.join(' ')}）` : ''}`); process.exit(0) }
console.log(`跑 ${files.length} 个测试文件${filters.length ? `（片段：${filters.join(' ')}）` : ''}`)
const r = spawnSync(process.execPath, ['--test', '--test-reporter', 'spec', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(path.join(__dirname, 'lib', 'alias-hook.js'))}`.trim(), DEV_TEAM_BUILD_DIR: c.codebaseInBuild, DEV_TEAM_TSCONFIG: c.tsconfig },
})
process.exit(r.status ?? 1)
