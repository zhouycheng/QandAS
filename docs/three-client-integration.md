# 三端实际联调

2026-11-01，独立联调环境已运行当前 v1.0 后端，合同包含 136 个操作。浏览器管理端与微信开发者工具连接同一服务入口，首轮账号、目录、作答、同步、结果和监控流程已通过实际调用验证。

## 环境与操作入口

联调使用独立 Colima profile 和 Docker Compose project `qanda-integration`。API、同步消费者、监控、网关、RabbitMQ、PostgreSQL、Prometheus、Mailpit 共 8 个服务使用独立数据卷；原开发环境继续保留。

本机连接参数和测试凭据保存在 `$HOME/.config/qanda/integration/`，权限为目录 `700`、配置文件 `600`：

| 文件或字段 | 用途 |
| --- | --- |
| `environment.json` 的 `adminUrl`、`api`、`mail` | 管理端、统一服务入口、验证码收件箱 |
| `admin`、`secondAdmin` | 两个超级管理员账号，具有相同管理权限 |
| `uiAdmin` | 本轮通过管理端设置页面创建并验证登录的管理员 |
| `student`、`secondStudent` | 两名学生，分别设置不同专业；密码符合 8–16 位且包含字母、数字的规则 |
| `backend.env` | 独立容器端口、数据库及队列凭据、业务密钥 |
| `fixtures.json` | 联调样例 ID、写入幂等键和初始化进度 |
| `verification.json` | 本次实际 HTTP 与队列检查结果、排队时的 SSE 快照 |
| `miniapp-original.json` | 切换联调入口前的小程序本机配置 |

邮箱注册及找回密码的验证码由 Mailpit 捕获。正式运行的微信身份交换和外部邮件投递需另行验证。

管理端使用真实 HTTP Gateway，经 Vite 同源代理访问统一入口，SSE 沿用同一代理。小程序的忽略文件 `ext.json` 和构建生成的本机配置指向该入口。

## 日常使用

从仓库根目录执行。当前环境已经初始化，继续使用时运行 `status` 检查；代码更新后用 `up` 重建并启动服务，管理端启动命令保持前台运行。

```sh
python3 apps/api/scripts/integration.py status
python3 apps/api/scripts/integration.py up
python3 apps/api/scripts/integration.py admin
```

首次准备新环境的顺序如下。`init` 遇到已有配置会停止，避免替换现有账号与密钥；`bootstrap` 和 `seed` 保存进度，允许中断后继续。

```sh
colima start --profile qanda-integration --cpu 4 --memory 4 --disk 20 --activate=false
python3 apps/api/scripts/integration.py init
python3 apps/api/scripts/integration.py up
python3 apps/api/scripts/integration.py bootstrap
python3 apps/api/scripts/integration.py seed
python3 apps/api/scripts/integration.py connect
python3 apps/api/scripts/integration.py admin
```

`connect` 更新本机小程序配置并执行 npm 构建。微信开发者工具打开 `apps/miniapp` 后，使用私有配置中的学生账号登录。已配置的 `wechatide` 可以通过 `node apps/miniapp/scripts/integration-login.cjs` 完成相同的界面登录。

查看日志和停止服务：

```sh
python3 apps/api/scripts/integration.py logs
python3 apps/api/scripts/integration.py stop
```

`stop` 保留联调数据卷。后端及合同保持 v1.0，初始化结构使用当前 `schema.sql`。

## 样例与真实客户端检查

开发数据包含学院、两个专业、全校开放课程、专业范围课程、已发布题库、未发布草稿和公告。主练习覆盖单选、多选、判断、填空、简答、阅读题组；阅读题组包含两道小题，整卷共 7 道作答题。

