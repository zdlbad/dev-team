/**
 * 给人看的时间一律用本机时区（环境变量 DEV_TEAM_TZ 可另指定一个 IANA 时区名）：人认的是自己墙上的钟。
 *
 * 存进文件的还是 UTC 的 ISO 串（`new Date().toISOString()`）——两台机器、两个会话写同一份日志，
 * 只有一个绝对时刻不会错。这里只管**显示**：读出来是几点，就按本地的挂钟说几点。
 * 夏令时交给 Intl 按时区算，不自己加减小时。
 */
const TZ = process.env.DEV_TEAM_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const F = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const ZONE = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, timeZoneName: 'short' })

/** ISO 串（或 Date）拆成本地的年月日时分秒；认不出来的时间返回 null，调用处照原样显示 */
function parts(ts) {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const o = {}
  for (const p of F.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value
  if (o.hour === '24') o.hour = '00' // 有的 ICU 把午夜印成 24 点
  return o
}
const or = (ts, f) => { const p = parts(ts); return p ? f(p) : String(ts ?? '') }

/** 2026-09-17 */
const date = (ts) => or(ts, (p) => `${p.year}-${p.month}-${p.day}`)
/** 10:03:53 */
const hms = (ts) => or(ts, (p) => `${p.hour}:${p.minute}:${p.second}`)
/** 10:03 */
const hm = (ts) => or(ts, (p) => `${p.hour}:${p.minute}`)
/** 09-17 10:03 */
const mdhm = (ts) => or(ts, (p) => `${p.month}-${p.day} ${p.hour}:${p.minute}`)
/** 那个时刻本地时区的简称（比如 AEST、AEDT，夏令时那半年会变） */
const zone = (ts = new Date()) => (ZONE.formatToParts(ts instanceof Date ? ts : new Date(ts)).find((p) => p.type === 'timeZoneName') ?? {}).value ?? TZ

module.exports = { TZ, parts, date, hms, hm, mdhm, zone }
