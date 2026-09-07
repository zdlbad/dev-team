/**
 * 路径别名钩子：让 tsc 编译出的 CommonJS 在运行时能解析 tsconfig 的 paths（如 @shared/building-block/*）。
 * 给 node --test 用：NODE_OPTIONS="--require <本文件>"，参数经环境变量传入：
 *   DEV_TEAM_BUILD_DIR   编译产物里对应代码库的目录
 *   DEV_TEAM_TSCONFIG    代码库的 tsconfig.json
 * proto-run.js 里同样的逻辑是给原型宿主用的；两处都很短，各自独立，免得原型启动多一层间接。
 */
const path = require('node:path')
const Module = require('node:module')

const buildDir = process.env.DEV_TEAM_BUILD_DIR
const tsconfigPath = process.env.DEV_TEAM_TSCONFIG
if (buildDir && tsconfigPath) {
  let paths = {}
  try {
    const ts = require('typescript')
    const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
    paths = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, path.dirname(tsconfigPath)).options.paths ?? {}
  } catch { /* 没有 paths 就不映射 */ }
  const rules = Object.entries(paths).map(([alias, targets]) => ({ prefix: alias.replace(/\*$/, ''), star: alias.endsWith('*'), target: String(targets[0]).replace(/\*$/, '').replace(/\.ts$/, '') }))
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    for (const r of rules) {
      if (r.star ? request.startsWith(r.prefix) : request === r.prefix) {
        const tail = r.star ? request.slice(r.prefix.length) : ''
        return origResolve.call(this, path.join(buildDir, r.target + tail), parent, ...rest)
      }
    }
    return origResolve.call(this, request, parent, ...rest)
  }
}
