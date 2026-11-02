const remoteData = require('../repositories/remote-data-repository.js')
const practiceRepository = require('../repositories/practice-repository.js')
const { describeAuth, getProviderLabel } = require('../utils/auth-session.js')
const { maskEmail } = require('../utils/auth-form.js')
const { GRADE_LABELS } = require('../utils/profile-rules.js')
const { AccountSecurityRepository } = require('../repositories/account-security-repository.js')
const { uuid } = require('../repositories/api-transport.js')

const LOGIN_URL = '/page/login/index'
const SECURITY_URL = '/page/account-security/index'

/**
 * 个人资料。
 *
 * 资料编辑完成后统一保存。
 * 输入过程中每敲一个字就写 storage 会在真机上卡顿，而且中途退出会留下半截数据。
 *
 * 邮箱和密码由账号安全页面处理，微信身份在当前页绑定。
 */

function createNullStorage() {
  return {
    get() {
      return null
    },

    set() {}
  }
}

function createEmptyProfile() {
  return {
    avatarUrl: '',
    nickname: '',
    college: '',
    emailMasked: '',
    providerLabel: '',
    passwordStatus: '未设置',
    wechatStatus: '未绑定'
  }
}

function getInitialAccountViewData() {
  return {
    loggedIn: false,
    profile: createEmptyProfile(),
    draft: {
      avatarUrl: '',
      nickname: '',
      college: '', major: '', currentGrade: null, gradeLabel: ''
    },
    // 有没有未保存的改动：没有改动时保存按钮置灰
    dirty: false,
    saving: false,
    avatarPreparing: false,
    nicknameFocus: false,
    wechatBinding: false,
    collegeOptions: [],
    collegeIndex: 0,
    collegePickerVisible: false,
    collegeLoading: false,
    collegeError: '',
    collegeHasMore: false,
    collegePage: 1,
    required: false,
    gradeLabels: GRADE_LABELS,
    gradePickerVisible: false,
    majorOptions: [], majorPickerVisible: false, majorLoading: false, majorError: '', majorHasMore: false, majorPage: 1
  }
}

class AccountViewModel {
  constructor(options) {
    const normalizedOptions = options || {}
    this.repository = normalizedOptions.repository || practiceRepository
    this.storage = normalizedOptions.storage || createNullStorage()
    // 输入框刻意不受控：只在内存里攒改动，不回写 value，否则真机光标会跳到末尾
    this.pending = null
    this.editRevision = 0
    this.required = !!normalizedOptions.required
    this.majorOptions = []
    this.securityRepository = normalizedOptions.securityRepository
  }

  refreshRemote(subjectId) {
    if (!this.repository.isRemoteEnabled || !this.repository.isRemoteEnabled()) return Promise.resolve(null)
    const revision = this.editRevision
    return this.repository.refreshRemote(this.storage, 'profile').then(() => revision !== this.editRevision ? null : this.loadedEditRevision !== this.editRevision ? { data: { profile: this.readProfile() } } : this.load()).catch((error) => ({ command: { type: 'toast', title: error.message } }))
  }

  projectRemote() {
    remoteData.getProfile(this.storage)
    if (this.loadedEditRevision !== this.editRevision) return { profile: this.readProfile(), collegeOptions: [{ id: '', name: '未选择' }].concat(remoteData.getColleges()) }
    return this.load().data
  }

  loadColleges(page) {
    return remoteData.loadColleges(this.storage, page || 1).then(result => ({ data: {
      collegeOptions: [{ id: '', name: '未选择' }].concat(remoteData.getColleges()),
      collegeHasMore: !!result && result.page * result.pageSize < result.total,
      collegePage: page || 1
    } }))
  }

  loadMajors(page) {
    const collegeId = this.pending && this.pending.collegeId
    if (!collegeId) return Promise.reject(new Error('请先选择学院'))
    return remoteData.loadMajors(collegeId, page || 1).then(result => {
      if (!this.pending || collegeId !== this.pending.collegeId) return null
      this.majorOptions = page > 1 ? this.majorOptions.concat(result.items) : result.items
      return { data: { majorOptions: this.majorOptions, majorHasMore: result.page * result.pageSize < result.total, majorPage: page || 1 } }
    })
  }

