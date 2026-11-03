# 数据库设计

V1 基线定义为 `apps/api/src/main/resources/db/schema.sql`，包含 42 张表；后续结构由增量迁移维护。监控权限定义在相邻的 `monitoring-permissions.sql`。应用启动核对结构；开发初始化和生产 Flyway 在基线之后执行 `db/migration/V2__ProfileSetupAndBankVisibility.sql`。V2 增加 `user_account.profile_setup_seen` 并更新 `bank_visible`，资料齐全的存量账号初始化为已完成引导，其余账号首次展示后登记。

题目稳定身份与不可变修订分离。练习固定题目和材料修订，正式结果及历史引用由外键、约束和触发器保护。同步命令保存身份、幂等摘要、序号、处理状态及最终回执；一场练习最多一个未完成命令。

以下字段与约束按当前 DDL 整理；索引、触发器和只读视图以初始化脚本为准。

## `college`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `code` | `varchar(40) NOT NULL UNIQUE` |
| `name` | `varchar(80) NOT NULL UNIQUE` |
| `status` | `varchar(12) NOT NULL CHECK(status IN ('ACTIVE','INACTIVE'))` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

## `major`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `college_id` | `uuid NOT NULL REFERENCES college(id)` |
| `code` | `varchar(40) NOT NULL` |
| `name` | `varchar(80) NOT NULL` |
| `status` | `varchar(12) NOT NULL CHECK(status IN ('ACTIVE','INACTIVE'))` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `UNIQUE(college_id,code)` | `` |
| `UNIQUE(college_id,name)` | `` |

## `user_account`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `account_code` | `varchar(12) NOT NULL UNIQUE` |
| `nickname` | `varchar(40) NOT NULL` |
| `avatar` | `text CHECK(avatar IS NULL OR (char_length(avatar) BETWEEN 1 AND 87407 AND avatar ~ '^data:image/(jpeg\|png` |

## `user_profile`

| 字段或约束 | 定义 |
| --- | --- |
| `user_id` | `uuid PRIMARY KEY REFERENCES user_account(id)` |
| `college_id` | `uuid REFERENCES college(id)` |
| `major_id` | `uuid REFERENCES major(id)` |
| `grade` | `integer CHECK(grade BETWEEN 1 AND 5)` |
| `grade_academic_year` | `integer CHECK(grade_academic_year BETWEEN 1900 AND 2200)` |
| `CHECK((grade` | `IS NULL)=(grade_academic_year IS NULL))` |
| `CHECK(major_id` | `IS NULL OR college_id IS NULL)` |

