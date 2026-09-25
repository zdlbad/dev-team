/**
 * 把一个代码库用 tsc 编译成 CommonJS 到 <代码库>/.proto-build（原型宿主与测试运行器共用）。
 * 编译根 = 代码库与 tsconfig include 指到的所有目录的公共祖先（构建块可能在代码库之外），
 * 所以产物里代码库对应的目录是 buildDir/<codebase 相对编译根的路径>。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function rootDirOf(codebase, tsconfig) {
  const ts = require('typescript')
  const cfg = ts.readConfigFile(tsconfig, ts.sys.readFile)
  const parsed = cfg.config ? ts.parseJsonConfigFileContent(cfg.config, ts.sys, codebase) : { fileNames: [] }
  const dirs = [codebase, ...parsed.fileNames.map((f) => path.dirname(path.resolve(f)))]
  const segs = dirs.map((d) => d.split(path.sep))
  let common = segs[0]
  for (const s of segs) { let i = 0; while (i < common.length && i < s.length && common[i].toLowerCase() === s[i].toLowerCase()) i++; common = common.slice(0, i) }
  return common.join(path.sep) || path.parse(codebase).root
}

/** @returns {{ ok: boolean, output: string, buildDir: string, codebaseInBuild: string, tsconfig: string }} */
function compile(codebase) {
  const buildDir = path.join(codebase, '.proto-build')
  const tsconfig = path.join(codebase, 'tsconfig.json')
  const rootDir = rootDirOf(codebase, tsconfig)
  const codebaseInBuild = path.join(buildDir, path.relative(rootDir, codebase))
  const tsc = require.resolve('typescript/bin/tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--noEmit', 'false', '--noEmitOnError', '--outDir', buildDir, '--rootDir', rootDir, '--module', 'commonjs', '--moduleResolution', 'node', '--esModuleInterop', '--declaration', 'false', '--sourceMap', 'false', '--skipLibCheck'], { encoding: 'utf8', cwd: codebase })
  // 编译不过就让构建目录里没有可跑的东西。tsc 默认即使报错也把能编的文件产出来，留着它，
  // 下一个起原型或跑探针的人跑的就是那份半新半旧的坏代码，还以为是真结果。
  if (r.status !== 0) { fs.rmSync(buildDir, { recursive: true, force: true }); return { ok: false, output: (r.stdout + r.stderr).trim(), buildDir, codebaseInBuild, tsconfig } }
  fs.mkdirSync(buildDir, { recursive: true })
  fs.writeFileSync(path.join(buildDir, 'package.json'), '{ "type": "commonjs" }\n')
  return { ok: true, output: (r.stdout + r.stderr).trim(), buildDir, codebaseInBuild, tsconfig }
}

module.exports = { compile, rootDirOf }
