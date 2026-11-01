Component({
  properties: { paths: { type: Array, value: [] } },
  methods: {
    preview(e) {
      wx.previewImage({ urls: this.data.paths, current: e.currentTarget.dataset.path })
    }
  }
})
