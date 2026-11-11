# 接口接入台账

合同版本为 **1.0.0**，当前包含 **137 项操作**。路径、参数及响应以 [OpenAPI](../apps/api/contracts/openapi.yaml) 为准；[Postman](../apps/api/postman/QandA.postman_collection.json) 提供请求模板，凭据变量由使用者填写。

## 调用与身份

小程序通过 Page、ViewModel、Repository 和统一请求层调用接口。普通用户使用邮箱验证码或微信首次验证后直接取得会话；`POST /auth/sessions` 仅接受实际存在、启用且未到期的测试账号固定登录码。账号绑定冲突明确拒绝，邮箱更换验证新旧身份并撤销旧会话。资料只包含昵称、头像与绑定信息。

首页、题库、复盘、我的使用四个等宽 Tab，首页答题卡提供续答与创建入口。题库搜索框下的学院、专业、年级筛选保存在本机，查询参数、分页和缓存共同使用相同条件；切换账号保留筛选，私人学习数据继续隔离。公开 ID 直达读取不受分类筛选限制。

管理端通过 `AdminContentGateway → HttpAdminContentGateway` 调用 `/api/v1`。版本检查、幂等键、固定设备写凭据、不可变修订、确认序号与交卷屏障沿用现有协议。异步进度返回 202 后保留本机命令，收到 COMMITTED 回执才清理对应序号。

## 写入检测与注销

用户提交的昵称、头像、反馈及缺课需求使用绑定当前会话、对象、内容摘要和业务版本的检测结果，写入引用 `X-Content-Safety-Request`。小程序通过新鲜微信 code 建立独立检测上下文。待检测媒体仅允许临时受限取件，检测通过后才保存。接口路径和 DTO 见下表及[内容安全](content-safety.md)。

`POST /me/deletion-confirmations` 复核当前登录身份，返回限时、一次性的注销证明。`DELETE /me` 使用证明、明确确认及幂等键完成注销；回执允许在会话已撤销后重试。调用方随后清理当前设备上该账号的私人数据。

## 操作清单

### admin

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/administrators` | `Admin_list_GET` | 管理员会话 |
| `POST /api/v1/admin/administrators` | `Admin_create_POST` | 管理员会话 |
| `GET /api/v1/admin/administrators/{id}` | `Admin_account_GET` | 管理员会话 |
| `PUT /api/v1/admin/administrators/{id}` | `Admin_update_PUT` | 管理员会话 |
| `GET /api/v1/admin/audit-logs` | `Admin_logs_GET` | 管理员会话 |
| `POST /api/v1/admin/auth/logout` | `Admin_logout_POST` | 管理员会话 |
| `GET /api/v1/admin/auth/me` | `Admin_me_GET` | 管理员会话 |
| `POST /api/v1/admin/auth/sessions` | `Admin_login_POST` | 公开或可选登录 |
| `GET /api/v1/admin/security-policy` | `Admin_policy_GET` | 管理员会话 |
| `PUT /api/v1/admin/security-policy` | `Admin_policy_PUT` | 管理员会话 |
| `GET /api/v1/admin/test-accounts` | `TestAccount_list_GET` | 管理员会话 |
| `POST /api/v1/admin/test-accounts` | `TestAccount_create_POST` | 管理员会话 |
| `GET /api/v1/admin/test-accounts/{id}/credentials` | `TestAccount_credentials_GET` | 管理员会话 |
| `PUT /api/v1/admin/test-accounts/{id}/status` | `TestAccount_disable_PUT` | 管理员会话 |
| `GET /api/v1/admin/users` | `Admin_users_GET` | 管理员会话 |
| `GET /api/v1/admin/users/{id}` | `Admin_user_GET` | 管理员会话 |
| `PUT /api/v1/admin/users/{id}` | `Admin_updateUserProfile_PUT` | 管理员会话 |
| `PUT /api/v1/admin/users/{id}/status` | `Admin_userStatus_PUT` | 管理员会话 |

### announcements

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/announcements` | `Operations_adminAnnouncements_GET` | 管理员会话 |
| `POST /api/v1/admin/announcements` | `Operations_createAnnouncement_POST` | 管理员会话 |
| `DELETE /api/v1/admin/announcements/{id}` | `Operations_deleteAnnouncement_DELETE` | 管理员会话 |
| `PUT /api/v1/admin/announcements/{id}` | `Operations_updateAnnouncement_PUT` | 管理员会话 |
| `GET /api/v1/announcements` | `Operations_announcements_GET` | 用户会话 |

