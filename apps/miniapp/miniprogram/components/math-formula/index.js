let renderer
function loadRenderer() {
  if (!renderer) renderer = require.async('../../math/renderer.js').catch(error => {
    renderer = null
    throw error
  })
  return renderer
}

Component({
  properties: { tex: String, raw: String, display: Boolean },
  data: { src: '', style: '' },
  observers: {
    'tex, display': async function (tex, display) {
      const revision = this.revision = (this.revision || 0) + 1
      if (this.data.src) this.setData({ src: '' })
      if (!tex) return
      try {
        const engine = await loadRenderer()
        if (revision !== this.revision) return
        const { xml, width, height, align } = engine.renderFormula(tex, display)
        const bytes = encodeURIComponent(xml).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        const src = 'data:image/svg+xml;base64,' + wx.arrayBufferToBase64(Uint8Array.from(bytes, c => c.charCodeAt(0)).buffer)
        this.setData({ src, style: 'width:' + width + ';height:' + height + ';vertical-align:' + align })
      } catch (_) { /* The template displays the original expression. */ }
    }
  },
  methods: {
    noop() {},
    ready() { this.triggerEvent('contentready', {}, { bubbles: true, composed: true }) },
    failed() { this.setData({ src: '' }, () => this.ready()) }
  }
})
