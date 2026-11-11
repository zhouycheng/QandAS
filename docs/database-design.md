# 数据库设计

应用与 API 版本为 `1.0.0`。V1 初始化结构由 `apps/api/src/main/resources/db/schema.sql` 定义；监控只读权限由同目录 `monitoring-permissions.sql` 定义。V2、V3 迁移分别提供可用题目与可见题库视图，生产部署由 Flyway 顺序执行。下表根据隔离 PostgreSQL 实际初始化后的结构整理，共 45 张业务表。启动时校验当前结构；结构不一致时停止启动，按[开发与运行](development.md)核实迁移记录、备份和目标环境后处理。

普通用户保存邮箱与微信绑定，测试登录码哈希及加密凭据归测试账号表，管理员密码独立保存。学院、专业和年级描述题库分类，空分类表示通用目录。批量查询通过 `visible_question_bank` 与 `active_question` 视图计算可见性和可用题目；`bank_visible`、`question_active` 提供同一规则的单项判断，分类列表使用 `bank_matches_category`。

题目稳定身份与不可变修订分离，练习固定题目和材料修订。历史结果、同步序号与交卷屏障沿用数据库约束。内容检测上下文、请求、媒体和回调持久化；注销证明完成后与账号及会话外键解耦，保留限时幂等回执。个人头像和待检测媒体随对应账号／任务清理。具体事务与访问规则见[产品规则](product-rules.md)、[内容安全](content-safety.md)及[同步监控](sync-monitoring.md)。

## 表与字段

### `account_deletion_proof`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `token_digest` | `bytea` | 否 | — |
| `user_id` | `uuid` | 是 | — |
| `session_id` | `uuid` | 是 | — |
| `credential_version` | `bigint` | 是 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `command_id` | `uuid` | 是 | — |
| `completed_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `account_deletion_proof_check` | `CHECK (((completed_at IS NULL) = (command_id IS NULL)))` |
| `account_deletion_proof_check1` | `CHECK (((completed_at IS NULL) OR ((user_id IS NULL) AND (session_id IS NULL) AND (credential_version IS NULL))))` |
| `account_deletion_proof_pkey` | `PRIMARY KEY (token_digest)` |
| `account_deletion_proof_token_digest_check` | `CHECK ((octet_length(token_digest) = 32))` |

### `admin_account`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `username` | `character varying(64)` | 否 | — |
| `name` | `character varying(40)` | 否 | — |
| `password_hash` | `character varying(256)` | 否 | — |
| `role` | `character varying(20)` | 否 | — |
| `status` | `character varying(12)` | 否 | — |
| `version` | `bigint` | 否 | `1` |
| `credential_version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |
| `last_login_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `admin_account_credential_version_check` | `CHECK ((credential_version > 0))` |
| `admin_account_pkey` | `PRIMARY KEY (id)` |
| `admin_account_role_check` | `CHECK (((role)::text = 'SUPER_ADMIN'::text))` |
| `admin_account_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))` |
| `admin_account_username_key` | `UNIQUE (username)` |
| `admin_account_version_check` | `CHECK ((version > 0))` |

### `admin_control`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `integer` | 否 | — |
| `bootstrap_completed_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `admin_control_id_check` | `CHECK ((id = 1))` |
| `admin_control_pkey` | `PRIMARY KEY (id)` |

### `admin_session`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `admin_id` | `uuid` | 否 | — |
| `token_digest` | `bytea` | 否 | — |
| `credential_version` | `bigint` | 否 | — |
| `device_id` | `uuid` | 否 | — |
| `issued_at` | `timestamp with time zone` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `last_seen_at` | `timestamp with time zone` | 否 | — |
| `revoked_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `admin_session_admin_id_fkey` | `FOREIGN KEY (admin_id) REFERENCES admin_account(id)` |
| `admin_session_check` | `CHECK ((expires_at > issued_at))` |
| `admin_session_pkey` | `PRIMARY KEY (id)` |
| `admin_session_token_digest_check` | `CHECK ((octet_length(token_digest) = 32))` |
| `admin_session_token_digest_key` | `UNIQUE (token_digest)` |

其他索引：

- `CREATE INDEX admin_session_account_idx ON public.admin_session USING btree (admin_id, issued_at DESC)`

### `announcement`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `title` | `character varying(120)` | 否 | — |
| `summary` | `character varying(500)` | 否 | — |
| `body` | `text` | 否 | — |
| `audience` | `character varying(12)` | 否 | — |
| `status` | `character varying(16)` | 否 | — |
| `publish_at` | `timestamp with time zone` | 是 | — |
| `pinned` | `boolean` | 否 | `false` |
| `show_community_group` | `boolean` | 否 | `false` |
| `version` | `bigint` | 否 | `1` |
| `created_by` | `uuid` | 否 | — |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `announcement_audience_check` | `CHECK (((audience)::text = ANY ((ARRAY['ALL'::character varying, 'SELECTED'::character varying])::text[])))` |
| `announcement_check` | `CHECK ((((status)::text <> 'SCHEDULED'::text) OR (publish_at IS NOT NULL)))` |
| `announcement_created_by_fkey` | `FOREIGN KEY (created_by) REFERENCES admin_account(id)` |
| `announcement_pkey` | `PRIMARY KEY (id)` |
| `announcement_status_check` | `CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'PUBLISHED'::character varying, 'SCHEDULED'::character varying])::text[])))` |
| `announcement_version_check` | `CHECK ((version > 0))` |

其他索引：

- `CREATE INDEX announcement_creator_idx ON public.announcement USING btree (created_by)`
- `CREATE INDEX announcement_display_idx ON public.announcement USING btree (pinned DESC, updated_at DESC, id)`

### `announcement_recipient`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `announcement_id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `announcement_recipient_announcement_id_fkey` | `FOREIGN KEY (announcement_id) REFERENCES announcement(id)` |
| `announcement_recipient_pkey` | `PRIMARY KEY (announcement_id, user_id)` |
| `announcement_recipient_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX announcement_recipient_user_idx ON public.announcement_recipient USING btree (user_id, announcement_id)`

