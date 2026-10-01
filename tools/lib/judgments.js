/**
 * 校验报告里的判断项：判断的键、按键取判过的结论。validate.js 与 judge.js 共用。
 *
 * 一条判断的键 = 目标、检查项、业务／模型／代码几栏原文，加上它在前端页面上的落点。键里没有切片：
 * 同一句话、同一份原文，在哪一段的报告里判过都一样，所以判过的结论跨段接——
 * 从前只在同一段里接，同一条在十八段的报告里各判一遍（2026-10-02）。原文任何一边变了，键就变了，照旧重判。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function judgeKey(x) {
  const pageOnModel = x.pageKey !== undefined && x.sides?.page === undefined
  const parts = [x.target, x.check, x.sides?.business ?? '', pageOnModel ? '' : x.sides?.model ?? '', x.sides?.code ?? '']
  if (x.pageKey !== undefined) parts.push(x.pageKey)
  return parts.join('\u0000')
}
/** 键的短号：待判单子上一条一个，写回时照它对 */
const judgeId = (x) => crypto.createHash('sha1').update(judgeKey(x)).digest('hex').slice(0, 12)

/** 这一方向的报告文件：现役的 validate-<方向>.json 与按切片存的 validate-<方向>.<切片>.json */
function reportFiles(reportsDir, direction) {
  if (!fs.existsSync(reportsDir)) return []
  const re = new RegExp(`^validate-${direction}(\\.[^.]+)?\\.json$`)
  const out = []
  for (const f of fs.readdirSync(reportsDir).filter((f) => re.test(f))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8'))
      if (String(r.direction) === String(direction)) out.push({ file: path.join(reportsDir, f), report: r })
    } catch {}
  }
  return out
}
/** 待判单子：开发指挥给审查的那一份，审查在上面填的判定也算一个来源 */
const pendingFile = (reportsDir, direction) => path.join(reportsDir, `待判-${direction}.json`)

/**
 * 这一方向判过的全部结论：键 → { verdict, confidence, reason, at }。
 * 来源是各段的报告与待判单子；同一条几处都判过，取后写的（报告按它的 at，单子按文件改动时刻）
 */
function knownVerdicts(reportsDir, direction) {
  const sources = reportFiles(reportsDir, direction).map(({ report }) => ({ at: String(report.at ?? ''), judgments: report.judgments ?? [] }))
  const pf = pendingFile(reportsDir, direction)
  if (fs.existsSync(pf)) {
    try { sources.push({ at: fs.statSync(pf).mtime.toISOString(), judgments: JSON.parse(fs.readFileSync(pf, 'utf8')).items ?? [] }) } catch {}
  }
  sources.sort((a, b) => a.at.localeCompare(b.at))
  const known = new Map()
  for (const s of sources) for (const j of s.judgments) {
    if (j.verdict) known.set(judgeKey(j), { verdict: j.verdict, confidence: j.confidence, reason: j.reason, at: s.at })
  }
  return known
}

module.exports = { judgeKey, judgeId, reportFiles, pendingFile, knownVerdicts }
