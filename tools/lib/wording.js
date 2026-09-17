/**
 * 给人读的文字里，编号该是佐证不是主语（agents/common/wording.md「编号是佐证，不是主语」）。
 * 这里只量两件机械的事，量出来就提醒写的人重写；改字是写的人的活，不派文职（2026-09-15 项目所有者：「写的人自己改，工具提醒」）。
 *   1. 开头先有人话：一段话前 20 个字里就冒出编号、行号、批次，读的人还不知道在说什么毛病。
 *   2. 编号太密：一段话里编号、行号、「第 N 步」这类标记 4 个以上、每百字 2 个以上。
 *   3. 指路：「同第 N 步」「见第 N 步」「同上」——把那件事直接说出来，别让读的人自己回去翻。
 * 由来：2026-09-15 s-003 pre-pr 第 D 角度那条——「两个用例把实现决定挂在业务编号下：AgreedPrice 测试 :73「[R-070]……」项目所有者：「这个解释里全都是标号 看不懂在说什么」。
 * 第 3 条添于 2026-09-16：k-001 走查里三十处「同第 N 步」被文职清掉，可 walk 里剩的两处成了样板，模型师照着又写了两处。
 * 走查页与审阅页都是一条一条摆出来看的，指到别处那句话到这儿就断了——项目所有者在手机上读时尤其接不上。
 */
const MARK = /\[?[RGU]-\d{3,}\]?|(?<![\w.])s-\d{3,}\b|(?<!\d):\d{2,}\b|第\s?\d+\s?步|第[一二三四五六七八九十百零〇\d]+批|§\s?[\d.]+/g
/** 指路：把读的人支到别处去，而不是把事情说出来 */
const POINTER = /同第\s?\d+\s?步|见第\s?\d+\s?步|同上(?:一)?步?|如前所述|参见上文|见上文/g
/** 坏字：一个中文字写坏了，它那几个字节各成一个替换字符，屏幕上是一串「�」 */
const BROKEN = /�+/g

/**
 * 文字里的坏字，每处带前后十来个字，好让写的人照上下文把原字补回来。
 * 由来：2026-09-17 走查 k-002 里修掉七个（「行□无忧」「录□人」…），2026-09-18 改名时又扫出六个
 * （「欠乐□的」「护士助□」「HCP □用款」…）——两批都躲过了所有检查，因为当时一处都没查。
 */
function brokenChars(text) {
  const s = String(text ?? '')
  const out = []
  BROKEN.lastIndex = 0
  let m
  while ((m = BROKEN.exec(s))) {
    const ctx = s.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12).replace(/[\n\r]/g, '␊')
    out.push(`坏字：…${ctx}…　照上下文把原字补回来`)
  }
  return out
}

function marks(text) { return String(text ?? '').match(MARK) ?? [] }

/** 返回提醒句的数组；空数组＝没毛病 */
function densityIssues(text) {
  const s = String(text ?? '').trim()
  if (!s) return []
  const out = brokenChars(s)
  const head = s.slice(0, 20)
  if (MARK.test(head)) out.push('开头先用一句人话说清是什么毛病，编号、行号、批次放后面当佐证')
  MARK.lastIndex = 0
  // 佐证放在末尾括号里的不算：「……。（AgreedPrice 测试 :73 挂的 R-070、…）」正是规矩要的写法
  const body = s.replace(/[（(][^（）()]*[）)]\s*$/, '')
  const n = marks(body).length
  if (n >= 5 && n / (body.length / 100) >= 2.5) out.push(`编号太密（正文 ${n} 个标记 / ${body.length} 字）：读的人看不出在说什么，先说事，编号收进末尾的括号当佐证`)
  POINTER.lastIndex = 0
  const pointers = s.match(POINTER) ?? []
  if (pointers.length) out.push(`指路（${[...new Set(pointers)].join('、')}）：页面一条一条摆出来看，指到别处那句话到这儿就断了——把那件事直接说出来`)
  return out
}

module.exports = { densityIssues, marks, brokenChars }
