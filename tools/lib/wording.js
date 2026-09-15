/**
 * 给人读的文字里，编号该是佐证不是主语（agents/common/wording.md「编号是佐证，不是主语」）。
 * 这里只量两件机械的事，量出来就提醒写的人重写；改字是写的人的活，不派文职（2026-09-15 项目所有者：「写的人自己改，工具提醒」）。
 *   1. 开头先有人话：一段话前 20 个字里就冒出编号、行号、批次，读的人还不知道在说什么毛病。
 *   2. 编号太密：一段话里编号、行号、「第 N 步」这类标记 4 个以上、每百字 2 个以上。
 * 由来：2026-09-15 s-003 pre-pr 第 D 角度那条——「两个用例把实现决定挂在业务编号下：AgreedPrice 测试 :73「[R-070]……」项目所有者：「这个解释里全都是标号 看不懂在说什么」。
 */
const MARK = /\[?[RGU]-\d{3,}\]?|(?<![\w.])s-\d{3,}\b|(?<!\d):\d{2,}\b|第\s?\d+\s?步|第[一二三四五六七八九十百零〇\d]+批|§\s?[\d.]+/g

function marks(text) { return String(text ?? '').match(MARK) ?? [] }

/** 返回提醒句的数组；空数组＝没毛病 */
function densityIssues(text) {
  const s = String(text ?? '').trim()
  if (!s) return []
  const out = []
  const head = s.slice(0, 20)
  if (MARK.test(head)) out.push('开头先用一句人话说清是什么毛病，编号、行号、批次放后面当佐证')
  MARK.lastIndex = 0
  // 佐证放在末尾括号里的不算：「……。（AgreedPrice 测试 :73 挂的 R-070、…）」正是规矩要的写法
  const body = s.replace(/[（(][^（）()]*[）)]\s*$/, '')
  const n = marks(body).length
  if (n >= 5 && n / (body.length / 100) >= 2.5) out.push(`编号太密（正文 ${n} 个标记 / ${body.length} 字）：读的人看不出在说什么，先说事，编号收进末尾的括号当佐证`)
  return out
}

module.exports = { densityIssues, marks }
