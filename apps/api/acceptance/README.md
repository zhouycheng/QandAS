# 后端接口验收


## Maven 验收

从仓库根目录执行，需要 JDK 21、Node.js、Python 3 和运行中的 Docker：

```sh
node apps/api/scripts/backend.mjs test
node apps/api/scripts/backend.mjs verify
```

`test` 执行单元及模块依赖检查；`verify` 还执行 Testcontainers PostgreSQL、RabbitMQ、Prometheus、Mailpit 的 HTTP/SSE 验收，并通过打包后的 JAR 检查数据库初始化、交互式首管创建及独立监控进程。测试数据库均为临时隔离容器，测试结束后删除。


### 身份与内容检测

普通用户使用邮箱验证码或微信登录，首次验证成功直接创建账号并返回会话。固定测试登录码只接受真实测试记录；管理员密码使用独立策略。测试覆盖首次登录并发、验证码重放、绑定冲突、更换邮箱及会话撤销。

`ContentSafetyPostgresTest` 使用显式本地提供端，覆盖邮箱账号独立检测上下文、请求与会话绑定、内容版本变化、失败保留原资料、私有待检测头像、回调重放及注销后的迟到回调。`WechatCallbackTest` 检查签名、加解密、过期请求及 XML 外部实体拒绝。真实微信接口和真机验证单独记录，不能从本地提供端测试推导。

注销验证当前会话的登录身份，明确确认后执行幂等清理；注销回执不依赖已删除账号。正式学习历史的不可变保护与注销清理分别测试。

默认运行证据位于忽略目录 `.backend-runtime/verification/`：

| 文件 | 内容 |
| --- | --- |
| `openapi.json` | 本次服务运行导出的合同 |
| `http-redacted.json` | 去除密码、验证码及令牌的 HTTP 请求与响应 |
| `bootstrap-cli.json` | 打包程序和真实终端验收结果 |
| `spec-validation.json` | 全部合同文档结构校验 |
| `http-schema-validation.json` | 逐次 HTTP Schema 校验 |
| `operation-coverage.json` | 逐操作成功观察与 Schema 状态 |
| `miniapp-live.json` | 真实小程序请求层、Repository、ViewModel 对接临时 PostgreSQL 与 HTTP 的练习闭环 |
| `practice-sync-observation.json` | 4 题练习 30 次串行保存的响应大小、进程 CPU 与用时观察 |
| `database-schema.json` | 实际初始化后的表、列、约束和索引，供 ER 与字段字典复核 |
| `monitor-runtime.log` | 独立监控 JAR 的启动及受限查询记录 |

SSE 在 `http-redacted.json` 中记录首个 `sync-health` 事件的 JSON 数据并按对应 Schema 校验；持续推送、权限撤销和断线行为由集成测试及管理端流式读取测试检查。队列计数对照输出为测试日志中的 `SYNC_METRICS_EVIDENCE`。

已注册、实际成功观察、Schema 通过是不同证据。台账依据当前运行文件生成，缺少记录时显示未观察；不会依据接口存在自动声称验收通过。构建报告位于 `target/surefire-reports/` 和 `target/failsafe-reports/`。

## 合同与 Postman

QA 依赖见 [`requirements-qa.txt`](requirements-qa.txt)。首次使用可在忽略目录创建工具环境：

```sh
uv venv --python 3.12 apps/api/.backend-runtime/verification/quality/tools/python
uv pip install --python apps/api/.backend-runtime/verification/quality/tools/python/bin/python \
  -r apps/api/acceptance/requirements-qa.txt
```

运行集成验收后，从仓库根目录执行：

```sh
QA_PY=apps/api/.backend-runtime/verification/quality/tools/python/bin/python
"$QA_PY" apps/api/acceptance/contracts.py export
"$QA_PY" apps/api/acceptance/contracts.py spec \
  > apps/api/.backend-runtime/verification/spec-validation.json
"$QA_PY" apps/api/acceptance/contracts.py exchanges \
  < apps/api/.backend-runtime/verification/http-redacted.json \
  > apps/api/.backend-runtime/verification/http-schema-validation.json
"$QA_PY" apps/api/acceptance/postman.py
"$QA_PY" apps/api/acceptance/ledger.py
```

可用 `QANDA_QUALITY_EVIDENCE_DIR` 指定另一批运行证据。`export --source` 可指定该次运行的 OpenAPI JSON。合同校验包含格式、类型、必填、重复值、未知字段及数值边界的反例自检。

导入生成的 [Postman 集合](../postman/QandA.postman_collection.json)和[本地环境](../postman/QandA-Local.postman_environment.json)。账号、密码、邮箱、验证码和令牌变量为空，由运行者填写；资源 ID、并发字段和当前令牌由响应脚本提取。每个写意图生成幂等键，需要模拟同一意图重试时设置 `commandKey` 为之前的 `lastCommandKey`。请求样例见 [`QandA.examples.json`](../postman/QandA.examples.json)。
