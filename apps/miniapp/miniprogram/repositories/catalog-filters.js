const KEY = 'qandaCatalogFilters'
const GRADES = ['全部年级', '大一', '大二', '大三', '大四', '已毕业']
function normalize(value) {
  value = value && typeof value === 'object' ? value : {}
  const collegeId = typeof value.collegeId === 'string' ? value.collegeId : ''
  return {
    collegeId,
    majorId: collegeId && typeof value.majorId === 'string' ? value.majorId : '',
    grade: Number.isInteger(value.grade) && value.grade >= 1 && value.grade <= 5 ? value.grade : null
  }
}
function read(storage) { return normalize(storage && storage.get(KEY)) }
function hasSelection(value) { return !!(value.collegeId || value.majorId || value.grade) }
function toggleState(storage) {
  const stored = storage && storage.get(KEY) || {}
  const current = normalize(stored)
  const previous = normalize(stored.previous)
  const active = hasSelection(current)
  return { enabled: active || hasSelection(previous), restoring: !active && hasSelection(previous) }
}
function query(storage) {
  const value = read(storage)
  return { collegeId: value.collegeId || undefined, majorId: value.majorId || undefined, grade: value.grade || undefined }
}
function save(storage, patch, options) {
  const previous = read(storage)
  const stored = storage.get(KEY) || {}
  const next = normalize(Object.assign({}, previous, patch))
  if (next.collegeId !== previous.collegeId && !Object.prototype.hasOwnProperty.call(patch, 'majorId')) next.majorId = ''
  if (!next.collegeId) next.majorId = ''
  const saved = options && options.clearPrevious ? null : hasSelection(previous) && !hasSelection(next) ? previous : normalize(stored.previous)
  if (saved && hasSelection(saved)) next.previous = saved
  storage.set(KEY, next)
  return read(storage)
}
function toggle(storage) {
  const current = read(storage)
  const saved = normalize((storage.get(KEY) || {}).previous)
  if (!hasSelection(current) && !hasSelection(saved)) return null
  const next = hasSelection(current) ? { collegeId: '', majorId: '', grade: null, previous: current } : Object.assign({}, saved, { previous: saved })
  storage.set(KEY, next)
  return read(storage)
}
async function options(storage) {
  const api = require('./api-transport.js')
  let value = read(storage)
  const colleges = await api.getAll('/colleges')
  if (!colleges.ok) throw new Error(colleges.reason || '分类读取失败')
  let invalid = false
  if (value.collegeId && !colleges.data.some(item => item.id === value.collegeId)) {
    value = Object.assign({}, value, { collegeId: '', majorId: '' }); invalid = true
  }
  let majors = []
  if (value.collegeId) {
    const result = await api.getAll('/colleges/' + encodeURIComponent(value.collegeId) + '/majors')
    if (!result.ok) throw new Error(result.reason || '专业读取失败')
    majors = result.data
    if (value.majorId && !majors.some(item => item.id === value.majorId)) {
      value = Object.assign({}, value, { majorId: '' }); invalid = true
    }
  }
  return { colleges: [{ id: '', name: '全部学院' }].concat(colleges.data), majors: [{ id: '', name: '全部专业' }].concat(majors), value, invalid }
}
module.exports = { KEY, GRADES, read, query, save, toggle, toggleState, options }
