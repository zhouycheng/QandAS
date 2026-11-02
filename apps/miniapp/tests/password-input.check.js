const assert = require('node:assert/strict')
let definition
global.Component = value => { definition = value }
require('../miniprogram/components/password-input/index.js')
delete global.Component
const events = []
const instance = {
  properties: { disabled: false, value: 'VisibleTest123' },
  data: { visible: false, focused: false },
  setData(patch) { Object.assign(this.data, patch) },
  triggerEvent(name, detail) { events.push({ name, detail }) }
}
definition.methods.toggleVisibility.call(instance)
assert.equal(instance.data.visible, true)
assert.equal(instance.properties.value, 'VisibleTest123')
definition.methods.toggleVisibility.call(instance)
assert.equal(instance.data.visible, false)
const detail = { value: 'Edited123', cursor: 3 }
definition.methods.input.call(instance, { detail })
assert.deepEqual(events, [{ name: 'input', detail }])
instance.properties.disabled = true
definition.methods.toggleVisibility.call(instance)
assert.equal(instance.data.visible, false)
instance.data.visible = true
definition.pageLifetimes.hide.call(instance)
assert.equal(instance.data.visible, false)
assert.equal(instance.data.focused, false)
console.log('PASS password input: visibility, unchanged value, native input forwarding, disabled and page hiding')
