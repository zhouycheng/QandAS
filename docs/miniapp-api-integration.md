# 小程序接口接入台账

核对日期：2026-11-01。接口集合取自 `apps/api/contracts/openapi.yaml`；逐项以当前 Controller 和小程序页面调用链核对。表中“已接入待验收”表示代码已有真实页面或生命周期调用，真机验收须结合运行记录确认。仅存在导出函数的能力不计为接入。页面请求预算与缓存规则见[页面加载说明](miniapp-page-loading.md)。

## 调用与数据约定

- 正式运行由 App 启用在线仓储，公共请求统一经 `repositories/api-transport.js` 使用 `/api/v1`、学生 Bearer token、请求追踪及写入幂等键；管理员接口使用独立管理员身份。
- 页面通过 ViewModel 投影展示字段，Repository 使用 MobX 管理独立资源。目录每页 20 条、错题和收藏每页 5 条，按操作加载；题目正文用于详情和练习。目录及资料缓存 5 分钟、学习摘要和集合列表 30 秒，同账号同查询请求合并。
- `remote-data-repository.js` 的题目展示映射不等于练习快照；答题使用 `online-practice.js` 的修订快照。答案展示遵守确认状态、反馈模式及交卷状态；题目详情在无对应练习上下文时展示题干和选项。
- 最近练习首批读取 20 条；后台等待记录独立保留并提供返回入口。
- 首页只读取学习概览和 1 条公告，公告总数决定动画状态；打开弹窗读取 20 条并支持加载更多，缓存 60 秒。切换账号清理展示缓存并拒收旧账号响应。弹窗通过 root-portal 覆盖底栏，底栏保留并随背景变暗。
- 同一练习的草稿、在途命令和业务版本分别保存；同步确认前保留本地答案。队列限频与跨端接管规则见本轮实现及测试，接口按当前 v1.0 合同统一调用。
- 游客通过公开目录浏览已发布、启用的内容，目录省略个人进度。试答使用独立快照接口，本机累计两次，完整快照成功保存后扣次；草稿、结果和额度保存在 `qandaTrialPractice`，账号切换时保留。正式同步仍只处理账号练习。

## 版本与扩展约束

- 当前基线为 v1.0，合同版本 `1.0.0`。创建练习要求设备标识，进行中的写请求要求有效凭证；进度使用异步命令和落库回执，账号资料统一通过 `GET /me` 读取。
- 练习配置、题目修订与题序在创建时固定。业务版本用于并发校验，本机序号用于确认同步，两者分别递增；接管后服务端为新写入方从零确认序号。
- 后续增加字段优先保持可选；改变题型含义、计分、字段类型或必填条件时使用新接口或新版本。客户端草稿格式独立版本化，未知格式保留数据并提示更新。
- 管理端使用独立认证；用户 Web 复用学生接口、业务版本、幂等及交接协议。统计使用服务端统一口径，答案展示由题型、确认状态和反馈模式共同决定。

## 逐接口记录

权限列“学生”表示登录学生且受资源所有权/可见性校验；“管理员”表示独立后台权限，具体写权限由各 Controller/Service 校验。证据列指静态调用链及自动检查，正式运行验收另行追加。
“游客”仅表示公开发布内容的读取权限；私人资料和学习记录要求登录。公开图片校验其当前所属内容；已发放的正式练习快照图片继续按账号所有权读取。

