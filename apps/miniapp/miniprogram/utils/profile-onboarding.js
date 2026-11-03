const { needsProfile } = require('./profile-rules.js')
function decide(identity, locallySeen, codeLogin) {
  const profile = identity && identity.profile || {}
  if (!needsProfile(identity) && profile.passwordSet !== false) return { type: 'NONE' }
  if (!codeLogin && !profile.profileSetupSeen && !locallySeen) return { type: 'SETUP' }
  return { type: 'REMINDER', content: profile.passwordSet === false
    ? '可在个人资料中补充学习资料，并进入账号安全设置密码。'
    : '填写学院、专业和年级，可以为你匹配更合适的题库。' }
}
module.exports = { decide }
