const GRADE_LABELS = ['大一', '大二', '大三', '大四', '已毕业']
function scopeKey(auth) {
  return auth && auth.userId || ''
}
function successCommand(auth, title) {
  return { type: 'back', title }
}
module.exports = { GRADE_LABELS, scopeKey, successCommand }
