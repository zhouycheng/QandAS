const assert = require('node:assert/strict')
const reads = require('../miniprogram/repositories/announcement-reads.js')
const auth = require('../miniprogram/repositories/auth-repository.js')
const values = {}
const storage = { get: k => values[k], set: (k, v) => { values[k] = v } }
const login = id => auth.saveAuth(storage, { provider: 'email', userId: id, token: id })
login('one')
const a = { id: 'a', version: 1 }, b = { id: 'b', version: 1 }
assert.equal(reads.hasUnread(storage, []), false)
assert.equal(reads.hasUnread(storage, [a, b]), true)
assert.equal(reads.markRead(storage, a), true)
assert.equal(reads.hasUnread(storage, [a]), false)
assert.equal(reads.hasUnread(storage, [a, b]), true)
reads.markRead(storage, b)
assert.equal(reads.hasUnread(storage, [a, b]), false)
assert.equal(reads.hasUnread(storage, [{ ...a, version: 2 }]), true)
login('two'); assert.equal(reads.hasUnread(storage, [a]), true)
login('one'); assert.equal(reads.hasUnread(storage, [a]), false)
const broken = { get: storage.get, set() { throw Error('full') } }
assert.equal(reads.markRead(broken, { ...a, version: 2 }), false)
assert.equal(reads.hasUnread(storage, [{ ...a, version: 2 }]), true)
console.log('公告已读：持久化、逐条阅读、版本更新、账号隔离和保存失败通过')
async function pagination() {
 const remote = require('../miniprogram/repositories/remote-data-repository.js')
 const api = require('../miniprogram/repositories/api-transport.js')
 const pages = []
 const items = Array.from({ length: 21 }, (_, i) => ({ id: 'history-' + i, version: 1 }))
 api.request = async (_, path, query) => {
   if (path !== '/announcements') return { ok: true, data: {} }
   pages.push(query.page)
   return { ok: true, data: { items: items.slice((query.page - 1) * 20, query.page * 20), total: 21 } }
 }
 remote.enable(true)
 await remote.refresh(storage, 'home')
 assert.deepEqual(pages, [1, 2])
 assert.equal(remote.getAnnouncementIndex(storage).length, 21)
 items.slice(0, 20).forEach(item => reads.markRead(storage, item))
 await remote.refreshAnnouncements(storage, { page: 1 })
 assert.equal(reads.hasUnread(storage, remote.getAnnouncementIndex(storage)), true, '分页切换不能丢掉尚未读过的历史公告')
 reads.markRead(storage, items[20])
 assert.equal(reads.hasUnread(storage, remote.getAnnouncementIndex(storage)), false)
 console.log('公告已读：跨分页索引保留未读记录通过')
}
pagination().catch(error => { console.error(error); process.exitCode = 1 })
