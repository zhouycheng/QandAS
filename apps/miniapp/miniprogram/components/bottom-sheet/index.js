Component({
  options: { multipleSlots: true },
  properties: {
    scrollTop: { type: Number, value: 0 },
    visible: {
      type: Boolean,
      value: false
    },
    title: {
      type: String,
      value: ''
    },
    placement: {
      type: String,
      value: 'bottom'
    },
    fixedFooter: {
      type: Boolean,
      value: false
    }
  },
  data: {
    rendered: false,
    closing: false
  },
  lifetimes: {
    attached() {
      this._closeTimer = null
      if (this.data.visible) {
        this.setData({ rendered: true, closing: false })
      }
    },
    detached() {
      if (this._closeTimer) {
        clearTimeout(this._closeTimer)
        this._closeTimer = null
      }
    }
  },
  observers: {
    visible(visible) {
      if (visible) {
        if (this._closeTimer) {
          clearTimeout(this._closeTimer)
          this._closeTimer = null
        }
        this.setData({ rendered: true, closing: false })
        return
      }

      if (!this.data.rendered || this.data.closing) return
      this.setData({ closing: true })
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null
        if (!this.data.visible) {
          this.setData({ rendered: false, closing: false })
        }
      }, 160)
    }
  },
  methods: {
    handleBodyScroll(e) { this.triggerEvent('bodyscroll', e.detail) },
    handleMaskTap() {
      this.triggerEvent('close')
    },

    handleCloseTap() {
      this.triggerEvent('close')
    },

    noop() {
      return false
    }
  }
})
