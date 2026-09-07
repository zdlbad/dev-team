#!/usr/bin/env node
/**
 * 按文件名把项目里的 JSON 对到 schema 并校验。
 * 用法：node tools/check-schema.js <项目目录>          校验 glossary、model/、slices/（含 *.story.json）、plans/、contracts/
 *       node tools/check-schema.js --self               只编译全部 schema，检查 schema 本身
 * 退出码：0 全部通过；1 有不合规文件；2 用法或 schema 错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')

const schemaDir = path.join(__dirname, '..', 'schema')

function loadAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
  addFormats(ajv)
  for (const f of fs.readdirSync(schemaDir).filter((n) => n.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaDir, f), 'utf8')))
  }
  // 编译一遍，让 schema 自身的错误尽早暴露
  for (const id of Object.keys(ajv.schemas).filter((k) => k.startsWith('urn:dev-team:'))) ajv.getSchema(id)
  return ajv
}

/** 文件名 → schema id */
function schemaFor(file, rel) {
  const base = path.basename(file)
  if (base === 'glossary.json') return 'urn:dev-team:glossary'
  if (base === 'modules.json' && rel.startsWith('model')) return 'urn:dev-team:modules'
  if (base === 'module.json' && rel.startsWith('model')) return 'urn:dev-team:module'
  if (rel.startsWith('slices')) return base.endsWith('.story.json') ? 'urn:dev-team:story' : 'urn:dev-team:slice'
  if (rel.startsWith('plans')) return 'urn:dev-team:plan'
  if (rel.startsWith('contracts')) return 'urn:dev-team:contract'
  const m = base.match(/^(aggregate-root|entity|value-object|event|error|repository|service|command-handler|query-handler|event-handler|port)\.[A-Za-z0-9]+\.json$/)
  return m ? `urn:dev-team:${m[1]}` : null
}

/** 文件名中的类名与 name 字段是否一致（去后缀） */
const SUFFIX = {
  'aggregate-root': 'AggregateRoot', entity: 'Entity', 'value-object': 'ValueObject', event: 'Event', error: 'Error',
  service: 'Service', repository: 'Interface', 'command-handler': 'CommandHandler', 'query-handler': 'QueryHandler',
  'event-handler': 'EventHandler', port: 'Interface',
}
function nameMismatch(file, data) {
  const m = path.basename(file).match(/^([a-z-]+)\.([A-Za-z0-9]+)\.json$/)
  if (!m || !SUFFIX[m[1]]) return null
  const suffix = SUFFIX[m[1]]
  const cls = m[2]
  if (!cls.endsWith(suffix)) return `文件名类名应以 ${suffix} 结尾：${cls}`
  const expected = cls.slice(0, -suffix.length)
  if (data.name !== expected) return `name 应为 ${expected}（文件名去后缀），实际 ${data.name}`
  return null
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法：node tools/check-schema.js <项目目录> | --self')
    process.exit(2)
  }
  let ajv
  try {
    ajv = loadAjv()
  } catch (e) {
    console.error('schema 本身有错：', e.message)
    process.exit(2)
  }
  if (arg === '--self') {
    console.log('全部 schema 编译通过。')
    return
  }
  const root = path.resolve(arg)
  const files = [
    path.join(root, 'glossary.json'),
    ...walk(path.join(root, 'model')),
    ...walk(path.join(root, 'slices')),
    ...walk(path.join(root, 'plans')),
    ...walk(path.join(root, 'contracts')),
  ].filter((f) => fs.existsSync(f))

  let bad = 0
  let checked = 0
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll('\\', '/')
    const id = schemaFor(file, rel)
    if (!id) {
      console.log(`? ${rel}  （无对应 schema，跳过）`)
      continue
    }
    let data
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      console.log(`✗ ${rel}  JSON 解析失败：${e.message}`)
      bad++
      continue
    }
    checked++
    const validate = ajv.getSchema(id)
    const ok = validate(data)
    const nm = nameMismatch(file, data)
    if (ok && !nm) {
      console.log(`✓ ${rel}`)
      continue
    }
    bad++
    console.log(`✗ ${rel}`)
    if (nm) console.log(`    ${nm}`)
    for (const err of validate.errors ?? []) {
      console.log(`    ${err.instancePath || '/'} ${err.message}${err.params?.additionalProperty ? `: ${err.params.additionalProperty}` : ''}`)
    }
  }
  console.log(`\n已检查 ${checked} 个文件，${bad} 个不合规。`)
  process.exit(bad ? 1 : 0)
}

main()