### `audit_log`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `actor_user_id` | `uuid` | 是 | — |
| `actor_admin_id` | `uuid` | 是 | — |
| `operation` | `character varying(200)` | 否 | — |
| `request_id` | `uuid` | 否 | — |
| `outcome` | `character varying(12)` | 否 | — |
| `reason_code` | `character varying(64)` | 是 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `audit_log_actor_admin_id_fkey` | `FOREIGN KEY (actor_admin_id) REFERENCES admin_account(id)` |
| `audit_log_actor_user_id_fkey` | `FOREIGN KEY (actor_user_id) REFERENCES user_account(id)` |
| `audit_log_check` | `CHECK ((num_nonnulls(actor_user_id, actor_admin_id) <= 1))` |
| `audit_log_outcome_check` | `CHECK (((outcome)::text = ANY ((ARRAY['SUCCESS'::character varying, 'FAILURE'::character varying])::text[])))` |
| `audit_log_pkey` | `PRIMARY KEY (id)` |

其他索引：

- `CREATE INDEX audit_log_admin_idx ON public.audit_log USING btree (actor_admin_id)`
- `CREATE INDEX audit_log_page_idx ON public.audit_log USING btree (created_at DESC, id)`
- `CREATE INDEX audit_log_user_idx ON public.audit_log USING btree (actor_user_id)`

### `bank_category`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `bank_id` | `uuid` | 否 | — |
| `college_id` | `uuid` | 是 | — |
| `major_id` | `uuid` | 是 | — |
| `grade` | `integer` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `bank_category_bank_id_college_id_major_id_grade_key` | `UNIQUE NULLS NOT DISTINCT (bank_id, college_id, major_id, grade)` |
| `bank_category_bank_id_fkey` | `FOREIGN KEY (bank_id) REFERENCES question_bank(id)` |
| `bank_category_check` | `CHECK (((major_id IS NULL) OR (college_id IS NULL)))` |
| `bank_category_check1` | `CHECK ((num_nonnulls(college_id, major_id, grade) > 0))` |
| `bank_category_college_id_fkey` | `FOREIGN KEY (college_id) REFERENCES college(id)` |
| `bank_category_grade_check` | `CHECK (((grade >= 1) AND (grade <= 5)))` |
| `bank_category_major_id_fkey` | `FOREIGN KEY (major_id) REFERENCES major(id)` |
| `bank_category_pkey` | `PRIMARY KEY (id)` |

其他索引：

- `CREATE INDEX bank_category_college_idx ON public.bank_category USING btree (college_id)`
- `CREATE INDEX bank_category_major_idx ON public.bank_category USING btree (major_id)`

### `bank_maintainer`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `bank_id` | `uuid` | 否 | — |
| `admin_id` | `uuid` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `bank_maintainer_admin_id_fkey` | `FOREIGN KEY (admin_id) REFERENCES admin_account(id)` |
| `bank_maintainer_bank_id_fkey` | `FOREIGN KEY (bank_id) REFERENCES question_bank(id)` |
| `bank_maintainer_pkey` | `PRIMARY KEY (bank_id, admin_id)` |

其他索引：

- `CREATE INDEX bank_maintainer_admin_idx ON public.bank_maintainer USING btree (admin_id, bank_id)`

### `chapter`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `bank_id` | `uuid` | 否 | — |
| `name` | `character varying(120)` | 否 | — |
| `sort_order` | `integer` | 否 | — |
| `version` | `bigint` | 否 | `1` |

| 约束 | 定义 |
| --- | --- |
| `chapter_bank_id_fkey` | `FOREIGN KEY (bank_id) REFERENCES question_bank(id)` |
| `chapter_bank_id_sort_order_key` | `UNIQUE (bank_id, sort_order) DEFERRABLE INITIALLY DEFERRED` |
| `chapter_id_bank_id_key` | `UNIQUE (id, bank_id)` |
| `chapter_pkey` | `PRIMARY KEY (id)` |
| `chapter_sort_order_check` | `CHECK ((sort_order >= 0))` |
| `chapter_version_check` | `CHECK ((version > 0))` |

### `college`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `code` | `character varying(40)` | 否 | — |
| `name` | `character varying(80)` | 否 | — |
| `status` | `character varying(12)` | 否 | — |
| `version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `college_code_key` | `UNIQUE (code)` |
| `college_name_key` | `UNIQUE (name)` |
| `college_pkey` | `PRIMARY KEY (id)` |
| `college_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))` |
| `college_version_check` | `CHECK ((version > 0))` |

### `command_receipt`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `scope` | `character varying(100)` | 否 | — |
| `operation` | `character varying(200)` | 否 | — |
| `command_id` | `uuid` | 否 | — |
| `actor_user_id` | `uuid` | 是 | — |
| `actor_admin_id` | `uuid` | 是 | — |
| `payload_digest` | `bytea` | 否 | — |
| `digest_key_version` | `integer` | 否 | — |
| `response_json` | `text` | 否 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `command_receipt_actor_admin_id_fkey` | `FOREIGN KEY (actor_admin_id) REFERENCES admin_account(id)` |
| `command_receipt_actor_user_id_fkey` | `FOREIGN KEY (actor_user_id) REFERENCES user_account(id)` |
| `command_receipt_check` | `CHECK ((num_nonnulls(actor_user_id, actor_admin_id) <= 1))` |
| `command_receipt_pkey` | `PRIMARY KEY (id)` |
| `command_receipt_scope_operation_command_id_key` | `UNIQUE (scope, operation, command_id)` |

其他索引：

- `CREATE INDEX command_receipt_admin_idx ON public.command_receipt USING btree (actor_admin_id)`
- `CREATE INDEX command_receipt_user_idx ON public.command_receipt USING btree (actor_user_id)`

### `community_group`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `integer` | 否 | — |
| `image` | `bytea` | 是 | — |
| `expires_at` | `timestamp with time zone` | 是 | — |
| `version` | `bigint` | 否 | `1` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `community_group_check` | `CHECK (((image IS NULL) = (expires_at IS NULL)))` |
| `community_group_id_check` | `CHECK ((id = 1))` |
| `community_group_pkey` | `PRIMARY KEY (id)` |
| `community_group_version_check` | `CHECK ((version > 0))` |

### `content_safety_callback`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `trace_id` | `character varying(128)` | 否 | — |
| `suggest` | `character varying(12)` | 否 | — |
| `received_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `content_safety_callback_pkey` | `PRIMARY KEY (trace_id)` |

