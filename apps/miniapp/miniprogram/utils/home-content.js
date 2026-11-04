/**
 * 首页文案：纯计算模块，不依赖微信 API，便于在 Node 中直接测试。
 *
 * 首页三段文案都由当前学习状态推导，而不是写死：
 *   1. 问候语   —— 按设备本地时间落在哪个时段
 *   2. 横幅建议 —— 按「有没有错题 / 有没有进度 / 是否全新用户」给一句具体的话
 *   3. 公告条   —— 同源规则，但额外带一个可直达的入口
 *
 * 这样首页对新用户、练了一半的人、错题堆积的人是三种不同的口径，
 * 而不是对所有人说同一句「欢迎使用」。
 */

const { getDailyQuote } = require('./daily-quotes.js')

const TIP_ACTIONS = {
  BANK: 'bank',
  STATS: 'stats',
  WRONG_BOOK: 'wrongBook'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 相邻时段使用左闭右开区间，23:00 至次日 05:00 显示夜间问候。
const PERIODS = [
  { from: 5, to: 11, text: '早上好' },
  { from: 11, to: 13, text: '中午好' },
  { from: 13, to: 18, text: '下午好' },
  { from: 18, to: 23, text: '晚上好' }
]

/**
 * 封面图时段：早 / 中 / 晚 三张。
 *
 * 边界刻意和 PERIODS 不完全对齐 —— 图只有三张，而问候语有五档。
 * 所以「中午好 + 下午好」共用正午图（11~18），「晚上好 + 夜深了」共用黄昏图（18~次日 5）。
 * 两处都用同一份 hour，别在这里重算一遍时间，否则 18 点整会出现「说晚上好、却显示正午图」。
 */
const COVER_BY_DAY_PART = {
  morning: '/assets/home/cover-morning.jpg',
  noon: '/assets/home/cover-noon.jpg',
  evening: '/assets/home/cover-evening.jpg'
}

function toTimestamp(timestamp) {
  const time = Number(timestamp)

  return Number.isFinite(time) && time > 0 ? time : Date.now()
}

function getGreetingText(timestamp) {
  const hour = new Date(toTimestamp(timestamp)).getHours()
  const matched = PERIODS.find((period) => hour >= period.from && hour < period.to)

  // 23:00 - 05:00 都不在 PERIODS 里，落到这句
  return matched ? matched.text : '夜深了'
}

function getDateText(timestamp) {
  const date = new Date(toTimestamp(timestamp))

  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${WEEKDAYS[date.getDay()]}`
}

/** 封面时段：05–11 时为早间，11–18 时为午间，其余为晚间。 */
function getDayPart(timestamp) {
  const hour = new Date(toTimestamp(timestamp)).getHours()

  if (hour >= 5 && hour < 11) {
    return 'morning'
  }

  if (hour >= 11 && hour < 18) {
    return 'noon'
  }

  return 'evening'
}

function getCoverImage(timestamp) {
  return COVER_BY_DAY_PART[getDayPart(timestamp)]
}

/**
 * 横幅副标题：给一句和当前状态对得上的建议。
 * @param {object} summary { pendingWrong, answered, accuracyText }
 */
function getGreetingAdvice(summary) {
  const stats = summary || {}
  const pendingWrong = Math.max(Number(stats.pendingWrong) || 0, 0)
  const answered = Math.max(Number(stats.answered) || 0, 0)

  if (pendingWrong > 0) {
    return `还有 ${pendingWrong} 道错题待复习，从熟悉的一题开始。`
  }

  if (answered > 0) {
    return `已经做了 ${answered} 题，正确率 ${stats.accuracyText || '0%'}，保持这个节奏。`
  }

  return '挑一个科目，先做 10 道题找找感觉。'
}

/**
 * 公告条：一条可点击直达的行动提示。
 * @param {object} summary { pendingWrong, masteredWrong, answered, total }
 * @returns {object} { key, tag, text, detail, actionText, action }
 */
function buildHomeTip(summary) {
  const stats = summary || {}
  const pendingWrong = Math.max(Number(stats.pendingWrong) || 0, 0)
  const masteredWrong = Math.max(Number(stats.masteredWrong) || 0, 0)
  const answered = Math.max(Number(stats.answered) || 0, 0)
  const total = Math.max(Number(stats.total) || 0, 0)

  if (pendingWrong > 0) {
    return {
      key: 'wrong-pending',
      tag: '待复习',
      text: `错题本里还有 ${pendingWrong} 道题待复习。`,
      detail:
        `你有 ${pendingWrong} 道错题待复习。开启自动收集后，正式练习中答错的客观题会加入错题本。\n\n` +
        '复习答对后，该题会移出待复习列表。主观题可在交卷后自评为“掌握”或“待复习”。' +
        (masteredWrong > 0 ? `已有 ${masteredWrong} 道错题复习后答对。` : ''),
      actionText: '去复习',
      action: TIP_ACTIONS.WRONG_BOOK
    }
  }

  if (answered > 0) {
    if (stats.coverageKnown === false) return {
      key: 'keep-going', tag: '进行中', text: `累计练习过 ${answered} 道题，继续巩固知识。`,
      detail: `学习记录保留了 ${answered} 道题的作答。当前范围有 ${total} 道可练题目，可以按课程选择下一次练习。`,
      actionText: '去刷题', action: TIP_ACTIONS.BANK
    }
    const remaining = Math.max(total - answered, 0)

    return {
      key: 'keep-going',
      tag: '进行中',
      text: remaining > 0
        ? `已完成 ${answered} 题，还剩 ${remaining} 题没做过。`
        : '所有题目都做过了，可以随机抽题巩固一遍。',
      detail: remaining > 0
        ? `你已经完成 ${answered} 题，题库还剩 ${remaining} 题没有做过。\n\n` +
          '选择一个科目，继续未完成的部分，或回顾之前的错题。'
        : `题库里的 ${total} 道题你都做过了。\n\n` +
          '可以用随机练习打散题目顺序，再检查一次掌握情况；' +
          '也可以去错题本复习尚未掌握的题目。',
      actionText: '去刷题',
      action: TIP_ACTIONS.BANK
    }
  }

  return {
    key: 'fresh-start',
    tag: '开始学习',
    text: total ? `${total} 道题可供练习，选择一个科目开始。` : '题库正在整理，稍后再来看看。',
    detail:
      `当前可练习 ${total} 道题，可在题库中按科目查看。\n\n` +
      '每个科目都提供背题、顺序、随机三种练习方式：背题模式直接显示答案，适合第一遍过知识点；' +
      '顺序与随机模式按答题偏好显示判定和解析。登录后同步正式学习记录，游客可在本机试答两次。',
    actionText: '去刷题',
    action: TIP_ACTIONS.BANK
  }
}

/**
 * 首页文案总入口。
 * @param {object} summary 学习状态汇总
 * @param {number} timestamp 可选，便于测试固定时间
 */
function buildHomeContent(summary, timestamp) {
  const time = toTimestamp(timestamp)
  const dayPart = getDayPart(time)

  return {
    greeting: getGreetingText(time),
    dateText: getDateText(time),
    // 倒计时卡底图跟着时段走：早/中/晚三张，切 tab 回来时 onShow 会重算
    dayPart,
    coverImage: COVER_BY_DAY_PART[dayPart],
    advice: getGreetingAdvice(summary),
    // 每日一句：按当天日期取值，同一天稳定、次日自动更换
    quote: getDailyQuote(time).text,
    tip: buildHomeTip(summary)
  }
}

module.exports = {
  TIP_ACTIONS,
  WEEKDAYS,
  COVER_BY_DAY_PART,
  buildHomeContent,
  buildHomeTip,
  getCoverImage,
  getDateText,
  getDayPart,
  getGreetingAdvice,
  getGreetingText
}