  selectMajor(index) {
    const major = this.majorOptions[Number(index)]
    if (!major) return null
    this.editRevision += 1
    Object.assign(this.pending, { majorId: major.id, major: major.name })
    return { data: { 'draft.major': major.name, dirty: this.dirtyNow() } }
  }

  selectGrade(index) {
    const grade = Number(index) + 1
    if (!GRADE_LABELS[grade - 1]) return null
    this.editRevision += 1
    Object.assign(this.pending, { currentGrade: grade, gradeLabel: GRADE_LABELS[grade - 1] })
    this.gradeEdited = true
    return { data: { 'draft.currentGrade': grade, 'draft.gradeLabel': GRADE_LABELS[grade - 1], dirty: true } }
  }

  static getInitialData() {
    return getInitialAccountViewData()
  }

  load() {
    const profile = this.readProfile()
    const draft = {
      avatarUrl: profile.avatarUrl,
      nickname: profile.nickname,
      college: profile.college,
      collegeId: profile.collegeId, majorId: profile.majorId, major: profile.major,
      currentGrade: profile.currentGrade, gradeLabel: profile.gradeLabel
    }

    this.pending = Object.assign({}, draft)
    this.loadedEditRevision = this.editRevision
    this.gradeEdited = false

    return {
      data: {
        loggedIn: this.readAuth().view.loggedIn,
        required: this.required,
        profile,
        draft,
        dirty: false,
        saving: false,
        collegeOptions: [{ id: '', name: '未选择' }].concat(remoteData.getColleges()),
        collegeIndex: Math.max(0, [{ id: '' }].concat(remoteData.getColleges()).findIndex((item) => item.id === ((remoteData.getProfile(this.storage) || {}).collegeId || '')))
      }
    }
  }

  readAuth() {
    try {
      const raw = this.repository.getAuth(this.storage)

      return {
        view: describeAuth(raw),
        // 编辑框要的是「用户真正填过的昵称」，不是带兜底的 displayName
        nickname: raw && typeof raw.nickname === 'string' ? raw.nickname : '',
        token: raw && raw.token,
        profile: raw && raw.profile
      }
    } catch (error) {
      return { view: describeAuth(null), nickname: '' }
    }
  }

  readProfile() {
    const state = this.readAuth()
    const view = state.view
    const profile = remoteData.getProfile(this.storage) || state.profile || {}

    if (!view.loggedIn) {
      return createEmptyProfile()
    }

    return {
      avatarUrl: profile.avatarUrl || view.avatarUrl,
      nickname: state.nickname,
      college: profile.collegeName || view.college || '',
      collegeId: profile.collegeId || null, majorId: profile.majorId || null, major: profile.majorName || '',
      currentGrade: profile.currentGrade || null, gradeLabel: GRADE_LABELS[profile.currentGrade - 1] || '',
      emailMasked: maskEmail(profile.email === undefined ? view.email : profile.email),
      providerLabel: getProviderLabel(view.provider) || view.accountTag,
      passwordStatus: profile.passwordSet ? '已设置' : '未设置',
      wechatBound: !!profile.wechatBound,
      wechatStatus: profile.wechatBound ? '已绑定' : '未绑定',
      wechatAction: profile.wechatBound ? '' : '绑定'
    }
  }

  selectCollege(index) {
    this.editRevision += 1
    const colleges = [{ id: '', name: '未选择' }].concat(remoteData.getColleges())
    const college = colleges[Number(index)] || colleges[0]
    if (this.pending && this.pending.collegeId === college.id) return null
    this.majorOptions = []
    this.pending = Object.assign({}, this.pending, { college: college.id ? college.name : '', collegeId: college.id || null, majorId: null, major: '' })
    return { data: { collegeIndex: Number(index), 'draft.college': this.pending.college, 'draft.major': '', majorOptions: [], dirty: true } }
  }

