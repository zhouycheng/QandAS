const { getInitialHomeHeaderData } = require('../../utils/home-header.js')
const navigation = require('../../utils/navigation.js')

Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' }
  },
  data: getInitialHomeHeaderData(),
  lifetimes: { attached() { this.updateLayout() } },
  pageLifetimes: { resize() { this.updateLayout() } },
  methods: {
    updateLayout() {
      this.setData(getInitialHomeHeaderData(
        typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : {},
        typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null
      ))
    },
    goBack() {
      if (this.navigatingBack) return
      this.navigatingBack = true
      wx.navigateBack({
        fail: () => navigation.switchTab({ url: '/page/subject-list/index' }),
        complete: () => { this.navigatingBack = false }
      })
    }
  }
})
