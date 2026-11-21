const assert = require('node:assert/strict')
const fs = require('node:fs')
const { CommunityGroupViewModel } = require('../miniprogram/viewmodels/community-group-viewmodel.js')
const repository = require('../miniprogram/repositories/community-group-repository.js')
const api = require('../miniprogram/repositories/api-transport.js')

async function main() {
  let group = { available: true, expiresAt: new Date(Date.now() + 60000).toISOString(), imageUrl: 'https://example.test/group?v=2' }
  const model = new CommunityGroupViewModel({ repository: { load: async () => group } })
  assert.equal((await model.load(true)).command.url, group.imageUrl)
  assert.equal((await model.load()).data.imageUrl, group.imageUrl)
  group = Object.assign({}, group, { expiresAt: new Date(Date.now() - 1).toISOString() })
  assert.equal((await model.load(true)).command, null)
  assert.equal((await model.load()).data.imageUrl, '')
  assert.match((await model.load()).data.message, /过期/)
  group = { available: false, expiresAt: null }
  assert.match((await model.load()).data.message, /更新中/)
  const failed = new CommunityGroupViewModel({ repository: { load: async () => { throw new Error('网络失败') } } })
  assert.equal((await failed.load(true)).data.message, '网络失败')

  let component, previews = []
  global.Component = value => { component = value }
  global.wx = { previewImage(options) { previews.push(options.current) } }
  require('../miniprogram/components/community-group/index.js')
  group = { available: true, expiresAt: new Date(Date.now() + 60000).toISOString(), imageUrl: 'https://example.test/group' }
  const card = { ...component.methods, active: true, data: Object.assign({ hideUnavailable: true }, CommunityGroupViewModel.getInitialData()), viewModel: model, setData(patch) { Object.assign(this.data, patch) } }
  card.refresh = component.methods.refresh
  assert.equal(card.data.imageUrl, '', '首页卡片默认隐藏')
  await card.refresh(false)
  assert.equal(card.data.imageUrl, group.imageUrl, '图片加载成功后显示')
  card.viewModel = failed
  await card.refresh(false)
  assert.equal(card.data.imageUrl, '', '图片加载失败后隐藏')
  card.viewModel = model
  group = { available: false, expiresAt: null }
  await card.refresh(false)
  assert.equal(card.data.imageUrl, '', '未配置群码时隐藏')
  const template = fs.readFileSync(require.resolve('../miniprogram/components/community-group/index.wxml'), 'utf8')
  assert.match(template, /compact && imageUrl[^\n]*catchtap="open"/, '卡片内按钮仅在群码可用时显示并拦截父级点击')
  const about = fs.readFileSync(require.resolve('../miniprogram/page/about/index.wxml'), 'utf8')
  assert.match(about, /<community-group hide-unavailable="\{\{true\}\}"\s*\/>/, '关于页沿用首页群码可用性规则')
  group = { available: true, expiresAt: new Date(Date.now() + 60000).toISOString(), imageUrl: 'https://example.test/group?v=4' }
  await card.refresh(false)
  assert.equal(card.data.imageUrl, group.imageUrl, '失败隐藏后再次获取可恢复卡片')
  await Promise.all([card.refresh(false), card.open()])
  assert.deepEqual(previews, [group.imageUrl], '刷新期间点击仍会预览')
  component.pageLifetimes.hide.call(card)
  await component.pageLifetimes.show.call(card)
  await card.refreshPromise
  assert.equal(card.data.imageUrl, group.imageUrl, '重新进入页面主动获取')
  assert.match(template, /class="group-arrow" src="\/assets\/icons\/arrow-right.svg"/, '入口显示右箭头图标')
  const home = fs.readFileSync(require.resolve('../miniprogram/page/subject-list/index.wxml'), 'utf8')
  assert.match(home, /id="home-community" hide-unavailable="\{\{true\}\}"/, '首页失败时隐藏内部卡片并保留组件实例')
  clearTimeout(card.expiryTimer)
  delete global.Component
  delete global.wx

  const original = api.request
  api.configure({ baseUrl: 'https://example.test/api/v1' })
  const files = new Map()
  let decoded = true
  global.wx = {
    env: { USER_DATA_PATH: '/cache' },
    getImageInfo({ src, success, fail }) { assert.ok(src.startsWith('/cache/')); (decoded && files.has(src) ? success : fail)() },
    getFileSystemManager: () => ({
      writeFile({ filePath, data, success }) { files.set(filePath, data); success() },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from) },
      unlinkSync(path) { files.delete(path) },
      readdirSync() { return [...files.keys()].map(path => path.slice('/cache/'.length)) }
    })
  }
  let version = 3, downloads = 0, states = 0, available = true, imageOk = true
  let expiresAt = new Date(Date.now() + 60000).toISOString()
  api.request = async (method, path, data, options) => {
    assert.equal(method, 'GET'); assert.equal(options.token, '')
    if (path === '/community/group') {
      states++
      return { ok: true, data: JSON.stringify({ available, version, expiresAt }) }
    }
    assert.equal(path, '/community/group/image?v=' + version)
    assert.equal(options.responseType, 'arraybuffer')
    downloads++
    return { ok: imageOk, data: new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68,174,66,96,130]).buffer }
  }
  const first = await Promise.all([repository.load(), repository.load(), repository.load()])
  assert.equal(new Set(first.map(group => group.imageUrl)).size, 1)
  assert.equal(downloads, 1)
  assert.ok(files.has(first[0].imageUrl))
  await repository.load()
  assert.equal(downloads, 1)
  assert.equal(states, 4)
  version++
  imageOk = false
  await assert.rejects(repository.load(), /读取失败/)
  imageOk = true
  decoded = false
  await assert.rejects(repository.load(), /无法显示/)
  decoded = true
  const replacement = await repository.load()
  assert.notEqual(replacement.imageUrl, first[0].imageUrl)
  assert.deepEqual([...files.keys()], [replacement.imageUrl])
  available = false
  assert.equal((await repository.load()).imageUrl, '')
  available = true
  expiresAt = new Date(Date.now() - 1000).toISOString()
  assert.equal((await repository.load()).imageUrl, '')
  assert.equal(downloads, 4)
  api.request = async () => ({ ok: false, reason: '请求超时' })
  await assert.rejects(repository.load(), /请求超时/)
  delete global.wx
  api.request = original
  console.log('群码自检通过：有效预览、过期隐藏、未配置、读取失败、公共接口与版本图片地址')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