### `content_safety_context`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `actor_id` | `uuid` | 否 | — |
| `session_id` | `uuid` | 否 | — |
| `actor_kind` | `character varying(5)` | 否 | — |
| `app_id` | `character varying(64)` | 否 | — |
| `open_id` | `character varying(128)` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `content_safety_context_actor_kind_check` | `CHECK (((actor_kind)::text = ANY ((ARRAY['USER'::character varying, 'ADMIN'::character varying])::text[])))` |
| `content_safety_context_pkey` | `PRIMARY KEY (id)` |

### `content_safety_media`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `request_id` | `uuid` | 否 | — |
| `data` | `bytea` | 否 | — |
| `media_type` | `character varying(32)` | 否 | — |
| `sha256` | `character varying(64)` | 否 | — |
| `trace_id` | `character varying(128)` | 是 | — |
| `fetch_digest` | `bytea` | 否 | — |
| `fetch_expires_at` | `timestamp with time zone` | 否 | — |
| `state` | `character varying(12)` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `content_safety_media_pkey` | `PRIMARY KEY (id)` |
| `content_safety_media_request_id_fkey` | `FOREIGN KEY (request_id) REFERENCES content_safety_request(id)` |
| `content_safety_media_state_check` | `CHECK (((state)::text = ANY ((ARRAY['PENDING'::character varying, 'PASSED'::character varying, 'REJECTED'::character varying])::text[])))` |
| `content_safety_media_trace_id_key` | `UNIQUE (trace_id)` |

其他索引：

- `CREATE INDEX content_safety_media_request_idx ON public.content_safety_media USING btree (request_id)`

### `content_safety_request`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `actor_id` | `uuid` | 否 | — |
| `session_id` | `uuid` | 否 | — |
| `actor_kind` | `character varying(5)` | 否 | — |
| `operation` | `character varying(200)` | 否 | — |
| `payload_json` | `text` | 否 | — |
| `payload_digest` | `bytea` | 否 | — |
| `context_id` | `uuid` | 是 | — |
| `confirmation_digest` | `bytea` | 是 | — |
| `state` | `character varying(24)` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `consumed_at` | `timestamp with time zone` | 是 | — |
| `error_code` | `character varying(64)` | 是 | — |
| `worker_token` | `uuid` | 是 | — |
| `worker_heartbeat_at` | `timestamp with time zone` | 是 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `content_safety_request_actor_kind_check` | `CHECK (((actor_kind)::text = ANY ((ARRAY['USER'::character varying, 'ADMIN'::character varying])::text[])))` |
| `content_safety_request_check` | `CHECK (((worker_token IS NULL) = (worker_heartbeat_at IS NULL)))` |
| `content_safety_request_check1` | `CHECK ((((state)::text = 'RUNNING'::text) = (worker_token IS NOT NULL)))` |
| `content_safety_request_context_id_fkey` | `FOREIGN KEY (context_id) REFERENCES content_safety_context(id)` |
| `content_safety_request_pkey` | `PRIMARY KEY (id)` |
| `content_safety_request_state_check` | `CHECK (((state)::text = ANY ((ARRAY['WAITING_CONFIRMATION'::character varying, 'CHECKING'::character varying, 'RUNNING'::character varying, 'PENDING'::character varying, 'PASSED'::character varying, 'REJECTED'::character varying, 'EXPIRED'::character varying, 'CONSUMED'::character varying])::text[])))` |

其他索引：

- `CREATE INDEX content_safety_pending_idx ON public.content_safety_request USING btree (state, expires_at)`

### `course_request`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `course_name` | `character varying(120)` | 否 | — |
| `major_id` | `uuid` | 是 | — |
| `body` | `text` | 否 | — |
| `status` | `character varying(16)` | 否 | `'OPEN'::character varying` |
| `response` | `text` | 否 | `''::text` |
| `version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `course_request_major_id_fkey` | `FOREIGN KEY (major_id) REFERENCES major(id)` |
| `course_request_pkey` | `PRIMARY KEY (id)` |
| `course_request_status_check` | `CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'IN_PROGRESS'::character varying, 'RESOLVED'::character varying, 'DISMISSED'::character varying])::text[])))` |
| `course_request_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |
| `course_request_version_check` | `CHECK ((version > 0))` |

其他索引：

- `CREATE INDEX course_request_major_idx ON public.course_request USING btree (major_id)`
- `CREATE INDEX course_request_queue_idx ON public.course_request USING btree (status, created_at DESC, id)`
- `CREATE INDEX course_request_user_idx ON public.course_request USING btree (user_id, created_at DESC, id)`

### `domain_event_outbox`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `occurred_at` | `timestamp with time zone` | 否 | — |
| `processed_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `domain_event_outbox_pkey` | `PRIMARY KEY (id)` |
| `domain_event_outbox_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX domain_event_pending_idx ON public.domain_event_outbox USING btree (occurred_at, id) WHERE (processed_at IS NULL)`

### `email_challenge`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 是 | — |
| `purpose` | `character varying(24)` | 否 | — |
| `email` | `character varying(254)` | 否 | — |
| `email_key` | `character varying(254)` | 否 | — |
| `code_mac` | `bytea` | 否 | — |
| `key_version` | `integer` | 否 | — |
| `eligible` | `boolean` | 否 | — |
| `credential_version` | `bigint` | 是 | — |
| `failed_attempts` | `integer` | 否 | `0` |
| `created_at` | `timestamp with time zone` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `consumed_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `email_challenge_check` | `CHECK ((expires_at > created_at))` |
| `email_challenge_code_mac_check` | `CHECK ((octet_length(code_mac) = 32))` |
| `email_challenge_failed_attempts_check` | `CHECK (((failed_attempts >= 0) AND (failed_attempts <= 5)))` |
| `email_challenge_pkey` | `PRIMARY KEY (id)` |
| `email_challenge_purpose_check` | `CHECK (((purpose)::text = ANY ((ARRAY['LOGIN'::character varying, 'BIND_EMAIL'::character varying, 'CHANGE_EMAIL_OLD'::character varying, 'CHANGE_EMAIL_NEW'::character varying, 'DELETE_ACCOUNT'::character varying])::text[])))` |
| `email_challenge_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX email_challenge_target_idx ON public.email_challenge USING btree (email_key, purpose, created_at DESC)`
- `CREATE INDEX email_challenge_user_idx ON public.email_challenge USING btree (user_id)`

