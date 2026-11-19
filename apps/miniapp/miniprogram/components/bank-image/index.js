const assets = require('../../repositories/question-assets.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
Component({
  properties: { assetId: String, alt: String },
  data: { path: '', error: false },
  observers: { assetId() { this.load() } },
  methods: {
    async load() {
      const id = this.properties.assetId
      this.setData({ path: '', error: false })
      if (!id) return
      try {
        const [path] = await assets.load(createWxStorageAdapter(), [id])
        if (this.properties.assetId === id) this.setData({ path })
      } catch (_) { if (this.properties.assetId === id) this.setData({ error: true }) }
    },
    ready() { this.triggerEvent('contentready', {}, { bubbles: true, composed: true }) },
    preview() { wx.previewImage({ current: this.data.path, urls: [this.data.path] }) }
  }
})
