# 接口台账

合同版本为 **1.0.0**，当前包含 **121 项操作**。路径、参数、权限与响应以 [OpenAPI](../apps/api/contracts/openapi.yaml) 为准；[Postman](../apps/api/postman/QandA.postman_collection.json) 提供本地请求入口。

## 调用边界

小程序调用经过 Page、ViewModel、Repository 和统一 HTTP 请求层。目录与统计数据使用分页、缓存、去重和迟到响应保护。正式练习使用固定设备凭证，异步进度返回 202 后保留原命令，收到 COMMITTED 回执才清理已确认序号。交卷等待进度落库。

管理端通过 `AdminContentGateway → HttpAdminContentGateway` 访问同源 `/api/v1` 或配置的服务。认证与浏览器跨服务配置见[开发规范](development.md)。

健康、文件、监控、回执与死信入口按对应职责保留。接口注册、调用方接入、隔离 HTTP 验收和实际页面验收分别记录；运行证据与待验场景见[验收规范](verification.md)及[接口验收说明](../apps/api/acceptance/README.md)。

## 操作清单

### admin

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/administrators` | `Admin_list_GET` | 管理员 |
| `POST /api/v1/admin/administrators` | `Admin_create_POST` | 管理员 |
| `GET /api/v1/admin/administrators/{id}` | `Admin_account_GET` | 管理员 |
| `PUT /api/v1/admin/administrators/{id}` | `Admin_update_PUT` | 管理员 |
| `GET /api/v1/admin/audit-logs` | `Admin_logs_GET` | 管理员 |
| `POST /api/v1/admin/auth/logout` | `Admin_logout_POST` | 管理员 |
| `GET /api/v1/admin/auth/me` | `Admin_me_GET` | 管理员 |
| `POST /api/v1/admin/auth/sessions` | `Admin_login_POST` | 管理员 |
| `GET /api/v1/admin/security-policy` | `Admin_policy_GET` | 管理员 |
| `PUT /api/v1/admin/security-policy` | `Admin_policy_PUT` | 管理员 |
| `GET /api/v1/admin/users` | `Admin_users_GET` | 管理员 |
| `GET /api/v1/admin/users/{id}` | `Admin_user_GET` | 管理员 |
| `PUT /api/v1/admin/users/{id}/status` | `Admin_userStatus_PUT` | 管理员 |

### announcements

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/announcements` | `Operations_adminAnnouncements_GET` | 管理员 |
| `POST /api/v1/admin/announcements` | `Operations_createAnnouncement_POST` | 管理员 |
| `DELETE /api/v1/admin/announcements/{id}` | `Operations_deleteAnnouncement_DELETE` | 管理员 |
| `PUT /api/v1/admin/announcements/{id}` | `Operations_updateAnnouncement_PUT` | 管理员 |
| `GET /api/v1/announcements` | `Operations_announcements_GET` | 学生 |