| 方法与路径 | operationId | 用途 | 适用端 / 权限 | 小程序入口与触发动作 | 调用链 | 接入状态 / 未使用原因与后续建议 | 兼容约束 / 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/admin/administrators` | `Admin_list_GET` | 读取管理员 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/administrators` | `Admin_create_POST` | 创建管理员 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `DELETE /api/v1/admin/administrators/{id}` | `Admin_disable_DELETE` | 停用管理员 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/administrators/{id}` | `Admin_account_GET` | 已选维护者资料 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `PUT /api/v1/admin/administrators/{id}` | `Admin_update_PUT` | 更新管理员 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/announcements` | `Operations_adminAnnouncements_GET` | 读取公告 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/announcements` | `Operations_createAnnouncement_POST` | 创建公告 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `DELETE /api/v1/admin/announcements/{id}` | `Operations_deleteAnnouncement_DELETE` | 删除或撤销公告 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/announcements/{id}` | `Operations_updateAnnouncement_PUT` | 更新公告 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/audit-logs` | `Admin_logs_GET` | 读取操作日志 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/auth/logout` | `Admin_logout_POST` | 创建注销登录 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/auth/me` | `Admin_me_GET` | 读取当前身份 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/auth/sessions` | `Admin_login_POST` | 创建登录会话 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/colleges` | `Catalog_adminColleges_GET` | 读取学院 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/colleges` | `Catalog_createCollege_POST` | 创建学院 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/colleges/{id}` | `Catalog_adminCollege_GET` | 已选学院名称 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `PUT /api/v1/admin/colleges/{id}` | `Catalog_updateCollege_PUT` | 更新学院 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/colleges/{id}/majors` | `Catalog_adminMajors_GET` | 读取专业 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/course-requests` | `Operations_adminRequests_GET` | 读取缺课需求 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/course-requests/{id}` | `Operations_handleRequest_PUT` | 更新缺课需求 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/dashboard` | `Operations_dashboard_GET` | 读取后台概览 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/directory-summary` | `Catalog_directory_GET` | 院级及年级人数聚合 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `GET /api/v1/admin/majors` | `Catalog_allMajors_GET` | 专业分页及搜索 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `POST /api/v1/admin/majors` | `Catalog_createMajor_POST` | 创建专业 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/majors/{id}` | `Catalog_adminMajor_GET` | 已选专业名称 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `PUT /api/v1/admin/majors/{id}` | `Catalog_updateMajor_PUT` | 更新专业 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/question-banks` | `Content_adminBanks_GET` | 读取题库 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/question-banks` | `Content_createBank_POST` | 创建题库 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `DELETE /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_deleteChapter_DELETE` | 删除空章节 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_updateChapter_PUT` | 更新章节 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/question-banks/{id}` | `Content_adminBank_GET` | 读取题库 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/question-banks/{id}` | `Content_updateBank_PUT` | 更新题库 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/question-banks/{id}/chapter-order` | `Content_reorder_PUT` | 更新章节顺序 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/question-banks/{id}/chapters` | `Content_adminChapters_GET` | 读取章节 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/question-banks/{id}/chapters` | `Content_createChapter_POST` | 创建章节 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/question-banks/{id}/images` | `File_upload_POST` | 创建题库图片 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/question-banks/{id}/import-preview` | `Content_preview_POST` | 创建题目导入预览 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/question-banks/{id}/imports` | `Content_importQuestions_POST` | 创建题目导入 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/question-banks/{id}/publication` | `Content_publish_PUT` | 更新题库发布状态 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/question-banks/{id}/publication-checks` | `Content_publicationChecks_GET` | 发布检查 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `GET /api/v1/admin/question-banks/{id}/questions` | `Content_adminQuestions_GET` | 读取题目 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/question-feedback` | `Operations_adminFeedback_GET` | 读取题目反馈 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/question-feedback/{id}` | `Operations_handleFeedback_PUT` | 更新题目反馈 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/questions` | `Content_createQuestion_POST` | 创建题目 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `DELETE /api/v1/admin/questions/{id}` | `Content_deactivateQuestion_DELETE` | 停用题目并保留历史 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/questions/{id}` | `Content_adminQuestion_GET` | 读取题目 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/questions/{id}` | `Content_updateQuestion_PUT` | 更新题目 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/security-policy` | `Admin_policy_GET` | 读取管理员安全策略 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/security-policy` | `Admin_policy_PUT` | 更新管理员安全策略 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/statistics/activity` | `Learning_activity_GET` | 读取平台活跃统计 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/statistics/organizations` | `Learning_organizations_GET` | 读取组织学习统计 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/statistics/rankings` | `Learning_rankings_GET` | 读取学习排名 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/statistics/summary` | `Learning_adminSummary_GET` | 读取学习统计汇总 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/students/{id}/practice-history` | `Learning_studentHistory_GET` | 读取练习历史 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/students/{id}/practice-history/{sessionId}` | `Learning_studentResult_GET` | 读取练习历史 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/students/{id}/statistics` | `Learning_studentSummary_GET` | 读取学习统计 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/subjects` | `Catalog_adminSubjects_GET` | 读取课程 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `POST /api/v1/admin/subjects` | `Catalog_createSubject_POST` | 创建课程 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/subjects/{id}` | `Catalog_adminSubject_GET` | 目标课程元数据 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `PUT /api/v1/admin/subjects/{id}` | `Catalog_updateSubject_PUT` | 更新课程 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/subjects/{id}/user-access` | `Catalog_userAccess_GET` | 课程开放用户分页 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `POST /api/v1/admin/subjects/{id}/user-access` | `Catalog_grant_POST` | 按课程开放用户 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `DELETE /api/v1/admin/subjects/{id}/user-access/{userId}` | `Catalog_revoke_DELETE` | 撤销课程单独开放 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | v1.0；Controller、OpenAPI 与独立 HTTP 检查 |
| `GET /api/v1/admin/users` | `Admin_users_GET` | 读取学生账号 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/admin/users/{id}` | `Admin_user_GET` | 读取学生账号 | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `PUT /api/v1/admin/users/{id}/status` | `Admin_userStatus_PUT` | 更新status | 管理端 / 管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立管理员令牌；Controller + OpenAPI |
| `GET /api/v1/announcements` | `Operations_announcements_GET` | 公告摘要与分页正文 | 小程序、用户 Web / 学生 | 首页提示；打开弹窗及加载更多 | subject-list → SubjectListViewModel → practice-repository → remote-data-repository.refreshAnnouncements → api-transport | 已接入待验收 | 首页 1 条，弹窗每页 20；60 秒缓存；remote-data 自检及开发者工具遮罩验收 |
| `POST /api/v1/auth/email-challenges` | `Identity_requestPublicEmailChallenge_POST` | 验证码挑战 | 小程序、用户 Web / 公开挑战/注册或登录 | 注册/找回密码发送验证码 | register/forgot-password → AuthFormViewModel → auth-repository → auth-gateway → http-gateway → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/auth/email-registrations` | `Identity_registerEmail_POST` | 邮箱注册 | 小程序、用户 Web / 公开挑战/注册或登录 | 注册页提交 | register → RegisterViewModel → auth-repository → auth-gateway → http-gateway → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/auth/password-resets` | `Identity_resetPassword_POST` | 重置密码 | 小程序、用户 Web / 公开挑战/注册或登录 | 找回密码页提交 | forgot-password → ForgotPasswordViewModel → auth-repository → auth-gateway → http-gateway → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/auth/sessions` | `Identity_login_POST` | 创建学生会话 | 小程序、用户 Web / 公开挑战/注册或登录 | 登录页输入邮箱密码 | login → LoginViewModel → auth-repository → auth-gateway → http-gateway → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `DELETE /api/v1/auth/sessions/current` | `Identity_logout_DELETE` | 撤销当前会话 | 小程序、用户 Web / 学生 | 我的退出登录 | my → MyViewModel → auth-repository → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/auth/wechat-registrations` | `Identity_registerWechat_POST` | 注册微信用户 | 小程序、用户 Web / 公开挑战/注册或登录 | 首次微信登录 | login → LoginViewModel → auth-repository → auth-gateway → http-gateway → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/auth/wechat-sessions` | `Identity_wechatLogin_POST` | 微信身份交换 | 小程序、用户 Web / 公开挑战/注册或登录 | 登录页微信登录 | login → LoginViewModel → auth-repository → auth-gateway → http-gateway → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `GET /api/v1/colleges` | `Catalog_colleges_GET` | 学院目录 | 小程序、用户 Web / 公开目录 | 账号页打开院校选择器及加载更多 | account → AccountViewModel → remote-data-repository → api-transport | 已接入待验收 | 每页 100；24 小时缓存；账号页进入不预取；remote-data 自检 |
| `GET /api/v1/colleges/{id}/majors` | `Catalog_majors_GET` | 专业目录 | 小程序、用户 Web / 公开目录 | 个人资料打开专业选择器、加载更多 | account → AccountViewModel → remote-data-repository.loadMajors → api-transport | 已接入待验收 | 停用分类不供新选择；每页 100；旧资料保留 |
| `GET /api/v1/files/{id}` | `File_read_GET` | 题目及材料附件 | 各端 / 按文件可见性 | 答题与题目详情中的附件组件 | practice/question-detail → ViewModel → question-assets → http-gateway；question-images → question-assets | 已接入待验收 | 完整快照下载后落盘；PNG 校验、账号隔离、去重与最多 4 个并发；question-assets 自检 |
| `GET /api/v1/health` | `Health_health_GET` | 健康检查 | 各端 / 公开 | — | — | 基础设施接口；由服务健康检查调用 | 保持状态及版本字段兼容；Controller + OpenAPI |
| `GET /api/v1/me` | `Identity_me_GET` | 读取账号资料 | 小程序、用户 Web / 学生 | 我的/账号页缓存过期更新；登录后读取 | my/account → MyViewModel/AccountViewModel → remote-data-repository → api-transport；登录 → auth-gateway | 已接入待验收 | 5 分钟缓存；可选院校/专业名称；资料编辑与账号隔离自检 |
| `POST /api/v1/me/activity/heartbeat` | `Identity_heartbeat_POST` | 前台在线与访问活跃 | 小程序、用户 Web / 学生 | 登录成功、App.onShow、前台每 60 秒 | App → activity-heartbeat → api-transport | 已接入待验收 | 学生会话；退后台停发；无离线补传；activity-heartbeat 自检与隔离 PG |
| `GET /api/v1/me/course-requests` | `Operations_requests_GET` | 缺课需求处理结果 | 小程序、用户 Web / 学生 | 我的 → 反馈记录 → 课程需求分页 | feedback → FeedbackViewModel → feedback-repository.list → api-transport | 已接入待验收 | 每页 20；按用户读取，拒收旧账号响应 |
| `POST /api/v1/me/course-requests` | `Operations_requestCourse_POST` | 提交缺课需求 | 小程序、用户 Web / 学生 | 无匹配题库 → 反馈缺少课程 | bank-detail → feedback-entry → feedback → FeedbackViewModel → feedback-repository.submit → api-transport | 已接入待验收 | 原内容幂等重试；提交后查看处理结果；feedback 自检 |
| `PUT /api/v1/me/email-binding` | `Identity_changeEmail_PUT` | 更新邮箱绑定 | 小程序、用户 Web / 学生 | — | — | 无完整操作入口；账号页提示/找回密码不等于绑定或改密流程，后续补验证码及确认表单 | 保持当前合同；Controller + OpenAPI |
| `POST /api/v1/me/email-challenges` | `Identity_requestOwnEmailChallenge_POST` | 创建邮箱验证码挑战 | 小程序、用户 Web / 学生 | — | — | 无完整操作入口；账号页提示/找回密码不等于绑定或改密流程，后续补验证码及确认表单 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/me/favorites` | `Discovery_favorites_GET` | 分页收藏列表、全量集合管理 | 小程序、用户 Web / 学生 | 收藏本筛选/排序/翻页；清空操作逐页读取 | wrong-book → WrongBookViewModel → practice-repository → remote-data-repository.refreshCollection/clearFavorites → api-transport | 已接入待验收 | 每页 5；来源名称、practiced 可选；30 秒缓存；分页统计 PostgreSQL 验收 |
| `DELETE /api/v1/me/favorites/{id}` | `Discovery_unfavorite_DELETE` | 取消收藏 | 小程序、用户 Web / 学生 | 答题/详情取消收藏及收藏本管理 | practice/question-detail/wrong-book → 对应 ViewModel → practice-repository → remote-data-repository → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `PUT /api/v1/me/favorites/{id}` | `Discovery_favorite_PUT` | 收藏题目 | 小程序、用户 Web / 学生 | 答题或题目详情收藏 | practice/question-detail → 对应 ViewModel → practice-repository → remote-data-repository → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `GET /api/v1/me/learning-overview` | `Learning_overview_GET` | 学习、目录计数和可续答摘要 | 小程序、用户 Web / 学生 | 首页/复盘刷新；设置复用已有摘要 | subject-list/stats → 对应 ViewModel → practice-repository → remote-data-repository.refreshOverview → api-transport | 已接入待验收 | v1.0 新增能力；30 秒缓存；首页 2 请求自检、PostgreSQL 聚合验收 |
| `PUT /api/v1/me/password` | `Identity_changePassword_PUT` | 更新密码 | 小程序、用户 Web / 学生 | — | — | 无完整操作入口；账号页提示/找回密码不等于绑定或改密流程，后续补验证码及确认表单 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/me/practice-history` | `Learning_history_GET` | 读取练习历史 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/me/practice-history/{id}` | `Learning_record_GET` | 读取练习历史 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `PUT /api/v1/me/profile` | `Identity_updateProfile_PUT` | 保存昵称、学院、专业和当前年级 | 小程序、用户 Web / 学生 | 注册或登录后完善资料；个人资料自由修改 | account → AccountViewModel → remote-data-repository → api-transport | 已接入待验收 | 业务版本；手动年级重设学年；保存后刷新范围并拒收旧响应 |
| `GET /api/v1/me/question-collections/summary` | `Learning_collectionSummary_GET` | 集合计数、筛选计数与科目/题库分布 | 小程序、用户 Web / 学生 | 错题本/收藏本统计卡及筛选项 | wrong-book → WrongBookViewModel → practice-repository → remote-data-repository.refreshCollection → api-transport | 已接入待验收 | kind=WRONG 或 FAVORITE；全集合统计，30 秒缓存；7 条集合分页 5+2 的 PostgreSQL 验收 |
| `GET /api/v1/me/question-feedback` | `Operations_feedback_GET` | 题目纠错处理结果 | 小程序、用户 Web / 学生 | 我的 → 反馈记录 → 题目纠错分页 | feedback → FeedbackViewModel → feedback-repository.list → api-transport | 已接入待验收 | 每页 20；按用户读取，展示管理员回复 |
| `POST /api/v1/me/question-feedback` | `Operations_submitFeedback_POST` | 提交题目纠错 | 小程序、用户 Web / 学生 | 答题工具栏、题目详情 → 纠错 | practice/question-detail → ViewModel → feedback-entry → FeedbackViewModel → feedback-repository.submit → api-transport | 已接入待验收 | 携带稳定题目与修订 ID；原内容幂等重试 |
| `GET /api/v1/me/question-progress` | `Learning_questionProgress_GET` | 逐题最近已判定结果与题库进度 | 小程序、用户 Web / 学生 | — | — | 无入口；页面使用概览、目录进度和集合摘要；后续逐题进度页可接入 | 保留现有合同；静态调用检索及首页请求计数 |
| `GET /api/v1/me/recent-learning` | `Learning_recent_GET` | 最近练习 | 小程序、用户 Web / 学生 | 点击最近练习；题库最近在刷 | subject-list/bank-detail → 对应 ViewModel → practice-repository → remote-data-repository.refreshRecent → api-transport | 已接入待验收 | 每页 20；30 秒缓存；首页继续答题使用 learning-overview；草稿和等待入口自检 |
| `GET /api/v1/me/recommendations` | `Discovery_recommendations_GET` | 读取课程推荐 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/me/sessions` | `Identity_listSessions_GET` | 读取登录会话 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `DELETE /api/v1/me/sessions/{id}` | `Identity_revokeSession_DELETE` | 删除或撤销登录会话 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/me/statistics` | `Learning_summary_GET` | 个人统计；WEEK/MONTH/ALL | 小程序、用户 Web / 学生 | 复盘进入及切换 WEEK/MONTH/ALL | stats → StatsViewModel → practice-repository → remote-data-repository.refreshStatistics → api-transport | 已接入待验收 | 只取当前范围，按 period 缓存 30 秒；remote-data 自检 |
| `GET /api/v1/me/statistics/days` | `Learning_days_GET` | 每日学习量 | 小程序、用户 Web / 学生 | 复盘趋势和热力图 | stats → StatsViewModel → practice-repository → remote-data-repository → api-transport | 已接入待验收 | 复盘读取热力图日期范围；30 秒缓存；日期边界 PostgreSQL 验收 |
| `GET /api/v1/me/subjects` | `Discovery_courses_GET` | 读取课程 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `DELETE /api/v1/me/subjects/{id}` | `Discovery_removeCourse_DELETE` | 删除或撤销课程 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `PUT /api/v1/me/subjects/{id}` | `Discovery_saveCourse_PUT` | 更新课程 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `PUT /api/v1/me/wechat-binding` | `Identity_bindWechat_PUT` | 更新微信绑定 | 小程序、用户 Web / 学生 | — | — | 无完整操作入口；账号页提示/找回密码不等于绑定或改密流程，后续补验证码及确认表单 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/me/wrong-questions` | `Learning_wrong_GET` | 分页错题列表 | 小程序、用户 Web / 学生 | 错题本筛选/排序/翻页 | wrong-book → WrongBookViewModel → practice-repository → remote-data-repository.refreshCollection → api-transport | 已接入待验收 | 每页 5；chip/sort 可选；30 秒缓存；分页统计 PostgreSQL 验收 |
| `GET /api/v1/me/wrong-questions/{id}/history` | `Learning_wrongHistory_GET` | 读取历次答题记录 | 小程序、用户 Web / 学生 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `POST /api/v1/practice/scope-preview` | `Practice_preview_POST` | 预览实际选题范围 | 小程序、用户 Web / 学生、游客 | 题库开始、首页模拟考试、错题或收藏重练 | bank-detail/subject-list/wrong-book → ViewModel → practice-repository.previewRemotePracticeScope → remote-data-repository → api-transport | 已接入待验收 | 完整题组、实际题数、选题 ID 与内容版本复用于创建；资料变更拒收迟到响应 |
| `POST /api/v1/practice/sessions` | `Practice_create_POST` | 创建配置及题目快照 | 小程序、用户 Web / 学生 | 题库配置确认/首页模拟练习/错题收藏练习 | practice → PracticeViewModel → online-practice → api-transport | 已接入待验收 | selectionKind/collectionChip 由后端确定完整范围；快照附带收藏 ID；列表 5 条可创建 7 题，PostgreSQL 验收 |
| `GET /api/v1/practice/sessions/{id}` | `Practice_read_GET` | 读取会话 | 小程序、用户 Web / 学生 | 恢复云端练习 | practice → PracticeViewModel → online-practice → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/practice/sessions/{id}/cancel` | `Practice_cancel_POST` | 创建取消练习 | 小程序、用户 Web / 学生 | — | — | 无入口；离开页面保留草稿，显式取消练习入口待补 | 保持当前合同；Controller + OpenAPI |
| `POST /api/v1/practice/sessions/{id}/finish` | `Practice_finish_POST` | 后端判题与正式结果 | 小程序、用户 Web / 学生 | 交卷及联网后补交 | practice → PracticeViewModel → online-practice → practice-sync-queue/api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `PUT /api/v1/practice/sessions/{id}/items/{itemId}/self-assessment` | `Practice_assess_PUT` | 保存自评结果 | 小程序、用户 Web / 学生 | 简答题自评同步 | practice → PracticeViewModel → online-practice → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `PUT /api/v1/practice/sessions/{id}/progress-ack` | `Practice_progressAck_PUT` | 同步等待落库确认 | 小程序、用户 Web / 学生 | — | — | 无入口；保留原成功即落库合同，当前小程序使用异步命令 | 同一队列，超时原键重试；隔离 PostgreSQL/RabbitMQ 验收 |
| `GET /api/v1/practice/sessions/{id}/result` | `Practice_result_GET` | 读取正式结果 | 小程序、用户 Web / 学生 | 交卷/恢复已完成练习 | practice → PracticeViewModel → online-practice → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `GET /api/v1/practice/sessions/{id}/snapshot` | `Practice_snapshot_GET` | 练习快照与写入所有权 | 小程序、用户 Web / 学生 | 创建/恢复/同步与跨端接管 | practice/App → PracticeViewModel/online-practice → practice-sync-queue/api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/practice/sessions/{id}/writer-acquire` | `Practice_acquireWriter_POST` | 练习快照与写入所有权 | 小程序、用户 Web / 学生 | 创建/恢复/同步与跨端接管 | practice/App → PracticeViewModel/online-practice → practice-sync-queue/api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/practice/sessions/{id}/writer-release` | `Practice_releaseWriter_POST` | 练习快照与写入所有权 | 小程序、用户 Web / 学生 | 创建/恢复/同步与跨端接管 | practice/App → PracticeViewModel/online-practice → practice-sync-queue/api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `GET /api/v1/practice/sessions/{id}/writer-state` | `Practice_writerState_GET` | 练习快照与写入所有权 | 小程序、用户 Web / 学生 | 创建/恢复/同步与跨端接管 | practice/App → PracticeViewModel/online-practice → practice-sync-queue/api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `POST /api/v1/practice/trial-snapshots` | `Practice_trialSnapshot_POST` | 下载公开题库试答快照 | 小程序、用户 Web / 游客 | 题库配置或模拟考试开始试答 | practice → PracticeViewModel.loadTrial → trial-practice.prepare → http-gateway/api-transport | 已接入待验收 | v1.0 新增只读能力；配置、修订、题序与独立判题数据；四题型、存储失败及 PostgreSQL 游客验收 |
| `GET /api/v1/question-banks` | `Content_banks_GET` | 已发布题库目录 | 小程序、用户 Web / 学生、游客 | 题库页当前科目/搜索/翻页；模拟练习选择题库 | bank-detail/subject-list → 对应 ViewModel → practice-repository → remote-data-repository.refreshBanks → api-transport | 已接入待验收 | 每页 20；includeProgress 可选，批量计数；5 分钟缓存；SQL 与分页验收 |
| `GET /api/v1/question-banks/{id}` | `Content_bank_GET` | 获取内容版本和题量 | 小程序、用户 Web / 学生、游客 | 目标题库配置、直达练习及最近练习元数据缺失时 | bank-detail/subject-list/practice → 对应 ViewModel → practice-repository/online-practice → remote-data-repository.loadBank/api-transport | 已接入待验收 | 按 ID 读取元数据；内容版本用于创建校验；保持默认字段行为 |
| `GET /api/v1/question-banks/{id}/chapters` | `Content_chapters_GET` | 读取章节 | 小程序、用户 Web / 学生、游客 | — | — | 无入口；按业务补充入口后接入 | 保持当前合同；Controller + OpenAPI |
| `GET /api/v1/question-banks/{id}/questions` | `Content_questions_GET` | 读取题目 | 小程序、用户 Web / 学生、游客 | — | — | 无入口；按业务补充入口后接入 | 默认完整响应；可选 view=summary；摘要不取答案/解析/选项，PostgreSQL 验收 |
| `GET /api/v1/questions` | `Content_search_GET` | 分页搜索题目摘要 | 小程序、用户 Web / 学生、游客 | 首页搜索关键词和加载更多 | subject-list → SubjectListViewModel → practice-repository → remote-data-repository → api-transport | 已接入待验收 | 每页 20；view=summary；300 ms 输入合并；迟到结果忽略；remote-data 自检 |
| `GET /api/v1/questions/{id}` | `Content_question_GET` | 读取题目正文 | 小程序、用户 Web / 学生、游客 | 错题/收藏进入题目详情 | question-detail → QuestionDetailViewModel → practice-repository → remote-data-repository → api-transport | 已接入待验收 | 版本及幂等规则；页面调用链，定向 Node 自检，待客户端真实业务验收 |
| `GET /api/v1/subjects` | `Catalog_subjects_GET` | 课程目录 | 小程序、用户 Web / 学生、游客 | 题库页进入及科目分页 | bank-detail → BankDetailViewModel → practice-repository → remote-data-repository.refreshSubjects → api-transport | 已接入待验收 | 每页 20；includeProgress 可选，批量计数；5 分钟缓存；PostgreSQL 验收 |
| `GET /api/v1/subjects/{id}` | `Catalog_subject_GET` | 读取课程 | 小程序、用户 Web / 学生、游客 | 直接进入未加载的目标科目 | bank-detail → BankDetailViewModel → practice-repository → remote-data-repository.loadSubject → api-transport | 已接入待验收 | 按 ID 读取；includeProgress 可选；5 分钟缓存；目录第一页外直达自检及 PostgreSQL 验收 |
| `POST /api/v1/practice/sessions/{id}/progress-commands` | `ProgressCommand_submit_POST` | 提交持久进度命令 | 小程序、用户 Web / 学生 | 作答合并、离开、交卷前同步 | practice/App → PracticeViewModel → online-practice → practice-sync-queue/api-transport | 已接入待验收 | 202 保留草稿及原键；恢复、响应丢失、重复投递检查 |
| `GET /api/v1/practice/sessions/{id}/progress-commands/{commandId}` | `ProgressCommand_read_GET` | 读取落库回执 | 小程序、用户 Web / 学生 | 受理后查询、杀进程恢复 | practice/App → online-practice → practice-sync-queue/api-transport | 已接入待验收 | COMMITTED 才确认序号；后续答案保留，跨账号拒读 |
| `GET /api/v1/admin/statistics/online-users` | `OnlineUsers_list_GET` | 在线账号分页明细 | 管理端 / 平台管理员 | — | — | 其他端专用；管理端接入状态见下表 | 与在线卡同一判定；搜索、筛选、会话去重及权限检查 |
| `GET /api/v1/admin/monitoring/sync/stream` | `Monitoring_stream_GET` | SSE 同步健康 | 管理端 / 平台管理员 | — | — | 其他端专用；管理端接入状态见下表 | 5 秒快照；采样状态、权限失效、断线重连检查 |
| `GET /api/v1/admin/monitoring/health` | `Monitoring_health_GET` | 模块接口及任务健康 | 管理端 / 平台管理员 | — | — | 其他端专用；管理端接入状态见下表 | 独立 monitor 与受限只读视图，超时保留采样 |
| `GET /api/v1/admin/sync/dead-letters/head` | `SyncRecovery_head_GET` | 查看死信元数据 | 管理端 / 平台管理员 | — | — | 其他端专用；管理端接入状态见下表 | 只读查看，消息保留；空队列 item=null |
| `POST /api/v1/admin/sync/dead-letters/{commandId}/replay` | `SyncRecovery_replay_POST` | 受控死信处理 | 管理端 / 平台管理员 | — | — | 其他端专用；管理端接入状态见下表 | 原正文摘要校验，发布确认，幂等审计，已完成重复清理 |

