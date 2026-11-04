Component({
  properties: { paths: { type: Array, value: [] } },
  methods: {
    contentReady() { this.triggerEvent('contentready', {}, { bubbles: true, composed: true }) },
    preview(e) {
      wx.previewImage({ urls: this.data.paths, current: e.currentTarget.dataset.path })
    }
  }
})
