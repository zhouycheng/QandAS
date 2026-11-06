const { getAuth } = require('./auth-repository.js')
function key(storage) { const user = getAuth(storage).userId; return user ? 'qandaAnnouncementReads:' + user : '' }
function records(storage) {
  try { const value = storage.get(key(storage)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch (_) { return {} }
}
function revision(item) { return String(item.version || item.updatedAt || '') }
function hasUnread(storage, items) { const saved = records(storage); return items.some(item => saved[item.id] !== revision(item)) }
function markRead(storage, item) {
  if (!item || !key(storage)) return false
  try { storage.set(key(storage), Object.assign({}, records(storage), { [item.id]: revision(item) })); return true } catch (_) { return false }
}
module.exports = { hasUnread, markRead }