### `file_asset`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `bank_id` | `uuid` | 否 | — |
| `uploaded_by` | `uuid` | 否 | — |
| `storage_key` | `character varying(128)` | 否 | — |
| `sha256` | `character varying(64)` | 否 | — |
| `media_type` | `character varying(32)` | 否 | — |
| `size_bytes` | `bigint` | 否 | — |
| `width_pixels` | `integer` | 否 | — |
| `height_pixels` | `integer` | 否 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `file_asset_bank_id_fkey` | `FOREIGN KEY (bank_id) REFERENCES question_bank(id)` |
| `file_asset_height_pixels_check` | `CHECK ((height_pixels > 0))` |
| `file_asset_media_type_check` | `CHECK (((media_type)::text = 'image/png'::text))` |
| `file_asset_pkey` | `PRIMARY KEY (id)` |
| `file_asset_size_bytes_check` | `CHECK ((size_bytes > 0))` |
| `file_asset_storage_key_key` | `UNIQUE (storage_key)` |
| `file_asset_uploaded_by_fkey` | `FOREIGN KEY (uploaded_by) REFERENCES admin_account(id)` |
| `file_asset_width_pixels_check` | `CHECK ((width_pixels > 0))` |

其他索引：

- `CREATE INDEX file_asset_bank_idx ON public.file_asset USING btree (bank_id)`
- `CREATE INDEX file_asset_uploader_idx ON public.file_asset USING btree (uploaded_by)`

### `login_attempt`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `scope_digest` | `bytea` | 否 | — |
| `failures` | `integer` | 否 | `0` |
| `blocked_until` | `timestamp with time zone` | 是 | — |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `login_attempt_pkey` | `PRIMARY KEY (scope_digest)` |
| `login_attempt_scope_digest_check` | `CHECK ((octet_length(scope_digest) = 32))` |

### `mail_delivery`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `challenge_id` | `uuid` | 否 | — |
| `template_code` | `character varying(40)` | 否 | — |
| `template_version` | `integer` | 否 | — |
| `ciphertext` | `text` | 否 | — |
| `nonce` | `text` | 否 | — |
| `key_version` | `integer` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `state` | `character varying(24)` | 否 | — |
| `attempts` | `integer` | 否 | `0` |
| `next_attempt_at` | `timestamp with time zone` | 否 | `now()` |
| `lease_id` | `uuid` | 是 | — |
| `leased_at` | `timestamp with time zone` | 是 | — |
| `provider_message_id` | `character varying(256)` | 是 | — |
| `error_code` | `character varying(64)` | 是 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `mail_delivery_challenge_id_fkey` | `FOREIGN KEY (challenge_id) REFERENCES email_challenge(id)` |
| `mail_delivery_challenge_id_key` | `UNIQUE (challenge_id)` |
| `mail_delivery_pkey` | `PRIMARY KEY (id)` |
| `mail_delivery_state_check` | `CHECK (((state)::text = ANY ((ARRAY['PENDING'::character varying, 'SENDING'::character varying, 'ACCEPTED'::character varying, 'RETRYABLE_FAILED'::character varying, 'PERMANENT_FAILED'::character varying, 'UNKNOWN'::character varying, 'CANCELLED'::character varying])::text[])))` |

其他索引：

- `CREATE INDEX mail_delivery_pending_idx ON public.mail_delivery USING btree (state, next_attempt_at)`

