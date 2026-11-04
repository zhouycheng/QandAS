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

  let component, imageLoads = 0, imageSucceeds = true
  global.Component = value => { component = value }
  global.wx = { getImageInfo(options) { imageLoads++; (imageSucceeds ? options.success : options.fail)() } }
  require('../miniprogram/components/community-group/index.js')
  group = { available: true, expiresAt: new Date(Date.now() + 60000).toISOString(), imageUrl: 'https://example.test/group' }
  const card = { active: true, data: Object.assign({ hideUnavailable: true }, CommunityGroupViewModel.getInitialData()), viewModel: model, setData(patch) { Object.assign(this.data, patch) } }
  card.refresh = component.methods.refresh
  assert.equal(card.data.imageUrl, '', '首页卡片默认隐藏')
  await card.refresh(false)
  assert.equal(card.data.imageUrl, group.imageUrl, '图片加载成功后显示')
  imageSucceeds = false
  await card.refresh(false)
  assert.equal(card.data.imageUrl, '', '图片加载失败后隐藏')
  group = { available: false, expiresAt: null }
  await card.refresh(false)
  assert.equal(card.data.imageUrl, '', '未配置群码时隐藏')
  assert.equal(imageLoads, 2, '不可用群码不请求图片')
  const template = fs.readFileSync(require.resolve('../miniprogram/components/community-group/index.wxml'), 'utf8')
  assert.match(template, /compact && imageUrl[^\n]*catchtap="open"/, '卡片内按钮仅在群码可用时显示并拦截父级点击')
  const about = fs.readFileSync(require.resolve('../miniprogram/page/about/index.wxml'), 'utf8')
  assert.match(about, /<community-group hide-unavailable="\{\{true\}\}"\s*\/>/, '关于页沿用首页群码可用性规则')
  clearTimeout(card.expiryTimer)
  delete global.Component
  delete global.wx

  const original = api.request
  api.configure({ baseUrl: 'https://example.test/api/v1' })
  api.request = async (method, path, data, options) => {
    assert.equal(method, 'GET'); assert.equal(path, '/community/group'); assert.equal(options.token, '')
    return { ok: true, data: JSON.stringify({ available: true, version: 3, expiresAt: new Date(Date.now() + 60000).toISOString() }) }
  }
  assert.equal((await repository.load()).imageUrl, 'https://example.test/api/v1/community/group/image?v=3')
  api.request = async () => ({ ok: false, reason: '请求超时' })
  await assert.rejects(repository.load(), /请求超时/)
  api.request = original
  console.log('群码自检通过：有效预览、过期隐藏、未配置、读取失败、公共接口与版本图片地址')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
