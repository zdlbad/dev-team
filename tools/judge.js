#!/usr/bin/env node
/**
 * 待判单子：几段一起要审时，把各段校验报告里还没判的判断去重成一张小单子给审查；审查在单子上填，再一条命令写回各段。
 * 从前审查要打开十几份几十万字的报告，自己认出「这条跟别段那条原文一样」，再一份份写回（2026-10-02 起不用了）。
 *
 * 用法：
 *   node tools/judge.js <项目> pending [--code <代码库>] [--slices s-011,s-014,…] [--方向 1]
 *       对每一段跑一次 validate（--slice，写报告；判过的同一条跨段接过来），
 *       再把各段没判的去重，写 reports/待判-<方向>.json：一条一个 id、哪几段有它、两边原文、问什么；
 *       用到的判断指南放在最上面一份。没给 --slices 就取 reports 里已有这一方向报告的各段。
 *   node tools/judge.js <项目> apply [--方向 1]
 *       单子上填了 verdict 的，照单子记下的段与代码库再跑一次 validate：各段报告接过这些判定（validate 把单子当一个来源），
 *       报出各段还剩几条没判、几条不通过、干净没有。
 *
 * 审查只读、只填单子上每条的 verdict、confidence、reason，别的栏不动（agents/review/reviewer.md）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { judgeId, reportFiles, pendingFile } = require('./lib/judgments')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
const cmd = args[1]
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const direction = opt('--方向') ?? '1'
if (!root || !fs.existsSync(path.join(root, 'project.json')) || !['pending', 'apply'].includes(cmd)) {
  console.error('用法：node tools/judge.js <项目> pending [--code <代码库>] [--slices s-011,s-014,…] [--方向 1]\n　　　node tools/judge.js <项目> apply [--方向 1]')
  process.exit(2)
}
const reportsDir = path.join(root, 'reports')
const pf = pendingFile(reportsDir, direction)

/** 每段跑一次 validate（写报告）；返回各段的报告 */
function validateSlices(slices, codebase) {
  for (const s of slices) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'validate.js'), root, ...(codebase ? ['--code', codebase] : []), '--slice', s], { encoding: 'utf8' })
    if (r.status === 2) { console.error(`${s} 校验跑不起来：\n${(r.stdout + r.stderr).trim()}`); process.exit(2) }
  }
  // 现役那份与按切片存的那份都可能是这一段的，取后写的
  const bySlice = new Map()
  for (const { report } of reportFiles(reportsDir, direction)) {
    if (!slices.includes(report.slice)) continue
    const had = bySlice.get(report.slice)
    if (!had || String(report.at) > String(had.at)) bySlice.set(report.slice, report)
  }
  return slices.map((s) => ({ slice: s, report: bySlice.get(s) ?? null }))
}
const count = (r) => ({ all: r.judgments.length, open: r.judgments.filter((j) => !j.verdict).length, failed: r.judgments.filter((j) => j.verdict === 'fail').length, errors: r.errors.length })

if (cmd === 'pending') {
  const codebase = opt('--code') && path.resolve(opt('--code'))
  const given = opt('--slices')?.split(',').map((x) => x.trim()).filter(Boolean)
  const slices = given ?? [...new Set(reportFiles(reportsDir, direction).map(({ report }) => report.slice).filter(Boolean))].sort()
  if (!slices.length) { console.error('reports 里还没有这一方向按段的报告：用 --slices 指定要审哪几段'); process.exit(2) }
  const items = new Map()
  const lines = []
  for (const { slice, report } of validateSlices(slices, codebase)) {
    if (!report) { lines.push(`  ${slice}：没有报告`); continue }
    const c = count(report)
    lines.push(`  ${slice}：判断 ${c.all} 条，没判 ${c.open}${c.failed ? `，不通过 ${c.failed}` : ''}${c.errors ? `，错误 ${c.errors}（有错误先回模型师改，不判）` : ''}`)
    for (const j of report.judgments.filter((x) => !x.verdict)) {
      const id = judgeId(j)
      const had = items.get(id)
      if (had) { had.slices.push(slice); continue }
      const { verdict, confidence, reason, on, ...rest } = j
      items.set(id, { id, slices: [slice], ...rest, verdict: null, confidence: null, reason: '' })
    }
  }
  const list = [...items.values()]
  const checks = new Set(list.map((x) => x.check))
  const anyReport = reportFiles(reportsDir, direction).find(({ report }) => report.guides)?.report
  const guides = Object.fromEntries(Object.entries(anyReport?.guides ?? {}).filter(([k]) => checks.has(k)))
  fs.writeFileSync(pf, JSON.stringify({ direction: Number(direction), at: new Date().toISOString(), code: codebase ?? null, slices, guides, items: list }, null, 2) + '\n')
  console.log(`${slices.length} 段跑过校验：\n${lines.join('\n')}`)
  console.log(`去重后没判的 ${list.length} 条 → ${path.relative(process.cwd(), pf)}${list.length ? '' : '（没有要判的，不用派审查）'}`)
  process.exit(0)
}

if (cmd === 'apply') {
  if (!fs.existsSync(pf)) { console.error(`没有待判单子：${pf}，先跑 pending`); process.exit(2) }
  const sheet = JSON.parse(fs.readFileSync(pf, 'utf8'))
  const filled = sheet.items.filter((x) => x.verdict)
  const bad = filled.filter((x) => !['pass', 'fail'].includes(x.verdict) || !['high', 'medium', 'low'].includes(x.confidence) || !String(x.reason ?? '').trim())
  if (bad.length) { console.error(`单子上有 ${bad.length} 条填得不全（verdict 是 pass/fail、confidence 是 high/medium/low、reason 不空）：${bad.map((x) => x.id).join('、')}`); process.exit(1) }
  const changed = sheet.items.filter((x) => judgeId(x) !== x.id)
  if (changed.length) { console.error(`单子上有 ${changed.length} 条原文被改过（只许填 verdict、confidence、reason）：${changed.map((x) => x.id).join('、')}`); process.exit(1) }
  const lines = []
  let open = 0, failed = 0
  for (const { slice, report } of validateSlices(sheet.slices, sheet.code)) {
    if (!report) { lines.push(`  ${slice}：没有报告`); continue }
    const c = count(report)
    open += c.open; failed += c.failed
    lines.push(`  ${slice}：没判 ${c.open}，不通过 ${c.failed}${c.errors ? `，错误 ${c.errors}` : ''} → ${report.conclusion === 'clean' ? '干净' : '没干净'}`)
  }
  console.log(`单子上 ${sheet.items.length} 条，填了 ${filled.length} 条（不通过 ${filled.filter((x) => x.verdict === 'fail').length}）；各段接过以后：\n${lines.join('\n')}`)
  for (const x of filled.filter((x) => x.verdict === 'fail')) console.log(`  不通过 ${x.target}［${x.check}］（${x.slices.join('、')}）：${x.reason}`)
  if (filled.length < sheet.items.length) console.log(`还有 ${sheet.items.length - filled.length} 条没填`)
  process.exitCode = open || failed ? 1 : 0
}