当前合同合计 **136** 项操作。小程序有真实调用入口 **46** 项，状态为“已接入待验收”；管理端专用 **71** 项、无完整小程序入口 **18** 项、基础设施接口 **1** 项。方法、路径及 operationId 的集合逐项对齐合同。正式客户端联调另行验收。

## 小程序能力与接口缺口

| 现有能力 | 当前处理 | 后续需要 |
| --- | --- | --- |
| 头像 | 当前账号本地显示；`ProfileInput` 未提供头像字段 | 确认头像文件所有权及资料字段后实现上传与跨端展示 |
| 邮箱提醒 | 设置为本地偏好；服务端未提供订阅及发送计划接口 | 明确订阅、时区、取消及投递规则后接入 |
| 自定义考试倒计时、字号及布局 | 本地偏好；答题生效配置随练习快照管理 | 如需多端同步，增加用户偏好合同 |
| 全科练习 | 多题库时先选择题库，再进入共同配置流程 | 扩展跨题库选题需独立合同和题目归属校验 |
| 错题手动移除 | 云端错题按后端学习结果更新，页面提示复习掌握 | 如需人工归档，增加保留学习历史的状态接口 |
| 用户上传题库 | 题库页入口关闭，直接导入路由由正式应用阻止 | 独立产品阶段确定所有权与管理流程 |
| 历史记录 | 现有最近练习入口可继续未完成练习或查看最近已完成结果 | 后台等待练习可从最近练习选择；独立历史列表和筛选入口待补 |

