Component({
  data: { visible: false, leaving: false, message: '' },
  lifetimes: {
    detached() {
      clearTimeout(this.closeTimer)
      clearTimeout(this.removeTimer)
    }
  },
  pageLifetimes: { hide() { this.hide() } },
  methods: {
    show(message) {
      clearTimeout(this.closeTimer)
      clearTimeout(this.removeTimer)
      this.setData({ visible: true, leaving: false, message })
      this.closeTimer = setTimeout(() => {
        this.setData({ leaving: true })
        this.removeTimer = setTimeout(() => this.hide(), 160)
      }, 1600)
    },
    hide() {
      clearTimeout(this.closeTimer)
      clearTimeout(this.removeTimer)
      this.setData({ visible: false, leaving: false })
    }
  }
})