| 检查 | 本轮实际结果 |
| --- | --- |
| 管理端登录与运营页面 | 真实登录后进入概览；活跃度、公告、系统监控和管理员设置正常读取后端 |
| 管理员账号 | 在设置表单创建账号，使用独立浏览器上下文登录成功；身份统一为超级管理员 |
| 在线明细 | 点击“当前在线”，抽屉展示登录学生及小程序客户端、最近心跳 |
| 小程序登录与目录 | 通过登录表单进入首页，题库页读取真实科目和已发布题库 |
| 小程序练习 | 从题库配置进入 7 题练习，逐题点击或输入；简答展示参考答案并自评；交卷后结果为 7/7、100% |
| 同步状态 | 界面出现本机保存、服务器处理中和服务器保存状态，正式结果与后端一致 |
| 会话过期 | 服务端撤销本次小程序会话，复盘页显示登录引导；重新登录成功 |

浏览器截图保存在私有目录中的 `admin-activity.png`、`admin-monitoring.png`、`admin-announcements.png`、`admin-administrators.png`、`admin-online.png`、`admin-created.png`，小程序结果截图为 `miniapp-result.png`。截图可能包含测试账号资料，按本机验证材料保存。

## HTTP 与队列闭环

执行 `python3 apps/api/scripts/integration_check.py` 可重复验证当前持久联调环境。脚本会创建正式测试练习、反馈和活跃记录，并短暂停止本环境的消费者；请在没有其他人操作这套测试数据时运行。消费者会在 `finally` 中恢复。

本轮 17 项断言通过，主要证据为：

- 游客可读取已发布题库，未发布题库返回 `404`；学生修改专业后立即获得匹配题库，检查结束恢复原资料。
- 创建练习返回 7 道小题及独立判题数据，题目展示 DTO 保持答案隔离。
- 消费者停止时进度返回 `202`，同幂等键得到相同命令，命令持久排队；交卷返回 `409 SYNC_PENDING`。
- SSE 实际排队数量增长，恢复消费者后命令变为 `COMMITTED` 并确认序号；重复交卷返回同一结果。
- 简答自评计入正式结果，管理员读取的学生成绩与用户结果一致。
- 管理端处理纠错后，用户能读取处理结果；心跳使账号出现在在线明细，三种排行榜排序均可读取。

监控界面观察到的约 16 秒同步延迟包含本轮主动暂停消费者的等待时间。该观察用于验证排队与恢复，不代表正常延迟或系统容量。

## 已关闭问题

| 问题 | 原因与修复 | 复测 |
| --- | --- | --- |
| 浏览器真实 Gateway 报 `Illegal invocation` | 原生 `fetch` 被保存为对象方法后改变了调用接收者；默认实现绑定 `globalThis` | 浏览器登录、页面读取、SSE 和新管理员登录通过；补充接收者回归检查 |
| 小程序会话失效后仍显示登录状态 | 请求层没有把当前令牌的 `401` 通知身份仓储 | 当前会话失效后清理展示身份并显示登录引导；迟到的旧令牌响应不会清除新登录；练习草稿继续保存 |
| 联调配置中管理端地址与管理员账号重名 | 连接地址和账号对象使用相同键 | 地址统一为 `adminUrl`，初始化自检同时验证地址、账号、权限和密码规则 |

## 自动验收证据

| 检查 | 结果 |
| --- | --- |
| 后端单元与模块检查 | 19 项通过 |
| 隔离 PostgreSQL、RabbitMQ 等集成检查 | 43 项通过，Maven `BUILD SUCCESS` |
| 合同结构 | 13 个文档、136 个操作、21 项反例检查通过 |
| 实际 HTTP Schema | 953 次观察、136 个操作通过 |
| 管理端 | 66 项测试及构建通过 |
| 小程序 | 39 个自检脚本、27 个 WXML 与 28 个 WXSS 编译、官方 npm 构建通过 |
| 联调配置脚本 | 私有凭据、重复初始化保护、本机地址限制及账号字段自检通过 |

后端自动验收材料位于忽略目录 `apps/api/.backend-runtime/verification/`，逐操作结果为 `operation-coverage.json`。136 项接口的自动 HTTP 合同覆盖与上表列出的真实客户端操作分别记录；其余页面交互继续按[接口台账](miniapp-api-integration.md)逐项验收。

本轮真实客户端覆盖浏览器与微信开发者工具。真机、完整内容编辑和导入界面、长时间断网及大规模容量仍待专项验证。共享 PostgreSQL、开发环境单节点 RabbitMQ 保留共同故障边界。
