Component({
  options: { multipleSlots: true },
  properties: {
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