## `user_wechat`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `app_id` | `varchar(64) NOT NULL` |
| `open_id` | `varchar(128) NOT NULL` |
| `union_id` | `varchar(128)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `UNIQUE(app_id,open_id)` | `` |
| `UNIQUE(user_id,app_id)` | `` |

## `admin_account`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `username` | `varchar(64) NOT NULL UNIQUE` |
| `name` | `varchar(40) NOT NULL` |
| `password_hash` | `varchar(256) NOT NULL` |
| `role` | `varchar(20) NOT NULL CHECK(role = 'SUPER_ADMIN')` |
| `status` | `varchar(12) NOT NULL CHECK(status IN ('ACTIVE','INACTIVE'))` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `credential_version` | `bigint NOT NULL DEFAULT 1 CHECK(credential_version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `last_login_at` | `timestamptz` |

## `security_policy`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `integer PRIMARY KEY CHECK(id=1)` |
| `lock_enabled` | `boolean NOT NULL DEFAULT true` |
| `max_attempts` | `integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 3 AND 10)` |
| `lock_minutes` | `integer NOT NULL DEFAULT 30 CHECK(lock_minutes BETWEEN 1 AND 1440)` |
| `session_minutes` | `integer NOT NULL DEFAULT 30 CHECK(session_minutes BETWEEN 5 AND 1440)` |
| `min_password_length` | `integer NOT NULL DEFAULT 12 CHECK(min_password_length BETWEEN 12 AND 64)` |
| `require_letter` | `boolean NOT NULL DEFAULT true` |
| `require_number` | `boolean NOT NULL DEFAULT true` |
| `require_mixed_case` | `boolean NOT NULL DEFAULT false` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

## `community_group`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `integer PRIMARY KEY CHECK(id=1)` |
| `image` | `bytea` |
| `expires_at` | `timestamptz` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `CHECK((image` | `IS NULL) = (expires_at IS NULL))` |

## `admin_control`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `integer PRIMARY KEY CHECK(id=1)` |
| `bootstrap_completed_at` | `timestamptz` |

## `user_session`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `token_digest` | `bytea NOT NULL UNIQUE CHECK(octet_length(token_digest)=32)` |
| `credential_version` | `bigint NOT NULL` |
| `device_id` | `uuid NOT NULL` |
| `issued_at` | `timestamptz NOT NULL` |
| `expires_at` | `timestamptz NOT NULL` |
| `last_seen_at` | `timestamptz NOT NULL` |
| `revoked_at` | `timestamptz` |
| `CHECK(expires_at>issued_at)` | `` |
| `UNIQUE(id,user_id)` | `` |

## `session_presence`

| 字段或约束 | 定义 |
| --- | --- |
| `session_id` | `uuid PRIMARY KEY REFERENCES user_session(id)` |
| `foreground_seen_at` | `timestamptz NOT NULL` |

## `admin_session`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `admin_id` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `token_digest` | `bytea NOT NULL UNIQUE CHECK(octet_length(token_digest)=32)` |
| `credential_version` | `bigint NOT NULL` |
| `device_id` | `uuid NOT NULL` |
| `issued_at` | `timestamptz NOT NULL` |
| `expires_at` | `timestamptz NOT NULL` |
| `last_seen_at` | `timestamptz NOT NULL` |
| `revoked_at` | `timestamptz` |
| `CHECK(expires_at>issued_at)` | `` |

## `login_attempt`

| 字段或约束 | 定义 |
| --- | --- |
| `scope_digest` | `bytea PRIMARY KEY CHECK(octet_length(scope_digest)=32)` |
| `failures` | `integer NOT NULL DEFAULT 0` |
| `blocked_until` | `timestamptz` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

## `email_challenge`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid REFERENCES user_account(id)` |
| `purpose` | `varchar(24) NOT NULL CHECK(purpose IN ('REGISTER','RESET_PASSWORD','BIND_EMAIL','CHANGE_PASSWORD','CHANGE_EMAIL_OLD','CHANGE_EMAIL_NEW'))` |
| `email` | `varchar(254) NOT NULL` |
| `email_key` | `varchar(254) NOT NULL` |
| `code_mac` | `bytea NOT NULL CHECK(octet_length(code_mac)=32)` |
| `key_version` | `integer NOT NULL` |
| `eligible` | `boolean NOT NULL` |
| `credential_version` | `bigint` |
| `failed_attempts` | `integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5)` |
| `created_at` | `timestamptz NOT NULL` |
| `expires_at` | `timestamptz NOT NULL` |
| `consumed_at` | `timestamptz` |
| `CHECK(expires_at>created_at)` | `` |

## `wechat_ticket`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `token_digest` | `bytea NOT NULL UNIQUE` |
| `app_id` | `varchar(64) NOT NULL` |
| `open_id` | `varchar(128) NOT NULL` |
| `union_id` | `varchar(128)` |
| `expires_at` | `timestamptz NOT NULL` |
| `consumed_at` | `timestamptz` |

## `subject`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `name` | `varchar(120) NOT NULL UNIQUE` |
| `description` | `text NOT NULL DEFAULT ''` |
| `status` | `varchar(12) NOT NULL CHECK(status IN ('ACTIVE','INACTIVE'))` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

## `question_bank`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `subject_id` | `uuid NOT NULL REFERENCES subject(id)` |
| `name` | `varchar(120) NOT NULL` |
| `description` | `text NOT NULL DEFAULT ''` |
| `textbook` | `varchar(500) NOT NULL DEFAULT ''` |
| `status` | `varchar(12) NOT NULL CHECK(status IN ('ACTIVE','INACTIVE'))` |
| `publication_status` | `varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(publication_status IN ('DRAFT','PUBLISHED','UNPUBLISHED','ARCHIVED'))` |
| `scope_type` | `varchar(12) NOT NULL DEFAULT 'ALL' CHECK(scope_type IN ('ALL','TARGETED'))` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `content_version` | `bigint NOT NULL DEFAULT 1 CHECK(content_version>0)` |
| `created_by` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `UNIQUE(id,subject_id)` | `` |

## `bank_maintainer`

| 字段或约束 | 定义 |
| --- | --- |
| `bank_id` | `uuid NOT NULL REFERENCES question_bank(id)` |
| `admin_id` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `PRIMARY` | `KEY(bank_id,admin_id)` |

## `bank_audience`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `bank_id` | `uuid NOT NULL REFERENCES question_bank(id)` |
| `college_id` | `uuid REFERENCES college(id)` |
| `major_id` | `uuid REFERENCES major(id)` |
| `grade` | `integer CHECK(grade BETWEEN 1 AND 5)` |
| `CHECK(major_id` | `IS NULL OR college_id IS NULL)` |
| `CHECK(num_nonnulls(college_id,major_id,grade)>0)` | `` |
| `UNIQUE` | `NULLS NOT DISTINCT(bank_id,college_id,major_id,grade)` |

## `subject_user_access`

| 字段或约束 | 定义 |
| --- | --- |
| `subject_id` | `uuid NOT NULL REFERENCES subject(id)` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `granted_by` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `PRIMARY` | `KEY(subject_id,user_id)` |

## `chapter`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `bank_id` | `uuid NOT NULL REFERENCES question_bank(id)` |
| `name` | `varchar(120) NOT NULL` |
| `sort_order` | `integer NOT NULL CHECK(sort_order>=0)` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `UNIQUE(id,bank_id)` | `` |
| `UNIQUE(bank_id,sort_order)` | `DEFERRABLE INITIALLY DEFERRED` |

## `question`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `bank_id` | `uuid NOT NULL REFERENCES question_bank(id)` |
| `chapter_id` | `uuid` |
| `status` | `varchar(12) NOT NULL CHECK(status IN ('ACTIVE','INACTIVE'))` |
| `reading_parent_id` | `uuid` |
| `reading_order` | `integer NOT NULL DEFAULT 0 CHECK(reading_order>=0)` |
| `is_group` | `boolean NOT NULL DEFAULT false` |
| `current_revision_id` | `uuid NOT NULL` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `FOREIGN` | `KEY(chapter_id,bank_id) REFERENCES chapter(id,bank_id)` |
| `UNIQUE(id,bank_id)` | `` |
| `FOREIGN` | `KEY(reading_parent_id,bank_id) REFERENCES question(id,bank_id)` |
| `CHECK(NOT` | `is_group OR reading_parent_id IS NULL)` |

## `question_revision`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `question_id` | `uuid NOT NULL REFERENCES question(id) DEFERRABLE INITIALLY DEFERRED` |
| `revision_number` | `integer NOT NULL CHECK(revision_number>0)` |
| `type` | `varchar(20) NOT NULL CHECK(type IN ('SINGLE_CHOICE','MULTIPLE_CHOICE','TRUE_FALSE','FILL_BLANK','SHORT_ANSWER','READING'))` |
| `stem` | `text NOT NULL` |
| `explanation` | `text NOT NULL DEFAULT ''` |
| `correct_value` | `boolean` |
| `reference_answer` | `text` |
| `content_data` | `text NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(content_data::jsonb)='object')` |
| `created_by` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `CHECK((type='TRUE_FALSE')=(correct_value` | `IS NOT NULL))` |
| `CHECK((type='SHORT_ANSWER')=(reference_answer` | `IS NOT NULL))` |
| `UNIQUE(question_id,id)` | `` |
| `UNIQUE(question_id,revision_number)` | `` |

## `question_option`

| 字段或约束 | 定义 |
| --- | --- |
| `revision_id` | `uuid NOT NULL REFERENCES question_revision(id)` |
| `option_key` | `varchar(8) NOT NULL` |
| `content` | `text NOT NULL` |
| `is_correct` | `boolean NOT NULL` |
| `sort_order` | `integer NOT NULL` |
| `PRIMARY` | `KEY(revision_id,option_key)` |
| `UNIQUE(revision_id,sort_order)` | `` |

## `file_asset`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `bank_id` | `uuid NOT NULL REFERENCES question_bank(id)` |
| `uploaded_by` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `storage_key` | `varchar(128) NOT NULL UNIQUE` |
| `sha256` | `varchar(64) NOT NULL` |
| `media_type` | `varchar(32) NOT NULL CHECK(media_type='image/png')` |
| `size_bytes` | `bigint NOT NULL CHECK(size_bytes>0)` |
| `width_pixels` | `integer NOT NULL CHECK(width_pixels>0)` |
| `height_pixels` | `integer NOT NULL CHECK(height_pixels>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

## `question_attachment`

| 字段或约束 | 定义 |
| --- | --- |
| `revision_id` | `uuid NOT NULL REFERENCES question_revision(id)` |
| `file_id` | `uuid NOT NULL REFERENCES file_asset(id)` |
| `PRIMARY` | `KEY(revision_id,file_id)` |

## `user_favorite`

| 字段或约束 | 定义 |
| --- | --- |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `question_id` | `uuid NOT NULL REFERENCES question(id)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `PRIMARY` | `KEY(user_id,question_id)` |

## `practice_session`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `bank_id` | `uuid NOT NULL REFERENCES question_bank(id)` |
| `selection_kind` | `varchar(12) NOT NULL CHECK(selection_kind IN ('NORMAL','WRONG','FAVORITE'))` |
| `question_order` | `varchar(12) NOT NULL CHECK(question_order IN ('SEQUENTIAL','RANDOM'))` |
| `feedback` | `varchar(16) NOT NULL CHECK(feedback IN ('IMMEDIATE','AFTER_FINISH'))` |
| `status` | `varchar(16) NOT NULL CHECK(status IN ('IN_PROGRESS','SUBMITTED','CANCELLED'))` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `current_index` | `integer NOT NULL DEFAULT 0 CHECK(current_index>=0)` |
| `duration_seconds` | `integer NOT NULL DEFAULT 0 CHECK(duration_seconds>=0)` |
| `configuration_snapshot` | `text NOT NULL` |
| `auto_add_wrong_book` | `boolean NOT NULL DEFAULT true` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `submitted_at` | `timestamptz` |
| `UNIQUE(id,user_id)` | `` |
| `CHECK((status='SUBMITTED')=(submitted_at` | `IS NOT NULL))` |

## `practice_sync_state`

| 字段或约束 | 定义 |
| --- | --- |
| `session_id` | `uuid PRIMARY KEY REFERENCES practice_session(id)` |
| `writer_device_id` | `uuid` |
| `writer_token` | `uuid` |
| `acknowledged_sequence` | `bigint NOT NULL DEFAULT 0 CHECK(acknowledged_sequence>=0)` |
| `CHECK((writer_device_id` | `IS NULL)=(writer_token IS NULL))` |

## `practice_item`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `session_id` | `uuid NOT NULL REFERENCES practice_session(id)` |
| `question_id` | `uuid NOT NULL` |
| `revision_id` | `uuid NOT NULL` |
| `material_revision_id` | `uuid REFERENCES question_revision(id)` |
| `answer_blanks` | `text CHECK(answer_blanks IS NULL OR jsonb_typeof(answer_blanks::jsonb)='array')` |
| `position` | `integer NOT NULL CHECK(position>=0)` |
| `answer_text` | `text` |
| `answer_boolean` | `boolean` |
| `confirmed` | `boolean NOT NULL DEFAULT false` |
| `marked` | `boolean NOT NULL DEFAULT false` |
| `outcome` | `varchar(12) CHECK(outcome IN ('CORRECT','WRONG','UNANSWERED','SELF_RATED'))` |
| `self_assessment` | `varchar(12) CHECK(self_assessment IN ('CORRECT','WRONG'))` |
| `FOREIGN` | `KEY(question_id,revision_id) REFERENCES question_revision(question_id,id)` |
| `UNIQUE(session_id,position)` | `` |
| `UNIQUE(session_id,question_id)` | `` |
| `UNIQUE(id,revision_id)` | `` |

## `practice_item_choice`

| 字段或约束 | 定义 |
| --- | --- |
| `item_id` | `uuid NOT NULL` |
| `revision_id` | `uuid NOT NULL` |
| `option_key` | `varchar(8) NOT NULL` |
| `PRIMARY` | `KEY(item_id,option_key)` |
| `FOREIGN` | `KEY(item_id,revision_id) REFERENCES practice_item(id,revision_id)` |
| `FOREIGN` | `KEY(revision_id,option_key) REFERENCES question_option(revision_id,option_key)` |

## `practice_result`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `session_id` | `uuid NOT NULL UNIQUE REFERENCES practice_session(id)` |
| `total_count` | `integer NOT NULL CHECK(total_count>0)` |
| `objective_count` | `integer NOT NULL` |
| `answered_count` | `integer NOT NULL` |
| `correct_count` | `integer NOT NULL` |
| `wrong_count` | `integer NOT NULL` |
| `unanswered_count` | `integer NOT NULL` |
| `short_answer_count` | `integer NOT NULL` |
| `duration_seconds` | `integer NOT NULL CHECK(duration_seconds>=0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `CHECK(objective_count=correct_count+wrong_count+unanswered_count)` | `` |
| `CHECK(total_count=objective_count+short_answer_count)` | `` |
| `CHECK(correct_count>=0` | `AND wrong_count>=0 AND unanswered_count>=0 AND short_answer_count>=0)` |
| `CHECK(answered_count` | `BETWEEN correct_count+wrong_count AND total_count-unanswered_count)` |

## `question_feedback`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `question_id` | `uuid NOT NULL` |
| `revision_id` | `uuid NOT NULL` |
| `category` | `varchar(24) NOT NULL CHECK(category IN ('ANSWER','EXPLANATION','STEM_OPTIONS','OTHER'))` |
| `body` | `text NOT NULL` |
| `status` | `varchar(16) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','RESOLVED','DISMISSED'))` |
| `response` | `text NOT NULL DEFAULT ''` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `FOREIGN` | `KEY(question_id,revision_id) REFERENCES question_revision(question_id,id)` |

## `course_request`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `course_name` | `varchar(120) NOT NULL` |
| `major_id` | `uuid REFERENCES major(id)` |
| `body` | `text NOT NULL` |
| `status` | `varchar(16) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','RESOLVED','DISMISSED'))` |
| `response` | `text NOT NULL DEFAULT ''` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

## `announcement`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `title` | `varchar(120) NOT NULL` |
| `summary` | `varchar(500) NOT NULL` |
| `body` | `text NOT NULL` |
| `audience` | `varchar(12) NOT NULL CHECK(audience IN ('ALL','SELECTED'))` |
| `status` | `varchar(16) NOT NULL CHECK(status IN ('DRAFT','PUBLISHED','SCHEDULED'))` |
| `publish_at` | `timestamptz` |
| `pinned` | `boolean NOT NULL DEFAULT false` |
| `show_community_group` | `boolean NOT NULL DEFAULT false` |
| `version` | `bigint NOT NULL DEFAULT 1 CHECK(version>0)` |
| `created_by` | `uuid NOT NULL REFERENCES admin_account(id)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `CHECK(status<>'SCHEDULED'` | `OR publish_at IS NOT NULL)` |

## `announcement_recipient`

| 字段或约束 | 定义 |
| --- | --- |
| `announcement_id` | `uuid NOT NULL REFERENCES announcement(id)` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `PRIMARY` | `KEY(announcement_id,user_id)` |

## `user_activity`

| 字段或约束 | 定义 |
| --- | --- |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `activity_date` | `date NOT NULL` |
| `first_seen_at` | `timestamptz NOT NULL DEFAULT now()` |
| `last_seen_at` | `timestamptz NOT NULL DEFAULT now()` |
| `PRIMARY` | `KEY(user_id,activity_date)` |

## `mail_delivery`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `challenge_id` | `uuid NOT NULL UNIQUE REFERENCES email_challenge(id)` |
| `template_code` | `varchar(40) NOT NULL` |
| `template_version` | `integer NOT NULL` |
| `ciphertext` | `text NOT NULL` |
| `nonce` | `text NOT NULL` |
| `key_version` | `integer NOT NULL` |
| `expires_at` | `timestamptz NOT NULL` |
| `state` | `varchar(24) NOT NULL CHECK(state IN ('PENDING','SENDING','ACCEPTED','RETRYABLE_FAILED','PERMANENT_FAILED','UNKNOWN','CANCELLED'))` |
| `attempts` | `integer NOT NULL DEFAULT 0` |
| `next_attempt_at` | `timestamptz NOT NULL DEFAULT now()` |
| `lease_id` | `uuid` |
| `leased_at` | `timestamptz` |
| `provider_message_id` | `varchar(256)` |
| `error_code` | `varchar(64)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

## `command_receipt`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `scope` | `varchar(100) NOT NULL` |
| `operation` | `varchar(200) NOT NULL` |
| `command_id` | `uuid NOT NULL` |
| `actor_user_id` | `uuid REFERENCES user_account(id)` |
| `actor_admin_id` | `uuid REFERENCES admin_account(id)` |
| `payload_digest` | `bytea NOT NULL` |
| `digest_key_version` | `integer NOT NULL` |
| `response_json` | `text NOT NULL` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `UNIQUE(scope,operation,command_id)` | `` |
| `CHECK(num_nonnulls(actor_user_id,actor_admin_id)<=1)` | `` |

## `audit_log`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `actor_user_id` | `uuid REFERENCES user_account(id)` |
| `actor_admin_id` | `uuid REFERENCES admin_account(id)` |
| `operation` | `varchar(200) NOT NULL` |
| `request_id` | `uuid NOT NULL` |
| `outcome` | `varchar(12) NOT NULL CHECK(outcome IN ('SUCCESS','FAILURE'))` |
| `reason_code` | `varchar(64)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `CHECK(num_nonnulls(actor_user_id,actor_admin_id)<=1)` | `` |

## `sync_command`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `session_id` | `uuid NOT NULL` |
| `user_id` | `uuid NOT NULL` |
| `actor_session_id` | `uuid NOT NULL` |
| `writer_token` | `uuid NOT NULL` |
| `client_sequence` | `bigint NOT NULL CHECK(client_sequence>0)` |
| `payload_digest` | `bytea NOT NULL` |
| `digest_key_version` | `integer NOT NULL` |
| `request_id` | `uuid NOT NULL` |
| `state` | `varchar(20) NOT NULL CHECK(state IN ('ACCEPTING','QUEUED','RETRYING','COMMITTED','REJECTED','DEAD_LETTER'))` |
| `attempts` | `integer NOT NULL DEFAULT 0 CHECK(attempts>=0)` |
| `error_code` | `varchar(64)` |
| `error_message` | `varchar(200)` |
| `error_status` | `integer` |
| `receipt_id` | `uuid UNIQUE REFERENCES command_receipt(id)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `completed_at` | `timestamptz` |
| `FOREIGN` | `KEY(session_id,user_id) REFERENCES practice_session(id,user_id)` |
| `FOREIGN` | `KEY(actor_session_id,user_id) REFERENCES user_session(id,user_id)` |
| `CHECK((state='COMMITTED')=(receipt_id` | `IS NOT NULL))` |
| `CHECK((state` | `IN ('COMMITTED','REJECTED'))=(completed_at IS NOT NULL))` |

## `domain_event_outbox`

| 字段或约束 | 定义 |
| --- | --- |
| `id` | `uuid PRIMARY KEY` |
| `user_id` | `uuid NOT NULL REFERENCES user_account(id)` |
| `occurred_at` | `timestamptz NOT NULL` |
| `processed_at` | `timestamptz` |