### catalog

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/colleges` | `Catalog_adminColleges_GET` | 管理员会话 |
| `POST /api/v1/admin/colleges` | `Catalog_createCollege_POST` | 管理员会话 |
| `GET /api/v1/admin/colleges/{id}` | `Catalog_adminCollege_GET` | 管理员会话 |
| `PUT /api/v1/admin/colleges/{id}` | `Catalog_updateCollege_PUT` | 管理员会话 |
| `GET /api/v1/admin/directory-summary` | `Catalog_directory_GET` | 管理员会话 |
| `GET /api/v1/admin/majors` | `Catalog_allMajors_GET` | 管理员会话 |
| `POST /api/v1/admin/majors` | `Catalog_createMajor_POST` | 管理员会话 |
| `GET /api/v1/admin/majors/{id}` | `Catalog_adminMajor_GET` | 管理员会话 |
| `PUT /api/v1/admin/majors/{id}` | `Catalog_updateMajor_PUT` | 管理员会话 |
| `GET /api/v1/admin/subjects` | `Catalog_adminSubjects_GET` | 管理员会话 |
| `POST /api/v1/admin/subjects` | `Catalog_createSubject_POST` | 管理员会话 |
| `GET /api/v1/admin/subjects/{id}` | `Catalog_adminSubject_GET` | 管理员会话 |
| `PUT /api/v1/admin/subjects/{id}` | `Catalog_updateSubject_PUT` | 管理员会话 |
| `GET /api/v1/colleges` | `Catalog_colleges_GET` | 公开或可选登录 |
| `GET /api/v1/colleges/{id}/majors` | `Catalog_majors_GET` | 公开或可选登录 |
| `GET /api/v1/subjects` | `Catalog_subjects_GET` | 公开或可选登录 |
| `GET /api/v1/subjects/{id}` | `Catalog_subject_GET` | 公开或可选登录 |

### content

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/question-banks` | `Content_adminBanks_GET` | 管理员会话 |
| `POST /api/v1/admin/question-banks` | `Content_createBank_POST` | 管理员会话 |
| `DELETE /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_deleteChapter_DELETE` | 管理员会话 |
| `PUT /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_updateChapter_PUT` | 管理员会话 |
| `GET /api/v1/admin/question-banks/{id}` | `Content_adminBank_GET` | 管理员会话 |
| `PUT /api/v1/admin/question-banks/{id}` | `Content_updateBank_PUT` | 管理员会话 |
| `PUT /api/v1/admin/question-banks/{id}/chapter-order` | `Content_reorder_PUT` | 管理员会话 |
| `GET /api/v1/admin/question-banks/{id}/chapters` | `Content_adminChapters_GET` | 管理员会话 |
| `POST /api/v1/admin/question-banks/{id}/chapters` | `Content_createChapter_POST` | 管理员会话 |
| `POST /api/v1/admin/question-banks/{id}/import-preview` | `Content_preview_POST` | 管理员会话 |
| `POST /api/v1/admin/question-banks/{id}/imports` | `Content_importQuestions_POST` | 管理员会话 |
| `PUT /api/v1/admin/question-banks/{id}/publication` | `Content_publish_PUT` | 管理员会话 |
| `GET /api/v1/admin/question-banks/{id}/publication-checks` | `Content_publicationChecks_GET` | 管理员会话 |
| `GET /api/v1/admin/question-banks/{id}/questions` | `Content_adminQuestions_GET` | 管理员会话 |
| `POST /api/v1/admin/questions` | `Content_createQuestion_POST` | 管理员会话 |
| `DELETE /api/v1/admin/questions/{id}` | `Content_deactivateQuestion_DELETE` | 管理员会话 |
| `GET /api/v1/admin/questions/{id}` | `Content_adminQuestion_GET` | 管理员会话 |
| `PUT /api/v1/admin/questions/{id}` | `Content_updateQuestion_PUT` | 管理员会话 |
| `GET /api/v1/question-banks` | `Content_banks_GET` | 公开或可选登录 |
| `GET /api/v1/question-banks/{id}` | `Content_bank_GET` | 公开或可选登录 |
| `GET /api/v1/question-banks/{id}/chapters` | `Content_chapters_GET` | 公开或可选登录 |
| `GET /api/v1/questions` | `Content_search_GET` | 公开或可选登录 |
| `GET /api/v1/questions/{id}` | `Content_question_GET` | 公开或可选登录 |
| `GET /api/v1/search` | `Search_search_GET` | 公开或可选登录 |

