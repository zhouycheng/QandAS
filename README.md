# QandA

QandA 是面向课程复习的题库与练习平台，提供微信小程序、内容管理端和 Kotlin 后端，当前版本为 **V1.0.0**。

小程序支持课程题库、六类内容、联合练习、模拟考试、错题收藏和学习复盘。已下载的练习可在同一设备离线续答，联网后可靠同步。管理端负责目录、内容、发布、用户、公告、反馈及运行监控。

## 使用与开发

- [开发与运行](docs/development.md)：三端启动、配置和设计稿入口。
- [产品规则](docs/product-rules.md)：访问范围、练习、成绩及内容管理。
- [题库导入](docs/question-bank-import.md)：JSON 协议、模板和示例。
- [项目文档](docs/README.md)：架构、数据库、同步和验收规范。

## 工程结构

| 目录 | 内容 |
| --- | --- |
| `apps/miniapp` | 微信原生小程序 |
| `apps/admin` | React 管理端 |
| `apps/api` | Kotlin API、worker、monitor、数据库及接口合同 |
| `packages/content-format` | 共享 Markdown 与代码内容处理 |
| `docs` | 产品及工程规范 |

开发协作遵循 [Git 工作流](docs/git-workflow.md)。

- [生产部署与恢复](docs/deployment.md)
