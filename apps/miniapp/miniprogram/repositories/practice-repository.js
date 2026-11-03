const remoteData = require('./remote-data-repository.js')
const authRepository = require('./auth-repository.js')
const preferenceRepository = require('./preference-repository.js')
const reminderRepository = require('./reminder-repository.js')
const { getFavoriteIds, hasFavorite } = require('../utils/favorites.js')
const { getPendingIds, getMasteredIds, summarizeWrongBook } = require('../utils/wrong-book.js')

module.exports = {
  getPreferences: preferenceRepository.getPreferences,
  savePreferences: preferenceRepository.savePreferences,
  updatePreferenceSwitch: preferenceRepository.updatePreferenceSwitch,
  updatePreferenceChoice: preferenceRepository.updatePreferenceChoice,
  updatePreferenceText: preferenceRepository.updatePreferenceText,
  resetPreferences: preferenceRepository.resetPreferences,
  getAuth: authRepository.getAuth,
  login: authRepository.login,
  loginWithEmail: authRepository.loginWithEmail,
  loginWithCode: authRepository.loginWithCode,
  registerAccount: authRepository.register,
  sendAuthCode: authRepository.sendCode,
  resetPassword: authRepository.resetPassword,
  logout: authRepository.logout,
  updateAuthProfile: authRepository.updateProfile,
  clearAuth: authRepository.clearAuth,
  getReminder: reminderRepository.getReminder,
  saveReminder: reminderRepository.saveReminder,
  updateReminderSwitch: reminderRepository.updateReminderSwitch,
  updateReminderTime: reminderRepository.updateReminderTime,
  updateReminderFrequency: reminderRepository.updateReminderFrequency,
  toggleAdvanceDay: reminderRepository.toggleAdvance,
  addReminderExam: reminderRepository.addReminderExam,
  removeReminderExam: reminderRepository.removeReminderExam,
  getFavoriteIds, hasFavorite, getPendingIds, getMasteredIds, summarizeWrongBook,
  addQuestionFavorite: remoteData.addQuestionFavorite,
  removeQuestionFavorite: remoteData.removeQuestionFavorite,
  getSubjectSummaries: remoteData.getSubjectSummaries,
  getSubjectDetail: remoteData.getSubjectDetail,
  getCatalogStats: remoteData.getCatalogStats,
  getBankQuiz: remoteData.getBankQuiz,
  getSubjectQuiz: remoteData.getSubjectQuiz,
  getQuestionIndex: remoteData.getQuestionIndex,
  findQuestionEntries: remoteData.findQuestionEntries,
  getFavorites: remoteData.getFavorites,
  getWrongBook: remoteData.getWrongBook,
  getDailyLog: remoteData.getDailyLog,
  getStudyTime: remoteData.getStudyTime,
  getProgress: remoteData.getProgress,
  getScopeMeta: remoteData.getScopeMeta,
  toggleQuestionFavorite: remoteData.toggleQuestionFavorite,
  removeQuestionFavorites: remoteData.removeQuestionFavorites,
  clearFavorites: remoteData.clearFavorites,
  removeWrongQuestions: remoteData.removeWrongQuestions,
}
module.exports.refreshRemote = remoteData.refresh
module.exports.isRemoteEnabled = remoteData.isEnabled
module.exports.getRemoteStatistics = remoteData.getStatistics
module.exports.getRemoteRecent = function (storage) {
  return !authRepository.getAuth(storage).loggedIn ? require('./trial-practice.js').recent(storage) : remoteData.getRecent(storage)
}
module.exports.getResumableSession = function (storage) {
  const auth = authRepository.getAuth(storage)
  const snapshot = !auth.loggedIn ? require('./trial-practice.js').resumable(storage) : storage.get(`qandaOnline:${auth.userId}:${storage.get(`qandaOnlineLast:${auth.userId}`) || ''}`)
  if (snapshot && snapshot.status === 'IN_PROGRESS' && !snapshot.viewCompleted) return Object.assign({}, snapshot.localState || {}, { sessionId: snapshot.id, config: snapshot.route })
  if (!auth.loggedIn) return null
  const overview = remoteData.getOverview(storage)
  const recentItems = overview && Object.prototype.hasOwnProperty.call(overview, 'recentSession')
    ? overview.recentSession ? [overview.recentSession] : []
    : remoteData.getRecent(storage)
  const recent = recentItems.find(item => {
    const local = storage.get(`qandaOnline:${auth.userId}:${item.id}`)
    return item.deviceId === storage.get('qandaDeviceId') && item.status === 'IN_PROGRESS' && (!local || local.status === 'IN_PROGRESS' && !local.viewCompleted)
  })
  return recent ? { sessionId: recent.id, config: { bankId: recent.questionBankId, title: recent.title } } : null
}
module.exports.getRemoteHistory = remoteData.getHistory
module.exports.getRemoteAnnouncements = remoteData.getAnnouncements
module.exports.getRemoteRecommendations = remoteData.getRecommendations
module.exports.getRemoteRecommendationPage = remoteData.getRecommendationPage
module.exports.loadRemoteRecommendations = remoteData.refreshRecommendations
module.exports.loadRemoteQuestion = remoteData.loadQuestion

module.exports.searchRemoteQuestions = remoteData.searchQuestions

module.exports.getRemoteOverview = remoteData.getOverview
module.exports.refreshRemoteOverview = remoteData.refreshOverview
module.exports.getRemoteCollection = remoteData.getCollection
module.exports.getRemoteCollectionSummary = remoteData.getCollectionSummary
module.exports.getRemoteCatalogPage = remoteData.getCatalogPage
module.exports.getRemoteSubjectPage = remoteData.getSubjectPage
module.exports.getRemoteResourceState = remoteData.getResourceState
module.exports.getRemoteAnnouncementTotal = remoteData.getAnnouncementTotal
module.exports.loadRemoteSubjects = remoteData.refreshSubjects
module.exports.loadRemoteBanks = remoteData.refreshBanks
module.exports.loadRemoteBank = remoteData.loadBank
module.exports.loadRemoteChapters = remoteData.loadChapters
module.exports.getRemoteChapters = remoteData.getChapters
module.exports.previewRemotePracticeScope = remoteData.previewPracticeScope
