const DEFAULT_ORDER = ['info', 'stem', 'response', 'tools']
const LABELS = { info: '题目信息', stem: '题干', response: '作答区', tools: '工具栏' }
function normalizeOrder(order) {
  const current = Array.isArray(order) ? order.filter(id => id !== 'analysis') : []
  if (current.length === DEFAULT_ORDER.length && DEFAULT_ORDER.every(id => current.filter(value => value === id).length === 1)) return current
  return DEFAULT_ORDER.slice()
}
function ranks(order) { const result = {}; normalizeOrder(order).forEach((id, index) => { result[id] = index }); return result }
function move(order, id, index) {
  const next = normalizeOrder(order)
  if (!next.includes(id) || !Number.isInteger(index) || index < 0 || index >= next.length) return next
  next.splice(next.indexOf(id), 1)
  next.splice(index, 0, id)
  return next
}
function normalizeStemPercent(value) { return Number.isInteger(value) && value >= 30 && value <= 70 && value % 5 === 0 ? value : 50 }
function stemPercentAt(y, top, height) {
  if (![y, top, height].every(Number.isFinite) || height <= 0) return null
  return Math.max(30, Math.min(70, Math.round((70 - (y - top) * 40 / height) / 5) * 5))
}
function allocateHeights({ height, material = false, response = true, contentHeights = {}, keyboard = false, stemPercent = 50 }) {
  const available = Math.max(0, Math.floor(height) || 0)
  const materialWeight = material ? 30 : 0
  const stem = response ? normalizeStemPercent(stemPercent) : 100
  let weights = [materialWeight, (100 - materialWeight) * stem / 100, (100 - materialWeight) * (100 - stem) / 100]
  if (keyboard) weights = response ? (available < 120 ? [0, 0, 100] : [0, 35, 65]) : [0, 100, 0]
  const panes = ['material', 'stem', 'response']
  const heights = {}, overflow = {}
  panes.forEach((pane, index) => { heights[pane] = Math.floor(available * weights[index] / 100) })
  const remainderPane = response && weights[2] ? 'response' : 'stem'
  heights[remainderPane] += available - panes.reduce((sum, pane) => sum + heights[pane], 0)
  panes.forEach(pane => { overflow[pane] = heights[pane] > 0 && (contentHeights[pane] || 0) > heights[pane] + 1 })
  return { heights, overflow }
}

function viewportHeight(windowHeight, fullHeight, keyboardHeight) {
  // Some clients resize the window for the keyboard; others report an overlay.
  return Math.max(0, Math.min(windowHeight, fullHeight - keyboardHeight))
}

function materialKey(question) {
  const material = question && question.material
  return material ? (material.revisionId || material.id || `${material.passage || ''}|${(material.imagePaths || []).join('|')}`) : ''
}

function resetScroll(previous, next, controls, positions) {
  const patch = {}
  ;['material', 'stem', 'response'].forEach(pane => {
    const keepMaterial = pane === 'material' && materialKey(previous) === materialKey(next)
    const value = keepMaterial ? (positions[pane] || 0) : 0
    patch[pane] = controls[pane] === value ? value + 0.01 : value
  })
  return patch
}
module.exports = { DEFAULT_ORDER, LABELS, normalizeOrder, ranks, move, allocateHeights, viewportHeight, resetScroll, materialKey, normalizeStemPercent, stemPercentAt }