### `major`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `college_id` | `uuid` | 否 | — |
| `code` | `character varying(40)` | 否 | — |
| `name` | `character varying(80)` | 否 | — |
| `status` | `character varying(12)` | 否 | — |
| `version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `major_college_id_code_key` | `UNIQUE (college_id, code)` |
| `major_college_id_fkey` | `FOREIGN KEY (college_id) REFERENCES college(id)` |
| `major_college_id_name_key` | `UNIQUE (college_id, name)` |
| `major_pkey` | `PRIMARY KEY (id)` |
| `major_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))` |
| `major_version_check` | `CHECK ((version > 0))` |

### `practice_item`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `session_id` | `uuid` | 否 | — |
| `question_id` | `uuid` | 否 | — |
| `revision_id` | `uuid` | 否 | — |
| `material_revision_id` | `uuid` | 是 | — |
| `answer_blanks` | `text` | 是 | — |
| `position` | `integer` | 否 | — |
| `answer_text` | `text` | 是 | — |
| `answer_boolean` | `boolean` | 是 | — |
| `confirmed` | `boolean` | 否 | `false` |
| `marked` | `boolean` | 否 | `false` |
| `outcome` | `character varying(12)` | 是 | — |
| `self_assessment` | `character varying(12)` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `practice_item_answer_blanks_check` | `CHECK (((answer_blanks IS NULL) OR (jsonb_typeof((answer_blanks)::jsonb) = 'array'::text)))` |
| `practice_item_id_revision_id_key` | `UNIQUE (id, revision_id)` |
| `practice_item_material_revision_id_fkey` | `FOREIGN KEY (material_revision_id) REFERENCES question_revision(id)` |
| `practice_item_outcome_check` | `CHECK (((outcome)::text = ANY ((ARRAY['CORRECT'::character varying, 'WRONG'::character varying, 'UNANSWERED'::character varying, 'SELF_RATED'::character varying])::text[])))` |
| `practice_item_pkey` | `PRIMARY KEY (id)` |
| `practice_item_position_check` | `CHECK (("position" >= 0))` |
| `practice_item_question_id_revision_id_fkey` | `FOREIGN KEY (question_id, revision_id) REFERENCES question_revision(question_id, id)` |
| `practice_item_self_assessment_check` | `CHECK (((self_assessment)::text = ANY ((ARRAY['CORRECT'::character varying, 'WRONG'::character varying])::text[])))` |
| `practice_item_session_id_fkey` | `FOREIGN KEY (session_id) REFERENCES practice_session(id)` |
| `practice_item_session_id_position_key` | `UNIQUE (session_id, "position")` |
| `practice_item_session_id_question_id_key` | `UNIQUE (session_id, question_id)` |

其他索引：

- `CREATE INDEX practice_item_question_idx ON public.practice_item USING btree (question_id, session_id)`
- `CREATE INDEX practice_item_revision_idx ON public.practice_item USING btree (question_id, revision_id)`

### `practice_item_choice`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `item_id` | `uuid` | 否 | — |
| `revision_id` | `uuid` | 否 | — |
| `option_key` | `character varying(8)` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `practice_item_choice_item_id_revision_id_fkey` | `FOREIGN KEY (item_id, revision_id) REFERENCES practice_item(id, revision_id)` |
| `practice_item_choice_pkey` | `PRIMARY KEY (item_id, option_key)` |
| `practice_item_choice_revision_id_option_key_fkey` | `FOREIGN KEY (revision_id, option_key) REFERENCES question_option(revision_id, option_key)` |

其他索引：

- `CREATE INDEX practice_item_choice_revision_idx ON public.practice_item_choice USING btree (revision_id, option_key)`

### `practice_result`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `session_id` | `uuid` | 否 | — |
| `total_count` | `integer` | 否 | — |
| `objective_count` | `integer` | 否 | — |
| `answered_count` | `integer` | 否 | — |
| `correct_count` | `integer` | 否 | — |
| `wrong_count` | `integer` | 否 | — |
| `unanswered_count` | `integer` | 否 | — |
| `short_answer_count` | `integer` | 否 | — |
| `duration_seconds` | `integer` | 否 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `practice_result_check` | `CHECK ((objective_count = ((correct_count + wrong_count) + unanswered_count)))` |
| `practice_result_check1` | `CHECK ((total_count = (objective_count + short_answer_count)))` |
| `practice_result_check2` | `CHECK (((correct_count >= 0) AND (wrong_count >= 0) AND (unanswered_count >= 0) AND (short_answer_count >= 0)))` |
| `practice_result_check3` | `CHECK (((answered_count >= (correct_count + wrong_count)) AND (answered_count <= (total_count - unanswered_count))))` |
| `practice_result_duration_seconds_check` | `CHECK ((duration_seconds >= 0))` |
| `practice_result_pkey` | `PRIMARY KEY (id)` |
| `practice_result_session_id_fkey` | `FOREIGN KEY (session_id) REFERENCES practice_session(id)` |
| `practice_result_session_id_key` | `UNIQUE (session_id)` |
| `practice_result_total_count_check` | `CHECK ((total_count > 0))` |

### `practice_session`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `bank_id` | `uuid` | 否 | — |
| `selection_kind` | `character varying(12)` | 否 | — |
| `question_order` | `character varying(12)` | 否 | — |
| `feedback` | `character varying(16)` | 否 | — |
| `status` | `character varying(16)` | 否 | — |
| `version` | `bigint` | 否 | `1` |
| `current_index` | `integer` | 否 | `0` |
| `duration_seconds` | `integer` | 否 | `0` |
| `configuration_snapshot` | `text` | 否 | — |
| `auto_add_wrong_book` | `boolean` | 否 | `true` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |
| `submitted_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `practice_session_bank_id_fkey` | `FOREIGN KEY (bank_id) REFERENCES question_bank(id)` |
| `practice_session_check` | `CHECK ((((status)::text = 'SUBMITTED'::text) = (submitted_at IS NOT NULL)))` |
| `practice_session_current_index_check` | `CHECK ((current_index >= 0))` |
| `practice_session_duration_seconds_check` | `CHECK ((duration_seconds >= 0))` |
| `practice_session_feedback_check` | `CHECK (((feedback)::text = ANY ((ARRAY['IMMEDIATE'::character varying, 'AFTER_FINISH'::character varying])::text[])))` |
| `practice_session_id_user_id_key` | `UNIQUE (id, user_id)` |
| `practice_session_pkey` | `PRIMARY KEY (id)` |
| `practice_session_question_order_check` | `CHECK (((question_order)::text = ANY ((ARRAY['SEQUENTIAL'::character varying, 'RANDOM'::character varying])::text[])))` |
| `practice_session_selection_kind_check` | `CHECK (((selection_kind)::text = ANY ((ARRAY['NORMAL'::character varying, 'WRONG'::character varying, 'FAVORITE'::character varying])::text[])))` |
| `practice_session_status_check` | `CHECK (((status)::text = ANY ((ARRAY['IN_PROGRESS'::character varying, 'SUBMITTED'::character varying, 'CANCELLED'::character varying])::text[])))` |
| `practice_session_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |
| `practice_session_version_check` | `CHECK ((version > 0))` |

其他索引：

- `CREATE INDEX practice_active_bank_idx ON public.practice_session USING btree (user_id, bank_id) WHERE ((status)::text = 'IN_PROGRESS'::text)`
- `CREATE INDEX practice_history_idx ON public.practice_session USING btree (user_id, submitted_at DESC, id) WHERE ((status)::text = 'SUBMITTED'::text)`
- `CREATE INDEX practice_recent_idx ON public.practice_session USING btree (user_id, updated_at DESC, id)`
- `CREATE INDEX practice_session_bank_idx ON public.practice_session USING btree (bank_id)`
- `CREATE INDEX practice_statistics_idx ON public.practice_session USING btree (submitted_at, user_id) WHERE ((status)::text = 'SUBMITTED'::text)`

### `practice_sync_state`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `session_id` | `uuid` | 否 | — |
| `writer_device_id` | `uuid` | 是 | — |
| `writer_token` | `uuid` | 是 | — |
| `acknowledged_sequence` | `bigint` | 否 | `0` |
| `accepted_sequence` | `bigint` | 否 | `0` |
| `finish_sequence` | `bigint` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `practice_sync_state_acknowledged_sequence_check` | `CHECK ((acknowledged_sequence >= 0))` |
| `practice_sync_state_check` | `CHECK ((accepted_sequence >= acknowledged_sequence))` |
| `practice_sync_state_check1` | `CHECK (((writer_device_id IS NULL) = (writer_token IS NULL)))` |
| `practice_sync_state_pkey` | `PRIMARY KEY (session_id)` |
| `practice_sync_state_session_id_fkey` | `FOREIGN KEY (session_id) REFERENCES practice_session(id)` |

### `question`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `bank_id` | `uuid` | 否 | — |
| `chapter_id` | `uuid` | 是 | — |
| `status` | `character varying(12)` | 否 | — |
| `reading_parent_id` | `uuid` | 是 | — |
| `reading_order` | `integer` | 否 | `0` |
| `is_group` | `boolean` | 否 | `false` |
| `current_revision_id` | `uuid` | 否 | — |
| `version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `question_bank_id_fkey` | `FOREIGN KEY (bank_id) REFERENCES question_bank(id)` |
| `question_chapter_id_bank_id_fkey` | `FOREIGN KEY (chapter_id, bank_id) REFERENCES chapter(id, bank_id)` |
| `question_check` | `CHECK (((NOT is_group) OR (reading_parent_id IS NULL)))` |
| `question_current_revision_fk` | `FOREIGN KEY (id, current_revision_id) REFERENCES question_revision(question_id, id) DEFERRABLE INITIALLY DEFERRED` |
| `question_group_valid` | `TRIGGER DEFERRABLE INITIALLY DEFERRED` |
| `question_id_bank_id_key` | `UNIQUE (id, bank_id)` |
| `question_pkey` | `PRIMARY KEY (id)` |
| `question_reading_order_check` | `CHECK ((reading_order >= 0))` |
| `question_reading_parent_id_bank_id_fkey` | `FOREIGN KEY (reading_parent_id, bank_id) REFERENCES question(id, bank_id)` |
| `question_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))` |
| `question_version_check` | `CHECK ((version > 0))` |