### catalog

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/colleges` | `Catalog_adminColleges_GET` | 管理员 |
| `POST /api/v1/admin/colleges` | `Catalog_createCollege_POST` | 管理员 |
| `GET /api/v1/admin/colleges/{id}` | `Catalog_adminCollege_GET` | 管理员 |
| `PUT /api/v1/admin/colleges/{id}` | `Catalog_updateCollege_PUT` | 管理员 |
| `GET /api/v1/admin/directory-summary` | `Catalog_directory_GET` | 管理员 |
| `GET /api/v1/admin/majors` | `Catalog_allMajors_GET` | 管理员 |
| `POST /api/v1/admin/majors` | `Catalog_createMajor_POST` | 管理员 |
| `GET /api/v1/admin/majors/{id}` | `Catalog_adminMajor_GET` | 管理员 |
| `PUT /api/v1/admin/majors/{id}` | `Catalog_updateMajor_PUT` | 管理员 |
| `GET /api/v1/admin/subjects` | `Catalog_adminSubjects_GET` | 管理员 |
| `POST /api/v1/admin/subjects` | `Catalog_createSubject_POST` | 管理员 |
| `GET /api/v1/admin/subjects/{id}` | `Catalog_adminSubject_GET` | 管理员 |
| `PUT /api/v1/admin/subjects/{id}` | `Catalog_updateSubject_PUT` | 管理员 |
| `GET /api/v1/admin/subjects/{id}/user-access` | `Catalog_userAccess_GET` | 管理员 |
| `POST /api/v1/admin/subjects/{id}/user-access` | `Catalog_grant_POST` | 管理员 |
| `DELETE /api/v1/admin/subjects/{id}/user-access/{userId}` | `Catalog_revoke_DELETE` | 管理员 |
| `GET /api/v1/colleges` | `Catalog_colleges_GET` | 公开或可选登录 |
| `GET /api/v1/colleges/{id}/majors` | `Catalog_majors_GET` | 公开或可选登录 |
| `GET /api/v1/subjects` | `Catalog_subjects_GET` | 公开或可选登录 |
| `GET /api/v1/subjects/{id}` | `Catalog_subject_GET` | 公开或可选登录 |

### content

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/question-banks` | `Content_adminBanks_GET` | 管理员 |
| `POST /api/v1/admin/question-banks` | `Content_createBank_POST` | 管理员 |
| `DELETE /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_deleteChapter_DELETE` | 管理员 |
| `PUT /api/v1/admin/question-banks/{bankId}/chapters/{id}` | `Content_updateChapter_PUT` | 管理员 |
| `GET /api/v1/admin/question-banks/{id}` | `Content_adminBank_GET` | 管理员 |
| `PUT /api/v1/admin/question-banks/{id}` | `Content_updateBank_PUT` | 管理员 |
| `PUT /api/v1/admin/question-banks/{id}/chapter-order` | `Content_reorder_PUT` | 管理员 |
| `GET /api/v1/admin/question-banks/{id}/chapters` | `Content_adminChapters_GET` | 管理员 |
| `POST /api/v1/admin/question-banks/{id}/chapters` | `Content_createChapter_POST` | 管理员 |
| `POST /api/v1/admin/question-banks/{id}/import-preview` | `Content_preview_POST` | 管理员 |
| `POST /api/v1/admin/question-banks/{id}/imports` | `Content_importQuestions_POST` | 管理员 |
| `PUT /api/v1/admin/question-banks/{id}/publication` | `Content_publish_PUT` | 管理员 |
| `GET /api/v1/admin/question-banks/{id}/publication-checks` | `Content_publicationChecks_GET` | 管理员 |
| `GET /api/v1/admin/question-banks/{id}/questions` | `Content_adminQuestions_GET` | 管理员 |
| `POST /api/v1/admin/questions` | `Content_createQuestion_POST` | 管理员 |
| `DELETE /api/v1/admin/questions/{id}` | `Content_deactivateQuestion_DELETE` | 管理员 |
| `GET /api/v1/admin/questions/{id}` | `Content_adminQuestion_GET` | 管理员 |
| `PUT /api/v1/admin/questions/{id}` | `Content_updateQuestion_PUT` | 管理员 |
| `GET /api/v1/question-banks` | `Content_banks_GET` | 公开或可选登录 |
| `GET /api/v1/question-banks/{id}` | `Content_bank_GET` | 公开或可选登录 |
| `GET /api/v1/question-banks/{id}/chapters` | `Content_chapters_GET` | 公开或可选登录 |
| `GET /api/v1/questions` | `Content_search_GET` | 公开或可选登录 |
| `GET /api/v1/questions/{id}` | `Content_question_GET` | 公开或可选登录 |

### discovery

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/me/favorites` | `Discovery_favorites_GET` | 学生 |
| `DELETE /api/v1/me/favorites/{id}` | `Discovery_unfavorite_DELETE` | 学生 |
| `PUT /api/v1/me/favorites/{id}` | `Discovery_favorite_PUT` | 学生 |
| `GET /api/v1/me/recommendations` | `Discovery_recommendations_GET` | 学生 |

### identity

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `POST /api/v1/auth/email-challenges` | `Identity_requestPublicEmailChallenge_POST` | 公开或可选登录 |
| `POST /api/v1/auth/email-registrations` | `Identity_registerEmail_POST` | 公开或可选登录 |
| `POST /api/v1/auth/password-resets` | `Identity_resetPassword_POST` | 公开或可选登录 |
| `POST /api/v1/auth/sessions` | `Identity_login_POST` | 公开或可选登录 |
| `DELETE /api/v1/auth/sessions/current` | `Identity_logout_DELETE` | 学生 |
| `POST /api/v1/auth/wechat-registrations` | `Identity_registerWechat_POST` | 公开或可选登录 |
| `POST /api/v1/auth/wechat-sessions` | `Identity_wechatLogin_POST` | 公开或可选登录 |
| `GET /api/v1/me` | `Identity_me_GET` | 学生 |
| `POST /api/v1/me/activity/heartbeat` | `Identity_heartbeat_POST` | 学生 |
| `PUT /api/v1/me/email-binding` | `Identity_changeEmail_PUT` | 学生 |
| `POST /api/v1/me/email-challenges` | `Identity_requestOwnEmailChallenge_POST` | 学生 |
| `POST /api/v1/me/email-challenges/{id}/verification` | `Identity_verifyOwnEmailChallenge_POST` | 学生 |
| `PUT /api/v1/me/password` | `Identity_changePassword_PUT` | 学生 |
| `PUT /api/v1/me/profile` | `Identity_updateProfile_PUT` | 学生 |
| `PUT /api/v1/me/wechat-binding` | `Identity_bindWechat_PUT` | 学生 |

### learning

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/students/{id}/statistics` | `Learning_studentSummary_GET` | 管理员 |
| `GET /api/v1/me/learning-overview` | `Learning_overview_GET` | 学生 |
| `GET /api/v1/me/question-collections/summary` | `Learning_collectionSummary_GET` | 学生 |
| `GET /api/v1/me/recent-learning` | `Learning_recent_GET` | 学生 |
| `GET /api/v1/me/statistics` | `Learning_summary_GET` | 学生 |
| `GET /api/v1/me/statistics/days` | `Learning_days_GET` | 学生 |
| `GET /api/v1/me/wrong-questions` | `Learning_wrong_GET` | 学生 |

