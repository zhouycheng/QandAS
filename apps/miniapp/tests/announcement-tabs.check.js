const assert = require('node:assert/strict')
let definition
 global.Page = value => { definition = value }; global.wx = {}
require('../miniprogram/page/subject-list/index.js')
async function main() {
 let token = 'a', resolve, fail = false
 const first = { id: 'p', pinned: true, updatedAt: '2026-11-01', body: '置顶' }
 const latest = { id: 'n', updatedAt: '2026-11-06', body: '最新' }
 const page = Object.assign({}, definition, { data: { announcements: [first], announcementSheetVisible: false }, setData(p) { Object.assign(this.data, p) }, viewModel: {
 storage: {}, repository: { getAuth: () => ({ token }) }, closeAnnouncement: () => ({ data: { announcementSheetVisible: false } }),
 loadAnnouncements: async n => { if (fail) throw Error('offline'); if (n === 2) await new Promise(r => { resolve = r }); return { data: { announcements: [first, latest], announcementPage: n, announcementHasMore: n === 1 } } }
 } })
 await page.handleAnnouncementTap(); assert.equal(page.data.selectedAnnouncement.id, 'p'); assert.equal(page.data.latestAnnouncementId, 'n')
 page.handleAnnouncementDetail({ currentTarget: { dataset: { id: 'n' } } }); assert.equal(page.data.selectedAnnouncement.id, 'n')
 fail = true; await page.handleAnnouncementMore(); assert.equal(page.data.announcementPage, 1); assert.equal(page.data.selectedAnnouncement.id, 'n'); assert.equal(page.announcementRetryPage, 2)
 fail = false; const retry = page.handleAnnouncementRetry(); resolve(); await retry; assert.equal(page.data.announcementPage, 2); assert.equal(page.data.selectedAnnouncement.id, 'n')
 page.data.announcementHasMore = true; const pending = page.handleAnnouncementMore(); page.handleAnnouncementClose(); resolve(); await pending; assert.equal(page.data.selectedAnnouncement, null)
 await page.handleAnnouncementTap(); token = 'b'; page.applyViewModelResult({ data: { announcements: [] } }); assert.equal(page.data.announcementSheetVisible, false)
 page.data.announcements = []; page.updateAnnouncementBadges(); assert.equal(page.data.latestAnnouncementId, '')
 console.log('公告标签：默认正文、切换、分页重试、关闭迟到响应及账号隔离通过')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
