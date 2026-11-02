# 小程序导航体验修复记录

日期：2026-11-02。共享导航已在开发者工具的答题、结果、个人资料和账号安全页面显示；全量自检、真实编译及官方 npm 构建通过。逐帧转场和真机耗时仍待专门采样。

## 页面行为

- 答题页常规保存、排队和服务端处理中状态保持后台运行。界面仅在 `canRetrySync` 为真时显示保存异常与重试入口；交卷错误、登录要求、跨设备交接提示继续使用现有流程。
- 题库名与「顺序练习 · 共 N 题」在同一导航行中上下排列，左侧返回，右侧按微信胶囊实测位置留空。长标题单行省略。结果页和布局编辑器共用 `practice-head.wxml`，题目内容区直接从进度条下方开始。
- `app.json` 统一设置 `navigationStyle: custom`，14 个二级页使用共享 `page-header`。组件计算一次状态栏高度、导航高度和胶囊间距，并在窗口尺寸变化时更新。页面跳转和返回继续调用原生 wx API。
- 二级页内容容器使用导航下方的剩余空间；题目详情改为内部弹性滚动区。返回入口在答题页加载、交接及提交弹层期间保持可操作。

## 导航定位依据

修复前，四个 tab 页配置自定义导航，14 个二级页继承原生白色导航。全量检索页面、公共导航工具和生命周期封装，未发现 `setNavigationBarColor`、`setNavigationBarTitle` 或 `setBackgroundColor` 调用。`utils/navigation.js` 会在当前调用栈执行 wx 路由；首页、题库、复盘、个人中心及底部继续练习入口均复用该路径。四个学习设置入口在目标页读取本机设置，不发 HTTP 请求。

配置混用是本次识别出的背景绘制差异，与反馈图中「白色顶部先出现，首页主体仍在」相符。共享导航将白色顶部并入目标页面内容，移除了二级页独立的原生导航背景。自定义导航替代原生导航栏的用法见微信团队的 [WeUI Navigation 文档](https://wechat-miniprogram.github.io/weui/docs/navigation.html)。对具体转场帧先后顺序的判断仍需原生运行证据。

实际耗时通过现有 `utils/loading-metrics.js` 的 `tap`、`route-call`、`route-complete`、`onLoad`、`onReady` 记录拆分。`route-call` 到 `onReady` 可以观察页面准备时间；点击到 `route-call` 的间隔用于区分入口处理。记录不包含原生动画完成帧，因此应与转场录屏一起判断。当前没有采集新的原生转场样本，不能据此宣称模拟器或真机已提速。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `node tests/navigation-experience.check.js` | 通过：18 个页面配置、14 个二级页单一导航入口、刘海屏/安卓/320px 窗口的安全区、原生返回防重复与无前页回退、正常同步隐藏和异常提示保留 |
| `node tests/compile.check.js` | 通过：29 个 WXSS、28 个 WXML，使用开发者工具自带的真实编译器 |
| `node tests/page-loading.check.js` | 通过：原生路由即时调用、导航锁与失败回退、设置入口零 HTTP 请求 |
| `node tests/trial-layout.check.js` | 通过：试答持久化、离线恢复、题型展示和布局保存失败回滚 |
| `node tests/interaction-audit.check.js` | 8 项通过，包括组件样式隔离与按压反馈 |
| `node tests/tap-simulation.check.js` | 18 项通过 |
| `node tests/auth-pages.check.js` | 105 项通过 |
| `node tests/my-hub.check.js` | 97 项通过 |
| `node tests/wrong-book-favorite.check.js` | 88 项通过 |
| `node tests/result-review.check.js` | 38 项通过 |
| `node tests/font-size.check.js` | 38 项通过 |
| `node tests/route-audit.js` | 通过：13 处静态跳转的目标与路由 API 类型匹配 |

`node scripts/preview-practice.cjs` 生成忽略目录下的 `apps/miniapp/.tmp-preview/practice-preview.html`。独立浏览器核对了 13 个 402×874 画板，包括长标题、结果及六种题型布局编辑；每个画板只有一个导航入口，标题区与胶囊间隔为 8px，长标题发生省略，内容区未越出画板。预览复用实际 ViewModel 和 WXSS，不能验证原生转场或替代真机交互。

原 `mock-exam-remote-entry.check.js` 的仓储替身已补齐 `getResumableSession`，首页跨端续答通过回归。新增账号安全等页面后的最新检查为 42 个自检脚本、31 个 WXML 和 32 个 WXSS 编译、官方 npm 构建通过。

开发者工具曾因页面 JSON 缺少 `usingComponents` 对象而没有渲染全局共享页头，补回空对象后正常显示。个人资料与账号安全页面已实际核对返回箭头、标题和胶囊间距；证据见[三端联调记录](three-client-integration.md)。

## 原生复验入口

由主会话安排原项目 `apps/miniapp` 开发者工具窗口后，核对首页进入练习、登录、错题本、设置、个人资料及返回的转场；分别观察首次进入和再次进入，采集上述生命周期时间与录屏。练习页同时复验加载和交接弹层期间返回、交卷失败重试、长标题和六种题型、布局编辑拖拽。真机需补查刘海屏与安卓胶囊位置、返回手势、键盘和安全区。