## 2026-10-31 阶段验证记录

本节保留此前阶段证据；三端兼容检查见[独立验收记录](multi-client-compatibility-verification.md)，本轮队列、SSE 与模块检查见[同步监控验收记录](sync-monitoring-verification.md)。

- 游客读取已发布目录、分页搜索、详情、缓存隔离与不请求个人统计通过；后端公开试答验证包含未发布内容拒绝、修订检查、答案分层和正式记录数量不变。
- `tests/trial-layout.check.js`：两次共享额度、重复创建合并、超时与存储失败、四类题型、离线恢复、登录后回看、账号切换保留额度、布局保存回滚、取消手势和跨屏滚动位置计算通过。
- 后端 9 项单元、28 项 PostgreSQL 集成测试通过；覆盖游客公开图片可读、停用题目或取消发布后不可读及正式练习已有快照图片的所有权规则。118 项操作的合同与 Postman 同步，617 次 HTTP 交换 Schema 校验及 236 段集合脚本语法通过。运行报告位于忽略目录 `apps/api/.backend-runtime/verification/`。
- `tests/remote-data.check.js`：首页 2 个轻量请求、缓存复用、目标科目直达、服务端摘要映射、分页搜索、账号隔离及迟到响应、完整资料更新、答案展示时机通过。
- 首页公告：有/无公告、公告撤下、关闭后持续提示、60 秒缓存复用及账号切换迟到响应检查通过；此前真实后端临时发布 → 首页 ViewModel 可见 → 撤下恢复空态通过（29 次 HTTP 请求，临时公告已清理）。本轮开发者工具核对弹窗遮罩覆盖底栏且保持底栏可见，真机显示待验收。
- `tests/page-loading.check.js`：请求合并、缓存失效与迟到响应、全局并发 4／后台同步 1、官方绑定合并更新与隐藏时释放、立即调用原生路由、设置页零请求及分页失败重试通过。
- `tests/bank-detail-entry.check.js`：75 项通过；`tests/result-review.check.js`：38 项通过。
- `tests/compile.check.js`：26 个 WXSS、25 个 WXML 及 WXS 编译通过，通配符与闭合标签检查通过。
- 上述证据来自本地自动检查；真实接口闭环与请求开销观察见[验收记录](miniapp-integration-verification.md)，微信真机及外部服务验收继续按该记录执行。