其他索引：

- `CREATE INDEX question_bank_idx ON public.question USING btree (bank_id, status, created_at, id)`
- `CREATE INDEX question_chapter_idx ON public.question USING btree (chapter_id)`
- `CREATE INDEX question_reading_idx ON public.question USING btree (reading_parent_id, reading_order)`

### `question_attachment`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `revision_id` | `uuid` | 否 | — |
| `file_id` | `uuid` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `question_attachment_file_id_fkey` | `FOREIGN KEY (file_id) REFERENCES file_asset(id)` |
| `question_attachment_pkey` | `PRIMARY KEY (revision_id, file_id)` |
| `question_attachment_revision_id_fkey` | `FOREIGN KEY (revision_id) REFERENCES question_revision(id)` |

其他索引：

- `CREATE INDEX question_attachment_file_idx ON public.question_attachment USING btree (file_id)`

### `question_bank`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `subject_id` | `uuid` | 否 | — |
| `name` | `character varying(120)` | 否 | — |
| `description` | `text` | 否 | `''::text` |
| `textbook` | `character varying(500)` | 否 | `''::character varying` |
| `status` | `character varying(12)` | 否 | — |
| `publication_status` | `character varying(16)` | 否 | `'DRAFT'::character varying` |
| `version` | `bigint` | 否 | `1` |
| `content_version` | `bigint` | 否 | `1` |
| `created_by` | `uuid` | 否 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `question_bank_content_version_check` | `CHECK ((content_version > 0))` |
| `question_bank_created_by_fkey` | `FOREIGN KEY (created_by) REFERENCES admin_account(id)` |
| `question_bank_id_subject_id_key` | `UNIQUE (id, subject_id)` |
| `question_bank_pkey` | `PRIMARY KEY (id)` |
| `question_bank_publication_status_check` | `CHECK (((publication_status)::text = ANY ((ARRAY['DRAFT'::character varying, 'PUBLISHED'::character varying, 'UNPUBLISHED'::character varying, 'ARCHIVED'::character varying])::text[])))` |
| `question_bank_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))` |
| `question_bank_subject_id_fkey` | `FOREIGN KEY (subject_id) REFERENCES subject(id)` |
| `question_bank_version_check` | `CHECK ((version > 0))` |

其他索引：

- `CREATE INDEX question_bank_creator_idx ON public.question_bank USING btree (created_by)`
- `CREATE INDEX question_bank_listing_idx ON public.question_bank USING btree (publication_status, status, name, id)`
- `CREATE INDEX question_bank_subject_idx ON public.question_bank USING btree (subject_id, publication_status, status)`

### `question_feedback`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `question_id` | `uuid` | 否 | — |
| `revision_id` | `uuid` | 否 | — |
| `category` | `character varying(24)` | 否 | — |
| `body` | `text` | 否 | — |
| `status` | `character varying(16)` | 否 | `'OPEN'::character varying` |
| `response` | `text` | 否 | `''::text` |
| `version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `question_feedback_category_check` | `CHECK (((category)::text = ANY ((ARRAY['ANSWER'::character varying, 'EXPLANATION'::character varying, 'STEM_OPTIONS'::character varying, 'OTHER'::character varying])::text[])))` |
| `question_feedback_pkey` | `PRIMARY KEY (id)` |
| `question_feedback_question_id_revision_id_fkey` | `FOREIGN KEY (question_id, revision_id) REFERENCES question_revision(question_id, id)` |
| `question_feedback_status_check` | `CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'IN_PROGRESS'::character varying, 'RESOLVED'::character varying, 'DISMISSED'::character varying])::text[])))` |
| `question_feedback_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |
| `question_feedback_version_check` | `CHECK ((version > 0))` |

其他索引：

- `CREATE INDEX question_feedback_queue_idx ON public.question_feedback USING btree (status, created_at DESC)`
- `CREATE INDEX question_feedback_revision_idx ON public.question_feedback USING btree (question_id, revision_id)`
- `CREATE INDEX question_feedback_user_idx ON public.question_feedback USING btree (user_id, created_at DESC, id)`

### `question_option`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `revision_id` | `uuid` | 否 | — |
| `option_key` | `character varying(8)` | 否 | — |
| `content` | `text` | 否 | — |
| `is_correct` | `boolean` | 否 | — |
| `sort_order` | `integer` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `question_option_pkey` | `PRIMARY KEY (revision_id, option_key)` |
| `question_option_revision_id_fkey` | `FOREIGN KEY (revision_id) REFERENCES question_revision(id)` |
| `question_option_revision_id_sort_order_key` | `UNIQUE (revision_id, sort_order)` |

### `question_revision`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `question_id` | `uuid` | 否 | — |
| `revision_number` | `integer` | 否 | — |
| `type` | `character varying(20)` | 否 | — |
| `stem` | `text` | 否 | — |
| `explanation` | `text` | 否 | `''::text` |
| `correct_value` | `boolean` | 是 | — |
| `reference_answer` | `text` | 是 | — |
| `content_data` | `text` | 否 | `'{}'::text` |
| `created_by` | `uuid` | 否 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `question_revision_check` | `CHECK ((((type)::text = 'TRUE_FALSE'::text) = (correct_value IS NOT NULL)))` |
| `question_revision_check1` | `CHECK ((((type)::text = 'SHORT_ANSWER'::text) = (reference_answer IS NOT NULL)))` |
| `question_revision_content_data_check` | `CHECK ((jsonb_typeof((content_data)::jsonb) = 'object'::text))` |
| `question_revision_created_by_fkey` | `FOREIGN KEY (created_by) REFERENCES admin_account(id)` |
| `question_revision_pkey` | `PRIMARY KEY (id)` |
| `question_revision_question_id_fkey` | `FOREIGN KEY (question_id) REFERENCES question(id) DEFERRABLE INITIALLY DEFERRED` |
| `question_revision_question_id_id_key` | `UNIQUE (question_id, id)` |
| `question_revision_question_id_revision_number_key` | `UNIQUE (question_id, revision_number)` |
| `question_revision_revision_number_check` | `CHECK ((revision_number > 0))` |
| `question_revision_type_check` | `CHECK (((type)::text = ANY ((ARRAY['SINGLE_CHOICE'::character varying, 'MULTIPLE_CHOICE'::character varying, 'TRUE_FALSE'::character varying, 'FILL_BLANK'::character varying, 'SHORT_ANSWER'::character varying, 'READING'::character varying])::text[])))` |