### contentsafety

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/content-safety/media/{id}` | `ContentSafety_media_GET` | 限时取件凭据 |
| `GET /api/v1/content-safety/wechat-callback` | `ContentSafety_echo_GET` | 微信签名／加密消息 |
| `POST /api/v1/content-safety/wechat-callback` | `ContentSafety_callback_POST` | 微信签名／加密消息 |
| `POST /api/v1/me/content-safety/contexts` | `ContentSafety_context_POST` | 用户会话 |
| `POST /api/v1/me/content-safety/requests` | `ContentSafety_prepare_POST` | 用户会话 |
| `GET /api/v1/me/content-safety/requests/{id}` | `ContentSafety_status_GET` | 用户会话 |

### discovery

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/me/favorites` | `Discovery_favorites_GET` | 用户会话 |
| `DELETE /api/v1/me/favorites/{id}` | `Discovery_unfavorite_DELETE` | 用户会话 |
| `PUT /api/v1/me/favorites/{id}` | `Discovery_favorite_PUT` | 用户会话 |
| `GET /api/v1/me/recommendations` | `Discovery_recommendations_GET` | 用户会话 |

### excel

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/question-banks/excel/export` | `Excel_export_GET_admin_question_banks_excel_export` | 管理员会话 |
| `POST /api/v1/admin/question-banks/excel/imports` | `Excel_import_POST_admin_question_banks_excel_imports` | 管理员会话 |
| `POST /api/v1/admin/question-banks/excel/preview` | `Excel_preview_POST_admin_question_banks_excel_preview` | 管理员会话 |
| `GET /api/v1/admin/question-banks/excel/template` | `Excel_template_GET_admin_question_banks_excel_template` | 管理员会话 |
| `GET /api/v1/admin/users/excel/export` | `Excel_export_GET_admin_users_excel_export` | 管理员会话 |
| `POST /api/v1/admin/users/excel/imports` | `Excel_import_POST_admin_users_excel_imports` | 管理员会话 |
| `POST /api/v1/admin/users/excel/preview` | `Excel_preview_POST_admin_users_excel_preview` | 管理员会话 |
| `GET /api/v1/admin/users/excel/template` | `Excel_template_GET_admin_users_excel_template` | 管理员会话 |

### identity

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `POST /api/v1/auth/email-challenges` | `Identity_requestPublicEmailChallenge_POST` | 公开或可选登录 |
| `POST /api/v1/auth/email-code-sessions` | `Identity_emailCodeLogin_POST` | 公开或可选登录 |
| `POST /api/v1/auth/sessions` | `Identity_login_POST` | 公开或可选登录 |
| `DELETE /api/v1/auth/sessions/current` | `Identity_logout_DELETE` | 用户会话 |
| `POST /api/v1/auth/wechat-sessions` | `Identity_wechatLogin_POST` | 公开或可选登录 |
| `DELETE /api/v1/me` | `AccountDeletion_erase_DELETE` | 注销证明与幂等键 |
| `GET /api/v1/me` | `Identity_me_GET` | 用户会话 |
| `POST /api/v1/me/activity/heartbeat` | `Identity_heartbeat_POST` | 用户会话 |
| `POST /api/v1/me/deletion-confirmations` | `AccountDeletion_prepare_POST` | 用户会话 |
| `PUT /api/v1/me/email-binding` | `Identity_changeEmail_PUT` | 用户会话 |
| `POST /api/v1/me/email-challenges` | `Identity_requestOwnEmailChallenge_POST` | 用户会话 |
| `POST /api/v1/me/email-challenges/{id}/verification` | `Identity_verifyOwnEmailChallenge_POST` | 用户会话 |
| `PUT /api/v1/me/profile` | `Identity_updateProfile_PUT` | 用户会话 |
| `PUT /api/v1/me/wechat-binding` | `Identity_bindWechat_PUT` | 用户会话 |

### learning

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/students/{id}/statistics` | `Learning_studentSummary_GET` | 管理员会话 |
| `GET /api/v1/me/learning-overview` | `Learning_overview_GET` | 用户会话 |
| `GET /api/v1/me/question-collections/summary` | `Learning_collectionSummary_GET` | 用户会话 |
| `GET /api/v1/me/recent-learning` | `Learning_recent_GET` | 用户会话 |
| `GET /api/v1/me/statistics` | `Learning_summary_GET` | 用户会话 |
| `GET /api/v1/me/statistics/days` | `Learning_days_GET` | 用户会话 |
| `GET /api/v1/me/wrong-questions` | `Learning_wrong_GET` | 用户会话 |