## 管理端逐接口调用补充（2026-11-01）

管理端专用接口 71 项，其中页面或登录链实际使用 64 项，7 项暂无入口。所有调用经过 `AdminContentGateway` → `HttpAdminContentGateway`；Mock 按同一方法合同工作。此处“已接入待联调”只表示静态调用链、受控适配器与独立服务检查，不表示已完成真实三端联调。平台管理员可用全部管理能力；内容管理员只能读取目录并维护已分配题库、处理对应题目反馈。

| 方法与路径 | operationId | 管理端入口与调用 | 状态与后续 |
| --- | --- | --- | --- |
| `GET /api/v1/admin/administrators` | `Admin_list_GET` | operations-pages.AdministratorsPage / ResourceSelect → 管理员读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/administrators` | `Admin_create_POST` | operations-pages.AdministratorsPage / ResourceSelect → 管理员读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/administrators/{id}` | `Admin_account_GET` | operations-pages.AdministratorsPage / ResourceSelect → 管理员读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/administrators/{id}` | `Admin_update_PUT` | operations-pages.AdministratorsPage / ResourceSelect → 管理员读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `DELETE /api/v1/admin/administrators/{id}` | `Admin_disable_DELETE` | — | 无入口；管理员编辑页用 PUT 更新停用状态；DELETE 无独立按钮 |
| `GET /api/v1/admin/announcements` | `Operations_adminAnnouncements_GET` | operations-pages.AnnouncementsPage → listAnnouncements/saveAnnouncement/deleteAnnouncement | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/announcements` | `Operations_createAnnouncement_POST` | operations-pages.AnnouncementsPage → listAnnouncements/saveAnnouncement/deleteAnnouncement | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/announcements/{id}` | `Operations_updateAnnouncement_PUT` | operations-pages.AnnouncementsPage → listAnnouncements/saveAnnouncement/deleteAnnouncement | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `DELETE /api/v1/admin/announcements/{id}` | `Operations_deleteAnnouncement_DELETE` | operations-pages.AnnouncementsPage → listAnnouncements/saveAnnouncement/deleteAnnouncement | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/audit-logs` | `Admin_logs_GET` | operations-pages.LogsPage → listOperationLogs | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/auth/logout` | `Admin_logout_POST` | login-page / admin-layout → loginAdmin/currentAdmin/logoutAdmin | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/auth/me` | `Admin_me_GET` | login-page / admin-layout → loginAdmin/currentAdmin/logoutAdmin | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/auth/sessions` | `Admin_login_POST` | login-page / admin-layout → loginAdmin/currentAdmin/logoutAdmin | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/colleges` | `Catalog_adminColleges_GET` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/colleges` | `Catalog_createCollege_POST` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/colleges/{id}` | `Catalog_adminCollege_GET` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/colleges/{id}` | `Catalog_updateCollege_PUT` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/colleges/{id}/majors` | `Catalog_adminMajors_GET` | — | 无入口；专业选择统一使用支持筛选的 GET /admin/majors |
| `GET /api/v1/admin/course-requests` | `Operations_adminRequests_GET` | operations-pages.FeedbackPage → listFeedback/updateFeedback | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/course-requests/{id}` | `Operations_handleRequest_PUT` | operations-pages.FeedbackPage → listFeedback/updateFeedback | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/dashboard` | `Operations_dashboard_GET` | dashboard-page → getDashboardSummary | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/directory-summary` | `Catalog_directory_GET` | colleges-page → getDirectorySummary | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/majors` | `Catalog_allMajors_GET` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/majors` | `Catalog_createMajor_POST` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/majors/{id}` | `Catalog_adminMajor_GET` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/majors/{id}` | `Catalog_updateMajor_PUT` | colleges-page / directory-editor-modal / ResourceSelect / scope-directory → 院系分页、点查及保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/question-banks` | `Content_adminBanks_GET` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/question-banks` | `Content_createBank_POST` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_updateChapter_PUT` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `DELETE /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_deleteChapter_DELETE` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/question-banks/{id}` | `Content_adminBank_GET` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/question-banks/{id}` | `Content_updateBank_PUT` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/question-banks/{id}/chapter-order` | `Content_reorder_PUT` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/question-banks/{id}/chapters` | `Content_adminChapters_GET` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/question-banks/{id}/chapters` | `Content_createChapter_POST` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/question-banks/{id}/images` | `File_upload_POST` | question-content-editor → QuestionImages → uploadImage | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/question-banks/{id}/import-preview` | `Content_preview_POST` | import-questions-modal → previewImport/importQuestions | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/question-banks/{id}/imports` | `Content_importQuestions_POST` | import-questions-modal → previewImport/importQuestions | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/question-banks/{id}/publication` | `Content_publish_PUT` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/question-banks/{id}/publication-checks` | `Content_publicationChecks_GET` | publication-modal → publicationChecks | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/question-banks/{id}/questions` | `Content_adminQuestions_GET` | question-banks-page / bank-workspace-page / questions-manager → 题库、章节、分页题目方法 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/question-feedback` | `Operations_adminFeedback_GET` | operations-pages.FeedbackPage → listFeedback/updateFeedback | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/question-feedback/{id}` | `Operations_handleFeedback_PUT` | operations-pages.FeedbackPage → listFeedback/updateFeedback | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/questions` | `Content_createQuestion_POST` | questions-manager / question-form-drawer / question-detail-drawer → createQuestion/updateQuestion/getQuestion | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/questions/{id}` | `Content_adminQuestion_GET` | questions-manager / question-form-drawer / question-detail-drawer → createQuestion/updateQuestion/getQuestion | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/questions/{id}` | `Content_updateQuestion_PUT` | questions-manager / question-form-drawer / question-detail-drawer → createQuestion/updateQuestion/getQuestion | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `DELETE /api/v1/admin/questions/{id}` | `Content_deactivateQuestion_DELETE` | — | 无入口；题目启停统一使用带 expectedVersion 的 PUT |
| `GET /api/v1/admin/security-policy` | `Admin_policy_GET` | operations-pages.SecurityPage → getSecuritySettings/saveSecuritySettings | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/security-policy` | `Admin_policy_PUT` | operations-pages.SecurityPage → getSecuritySettings/saveSecuritySettings | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/statistics/activity` | `Learning_activity_GET` | activity-page → getActivity | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/statistics/organizations` | `Learning_organizations_GET` | — | 无入口；院级人数使用 directory-summary；组织学习排名无页面 |
| `GET /api/v1/admin/statistics/rankings` | `Learning_rankings_GET` | activity-page → getRankings | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/statistics/summary` | `Learning_adminSummary_GET` | — | 无入口；运营概览用 dashboard 聚合，活跃页用 activity/rankings |
| `GET /api/v1/admin/students/{id}/practice-history` | `Learning_studentHistory_GET` | — | 无入口；用户详情当前展示资料与汇总；历史分页入口待专门设计 |
| `GET /api/v1/admin/students/{id}/practice-history/{sessionId}` | `Learning_studentResult_GET` | — | 无入口；用户详情当前展示资料与汇总；逐卷结果入口待专门设计 |
| `GET /api/v1/admin/students/{id}/statistics` | `Learning_studentSummary_GET` | user-detail-drawer → getUserStatistics | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/subjects` | `Catalog_adminSubjects_GET` | question-banks-page / bank-workspace-page / course-editor-modal / ResourceSelect → 课程读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/subjects` | `Catalog_createSubject_POST` | question-banks-page / bank-workspace-page / course-editor-modal / ResourceSelect → 课程读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/subjects/{id}` | `Catalog_adminSubject_GET` | question-banks-page / bank-workspace-page / course-editor-modal / ResourceSelect → 课程读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/subjects/{id}` | `Catalog_updateSubject_PUT` | question-banks-page / bank-workspace-page / course-editor-modal / ResourceSelect → 课程读取与保存 | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/subjects/{id}/user-access` | `Catalog_userAccess_GET` | course-access-drawer → listSubjectAccess/grantSubjectAccess/revokeSubjectAccess | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `POST /api/v1/admin/subjects/{id}/user-access` | `Catalog_grant_POST` | course-access-drawer → listSubjectAccess/grantSubjectAccess/revokeSubjectAccess | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `DELETE /api/v1/admin/subjects/{id}/user-access/{userId}` | `Catalog_revoke_DELETE` | course-access-drawer → listSubjectAccess/grantSubjectAccess/revokeSubjectAccess | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/users` | `Admin_users_GET` | UsersPage / colleges-page / ResourceSelect / user-detail-drawer → listUsers/getUser/setUserStatus | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `GET /api/v1/admin/users/{id}` | `Admin_user_GET` | UsersPage / colleges-page / ResourceSelect / user-detail-drawer → listUsers/getUser/setUserStatus | 已接入待联调；分页、版本与幂等检查见独立验收记录 |
| `PUT /api/v1/admin/users/{id}/status` | `Admin_userStatus_PUT` | UsersPage / colleges-page / ResourceSelect / user-detail-drawer → listUsers/getUser/setUserStatus | 已接入待联调；分页、版本与幂等检查见独立验收记录 |

