const GRADE_LABELS = ['大一', '大二', '大三', '大四', '已毕业']
function academicYear(now) {
  const date = new Date((now === undefined ? Date.now() : now) + 8 * 60 * 60 * 1000)
  return date.getUTCFullYear() - (date.getUTCMonth() < 8 ? 1 : 0)
}
function scopeKey(auth) {
  const p = auth && auth.profile || {}
  return [auth && auth.userId || '', p.collegeId || '', p.majorId || '', p.currentGrade || '', academicYear()].join(':')
}
function needsProfile(auth) { return !!(auth && auth.token && auth.profile && auth.profile.profileComplete === false) }
function successCommand(auth, title) {
  return needsProfile(auth) ? { type: 'navigate', mode: 'redirect', url: '/page/account/index?required=1', title: '请完善个人资料' } : { type: 'back', title }
}
module.exports = { GRADE_LABELS, academicYear, scopeKey, needsProfile, successCommand }
