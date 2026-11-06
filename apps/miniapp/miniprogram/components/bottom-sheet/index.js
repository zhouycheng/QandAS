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
