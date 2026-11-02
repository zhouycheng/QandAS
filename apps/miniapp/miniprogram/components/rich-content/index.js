const { contentBlocks } = require('../../utils/rich-content.js')
Component({
  properties: { text: { type: String, value: '' }, format: { type: String, value: 'PLAIN_TEXT' }, codeLanguage: { type: String, value: '' }, blanks: { type: null, value: null }, disabled: { type: Boolean, value: false } },
  data: { blocks: [], links: [] },
  observers: {
    'text, format, codeLanguage, blanks'(text, format, language, blanks) {
      this.setData(contentBlocks(typeof text === 'string' ? text : '', format || 'PLAIN_TEXT', language, Array.isArray(blanks) ? blanks : null))
      this.triggerEvent('contentready', {}, { bubbles: true, composed: true })
    }
  },
  methods: {
    noop() {},
    inputBlank(event) { this.triggerEvent('blankinput', { index: Number(event.currentTarget.dataset.index), value: event.detail.value }) },
    focusBlank() { this.triggerEvent('blankfocus') },
    blurBlank() { this.triggerEvent('blankblur') },
    keyboardHeight(event) { this.triggerEvent('blankkeyboard', event.detail) },
    selectText() { this.triggerEvent('textselection', {}, { bubbles: true, composed: true }) },
    copyCode(event) { const block = this.data.blocks[event.currentTarget.dataset.index]; wx.setClipboardData({ data: block.raw, fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }) },
    copyLink(event) { wx.setClipboardData({ data: this.data.links[event.currentTarget.dataset.index] }) }
  }
})
