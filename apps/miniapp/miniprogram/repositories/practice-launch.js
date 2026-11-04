const { getDefaultPracticeRoute } = require('./preference-repository.js')
const { routeQuery } = require('../utils/practice-presets.js')
async function preparePracticeRoute(storage, repository, scope, overrides) {
  const route = Object.assign({}, getDefaultPracticeRoute(storage), overrides)
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'count') && overrides.countAll !== '1') delete route.countAll
  const requested = route.countAll === '1' ? 1000 : Number(route.count)
  const requestScope = Object.assign({}, scope, {
    count: requested, order: ['practice', 'test'].includes(route.mode) ? 'RANDOM' : 'SEQUENTIAL',
    ...(scope.selectionKind === 'NORMAL' ? { completeFirstGroup: true } : {})
  })
  let preview = await repository.previewRemotePracticeScope(storage, requestScope)
  if (preview.availableCount > requested && preview.availableCount <= 10) {
    preview = await repository.previewRemotePracticeScope(storage, Object.assign({}, requestScope, { count: preview.availableCount }))
  }
  if (route.countAll === '1' && preview.availableCount > 1000) throw new Error('每次最多 1000 题，请缩小范围后选择全部')
  const count = Number(preview.selectedCount === undefined ? preview.availableCount : preview.selectedCount) || 0
  if (!count) throw new Error('当前范围没有可练习的题目')
  return { route: Object.assign(route, { bankId: scope.questionBankId, count, seed: Date.now() }, preview.selectionKey ? { selectionKey: preview.selectionKey } : {}),
    count, adjusted: route.countAll !== '1' && count > requested }
}
module.exports = { preparePracticeRoute, routeQuery }
