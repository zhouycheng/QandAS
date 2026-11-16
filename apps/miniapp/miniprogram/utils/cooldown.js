/**
 * 验证码倒计时的页面控制器（登录页 / 账号安全页共用）。
 *
 * **按结束时刻算剩余秒数，不按每秒自减。**
 * 小程序退到后台时定时器会被系统掐断，我们在 onHide 里也主动停掉了定时器；
 * 若靠自减，`cooldown` 会冻在半路 —— 回到前台按钮显示「45s 后重发」且永远不归零，
 * 用户只能杀掉页面重进。用绝对结束时刻重算，onShow 里 resume 一次就无缝接上。
 *
 * **结束时刻还要落到本机存储。**
 * 浮窗切走时小程序可能被系统回收，页面实例（连同 `cooldownEndAt` 和表单输入）一起销毁，
 * 重建后倒计时归零、邮箱清空，用户被迫重新收一次验证码。
 * 因此把「最近一次发送的邮箱 + 绝对结束时刻」写入 storage，onLoad 时 restore 回来即可续上。
 *
 * 安全边界：只存邮箱和时刻，**不存验证码本身**；验证码始终由用户从邮件中输入。
 *
 * 约束：本模块只做「计算 + 驱动 setData + 可选读写 storage」，不碰 wx API，
 * 页面把自身与 storage 适配器传入即可，便于纯函数式测试。
 */

/** 结束时刻 → 剩余整秒；已过期返回 0 */
function remainingSeconds(endAt, now) {
  const end = Number(endAt) || 0
  const base = Number(now) > 0 ? Number(now) : Date.now()

  if (end <= base) {
    return 0
  }

  return Math.ceil((end - base) / 1000)
}

const STORAGE_PREFIX = 'qandaCooldown:v1:'

function storageKey(purpose) {
  return `${STORAGE_PREFIX}${purpose || 'default'}`
}

/** 读本机记录；脏数据一律当作没有 */
function read(options) {
  const storage = options && options.storage
  if (!storage) return null

  try {
    const saved = storage.get(storageKey(options.purpose))
    if (!saved || !Number(saved.endAt)) return null
    return {
      email: typeof saved.email === 'string' ? saved.email : '',
      endAt: Number(saved.endAt)
    }
  } catch (_) {
    return null
  }
}

function write(options, email, endAt) {
  const storage = options && options.storage
  if (!storage) return

  try {
    storage.set(storageKey(options.purpose), { email: email || '', endAt })
  } catch (_) {
    /* 存储失败不能影响倒计时本身 */
  }
}

function clearStore(options) {
  const storage = options && options.storage
  if (!storage) return

  try {
    storage.remove(storageKey(options.purpose))
  } catch (_) {
    /* 清理失败不影响倒计时展示 */
  }
}

/** 只停定时器，**不清**结束时刻 —— 让 onShow 还能接着算 */
function stop(page) {
  if (page && page.cooldownTimer) {
    clearInterval(page.cooldownTimer)
    page.cooldownTimer = null
  }
}

/**
 * 按 `page.cooldownEndAt` 驱动展示值。
 * 每秒重算而不是减一，避免定时器被系统延后导致累计漂移。
 */
function start(page, options) {
  stop(page)

  const tick = () => {
    const remain = remainingSeconds(page.cooldownEndAt)

    page.setData({ cooldown: remain })

    if (remain <= 0) {
      page.cooldownEndAt = 0
      stop(page)
      // 倒计时结束后本机不再保留记录，页面重建时按钮直接可用
      clearStore(options)
    }
  }

  tick()
  page.cooldownTimer = setInterval(tick, 1000)
}

/**
 * 设定秒数并开始倒数（秒数非法时退回 60 秒）。
 * options = { storage, purpose, email } 时同时把邮箱与结束时刻写入本机。
 */
function begin(page, seconds, options) {
  const value = Number(seconds) > 0 ? Number(seconds) : 60

  page.cooldownEndAt = Date.now() + value * 1000
  if (options) write(options, options.email, page.cooldownEndAt)
  start(page, options)
}

/**
 * 回到前台：内存里有结束时刻就接着跑；
 * 页面已被回收重建（内存为空）时从本机存储取回，再按剩余时间决定是否继续倒数。
 */
function resume(page, options) {
  if (!page) return

  if (!page.cooldownEndAt && options) {
    const saved = read(options)
    if (saved && saved.endAt > Date.now()) page.cooldownEndAt = saved.endAt
    else if (saved) clearStore(options)
  }

  if (!page.cooldownEndAt) {
    if (page.data && page.data.cooldown !== 0) page.setData({ cooldown: 0 })
    return
  }

  if (remainingSeconds(page.cooldownEndAt) > 0) {
    start(page, options)
    return
  }

  page.cooldownEndAt = 0
  clearStore(options)

  if (page.data && page.data.cooldown !== 0) {
    page.setData({ cooldown: 0 })
  }
}

/**
 * 页面重建时取回未过期的发送记录；过期则顺手清理并返回 null。
 * 返回值形如 { email, endAt }，页面据此回填邮箱与 `page.cooldownEndAt`。
 */
function restore(options) {
  const saved = read(options)
  if (!saved) return null

  if (saved.endAt <= Date.now()) {
    clearStore(options)
    return null
  }

  return saved
}

/**
 * 用户改了邮箱但倒计时还没走完：把记录里的邮箱换成新值，
 * 避免下次页面重建时把旧邮箱回填回输入框。
 */
function adopt(options, email) {
  const saved = read(options)
  if (!saved || !options) return

  write(options, email, saved.endAt)
}

/**
 * 页面 data 里 `cooldown` 字段的初始值。
 *
 * 这个字段只由本模块写入，初始值也一并在本模块给出 ——
 * 由 A 声明、由 B 修改的字段最容易在静态检查里「查无此人」，
 * 也会让页面看不出这个数字是从哪来的。
 */
function getInitialCooldownData() {
  return {
    cooldown: 0
  }
}

module.exports = {
  adopt,
  begin,
  getInitialCooldownData,
  remainingSeconds,
  restore,
  resume,
  start,
  stop
}