其他索引：

- `CREATE INDEX question_revision_creator_idx ON public.question_revision USING btree (created_by)`

### `security_policy`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `integer` | 否 | — |
| `lock_enabled` | `boolean` | 否 | `true` |
| `max_attempts` | `integer` | 否 | `5` |
| `lock_minutes` | `integer` | 否 | `30` |
| `session_minutes` | `integer` | 否 | `30` |
| `min_password_length` | `integer` | 否 | `12` |
| `require_letter` | `boolean` | 否 | `true` |
| `require_number` | `boolean` | 否 | `true` |
| `require_mixed_case` | `boolean` | 否 | `false` |
| `version` | `bigint` | 否 | `1` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `security_policy_id_check` | `CHECK ((id = 1))` |
| `security_policy_lock_minutes_check` | `CHECK (((lock_minutes >= 1) AND (lock_minutes <= 1440)))` |
| `security_policy_max_attempts_check` | `CHECK (((max_attempts >= 3) AND (max_attempts <= 10)))` |
| `security_policy_min_password_length_check` | `CHECK (((min_password_length >= 12) AND (min_password_length <= 64)))` |
| `security_policy_pkey` | `PRIMARY KEY (id)` |
| `security_policy_session_minutes_check` | `CHECK (((session_minutes >= 5) AND (session_minutes <= 1440)))` |
| `security_policy_version_check` | `CHECK ((version > 0))` |

### `session_presence`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `session_id` | `uuid` | 否 | — |
| `foreground_seen_at` | `timestamp with time zone` | 否 | — |

| 约束 | 定义 |
| --- | --- |
| `session_presence_pkey` | `PRIMARY KEY (session_id)` |
| `session_presence_session_id_fkey` | `FOREIGN KEY (session_id) REFERENCES user_session(id)` |

其他索引：

- `CREATE INDEX session_presence_online_idx ON public.session_presence USING btree (foreground_seen_at DESC, session_id)`

### `subject`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `name` | `character varying(120)` | 否 | — |
| `description` | `text` | 否 | `''::text` |
| `status` | `character varying(12)` | 否 | — |
| `version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `subject_name_key` | `UNIQUE (name)` |
| `subject_pkey` | `PRIMARY KEY (id)` |
| `subject_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying])::text[])))` |
| `subject_version_check` | `CHECK ((version > 0))` |

### `sync_command`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `session_id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `actor_session_id` | `uuid` | 否 | — |
| `writer_token` | `uuid` | 否 | — |
| `client_sequence` | `bigint` | 否 | — |
| `payload_digest` | `bytea` | 否 | — |
| `digest_key_version` | `integer` | 否 | — |
| `request_id` | `uuid` | 否 | — |
| `kind` | `character varying(8)` | 否 | — |
| `payload_json` | `text` | 否 | — |
| `next_attempt_at` | `timestamp with time zone` | 否 | `now()` |
| `dispatch_until` | `timestamp with time zone` | 是 | — |
| `state` | `character varying(20)` | 否 | — |
| `attempts` | `integer` | 否 | `0` |
| `error_code` | `character varying(64)` | 是 | — |
| `error_message` | `character varying(200)` | 是 | — |
| `error_status` | `integer` | 是 | — |
| `receipt_id` | `uuid` | 是 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |
| `completed_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `sync_command_actor_session_id_user_id_fkey` | `FOREIGN KEY (actor_session_id, user_id) REFERENCES user_session(id, user_id)` |
| `sync_command_attempts_check` | `CHECK ((attempts >= 0))` |
| `sync_command_check` | `CHECK ((((state)::text = 'COMMITTED'::text) = (receipt_id IS NOT NULL)))` |
| `sync_command_check1` | `CHECK ((((state)::text = ANY ((ARRAY['COMMITTED'::character varying, 'REJECTED'::character varying])::text[])) = (completed_at IS NOT NULL)))` |
| `sync_command_client_sequence_check` | `CHECK ((client_sequence > 0))` |
| `sync_command_kind_check` | `CHECK (((kind)::text = ANY ((ARRAY['SAVE'::character varying, 'FINISH'::character varying])::text[])))` |
| `sync_command_pkey` | `PRIMARY KEY (id)` |
| `sync_command_receipt_id_fkey` | `FOREIGN KEY (receipt_id) REFERENCES command_receipt(id)` |
| `sync_command_receipt_id_key` | `UNIQUE (receipt_id)` |
| `sync_command_session_id_user_id_fkey` | `FOREIGN KEY (session_id, user_id) REFERENCES practice_session(id, user_id)` |
| `sync_command_state_check` | `CHECK (((state)::text = ANY ((ARRAY['QUEUED'::character varying, 'RETRYING'::character varying, 'COMMITTED'::character varying, 'REJECTED'::character varying, 'DEAD_LETTER'::character varying])::text[])))` |

其他索引：

- `CREATE INDEX sync_command_committed_idx ON public.sync_command USING btree (completed_at) WHERE ((state)::text = 'COMMITTED'::text)`
- `CREATE INDEX sync_command_order_idx ON public.sync_command USING btree (session_id, client_sequence)`
- `CREATE INDEX sync_command_pending_idx ON public.sync_command USING btree (next_attempt_at, created_at) WHERE ((state)::text = ANY ((ARRAY['QUEUED'::character varying, 'RETRYING'::character varying])::text[]))`
- `CREATE UNIQUE INDEX sync_command_sequence_idx ON public.sync_command USING btree (session_id, writer_token, client_sequence) WHERE ((state)::text <> 'REJECTED'::text)`

### `test_account`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `user_id` | `uuid` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `include_in_statistics` | `boolean` | 否 | `false` |
| `created_by` | `uuid` | 否 | — |
| `disabled_at` | `timestamp with time zone` | 是 | — |
| `disable_reason` | `character varying(12)` | 是 | — |
| `login_code_hash` | `character varying(256)` | 是 | — |
| `password_ciphertext` | `text` | 是 | — |
| `password_nonce` | `character varying(24)` | 是 | — |
| `password_key_version` | `integer` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `test_account_check` | `CHECK (((disabled_at IS NULL) = (disable_reason IS NULL)))` |
| `test_account_check1` | `CHECK (((password_ciphertext IS NULL) = (password_nonce IS NULL)))` |
| `test_account_check2` | `CHECK (((password_ciphertext IS NULL) = (password_key_version IS NULL)))` |
| `test_account_created_by_fkey` | `FOREIGN KEY (created_by) REFERENCES admin_account(id)` |
| `test_account_disable_reason_check` | `CHECK (((disable_reason)::text = ANY ((ARRAY['MANUAL'::character varying, 'EXPIRED'::character varying])::text[])))` |
| `test_account_pkey` | `PRIMARY KEY (user_id)` |
| `test_account_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX test_account_expiry_idx ON public.test_account USING btree (expires_at, user_id) WHERE (disabled_at IS NULL)`

### `user_account`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `account_code` | `character varying(12)` | 否 | — |
| `nickname` | `character varying(40)` | 否 | — |
| `avatar` | `text` | 是 | — |
| `email` | `character varying(254)` | 是 | — |
| `email_key` | `character varying(254)` | 是 | — |
| `status` | `character varying(12)` | 否 | `'ACTIVE'::character varying` |
| `version` | `bigint` | 否 | `1` |
| `credential_version` | `bigint` | 否 | `1` |
| `created_at` | `timestamp with time zone` | 否 | `now()` |
| `updated_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `user_account_account_code_key` | `UNIQUE (account_code)` |
| `user_account_avatar_check` | `CHECK (((avatar IS NULL) OR (((char_length(avatar) >= 1) AND (char_length(avatar) <= 87407)) AND (avatar ~ '^data:image/(jpeg\|png);base64,'::text))))` |
| `user_account_check` | `CHECK (((email IS NULL) = (email_key IS NULL)))` |
| `user_account_credential_version_check` | `CHECK ((credential_version > 0))` |
| `user_account_email_key_check` | `CHECK (((email_key IS NULL) OR ((email_key)::text = lower((email_key)::text))))` |
| `user_account_email_key_key` | `UNIQUE (email_key)` |
| `user_account_pkey` | `PRIMARY KEY (id)` |
| `user_account_status_check` | `CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'DISABLED'::character varying, 'DELETING'::character varying])::text[])))` |
| `user_account_version_check` | `CHECK ((version > 0))` |

