const { contentBlocks } = require('../../utils/rich-content.js')
Component({
  properties: { text: { type: String, value: '' }, format: { type: String, value: 'PLAIN_TEXT' }, codeLanguage: { type: String, value: '' }, blanks: { type: null, value: null }, disabled: { type: Boolean, value: false }, managedKeyboard: { type: Boolean, value: false } },
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
    focusBlank(event) {
      this.triggerEvent('blankfocus')
      if (!this.properties.managedKeyboard) return
      const index = event.currentTarget.dataset.index
      this.focusedBlankIndex = index
      const query = this.createSelectorQuery()
      query.select('.rich-content').boundingClientRect()
      query.select('#rich-blank-' + index).boundingClientRect()
      query.exec(rects => {
        if (this.focusedBlankIndex === index && rects && rects[0] && rects[1]) this.triggerEvent('blankfocus', { offsetTop: rects[1].top - rects[0].top, height: rects[1].height })
      })
    },
    blurBlank() { this.focusedBlankIndex = null; this.triggerEvent('blankblur') },
    keyboardHeight(event) { this.triggerEvent('blankkeyboard', event.detail) },
    selectText() { this.triggerEvent('textselection', {}, { bubbles: true, composed: true }) },
    copyCode(event) { const block = this.data.blocks[event.currentTarget.dataset.index]; wx.setClipboardData({ data: block.raw, fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }) },
    copyLink(event) { wx.setClipboardData({ data: this.data.links[event.currentTarget.dataset.index] }) }
  }
})
