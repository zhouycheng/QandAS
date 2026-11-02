# QandA 管理端

管理端使用 React、TypeScript、Vite、Arco Design、TanStack Query 和 Zustand。界面、Mock 与 HTTP Gateway 共用业务类型、分页和版本合同，服务接口基线为 `/api/v1`。

## 运行

```sh
npm --prefix packages/content-format ci
npm --prefix packages/content-format run build
cd apps/admin
pnpm install
pnpm dev
```

默认使用本机 Mock，登录示例为 `admin / mock`。配置 `VITE_API_BASE_URL` 后使用 HTTP Gateway 和真实管理员会话；地址与凭据保存在仓库外的本机配置中。HTTP 模式不会使用演示账号兜底。

所有管理员均为超级管理员，可管理运营、题库、反馈、公告、用户和系统设置。在侧栏“设置 → 管理员账号”创建、编辑和停用账号；至少保留一个启用的管理员。每个账号使用独立会话，停用或重置密码后该账号的会话失效。安全规则仅在对应页面加载。

## 业务入口

- 院级管理：学院、专业的服务端分页与启停，固定五档当前年级及学生人数；学生可自行修改资料。
- 题库工作台：课程、课程单独开放名单、题库维护者、展示范围、章节和六类内容；维护者用于标识分工，所有管理员均可管理题库。下架与归档保留历史。
- 题目编辑：Markdown 源码与完整预览、代码高亮和图片附件，填空多答案、主观参考内容、阅读稳定小题 ID。JSON 整批最多 3000 道作答题、8 MiB。
- 活跃度监控：在线、日活、近 7 日与近 30 日活跃人数；趋势、三种排序和分页排行榜；用户详情显示正式学习摘要。
- 当前在线：点击人数卡打开分页账号明细，沿用筛选、支持搜索；昵称进入已有用户详情。
- 系统监控：通过 SSE 展示排队、处理、生产／消费速率、唯一落库速率和延迟；包含接口健康、后台任务及受控死信处理。隐藏页面停止订阅，失败保留最后成功采样。
- 学生反馈：题目纠错及缺课需求的分页处理；回复与状态通过版本校验保存。

请求超时、限流和服务错误重试沿用原写意图幂等键；账号切换拒收旧响应。列表使用服务端分页，选择器打开后读取第一页，已选资源按 ID 补名称。

## 独立验证

```sh
pnpm test
pnpm build
```

Mock 提供正常、空数据、失败、写入失败、慢请求和大题库场景，使用独立的 v1 本机演示存储。在线样例会按 120 秒窗口超时。Mock 图片保存在本次页面运行内，刷新后需要重新上传。

HTTP Gateway 测试使用受控 fetch 响应，覆盖分页、题型、身份、版本冲突、请求追踪、幂等重试和图片。浏览器管理端已经对接独立后端，并与微信开发者工具完成题库发布到作答、公告反馈及同步监控等页面闭环；逐项证据和剩余检查见[三端联调记录](../../docs/three-client-integration.md)。

- [题型、答题交互与 Markdown](../../docs/question-content-and-practice.md)
- [统一业务规则与三端调整](../../docs/multi-client-compatibility.md)
- [院级管理](../../docs/admin-college-management.md)
- [题库工作台](../../docs/admin-bank-workbench.md)
- [同步与监控](../../docs/sync-monitoring.md)
- [同步监控验收记录](../../docs/sync-monitoring-verification.md)
