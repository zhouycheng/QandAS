# 开发与运行

项目包含微信原生 JavaScript 小程序、React 管理端及 Kotlin / Spring Boot / MyBatis-Plus / PostgreSQL 后端。应用和接口合同版本统一为 `1.0.0`，接口前缀为 `/api/v1`。

设计参考：[题小搭 Figma 设计稿](https://www.figma.com/design/WWbHe9aOlf65LEwbUANxyn/QandA?node-id=1-2&t=7uv0uiEbx0WhNMtA-1)。

## 依赖与前端

在仓库根目录准备共享内容包：

```sh
npm --prefix packages/content-format ci
npm --prefix packages/content-format run build
```

管理端在 `apps/admin` 执行 `pnpm install`、`pnpm dev`。默认端口 5174，使用同源 `/api/v1`。跨服务开发使用 `VITE_API_BASE_URL` 或已有 `QANDA_API_PROXY_TARGET` 配置。账号由后端初始化，配置和凭据保存在忽略文件或仓库外。

微信开发者工具导入 `apps/miniapp`。在该目录执行 `npm ci`、`npm run build`。将 `miniprogram/ext.example.json` 复制为忽略的 `ext.json`，填写 AppID 和 `extConfig.apiBaseUrl`；构建脚本生成本机运行配置并调用官方 npm 构建。真机需要可访问的 HTTPS 服务和合法请求域名。

## 后端

需要 JDK 21、Node.js、Python 3 和 Docker。首次运行：

```sh
node apps/api/scripts/backend.mjs init
node apps/api/scripts/rebuild.mjs
node apps/api/scripts/backend.mjs docker-up
node apps/api/scripts/backend.mjs docker-bootstrap
```

私有配置保存在 `apps/api/.env.backend`，权限为 `600`。首管命令通过终端读取账号和密码。API、worker、monitor、PostgreSQL、RabbitMQ、Prometheus 和本地邮件捕获由 Compose 管理；gateway 提供统一入口。

普通重建保留数据卷。空库初始化执行统一 V1 的 `schema.sql` 和监控权限脚本，启动时核对结构。`build`、`test`、`verify` 先清理 Maven 构建产物，防止已删除的迁移脚本残留在包中。本次重构直接调整 V1，不提供旧数据升级脚本；已有库与新代码结构不一致时必须停止，不能通过修复校验和继续运行。需要重建专用开发／测试数据时，先核实目标环境、停止业务进程，重置该环境的数据库、关联队列及客户端账号缓存和草稿，再启动相同代码版本。学习偏好、布局和游客试答额度独立保留。数据库命令的运行模式、名称和本机地址保护继续有效。

官方微信和真实邮件采用仓库外的私有提供端配置。自动检查使用测试身份和本地邮件捕获。腾讯云 SES 私有配置位于 `~/.config/qanda/tencent-ses.env`，权限为 `600`，仅由明确的实发操作使用。

后端测试需要可访问的 Docker daemon。运行脚本会识别默认 Colima socket；使用其他已运行的本机 Colima 实例时，为本次命令设置 `DOCKER_HOST` 指向该实例的 socket，并设置 `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`。Testcontainers 创建独立测试容器，运行结束后清理。

## 日常维护

修改代码后运行 `rebuild.mjs`，再执行 `backend.mjs docker-up`。日志使用 `docker-logs`，停止使用 `docker-stop`。健康接口为 `/api/v1/health`，Swagger 为 `/swagger-ui/index.html`，运行时合同为 `/v3/api-docs`。

源素材与图标生成脚本用于维护现有资源；生成目录、运行证据和私有配置遵循 `.gitignore`。提交及 PR 规则见[Git 工作流](git-workflow.md)，验收命令见[验收规范](verification.md)。

测试学生账号的创建、凭据密钥和到期行为见[测试账号管理](test-accounts.md)。
