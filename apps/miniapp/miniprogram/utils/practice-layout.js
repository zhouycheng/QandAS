const DEFAULT_ORDER = ['info', 'stem', 'response', 'analysis', 'tools']
const LABELS = { info: '题目信息', stem: '题干', response: '作答区', analysis: '答案解析', tools: '工具栏' }
function normalizeOrder(order) {
  if (Array.isArray(order) && order.length === DEFAULT_ORDER.length && DEFAULT_ORDER.every(id => order.filter(value => value === id).length === 1)) return order.slice()
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
function allocateHeights({ height, material = false, analysis = false, response = true, contentHeights = {}, keyboard = false }) {
  const available = Math.max(0, Math.floor(height) || 0)
  let weights = material ? (analysis ? [30, 15, 30, 25] : [45, 20, 35, 0]) : (analysis ? [0, 25, 40, 35] : [0, 35, 65, 0])
  if (!response) { weights[1] += weights[2]; weights[2] = 0 }
  if (keyboard) weights = response ? (available < 120 ? [0, 0, 100, 0] : [0, 35, 65, 0]) : [0, 100, 0, 0]
  const panes = ['material', 'stem', 'response', 'analysis']
  const heights = {}, limits = {}, overflow = {}
  panes.forEach((pane, index) => {
    const natural = Number.isFinite(contentHeights[pane]) ? Math.max(0, Math.ceil(contentHeights[pane])) : Infinity
    limits[pane] = weights[index] ? Math.min(natural, pane === 'material' ? Math.floor(available * 0.45) : available) : 0
    heights[pane] = Math.min(limits[pane], Math.floor(available * weights[index] / 100))
  })
  let remaining = available - panes.reduce((sum, pane) => sum + heights[pane], 0)
  ;['response', 'stem', 'analysis', 'material'].forEach(pane => {
    const extra = Math.min(remaining, limits[pane] - heights[pane])
    heights[pane] += extra
    remaining -= extra
  })
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
  ;['material', 'stem', 'response', 'analysis'].forEach(pane => {
    const keepMaterial = pane === 'material' && materialKey(previous) === materialKey(next)
    const value = keepMaterial ? (positions[pane] || 0) : 0
    patch[pane] = controls[pane] === value ? value + 0.01 : value
  })
  return patch
}
module.exports = { DEFAULT_ORDER, LABELS, normalizeOrder, ranks, move, allocateHeights, viewportHeight, resetScroll }
