/**
 * 聚合设计这一关：故事、关系、聚合设计都定下了，场景的模型才开工；
 * 模型里有、聚合设计里没有的聚合，退回聚合设计补上。slice next 与工作台的待办都照它。
 * 上游有没定的，下游照着它建，回头还得跟着改。
 */
const { readDesigns, readStories, readRelations } = require('../../ui/server')
const { loadModel } = require('./project')

const unsettled = (list) => list.filter((x) => x.state !== '已定')
const label = (x, key) => x.data?.[key] ?? x.file
/** 名单太长只列前几个 */
const names = (a) => (a.length > 6 ? `${a.slice(0, 5).join('、')} 等 ${a.length} 份` : a.join('、'))

/** 眼下这一关卡在哪：{ stories, relations, designs, missing }，各是还没定下（或没设计）的名字 */
function designState(root) {
  const designs = readDesigns(root)
  const designed = new Set(designs.map((d) => d.data?.aggregate).filter(Boolean))
  const missing = []
  for (const e of loadModel(root).elements) {
    const name = e.kind === 'aggregate-root' && e.data?.name
    if (name && !designed.has(name) && !missing.includes(name)) missing.push(name)
  }
  return {
    stories: unsettled(readStories(root)).map((x) => label(x, 'title')),
    relations: unsettled(readRelations(root)).map((x) => label(x, 'title')),
    designs: unsettled(designs).map((x) => label(x, 'aggregate')),
    designCount: designs.length,
    missing,
  }
}

/** 下一步该谁做什么；这一关过了返回 null */
function designGate(root) {
  const s = designState(root)
  if (s.stories.length || s.relations.length) {
    const what = [s.stories.length && `故事页的 ${names(s.stories)}`, s.relations.length && `关系页的 ${names(s.relations)}`].filter(Boolean).join('，')
    return { who: '人', what: `在工作台看${what}，对了按「定下」；改过的要重按` }
  }
  if (!s.designCount) return { who: '模型师', what: '照故事、关系与概念卡的「它的一生」整理聚合设计，一个聚合一份 aggregate-design/<聚合>.json；业务还没写这几样的，先派业务分析「写故事」「写关系」「写它的一生」', run: 'node tools/brief.js 模型师 --活 聚合设计' }
  if (s.missing.length) return { who: '模型师', what: `模型里有、聚合设计里没有：${names(s.missing)}。退回聚合设计补上（业务没写的先交回业务分析补），人定下再接着建模`, run: 'node tools/brief.js 模型师 --活 聚合设计' }
  if (s.designs.length) return { who: '人', what: `在工作台「聚合设计」页看 ${names(s.designs)}，对了按「定下」；改过的要重按` }
  return null
}

module.exports = { designState, designGate, names }
