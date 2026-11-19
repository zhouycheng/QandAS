# 开发与运行

项目包含微信原生 JavaScript 小程序、React 管理端及 Kotlin / Spring Boot / MyBatis-Plus / PostgreSQL 后端。应用和接口合同版本统一为 `1.0.0`，接口前缀为 `/api/v1`。

设计参考：[题小搭 Figma 设计稿](https://www.figma.com/design/WWbHe9aOlf65LEwbUANxyn/QandA?node-id=1-2&t=7uv0uiEbx0WhNMtA-1)。

## 依赖与前端

在仓库根目录准备共享内容包：

```sh
npm --prefix packages/content-format ci
npm --prefix packages/content-format run build
```

管理端在 `apps/admin` 执行 `pnpm install`、`pnpm dev`。默认端口 5174，使用同源 `/api/v1`。本地代理默认连接 Compose gateway 的 8083 端口，自定义网关端口通过 `QANDA_GATEWAY_PROXY_TARGET` 指定。该网关同时路由 api 与 monitor。运行 `integration.py admin` 时会自动使用联调环境网关。原先通过 `QANDA_API_PROXY_TARGET` 指定地址的环境，请将网关地址配置为 `QANDA_GATEWAY_PROXY_TARGET`。账号由后端初始化，配置和凭据保存在忽略文件或仓库外。

微信开发者工具导入 `apps/miniapp`。在该目录执行 `npm ci`、`npm run build`。将 `miniprogram/ext.example.json` 复制为忽略的 `ext.json`，填写 AppID 和 `extConfig.apiBaseUrl`；构建脚本生成本机运行配置并调用官方 npm 构建。真机需要可访问的 HTTPS 服务和合法请求域名。

## 后端

需要 JDK 21、Node.js、Python 3 和 Docker。首次运行：

```sh
node apps/api/scripts/backend.mjs init
node apps/api/scripts/rebuild.mjs
node apps/api/scripts/backend.mjs docker-up
node apps/api/scripts/backend.mjs docker-bootstrap
```

私有配置保存在 `apps/api/.env.backend`，权限为 `600`。首管命令通过终端读取账号和密码。API、worker、monitor、PostgreSQL、RabbitMQ、Redis、Prometheus 和本地邮件捕获由 Compose 管理；gateway 提供统一入口。`init` 生成完整配置及独立随机密钥，运行脚本校验必需字段。`deps` 启动 PostgreSQL 和 Redis，本机缓存端口仅绑定回环地址。

普通构建和重启保留数据卷。空库通过 `schema-init` 或开发命令直接加载当前 `schema.sql` 与监控权限脚本；已有库运行 `schema-init` 执行增量升级，无法识别的结构会中止并报告差异。`build`、`test`、`verify` 清理 Maven 构建产物，避免包内残留旧文件。数据库命令的环境、名称和本机地址保护继续有效。

官方微信和真实邮件采用仓库外的私有提供端配置。自动检查使用测试身份和本地邮件捕获。腾讯云 SES 私有配置位于 `~/.config/qanda/tencent-ses.env`，权限为 `600`，仅由明确的实发操作使用。

后端测试需要可访问的 Docker daemon。运行脚本会识别默认 Colima socket；使用其他已运行的本机 Colima 实例时，为本次命令设置 `DOCKER_HOST` 指向该实例的 socket，并设置 `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`。Testcontainers 创建独立测试容器，运行结束后清理。

持久联调入口 `apps/api/scripts/integration.py` 使用权限 `600` 的完整私有环境；缺少必需字段时停止运行，已配置内容不会被启动脚本改写。

## 历史版本管理

「系统 → 历史版本管理」按实际后端发布提交列出兼容项。管理员读接口为 `GET /api/v1/admin/monitoring/compatibility`，查询参数 `release` 可指定发布版本。API 按 UTC 自然日记录实际进入旧接口或兼容分支的请求，同一请求内同一兼容项只计一次。近 7 天、近 30 天均包含今天。采集有缺口时，已有调用显示为下限，缺少证据时显示「未知」。历史导入方式无法从现存题目反推。

数据依赖统计读取当前数据库。它分别统计缺少正文格式的题目版本，以及历史练习仍引用的题目和阅读材料版本。显式保存为纯文本的题目是正常格式。调用量用于评估旧版本的使用情况，退役由后续发布单独决定。

## 日常维护

修改代码后运行 `rebuild.mjs`，再执行 `backend.mjs docker-up`。日志使用 `docker-logs`，停止使用 `docker-stop`。健康接口为 `/api/v1/health`，Swagger 为 `/swagger-ui/index.html`，运行时合同为 `/v3/api-docs`。

源素材与图标生成脚本用于维护现有资源；生成目录、运行证据和私有配置遵循 `.gitignore`。提交及 PR 规则见[Git 工作流](git-workflow.md)，验收命令见[验收规范](verification.md)。

测试学生账号的创建、凭据密钥和到期行为见[测试账号管理](test-accounts.md)。
