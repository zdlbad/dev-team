#!/usr/bin/env node
/**
 * 模型增量：把切片模型阶段开工时的模型（基线提交）与现在的模型比，渲染成页面——人只确认增量，不重看整个模型。
 *
 * 用法：node tools/model-delta.js <项目目录> [<切片id>] [--base <提交>] [--out <html>]
 *   基线默认取切片记录 stages.model.baseline（`slice advance <id> model in-progress` 时自动记下 git HEAD）；
 *   --base 可以指定别的提交（比如 HEAD、上一条切片确认时的提交）。
 *   页面：reports/model-delta.<切片>.html；红 = 本段新增或改动，绿 = 没动，「差异」视图按文件汇总。
 * 退出码：0 正常；2 用法或前置错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined)
const root = args[0] && path.resolve(args[0])
const id = args[1] && !args[1].startsWith('--') ? args[1] : null
const die = (m) => { console.error(m); process.exit(2) }
if (!root || !fs.existsSync(path.join(root, 'model'))) die('用法：node tools/model-delta.js <项目目录> [<切片id>] [--base <提交>] [--out <html>]')

let base = opt('--base')
if (!base) {
  if (!id) die('要么给切片 id（用它记的基线），要么 --base <提交>')
  const sp = path.join(root, 'slices', `${id}.json`)
  if (!fs.existsSync(sp)) die(`切片不存在：${path.relative(process.cwd(), sp)}`)
  base = JSON.parse(fs.readFileSync(sp, 'utf8')).stages?.model?.baseline
  if (!base) die(`切片 ${id} 没记基线提交（模型阶段还没 in-progress？）。先 slice advance ${id} model in-progress，或用 --base <提交>`)
}

const git = (a, o = {}) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, ...o })
const top = git(['rev-parse', '--show-toplevel'])
if (top.status !== 0) die('项目目录不在 git 仓库里，算不出基线')
const gitRoot = top.stdout.trim()
const relModel = path.relative(gitRoot, path.join(root, 'model')).replaceAll('\\', '/')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-delta-'))
// 逐文件从基线提交写出（不用 git archive + tar：Windows 的 tar 会把 C:\… 当成远程主机）；路径相对仓库根解析，所以在仓库根跑
const ls = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', base, '--', relModel], { cwd: gitRoot, encoding: 'utf8', maxBuffer: 1 << 28 })
if (ls.status !== 0) die(`导出基线失败（${base}）：${ls.stderr.trim()}`)
for (const f of ls.stdout.split('\0').filter(Boolean)) {
  const show = spawnSync('git', ['show', `${base}:${f}`], { cwd: gitRoot, maxBuffer: 1 << 28 })
  if (show.status !== 0) die(`导出基线文件失败（${f}）：${show.stderr.toString().trim()}`)
  const dest = path.join(tmp, f)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, show.stdout)
}
const baseDir = path.join(tmp, relModel)
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true }) // 基线里还没有 model/：全部算新增

// 差异摘要
const dj = path.join(tmp, 'diff.json')
spawnSync(process.execPath, [path.join(__dirname, 'diff-model.js'), path.join(root, 'model'), baseDir, '--json', dj], { encoding: 'utf8' })
const findings = fs.existsSync(dj) ? JSON.parse(fs.readFileSync(dj, 'utf8')).findings : []
const added = findings.filter((f) => f.kind === 'missing-file').map((f) => f.file)      // 现在有、基线无 = 本段新增
const removed = findings.filter((f) => f.kind === 'extra-file').map((f) => f.file)      // 基线有、现在无 = 本段删除
const changed = [...new Set(findings.filter((f) => !['missing-file', 'extra-file'].includes(f.kind)).map((f) => f.file))]

// 渲染
const out = path.resolve(opt('--out') ?? path.join(root, 'reports', `model-delta.${id ?? base.slice(0, 7)}.html`))
fs.mkdirSync(path.dirname(out), { recursive: true })
const r = spawnSync(process.execPath, [path.join(__dirname, 'render.js'), root, '--baseline', baseDir, '--out', out], { encoding: 'utf8' })
if (r.status !== 0) die(`渲染失败：${r.stderr}`)
fs.rmSync(tmp, { recursive: true, force: true })

const rel = (p) => path.relative(process.cwd(), p)
console.log(`模型增量（基线 ${base.slice(0, 7)} → 工作区）：新增 ${added.length} 个文件 · 改动 ${changed.length} 个文件 · 删除 ${removed.length} 个文件 · 细项 ${findings.length} 处`)
for (const f of added) console.log(`  + ${f}`)
for (const f of changed) console.log(`  ~ ${f}（${findings.filter((x) => x.file === f).length} 处）`)
for (const f of removed) console.log(`  - ${f}`)
console.log(`页面：${rel(out)}（红 = 本段新增或改动，绿 = 没动；顶栏「差异」按文件汇总）`)
