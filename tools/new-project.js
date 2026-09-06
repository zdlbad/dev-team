#!/usr/bin/env node
/**
 * 新建项目：拷贝模板、填占位符、git init + 首次提交。
 * 用法：node tools/new-project.js <目标目录> <系统名> [--codebase <代码库目录>]
 * 加 --codebase 时，把基础构建块拷到 <代码库目录>/src/shared/building-block/。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const args = process.argv.slice(2)
const target = args[0]
const system = args[1]
const cbIdx = args.indexOf('--codebase')
const codebase = cbIdx >= 0 ? args[cbIdx + 1] : null

if (!target || !system) {
  console.error('用法：node tools/new-project.js <目标目录> <系统名> [--codebase <代码库目录>]')
  process.exit(1)
}

const devTeam = path.resolve(__dirname, '..')
const templateDir = path.join(devTeam, 'template', 'project')
const dest = path.resolve(target)
const today = new Date().toISOString().slice(0, 10)

if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
  console.error(`目标目录非空：${dest}`)
  process.exit(1)
}
// dev-team 是 skill 仓库，项目必须建在它之外
const rel = path.relative(devTeam, dest)
if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  console.error(`项目不能建在 dev-team 目录之内：${dest}`)
  process.exit(1)
}

const fill = (s) =>
  s.replaceAll('__SYSTEM__', system).replaceAll('__DATE__', today).replaceAll('__DEV_TEAM__', devTeam.replaceAll('\\', '/'))

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.writeFileSync(dst, fill(fs.readFileSync(src, 'utf8')))
  }
}

copyDir(templateDir, dest)
for (const d of ['raw', 'slices', 'reports', 'model-decoded', '.viewer']) {
  fs.mkdirSync(path.join(dest, d), { recursive: true })
  fs.writeFileSync(path.join(dest, d, '.gitkeep'), '')
}

try {
  execSync('git init -q -b main', { cwd: dest, stdio: 'pipe' })
  execSync('git add -A', { cwd: dest, stdio: 'pipe' })
  // 没有全局身份时用项目级默认身份，不改动用户的全局配置
  const hasIdentity = (() => {
    try {
      execSync('git config user.email', { cwd: dest, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  })()
  const identity = hasIdentity ? '' : '-c user.name="dev-team" -c user.email="dev-team@local"'
  execSync(`git ${identity} commit -q -m "project: init ${system}"`, { cwd: dest, stdio: 'pipe' })
  console.log(`项目已创建并完成首次提交：${dest}`)
} catch (e) {
  console.log(`项目已创建：${dest}（git 初始化失败：${String(e.stderr || e.message).split('\n')[0]}）`)
}

if (codebase) {
  const bbSrc = path.join(devTeam, 'building-block')
  const bbDst = path.join(path.resolve(codebase), 'src', 'shared', 'building-block')
  fs.mkdirSync(bbDst, { recursive: true })
  for (const sub of ['domain', 'application', 'ports', 'proto']) {
    copyDir(path.join(bbSrc, sub), path.join(bbDst, sub))
  }
  console.log(`基础构建块已拷入：${bbDst}`)
}
