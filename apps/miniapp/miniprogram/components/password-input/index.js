Component({
  externalClasses: ['input-class'],
  properties: {
    value: { type: String, value: '' },
    placeholder: { type: String, value: '请输入密码' },
    maxlength: { type: Number, value: 16 },
    disabled: { type: Boolean, value: false },
    error: { type: Boolean, value: false },
    confirmType: { type: String, value: 'done' }
  },
  data: { visible: false, focused: false },
  pageLifetimes: { hide() { this.setData({ visible: false, focused: false }) } },
  methods: {
    toggleVisibility() { if (!this.properties.disabled) this.setData({ visible: !this.data.visible, focused: true }) },
    input(event) { this.triggerEvent('input', event.detail) },
    confirm(event) { this.triggerEvent('confirm', event.detail) },
    focus() { if (!this.data.focused) this.setData({ focused: true }) },
    blur(event) { this.setData({ focused: false }); this.triggerEvent('blur', event.detail) }
  }
})
