const authRepository = require('../repositories/auth-repository.js')
function feedbackEntry(storage, kind, question) {
  const query = kind === 'course' ? 'kind=course&compose=1' : question ? `kind=question&compose=1&questionId=${encodeURIComponent(question.id)}&revisionId=${encodeURIComponent(question.revisionId || '')}` : ''
  const url = `/page/feedback/index${query ? `?${query}` : ''}`
  return { command: { type: 'navigate', url: authRepository.getAuth(storage).token ? url : '/page/login/index' } }
}
module.exports = { feedbackEntry }
