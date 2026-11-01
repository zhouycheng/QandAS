function gradeBlanks(question, values) {
  const blanks = question.blanks || []
  const match = question.blankMatch || {}
  const normalize = value => {
    let text = String(value == null ? '' : value)
    if (match.trimWhitespace !== false) text = text.trim()
    return match.ignoreCase === false ? text : text.toLowerCase()
  }
  return blanks.length > 0 && Array.isArray(values) && values.length === blanks.length &&
    blanks.every((blank, index) => (blank.answers || []).some(answer => normalize(answer) === normalize(values[index])))
}
function blankAnswerText(question) {
  return (question.blanks || []).map((blank, index) => `第 ${index + 1} 空：${(blank.answers || []).join(' / ')}`).join('\n')
}
module.exports = { gradeBlanks, blankAnswerText }
