function equal(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b) }
function viewPatch(previous, next) {
  const patch = {}
  Object.keys(next).forEach(key => {
    const value = next[key], before = previous[key]
    if (equal(before, value)) return
    if (Array.isArray(value) && Array.isArray(before) && value.length === before.length) {
      value.forEach((item, index) => { if (!equal(before[index], item)) patch[`${key}[${index}]`] = item })
    } else patch[key] = value
  })
  return patch
}
module.exports = { viewPatch }
