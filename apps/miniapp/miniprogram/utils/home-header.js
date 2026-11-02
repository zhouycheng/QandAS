function getInitialHomeHeaderData(windowInfo, menuButton) {
  const info = windowInfo || {}
  const statusBarHeight = Number.isFinite(info.statusBarHeight) && info.statusBarHeight >= 0 ? info.statusBarHeight : 20
  const hasMenu = menuButton && menuButton.height > 0 && menuButton.top >= statusBarHeight
  const windowWidth = Number.isFinite(info.windowWidth) && info.windowWidth > 0 ? info.windowWidth : 375
  const menuLeft = hasMenu && Number.isFinite(menuButton.left) && menuButton.left > windowWidth / 2 && menuButton.left < windowWidth ? menuButton.left : windowWidth - 96
  return {
    homeStatusBarHeight: statusBarHeight,
    homeNavigationBarHeight: hasMenu ? (menuButton.top - statusBarHeight) * 2 + menuButton.height : 44,
    homeNavigationRight: windowWidth - menuLeft + 8
  }
}

module.exports = { getInitialHomeHeaderData }