### monitoring

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/monitoring/health` | `Monitoring_health_GET` | 管理员 |
| `GET /api/v1/admin/monitoring/sync/stream` | `Monitoring_stream_GET` | 管理员 |
| `GET /api/v1/admin/statistics/activity` | `Learning_activity_GET` | 管理员 |
| `GET /api/v1/admin/statistics/online-users` | `OnlineUsers_list_GET` | 管理员 |
| `GET /api/v1/admin/statistics/rankings` | `Learning_rankings_GET` | 管理员 |

### operations

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/course-requests` | `Operations_adminRequests_GET` | 管理员 |
| `PUT /api/v1/admin/course-requests/{id}` | `Operations_handleRequest_PUT` | 管理员 |
| `GET /api/v1/admin/dashboard` | `Operations_dashboard_GET` | 管理员 |
| `GET /api/v1/admin/question-feedback` | `Operations_adminFeedback_GET` | 管理员 |
| `PUT /api/v1/admin/question-feedback/{id}` | `Operations_handleFeedback_PUT` | 管理员 |
| `GET /api/v1/me/course-requests` | `Operations_requests_GET` | 学生 |
| `POST /api/v1/me/course-requests` | `Operations_requestCourse_POST` | 学生 |
| `GET /api/v1/me/question-feedback` | `Operations_feedback_GET` | 学生 |
| `POST /api/v1/me/question-feedback` | `Operations_submitFeedback_POST` | 学生 |

### platform

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/community/group` | `CommunityGroup_adminGroup_GET` | 管理员 |
| `PUT /api/v1/admin/community/group` | `CommunityGroup_save_PUT` | 管理员 |
| `POST /api/v1/admin/question-banks/{id}/images` | `File_upload_POST` | 管理员 |
| `GET /api/v1/community/group` | `CommunityGroup_publicGroup_GET` | 公开或可选登录 |
| `GET /api/v1/community/group/image` | `CommunityGroup_image_GET` | 公开或可选登录 |
| `GET /api/v1/files/{id}` | `File_read_GET` | 公开或可选登录 |
| `GET /api/v1/health` | `Health_health_GET` | 公开或可选登录 |

### practice

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `POST /api/v1/practice/scope-preview` | `Practice_preview_POST` | 公开或可选登录 |
| `POST /api/v1/practice/sessions` | `Practice_create_POST` | 学生 |
| `GET /api/v1/practice/sessions/{id}` | `Practice_read_GET` | 学生 |
| `POST /api/v1/practice/sessions/{id}/cancel` | `Practice_cancel_POST` | 学生 |
| `POST /api/v1/practice/sessions/{id}/finish` | `Practice_finish_POST` | 学生 |
| `PUT /api/v1/practice/sessions/{id}/items/{itemId}/self-assessment` | `Practice_assess_PUT` | 学生 |
| `GET /api/v1/practice/sessions/{id}/result` | `Practice_result_GET` | 学生 |
| `GET /api/v1/practice/sessions/{id}/snapshot` | `Practice_snapshot_GET` | 学生 |
| `POST /api/v1/practice/trial-snapshots` | `Practice_trialSnapshot_POST` | 公开或可选登录 |

### sync

| 方法与路径 | operationId | 权限范围 |
| --- | --- | --- |
| `GET /api/v1/admin/sync/dead-letters/head` | `SyncRecovery_head_GET` | 管理员 |
| `POST /api/v1/admin/sync/dead-letters/{commandId}/replay` | `SyncRecovery_replay_POST` | 管理员 |
| `POST /api/v1/practice/sessions/{id}/progress-commands` | `ProgressCommand_submit_POST` | 学生 |
| `GET /api/v1/practice/sessions/{id}/progress-commands/{commandId}` | `ProgressCommand_read_GET` | 学生 |