## 同步与监控调用补充（2026-11-01）

| 方法与路径 | operationId | 管理端入口与调用 | 状态与证据 |
| --- | --- | --- | --- |
| `GET /api/v1/admin/statistics/online-users` | `OnlineUsers_list_GET` | ActivityPage → OnlineUsersDrawer → getOnlineUsers → HTTP Gateway | 已接入待联调；Mock 抽屉和资料入口、独立 SQL 分页与去重通过 |
| `GET /api/v1/admin/monitoring/sync/stream` | `Monitoring_stream_GET` | MonitoringPage → watchSyncHealth → watchSyncStream | 已接入待联调；流式解析、重连、取消、权限撤销及实际 SSE 检查 |
| `GET /api/v1/admin/monitoring/health` | `Monitoring_health_GET` | MonitoringPage → getSystemHealth | 已接入待联调；可见时 30 秒刷新，独立 monitor JAR 通过 |
| `GET /api/v1/admin/sync/dead-letters/head` | `SyncRecovery_head_GET` | MonitoringPage → 查看待处理死信 → getDeadLetterHead | 已接入待联调；RabbitMQ 队首保留及元数据权限检查 |
| `POST /api/v1/admin/sync/dead-letters/{commandId}/replay` | `SyncRecovery_replay_POST` | 确认处理 → replaySyncCommand | 已接入待联调；原键重试、重放、完成重复清理检查 |

小程序异步进度收到 `202` 后保持原正文与幂等键，回执检查只清理已确认序号。共享请求预算和游客本机试答规则保持原口径。旧 `progress-ack` 作为已落库确认接口保留，当前页面使用新的命令调用链。
