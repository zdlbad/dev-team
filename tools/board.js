#!/usr/bin/env node
/**
 * 状态看板。依据 seed/05-roles.md：从 slices/、reports/、decisions[] 算出每个切片走到哪、卡在哪。
 *
 * 用法：node tools/board.js <项目目录> [--md]   带 --md 时同时写 reports/board.md
 * 只读，不写任何工件（board.md 除外，它和报告一样是临时物）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadProject } = require('./lib/project')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
if (!root || !fs.existsSync(path.join(root, 'project.json'))) {
  console.error('用法：node tools/board.js <项目目录> [--md]')
  process.exit(2)
}
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'))
const { business, glossary, model, slices } = loadProject(root)

// ---------- 数字 ----------
const goals = business.filter((s) => s.kind === 'goal').length
const rules = business.filter((s) => s.kind === 'rule').length
const usages = business.filter((s) => s.kind === 'usage').length
const kinds = {}
for (const el of model.elements) kinds[el.kind] = (kinds[el.kind] ?? 0) + 1
const modules = model.modules?.data.modules?.map((m) => m.name) ?? []
let decisions = 0
for (const el of model.elements) decisions += el.data?.decisions?.length ?? 0
for (const mf of model.moduleFiles) decisions += mf.data.decisions?.length ?? 0
decisions += model.modules?.data.decisions?.length ?? 0

// ---------- 报告 ----------
function report(direction) {
  const p = path.join(root, 'reports', `validate-${direction}.json`)
  if (!fs.existsSync(p)) return null
  const r = JSON.parse(fs.readFileSync(p, 'utf8'))
  const unjudged = r.judgments.filter((j) => !j.verdict).length
  const unreviewed = [...r.judgments, ...r.confirms].filter((it) => !it.human?.verdict).length
  const stale = [...r.judgments, ...r.confirms, ...r.warnings].filter((it) => it.staleDecision).length
  return { slice: r.slice, at: r.at.slice(0, 16).replace('T', ' '), errors: r.errors.length, warnings: r.warnings.length, confirms: r.confirms.length, judgments: r.judgments.length, unjudged, unreviewed, decided: r.decided.length, stale, applied: !!r.applied, conclusion: r.conclusion, decodedVersion: r.decodedVersion }
}
const r1 = report(1)
const r2 = report(2)

// ---------- 切片：下一步交给 slice.js 计算，看板不另写一套规则 ----------
function nextOf(id) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'slice.js'), 'next', root, id, '--json'], { encoding: 'utf8' })
  try {
    return JSON.parse(res.stdout)
  } catch {
    return { role: '?', action: (res.stderr || res.stdout).trim(), command: null }
  }
}
const STATUS = { pending: '待开始', 'in-progress': '进行中', done: '完成' }
const rows = (slices ?? [])
  .map((s) => s.data)
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((s) => {
    const done = Object.values(s.stages).every((st) => st.status === 'done')
    const n = done ? { role: '—', action: '切片完成' } : nextOf(s.id)
    const lastLog = s.log[s.log.length - 1]
    return { id: s.id, title: s.title, kind: ({ initial: '大切片', increment: '小切片', story: '建模', implementation: '实现' })[s.kind] ?? s.kind, model: STATUS[s.stages.model.status], code: STATUS[s.stages.code.status], validate: STATUS[s.stages.validate.status], next: `${n.role}：${n.action}`, command: n.command, last: lastLog ? `${lastLog.ts} ${lastLog.text}` : '' }
  })

// ---------- 渲染 ----------
function table(headers, data) {
  const L = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|']
  for (const r of data) L.push('| ' + r.map((c) => String(c ?? '').replaceAll('|', '\\|')).join(' | ') + ' |')
  return L
}
function reportLine(name, r) {
  if (!r) return `- ${name}：尚未执行`
  const state = r.errors + r.warnings ? `**不干净**（错误 ${r.errors}，警告 ${r.warnings}）` : r.unjudged ? `待判断 ${r.unjudged}` : r.unreviewed ? `待人审 ${r.unreviewed}` : r.applied ? '干净，裁决已写回' : '干净，裁决未写回'
  return `- ${name}（${r.at}${r.slice ? `，切片 ${r.slice}` : ''}${r.decodedVersion ? `，解码版本 ${r.decodedVersion}` : ''}）：${state}；需确认 ${r.confirms}，判断 ${r.judgments}，已裁决 ${r.decided}${r.stale ? `，**过期裁决 ${r.stale}**` : ''}`
}
const L = []
L.push(`# 看板 · ${project.name}`, '')
L.push(`- 业务：目标 ${goals} 条，规则 ${rules} 条，使用 ${usages} 条；词汇 ${glossary.terms.length} 个`)
L.push(`- 模型：模块 ${modules.length}（${modules.join('、') || '无'}）；${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join('，') || '尚无元素'}；裁决 ${decisions} 条`)
L.push(reportLine('校验 ①', r1))
L.push(reportLine('校验 ②', r2))
L.push('', '## 切片', '')
if (!rows.length) L.push('（还没有切片：`slice new` 建一个）')
else L.push(...table(['切片', '标题', '种类', '模型', '编码', '校验', '下一步'], rows.map((r) => [r.id, r.title, r.kind, r.model, r.code, r.validate, r.next])))
const open = rows.filter((r) => r.command)
if (open.length) {
  L.push('', '## 待执行', '')
  for (const r of open) L.push(`- ${r.id}：\`${r.command}\``)
}
L.push('', '## 最近动态', '')
for (const r of rows) L.push(`- ${r.id}：${r.last}`)
L.push('')
const text = L.join('\n')
console.log(text)
if (args.includes('--md')) {
  const p = path.join(root, 'reports', 'board.md')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  console.log(`已写出 ${path.relative(process.cwd(), p)}`)
}
