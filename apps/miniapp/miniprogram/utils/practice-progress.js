function mergeAnswerMaps(maps) {
  const merged = {}

  ;(maps || []).forEach((map) => {
    if (!map || typeof map !== 'object') {
      return
    }

    Object.keys(map).forEach((questionId) => {
      merged[questionId] = map[questionId]
    })
  })

  return merged
}

function summarizeAnswers(answers, total) {
  const questionIds = Object.keys(answers || {})
  const answered = questionIds.length
  const correct = questionIds.reduce((sum, questionId) => sum + (answers[questionId] === 1 ? 1 : 0), 0)
  const totalCount = Number(total) || answered
  const wrong = questionIds.filter(id => answers[id] === 0).length
  const objectiveAnswered = correct + wrong
  // 正确率按"已做题目"计算，未做的不拉低正确率
  const accuracy = objectiveAnswered ? Math.round((correct / objectiveAnswered) * 100) : null
  // 进度按"已做 / 总题量"计算，反映掌握范围
  const progressPercent = totalCount ? Math.min(Math.round((answered / totalCount) * 100), 100) : 0

  return {
    total: totalCount,
    answered,
    correct,
    wrong,
    accuracy,
    accuracyText: accuracy === null ? '—' : `${accuracy}%`,
    progressPercent,
    answeredText: `${answered} / ${totalCount}`,
    hasProgress: answered > 0,
    totalText: `${totalCount} 题`
  }
}

function collectAnswerMaps(progress, scopeKeys) {
  return (scopeKeys || [])
    .map((scopeKey) => {
      const entry = progress[scopeKey]
      return entry ? entry.answers : null
    })
    .filter(Boolean)
}

/**
 * 汇总一个科目下的所有题库进度。
 * @param {object} progress 已规范化的进度表
 * @param {object} subject 科目（需含 banks 与 questionCount）
 */
function summarizeSubjectProgress(progress, subject) {
  if (!subject) {
    return summarizeAnswers({}, 0)
  }
  if (subject.progress) return summarizeCounts(subject.progress, subject.questionCount)

  const bankIds = (subject.banks || []).map((bank) => bank.id)
  // 科目自身的 scope（整科抽题 / 模拟测试）也并入，题目 id 天然去重
  const maps = collectAnswerMaps(progress, bankIds.concat([subject.id]))

  return summarizeAnswers(mergeAnswerMaps(maps), subject.questionCount)
}

function summarizeBankProgress(progress, bank) {
  if (!bank) {
    return summarizeAnswers({}, 0)
  }

  const entry = progress[bank.id]
  if (bank.progress || entry && typeof entry.answeredCount === 'number') return summarizeCounts(bank.progress || entry, bank.questionCount)
  return summarizeAnswers(entry ? entry.answers : {}, bank.questionCount)
}

function summarizeCounts(counts, total) {
  const answered = Number(counts.answeredCount) || 0
  const correct = Number(counts.correctCount) || 0
  const objectiveAnswered = correct + (Number(counts.wrongCount) || 0)
  const accuracy = objectiveAnswered ? Math.round(correct / objectiveAnswered * 100) : null
  return { total, answered, correct, wrong: Number(counts.wrongCount) || 0, accuracy, accuracyText: accuracy === null ? '—' : `${accuracy}%`,
    progressPercent: total ? Math.min(100, Math.round(answered / total * 100)) : 0,
    answeredText: `${answered} / ${total}`, hasProgress: answered > 0, totalText: `${total} 题` }
}

/**
 * 汇总全部科目进度（多科目间按题目 id 去重）。
 * @param {object} progress 已规范化的进度表
 * @param {Array} subjects 科目列表，每项需含 banks 与 questionCount
 */
function summarizeOverallProgress(progress, subjects) {
  const scopeKeys = []
  let total = 0

  ;(subjects || []).forEach((subject) => {
    total += Number(subject.questionCount) || 0
    ;(subject.banks || []).forEach((bank) => scopeKeys.push(bank.id))
    scopeKeys.push(subject.id)
  })

  return summarizeAnswers(mergeAnswerMaps(collectAnswerMaps(progress, scopeKeys)), total)
}

/**
 * 从一次交卷结果构造写入用的题目记录。
 * @param {Array} questions 本次练习的题目
 * @param {Array} answers 与 questions 同序的作答数组
 */
module.exports = {
  mergeAnswerMaps,
  summarizeAnswers,
  summarizeBankProgress,
  summarizeOverallProgress,
  summarizeSubjectProgress
}