  /** 输入：只记改动，不回写 value（回写会让光标跳到末尾） */
  setField(key, value) {
    if (['avatarUrl', 'nickname', 'college'].indexOf(key) < 0) {
      return null
    }

    this.editRevision += 1
    const text = typeof value === 'string' ? value : ''

    this.pending = Object.assign({}, this.pending || {}, { [key]: text })

    const current = this.readProfile()
    const dirty = this.dirtyNow()

    return {
      data: {
        dirty
      }
    }
  }

  /** 保存资料：未登录先去登录，避免「改完没保存」还以为存上了 */
  save() {
    if (!this.readAuth().view.loggedIn) {
      return {
        command: {
          type: 'navigate',
          url: LOGIN_URL
        }
      }
    }

    if (!this.dirtyNow()) {
      return {
        command: {
          type: 'toast',
          title: '资料没有改动'
        }
      }
    }

    const pending = this.pending || {}
    const nickname = typeof pending.nickname === 'string' ? pending.nickname.trim() : ''
    const college = typeof pending.college === 'string' ? pending.college.trim() : ''

    if (this.repository.isRemoteEnabled && this.repository.isRemoteEnabled()) {
      if (!pending.collegeId || !pending.majorId || !pending.currentGrade) return { command: { type: 'toast', title: '请选择学院、专业和当前年级' } }
      if (this.saving) return null
      this.saving = true
      const patch = { nickname, collegeId: pending.collegeId, majorId: pending.majorId }
      if (pending.avatarUrl !== this.readProfile().avatarUrl && /^data:image\/(jpeg|png);base64,/.test(pending.avatarUrl || '')) patch.avatar = pending.avatarUrl
      if (this.gradeEdited) patch.currentGrade = pending.currentGrade
      return remoteData.saveProfile(this.storage, patch).then(() => {
        return Object.assign({}, this.load(), { command: { type: this.required ? 'profile-complete' : 'toast', title: '资料已保存' } })
      }).finally(() => { this.saving = false })
    }
    this.repository.updateAuthProfile(this.storage, {
      nickname,
      college,
      avatarUrl: pending.avatarUrl || ''
    })

    return Object.assign({}, this.load(), {
      command: {
        type: 'toast',
        title: '资料已保存'
      }
    })
  }

  dirtyNow() {
    const current = this.readProfile()
    const pending = this.pending || {}

    return (
      (pending.nickname || '') !== (current.nickname || '') ||
      (pending.college || '') !== (current.college || '') ||
      (pending.avatarUrl || '') !== (current.avatarUrl || '') ||
      pending.majorId !== current.majorId || pending.currentGrade !== current.currentGrade || this.gradeEdited
    )
  }

  security(mode) { return { command: { type: 'navigate', url: this.readAuth().view.loggedIn ? `${SECURITY_URL}?mode=${mode}` : LOGIN_URL } } }
  tapPassword() { return this.security('password') }
  tapEmail() { return this.security('email') }
  tapWechat() {
    if (!this.readAuth().view.loggedIn) return { command: { type: 'navigate', url: LOGIN_URL } }
    if (this.readProfile().wechatBound || this.wechatBinding) return null
    return { command: { type: 'confirm-wechat-binding' } }
  }

  async bindWechat() {
    if (this.wechatBinding) return null
    this.wechatBinding = true
    try {
      const repository = this.securityRepository || (this.securityRepository = new AccountSecurityRepository(this.storage))
      if (!this.wechatInput) {
        const profile = await repository.load()
        if (profile.wechatBound) return { data: { profile: this.readProfile() }, command: { type: 'toast', title: '微信已绑定' } }
        this.wechatInput = { expectedVersion: profile.version, code: await repository.wechatCode() }
        this.wechatKey = uuid()
      }
      await repository.wechat(this.wechatInput, this.wechatKey)
      await repository.refresh()
      this.wechatInput = null; this.wechatKey = ''
      return { data: { profile: this.readProfile() }, command: { type: 'toast', title: '微信已绑定' } }
    } catch (error) {
      if (error.statusCode) { this.wechatInput = null; this.wechatKey = '' }
      throw error
    } finally { this.wechatBinding = false }
  }
}

module.exports = {
  AccountViewModel
}