### `user_activity`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `user_id` | `uuid` | 否 | — |
| `activity_date` | `date` | 否 | — |
| `first_seen_at` | `timestamp with time zone` | 否 | `now()` |
| `last_seen_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `user_activity_pkey` | `PRIMARY KEY (user_id, activity_date)` |
| `user_activity_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX user_activity_date_idx ON public.user_activity USING btree (activity_date, user_id)`

### `user_favorite`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `user_id` | `uuid` | 否 | — |
| `question_id` | `uuid` | 否 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `user_favorite_pkey` | `PRIMARY KEY (user_id, question_id)` |
| `user_favorite_question_id_fkey` | `FOREIGN KEY (question_id) REFERENCES question(id)` |
| `user_favorite_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX user_favorite_order_idx ON public.user_favorite USING btree (user_id, created_at DESC, question_id)`
- `CREATE INDEX user_favorite_question_idx ON public.user_favorite USING btree (question_id)`

### `user_session`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `token_digest` | `bytea` | 否 | — |
| `credential_version` | `bigint` | 否 | — |
| `device_id` | `uuid` | 否 | — |
| `auth_method` | `character varying(8)` | 否 | — |
| `issued_at` | `timestamp with time zone` | 否 | — |
| `expires_at` | `timestamp with time zone` | 否 | — |
| `last_seen_at` | `timestamp with time zone` | 否 | — |
| `revoked_at` | `timestamp with time zone` | 是 | — |

| 约束 | 定义 |
| --- | --- |
| `user_session_auth_method_check` | `CHECK (((auth_method)::text = ANY ((ARRAY['EMAIL'::character varying, 'WECHAT'::character varying, 'TEST'::character varying])::text[])))` |
| `user_session_check` | `CHECK ((expires_at > issued_at))` |
| `user_session_id_user_id_key` | `UNIQUE (id, user_id)` |
| `user_session_pkey` | `PRIMARY KEY (id)` |
| `user_session_token_digest_check` | `CHECK ((octet_length(token_digest) = 32))` |
| `user_session_token_digest_key` | `UNIQUE (token_digest)` |
| `user_session_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

其他索引：

- `CREATE INDEX user_session_account_idx ON public.user_session USING btree (user_id, issued_at DESC)`

### `user_wechat`

| 字段 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | `uuid` | 否 | — |
| `user_id` | `uuid` | 否 | — |
| `app_id` | `character varying(64)` | 否 | — |
| `open_id` | `character varying(128)` | 否 | — |
| `union_id` | `character varying(128)` | 是 | — |
| `created_at` | `timestamp with time zone` | 否 | `now()` |

| 约束 | 定义 |
| --- | --- |
| `user_wechat_app_id_open_id_key` | `UNIQUE (app_id, open_id)` |
| `user_wechat_pkey` | `PRIMARY KEY (id)` |
| `user_wechat_user_id_app_id_key` | `UNIQUE (user_id, app_id)` |
| `user_wechat_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES user_account(id)` |

## 函数、触发器与监控

序列负责测试账号编号，停用及注销后继续递增。账号、会话和命令锁用于串行化普通写入、消费与注销。正式练习修订及结果保持不可变；注销事务通过受限的账号删除上下文清理该账号的历史数据。

监控视图按最小只读权限暴露会话、队列及统计所需字段；测试账号是否计入运营统计由现有统计函数统一判断。函数、触发器、视图及权限的完整定义以 V1 初始化 SQL 和实际初始化检查为准。
