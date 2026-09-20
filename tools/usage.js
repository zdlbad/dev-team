#!/usr/bin/env node
/**
 * 量用量：一段会话里，开发指挥自己花了多少、每趟角色花了多少、上下文是怎么长起来的。
 *
 * 用法：
 *   node tools/usage.js                      最近动过的那一段会话
 *   node tools/usage.js --列                 列出能量的会话（按时间倒序）
 *   node tools/usage.js <会话id>             指定一段
 *   node tools/usage.js --细 <角色趟次序号>    那一趟每轮调了什么工具、上下文多大（找白烧的轮次用）
 *   node tools/usage.js --读 [<会话id>]      那一段里每趟角色的工具输出排行：谁把什么读进了上下文
 *
 * 账怎么算（每一轮把全部上下文再送一遍，所以「轮数 × 每轮上下文」才是账）：
 *   上下文 = input + cache_read + cache_creation      每一轮实际送进去的
 *   折算   = input + cache_read×0.1 + cache_creation×1.25 + output×5
 *            按 Opus 的定价比例折成「相当于多少新写进去的 token」，缓存命中只按一折算
 *
 * 数据在 ~/.claude/projects/<项目slug>/：
 *   <会话id>.jsonl                      开发指挥自己这一条线
 *   <会话id>/subagents/agent-<id>.jsonl 每趟角色各一份（meta.json 里有派工时写的那句描述）
 * 只读，不写任何东西。
 *
 * 由来：2026-09-20 第一百七十六批。项目所有者问「查一下这期间的 token 用量」，又问「是否在给某个
 * 模块建模时加载了超出模型范围的上下文」。为了回答现写了三个一次性脚本；量出来的三笔账——开场 35K
 * 地板、读派工书花 8 轮、轮数乘每轮重送——后来变成第一百七十六、一百七十七、一百七十八批的规矩。
 * 规矩省没省得能量，所以把脚本做成工具（第一百七十九批）。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(os.homedir(), '.claude', 'projects')
const args = process.argv.slice(2)
const die = (m) => { console.error(m); process.exit(2) }
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }

/** 所有能量的会话：<项目slug>/<会话id>.jsonl，按最后写入时间倒序 */
function sessions() {
  if (!fs.existsSync(ROOT)) die(`没有 ${ROOT}——这台机器上没有可量的会话记录`)
  const out = []
  for (const slug of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, slug)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith('.jsonl')) continue
      const p = path.join(dir, fn)
      out.push({ slug, id: fn.replace(/\.jsonl$/, ''), file: p, at: fs.statSync(p).mtime })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** 一份转录里每一轮送进去多少、吐出来多少 */
function rounds(file) {
  const out = []
  let first = null, last = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.timestamp) { first = first ?? r.timestamp; last = r.timestamp }
    const u = r.message?.usage
    if (!u || r.type !== 'assistant') continue
    const tools = (r.message.content ?? []).filter((c) => c.type === 'tool_use')
    out.push({
      ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      tools: tools.map((c) => ({ name: c.name, arg: String(c.input?.file_path ?? c.input?.command ?? c.input?.pattern ?? c.input?.path ?? JSON.stringify(c.input ?? {})).replace(/\s+/g, ' ').slice(0, 110) })),
      thinking: (r.message.content ?? []).some((c) => c.type === 'thinking'),
    })
  }
  return { rs: out, first, last }
}

const sum = (rs, k) => rs.reduce((a, b) => a + b[k], 0)
const weigh = (rs) => sum(rs, 'input') + sum(rs, 'cacheRead') * 0.1 + sum(rs, 'cacheWrite') * 1.25 + sum(rs, 'out') * 5
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)))
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—')
const ymd = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '—')

/** 一段会话里的每趟角色：转录 + 派工时写的那句描述 */
function agentsOf(sess) {
  const dir = path.join(path.dirname(sess.file), sess.id, 'subagents')
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const fn of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const id = fn.replace(/^agent-|\.jsonl$/g, '')
    let label = id
    try { label = JSON.parse(fs.readFileSync(path.join(dir, fn.replace(/\.jsonl$/, '.meta.json')), 'utf8')).description || id } catch {}
    out.push({ id, label, file: path.join(dir, fn), ...rounds(path.join(dir, fn)) })
  }
  return out.sort((a, b) => String(a.first).localeCompare(String(b.first)))
}

if (args.includes('--列')) {
  console.log('能量的会话（按最后写入时间倒序）：\n')
  for (const s of sessions().slice(0, 20)) {
    const n = fs.statSync(s.file).size
    console.log(`  ${s.at.toLocaleString('zh-CN', { hour12: false })}  ${String(Math.round(n / 1024 / 1024 * 10) / 10 + 'MB').padStart(7)}  ${s.id}  ${s.slug}`)
  }
  process.exit(0)
}

// 会话 id 就是那个不带 -- 的参数。`--细` 后面跟的是趟次号，不是会话，排掉；
// `--读` 后面跟的恰恰是会话 id（`--读 <会话id>`），从前连它一起排了，指定哪一段都回落到最近一段。
const want = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--细')
const all = sessions()
const sess = want ? all.find((s) => s.id === want) ?? die(`找不到会话 ${want}；--列 看有哪些`) : all[0]
const cmd = rounds(sess.file)
const agents = agentsOf(sess)

