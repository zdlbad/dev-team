#!/usr/bin/env node
/**
 * 状态看板。依据 SKILL.md「开发指挥」：从 slices/、reports/、decisions[] 算出每个切片走到哪、卡在哪。
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
/** 这一步该谁动手：人自己拍板，还是某个角色（团队）干活，还是路由跑个命令 */
const WHO = {
  人: { side: '等你', hint: '要你拍板或走一遍，别人替不了' },
  路由: { side: '等机器', hint: '跑个命令就行，不用你动手' },
  业务分析: { side: '等团队', hint: '' },
  讲解: { side: '等团队', hint: '' },
  模型师: { side: '等团队', hint: '' },
  原型: { side: '等团队', hint: '' },
  接口: { side: '等团队', hint: '' },
  编码: { side: '等团队', hint: '' },
  模型校验: { side: '等团队', hint: '' },
  'pre-pr 审查': { side: '等团队', hint: '' },
  '文职': { side: '等团队', hint: '' },
  解读: { side: '等团队', hint: '' },
}
function sideOf(role) {
  for (const k of Object.keys(WHO)) if (String(role).startsWith(k)) return WHO[k].side
  return '等团队'
}
/** 这条切片此刻有几件事在等人：没裁的卡、没答的题、没审的判断 */
function pendingForHuman(id) {
  const out = []
  const sp = path.join(root, 'slices', `${id}.story.json`)
  if (fs.existsSync(sp)) {
    try {
      const st = JSON.parse(fs.readFileSync(sp, 'utf8'))
      const voided = (c) => c.ruling?.choice === '作废' || /^本卡作废/.test(c.ruling?.note ?? '')
      const cards = (st.choices ?? []).filter((c) => !c.ruling && !voided(c)).length
      const quiz = (st.steps ?? []).filter((s) => s.quiz && !s.human).length
      const unreviewed = (st.steps ?? []).filter((s) => !s.review).length
      if (cards) out.push(`${cards} 张卡没裁`)
      if (quiz) out.push(`${quiz} 道题没答`)
      if (unreviewed) out.push(`${unreviewed} 步没审`)
    } catch {}
  }
  for (const d of [1, 2]) {
    const rp = path.join(root, 'reports', `validate-${d}.json`)
    if (!fs.existsSync(rp)) continue
    try {
      const r = JSON.parse(fs.readFileSync(rp, 'utf8'))
      if (r.slice && r.slice !== id) continue
      const n = [...(r.judgments ?? []).filter((x) => x.verdict), ...(r.confirms ?? [])].filter((x) => !x.human?.verdict).length
      if (n) out.push(`校验 ${d} 有 ${n} 条没审`)
    } catch {}
  }
  const pp = path.join(root, 'plans', `${id}.json`)
  if (fs.existsSync(pp)) {
    try {
      const p = JSON.parse(fs.readFileSync(pp, 'utf8'))
      if (!p.confirmedAt) out.push('编码计划没确认')
    } catch {}
  }
  return out
}
/** 这条切片上一次有动静是哪天、距今多少天 */
function idleDays(lastTs) {
  if (!lastTs) return null
  const d = Math.round((Date.now() - new Date(lastTs + 'T00:00:00').getTime()) / 86400000)
  return Number.isFinite(d) ? Math.max(0, d) : null
}
const rows = (slices ?? [])
  .map((s) => s.data)
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((s) => {
    // 三个阶段都 done 不等于这条切片走完了：后面还有 pre-pr 审查与人在原型上走一遍。
    // 一律问 slice next——它自己会在真走完时说「切片完成，合并」。
    const n = s.archived ? { role: '—', action: '已归档：' + s.archived.reason } : nextOf(s.id)
    const lastLog = s.log[s.log.length - 1]
    const idle = idleDays(lastLog?.ts)
    const pending = s.archived ? [] : pendingForHuman(s.id)
    return { pending, archived: !!s.archived, id: s.id, title: s.title, kind: ({ initial: '大切片', increment: '小切片', story: '建模', implementation: '实现', refactor: '改说法' })[s.kind] ?? s.kind, model: STATUS[s.stages.model.status], code: STATUS[s.stages.code.status], validate: STATUS[s.stages.validate.status], role: n.role, side: s.archived ? '已归档' : sideOf(n.role), action: n.action, why: n.why ?? '', idle, next: `${n.role}：${n.action}`, command: n.command, last: lastLog ? `${lastLog.ts} ${lastLog.text}` : '' }
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

// ---------- 现场（scene set 写的，不是算出来的）----------
// 状态看板算的是「走到哪」，现场写的是「此刻谁在干什么」；两块板子人只开一页，所以现场也摆在这里。
const scenePath = path.join(root, 'reports', '_scene.json')
const scene = fs.existsSync(scenePath) ? JSON.parse(fs.readFileSync(scenePath, 'utf8')) : null
const hhmm = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
L.push('', '## 现场', '')
if (!scene || !scene.step) L.push('（还没写过现场：开发指挥每个动作之前 `scene set`）')
else {
  const who = scene.who === '人' ? '**等你**' : `${scene.who} 在做`
  L.push(`- **此刻**（${hhmm(scene.updatedAt)} 本机时间）：${scene.slice ?? ''}${scene.phase ? ` · ${scene.phase}` : ''} — ${who}：${scene.step}${scene.note ? `（${scene.note}）` : ''}`)
  const os = require('node:os')
  if (scene.machine && scene.machine !== os.hostname()) L.push(`- **现场上一次是在另一台机器（${scene.machine}）写的**——先 \`git pull\`，不然看到的是旧的`)
  const tl = (scene.timeline ?? []).slice(-6).reverse()
  if (tl.length) {
    L.push('- 最近几步（新的在上）：')
    for (const e of tl) L.push(`  - ${hhmm(e.ts)}　${e.who ?? '—'}${e.done ? '（完）' : ''}　${e.step}${e.note ? `（${e.note}）` : ''}`)
  }
}
L.push('', '## 谁在做什么', '')
const live = rows.filter((r) => !r.archived)
if (!live.length) L.push('（没有在推进的切片）')
else {
  const waitingYou = live.filter((r) => r.side === '等你' || r.pending.length)
  L.push(waitingYou.length ? `**${waitingYou.length} 条在等你**：${waitingYou.map((r) => `${r.id}（${r.side === '等你' ? r.action : r.pending.join('、')}）`).join('；')}` : '**没有一条在等你**——都在团队或机器手上。')
  L.push('')
  L.push(...table(['切片', '在等谁', '该谁上场', '要做的事', '另外还等你', '几天没动'], live.map((r) => [
    r.id,
    r.side,
    r.role,
    r.action,
    r.pending.length ? r.pending.join('、') : '—',
    r.idle == null ? '—' : r.idle === 0 ? '今天动过' : `${r.idle} 天`,
  ])))
}
const archived = rows.filter((r) => r.archived)
if (archived.length) L.push('', archived.map((r) => `（${r.id} ${r.action}）`).join(' '))
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
