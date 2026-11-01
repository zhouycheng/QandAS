const { createFeedbackRepository } = require('../repositories/feedback-repository.js')
const authRepository = require('../repositories/auth-repository.js')
const categories = ['ANSWER', 'EXPLANATION', 'STEM_OPTIONS', 'OTHER']
const statuses = { OPEN: '待处理', IN_PROGRESS: '处理中', RESOLVED: '已处理', DISMISSED: '已回复' }
class FeedbackViewModel {
  constructor(options) {
    this.storage = options.storage
    this.repository = options.repository || createFeedbackRepository(this.storage)
    this.kind = 'question'
    this.sequence = 0
    this.saving = false
  }
  static getInitialData() {
    return { kind: 'question', compose: false, questionId: '', revisionId: '', courseName: '', body: '', categoryIndex: 0,
      categories: ['答案问题', '解析问题', '题干或选项问题', '其他问题'], items: [], page: 1, hasMore: false, loading: false, saving: false, error: '' }
  }
  load(options) {
    this.kind = options.kind === 'course' ? 'course' : 'question'
    return { data: Object.assign(FeedbackViewModel.getInitialData(), { kind: this.kind, compose: options.compose === '1', questionId: options.questionId || '', revisionId: options.revisionId || '' }) }
  }
  async list(page) {
    const sequence = ++this.sequence
    try {
      const result = await this.repository.list(this.kind, page || 1)
      if (sequence !== this.sequence) return null
      if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total)) throw new Error('反馈列表格式异常，请重试')
      return { data: { loading: false, error: '', page: result.page, hasMore: result.page * result.pageSize < result.total,
        items: result.items.map(item => ({ id: item.id, title: item.courseName || item.question && item.question.stem || '题目纠错', body: item.body,
          response: item.response, statusText: statuses[item.status] || item.status, updatedAt: item.updatedAt ? new Date(Date.parse(item.updatedAt) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : '' })) } }
    } catch (error) {
      return sequence === this.sequence ? { data: { loading: false, error: error.message } } : null
    }
  }
  async submit(data) {
    if (this.saving) return null
    const body = String(data.body || '').trim()
    if (!body || body.length > 4000) return { command: { type: 'toast', title: '请填写 1–4000 字的问题描述' } }
    let input
    if (this.kind === 'course') {
      const courseName = String(data.courseName || '').trim()
      if (!courseName || courseName.length > 100) return { command: { type: 'toast', title: '请填写课程名称（最多 100 字）' } }
      const profile = authRepository.getAuth(this.storage).profile || {}
      input = { courseName, body, majorId: profile.majorId || null }
    } else {
      if (!data.questionId || !data.revisionId) return { command: { type: 'toast', title: '请从题目页面提交纠错' } }
      input = { questionId: data.questionId, revisionId: data.revisionId, category: categories[data.categoryIndex] || 'OTHER', body }
    }
    this.saving = true
    try {
      await this.repository.submit(this.kind, input)
      return { data: { saving: false, compose: false, body: '', courseName: '' }, command: { type: 'submitted' } }
    } catch (error) {
      return { data: { saving: false }, command: { type: 'toast', title: error.message } }
    } finally { this.saving = false }
  }
}
module.exports = { FeedbackViewModel }