// ---------- --细：一趟角色每轮干了什么 ----------
const 细 = opt('--细')
if (细 !== null && args.includes('--细')) {
  const a = agents[Number(细) - 1] ?? die(`没有第 ${细} 趟；这一段有 ${agents.length} 趟`)
  console.log(`第 ${细} 趟　${a.label}　${hm(a.first)}–${hm(a.last)}　${a.rs.length} 轮\n`)
  console.log('  轮   上下文   干了什么')
  a.rs.forEach((r, i) => {
    const what = r.tools.length ? r.tools.map((t) => `${t.name}: ${t.arg}`).join(' ｜ ') : r.thinking ? '（想）' : '（说话）'
    console.log(`  ${String(i + 1).padStart(3)}  ${fmt(r.ctx).padStart(6)}   ${what.slice(0, 96)}`)
  })
  console.log(`\n  合计上下文 ${fmt(sum(a.rs, 'ctx'))}；一轮就是把之前的全部再送一遍，所以白烧的轮次直接乘在账上。`)
  process.exit(0)
}

// ---------- --读：每趟把什么读进了上下文 ----------
if (args.includes('--读')) {
  console.log(`${ymd(cmd.first)} ${hm(cmd.first)}–${hm(cmd.last)}　每趟角色的工具输出排行（谁把什么读进了上下文）\n`)
  for (const [i, a] of agents.entries()) {
    // 工具结果的大小要从 user 那一侧的 tool_result 取
    const pending = new Map(), results = []
    for (const line of fs.readFileSync(a.file, 'utf8').split('\n')) {
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      if (r.type === 'assistant') for (const c of r.message?.content ?? []) if (c.type === 'tool_use') pending.set(c.id, { name: c.name, arg: String(c.input?.file_path ?? c.input?.command ?? JSON.stringify(c.input ?? {})).replace(/\s+/g, ' ').slice(0, 96) })
      if (r.type === 'user' && Array.isArray(r.message?.content)) for (const c of r.message.content) {
        if (c.type !== 'tool_result') continue
        const t = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('')
        results.push({ ...(pending.get(c.tool_use_id) ?? { name: '?', arg: '' }), chars: (t ?? '').length })
      }
    }
    const total = results.reduce((x, y) => x + y.chars, 0)
    console.log(`  ${i + 1}. ${a.label}　${a.rs.length} 轮 · 工具吐回来合计 ${fmt(total)} 字`)
    for (const t of [...results].sort((x, y) => y.chars - x.chars).slice(0, 5)) console.log(`       ${String(t.chars).padStart(6)} 字  ${t.name}  ${t.arg.slice(0, 80)}`)
  }
  process.exit(0)
}

// ---------- 缺省：这一段会话的总账 ----------
console.log(`会话 ${sess.id}（${sess.slug}）`)
console.log(`${ymd(cmd.first)}　${hm(cmd.first)} – ${hm(cmd.last)}\n`)

const line = (name, rs, pad = 24) => {
  const ctx = sum(rs, 'ctx')
  console.log(`${name.padEnd(pad)}${String(rs.length).padStart(4)} 轮 ${String(rs.reduce((a, b) => a + b.tools.length, 0)).padStart(4)} 工具 · 上下文 ${fmt(ctx).padStart(6)} · 吐 ${fmt(sum(rs, 'out')).padStart(5)} · 第一轮 ${fmt(rs[0]?.ctx ?? 0).padStart(5)} → 末轮 ${fmt(rs[rs.length - 1]?.ctx ?? 0).padStart(6)} · 平均 ${fmt(ctx / Math.max(rs.length, 1))}`)
}
line('开发指挥（自己）', cmd.rs)
if (agents.length) {
  console.log('')
  agents.forEach((a, i) => line(`${i + 1}. ${a.label}`.slice(0, 24), a.rs))
}
const roleRs = agents.flatMap((a) => a.rs)
const T = sum(cmd.rs, 'ctx') + sum(roleRs, 'ctx')
const W = weigh(cmd.rs) + weigh(roleRs)
console.log(`
合计读进去 ${fmt(T)}：开发指挥 ${fmt(sum(cmd.rs, 'ctx'))}（${Math.round(sum(cmd.rs, 'ctx') / T * 100)}%）· 角色 ${agents.length} 趟 ${fmt(sum(roleRs, 'ctx'))}（${Math.round(sum(roleRs, 'ctx') / T * 100)}%）
合计吐出来 ${fmt(sum(cmd.rs, 'out') + sum(roleRs, 'out'))}
折算 ${fmt(W)}（缓存命中×0.1、建缓存×1.25、输出×5）：开发指挥 ${Math.round(weigh(cmd.rs) / W * 100)}% · 角色 ${Math.round(weigh(roleRs) / W * 100)}%

看一趟是怎么烧掉的：node tools/usage.js --细 <趟次序号>
看一趟读了什么：    node tools/usage.js --读`)