### monitoring

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/monitoring/health` | `Monitoring_health_GET` | 管理员会话 |
| `GET /api/v1/admin/monitoring/sync/stream` | `Monitoring_stream_GET` | 管理员会话 |
| `GET /api/v1/admin/statistics/activity` | `Learning_activity_GET` | 管理员会话 |
| `GET /api/v1/admin/statistics/online-users` | `OnlineUsers_list_GET` | 管理员会话 |
| `GET /api/v1/admin/statistics/rankings` | `Learning_rankings_GET` | 管理员会话 |

### operations

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/course-requests` | `Operations_adminRequests_GET` | 管理员会话 |
| `PUT /api/v1/admin/course-requests/{id}` | `Operations_handleRequest_PUT` | 管理员会话 |
| `GET /api/v1/admin/dashboard` | `Operations_dashboard_GET` | 管理员会话 |
| `GET /api/v1/admin/question-feedback` | `Operations_adminFeedback_GET` | 管理员会话 |
| `PUT /api/v1/admin/question-feedback/{id}` | `Operations_handleFeedback_PUT` | 管理员会话 |
| `GET /api/v1/me/course-requests` | `Operations_requests_GET` | 用户会话 |
| `POST /api/v1/me/course-requests` | `Operations_requestCourse_POST` | 用户会话 |
| `GET /api/v1/me/question-feedback` | `Operations_feedback_GET` | 用户会话 |
| `POST /api/v1/me/question-feedback` | `Operations_submitFeedback_POST` | 用户会话 |

### platform

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `GET /api/v1/admin/community/group` | `CommunityGroup_adminGroup_GET` | 管理员会话 |
| `PUT /api/v1/admin/community/group` | `CommunityGroup_save_PUT` | 管理员会话 |
| `POST /api/v1/admin/question-banks/{id}/images` | `File_upload_POST` | 管理员会话 |
| `GET /api/v1/community/group` | `CommunityGroup_publicGroup_GET` | 公开或可选登录 |
| `GET /api/v1/community/group/image` | `CommunityGroup_image_GET` | 公开或可选登录 |
| `GET /api/v1/files/{id}` | `File_read_GET` | 公开或可选登录 |
| `GET /api/v1/health` | `Health_health_GET` | 公开或可选登录 |

### practice

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `POST /api/v1/practice/scope-preview` | `Practice_preview_POST` | 公开或可选登录 |
| `POST /api/v1/practice/sessions` | `Practice_create_POST` | 用户会话 |
| `GET /api/v1/practice/sessions/{id}` | `Practice_read_GET` | 用户会话 |
| `POST /api/v1/practice/sessions/{id}/cancel` | `Practice_cancel_POST` | 用户会话 |
| `PUT /api/v1/practice/sessions/{id}/items/{itemId}/self-assessment` | `Practice_assess_PUT` | 用户会话 |
| `GET /api/v1/practice/sessions/{id}/result` | `Practice_result_GET` | 用户会话 |
| `GET /api/v1/practice/sessions/{id}/snapshot` | `Practice_snapshot_GET` | 用户会话 |
| `POST /api/v1/practice/trial-snapshots` | `Practice_trialSnapshot_POST` | 公开或可选登录 |

### sync

| 方法与路径 | operationId | 访问凭据 |
| --- | --- | --- |
| `POST /api/v1/admin/sync/dead-letters/{commandId}/replay` | `SyncRecovery_replay_POST` | 管理员会话 |
| `GET /api/v1/admin/sync/dead-letters/head` | `SyncRecovery_head_GET` | 管理员会话 |
| `GET /api/v1/practice/sessions/{id}/sync-commands` | `ProgressCommand_checkpoint_GET` | 用户会话 |
| `POST /api/v1/practice/sessions/{id}/sync-commands` | `ProgressCommand_submit_POST` | 用户会话 |
| `GET /api/v1/practice/sessions/{id}/sync-commands/{commandId}` | `ProgressCommand_read_GET` | 用户会话 |

## 验收记录

接口注册、客户端接入、成功 HTTP 观察、Schema 校验和真机表现分别记录。本地验收复用隔离 PostgreSQL、RabbitMQ、Prometheus 与邮件捕获环境；微信本地提供端用于业务和错误路径验证。真实微信文本检测、媒体取件与回调以及真机验证单独记录。生成与校验入口见[接口验收说明](../apps/api/acceptance/README.md)，逐操作观察存放在忽略目录的 `operation-coverage.json`。
