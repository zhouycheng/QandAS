/** 每日练习提示按日期轮换，同一天保持一致。 */

const QUOTES = [
  '先做一道题，看看今天的状态。',
  '把题干读完整，再看选项。',
  '答完以后，试着说清楚理由。',
  '拿不准的题，可以先标记。',
  '今天先复习昨天做错的一题。',
  '记住答案后，再问一次为什么。',
  '把容易混淆的知识点放在一起比较。',
  '做完一组题，给自己留一点休息时间。',
  '从熟悉的章节开始，慢慢进入状态。',
  '一道题卡住时，可以先换一题。',
  '看解析前，先回想自己的思路。',
  '把长题干里的条件逐个圈出来。',
  '试着用自己的话解释这个知识点。',
  '把今天的练习分成几小组。',
  '答对的题，也可以再看一眼解析。',
  '给难题留个标记，之后回来复习。',
  '复习时，先回想，再翻看答案。',
  '选一个科目，完成今天的一小段。',
  '记不清的地方，正好值得再看一次。',
  '做题累了，就停下来活动一下。',
  '先检查已知条件，再开始计算。',
  '将相近的概念分别举一个例子。',
  '看看这次和上次是否错在同一个地方。',
  '学完一节，用几道题检查一下。',
  '把复杂的问题拆成几步。',
  '写下推导过程，方便回头检查。',
  '找到出错的那一步，再重做一次。',
  '今天的练习，按自己的节奏来。',
  '遇到生词，先结合上下文理解。',
  '主观题可以先列要点，再组织答案。',
  '复习一遍以后，试着合上资料回想。',
  '先完成眼前这一题。',
  '填空时，留意单位和大小写。',
  '检查多选题有没有漏掉的选项。',
  '睡前可以回想今天学到的一个知识点。',
  '做完练习，看看哪些题需要再复习。'
]

function toTimestamp(timestamp) {
  const time = Number(timestamp)

  return Number.isFinite(time) && time > 0 ? time : Date.now()
}

/**
 * 一年中的第几天（1 月 1 日返回 1）。
 * 用本地时间计算，和用户看到的「日期」保持一致。
 */
function getDayOfYear(timestamp) {
  const date = new Date(toTimestamp(timestamp))
  const startOfYear = new Date(date.getFullYear(), 0, 0)

  return Math.floor((date.getTime() - startOfYear.getTime()) / 86400000)
}

/**
 * 取今日语录。
 * @returns {{ text: string, index: number, total: number }}
 */
function getDailyQuote(timestamp) {
  const dayOfYear = getDayOfYear(timestamp)
  const index = dayOfYear % QUOTES.length

  return {
    text: QUOTES[index],
    index,
    total: QUOTES.length
  }
}

module.exports = {
  QUOTES,
  getDailyQuote,
  getDayOfYear
}
