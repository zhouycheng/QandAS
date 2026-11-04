const navigation = require('../utils/navigation.js')

/**
 * tab 索引 → 页面路径。
 * 顺序必须与 app.json 的 tabBar.list 一致，自检 tests/custom-tabbar.check.js 会比对。
 *
 * 第 3 个 tab 的路由仍是 page/stats/index（改路由要动 app.json、测试和所有深链，
 * 收益为零），但产品名已改为「复盘」：这一页现在讲的是「这段时间练得怎么样」，
 * 不再是以前那张成绩统计表。
 */
const TAB_ROUTES = [
  { pagePath: '/page/subject-list/index', key: 'home' },
  { pagePath: '/page/bank-detail/index', key: 'bank' },
  { pagePath: '/page/stats/index', key: 'review' },
  { pagePath: '/page/my/index', key: 'my' }
]

function findTabIndexByRoute(route) {
  const path = typeof route === 'string' ? route.split('?')[0] : ''

  if (!path) {
    return -1
  }

  const normalized = path.charAt(0) === '/' ? path : `/${path}`

  return TAB_ROUTES.findIndex((tab) => tab.pagePath === normalized)
}

Component({
  options: {
    styleIsolation: 'apply-shared'
  },

  data: {
    selected: 0,
    tabs: [
      { key: 'home', text: '首页', icon: '/assets/tabbar/home.png', activeIcon: '/assets/tabbar/home-active.png' },
      { key: 'bank', text: '题库', icon: '/assets/tabbar/bank.png', activeIcon: '/assets/tabbar/bank-active.png' },
      { key: 'review', text: '复盘', icon: '/assets/tabbar/review.png', activeIcon: '/assets/tabbar/review-active.png' },
      { key: 'my', text: '我的', icon: '/assets/tabbar/my.png', activeIcon: '/assets/tabbar/my-active.png' }
    ]
  },

  lifetimes: {
    attached() {
      // 组件实例可能早于页面 onShow 创建，先按当前页面栈定位一次
      this.syncFromRoute()
    }
  },

  methods: {
    syncFromRoute() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      const current = pages.length ? pages[pages.length - 1] : null
      const route = current && current.route ? current.route : ''
      const index = findTabIndexByRoute(route)

      if (index >= 0) this.setSelected(route)

      return index
    },



    setSelected(route) {
      const index = findTabIndexByRoute(route)
      if (index >= 0 && index !== this.data.selected) this.setData({ selected: index })
    },

    handleTabTap(e) {
      const index = Number(e.currentTarget.dataset.index)
      const tab = TAB_ROUTES[index]

      if (!tab) {
        return
      }

      if (index === this.data.selected) {
        // 已在当前 tab：重新点一次不重复 switchTab（会闪一下），直接忽略
        return
      }

      navigation.switchTab({
        url: tab.pagePath,
        fail: () => {
          wx.showToast({
            title: '页面暂不可用',
            icon: 'none'
          })
        }
      })
    }
  }
})
