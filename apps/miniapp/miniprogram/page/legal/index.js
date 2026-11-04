const { AGREEMENT_TEXT, PRIVACY_TEXT } = require('../../utils/legal-content.js')
Page({
  data: { title: '', body: '' },
  onLoad(options) { const privacy = options && options.kind === 'privacy'; this.setData({ title: privacy ? '隐私政策' : '用户协议', body: privacy ? PRIVACY_TEXT : AGREEMENT_TEXT }) }
})
