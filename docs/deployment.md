# 生产部署与恢复

QandA 使用私有仓库、GHCR 和 Docker Compose。`develop` 用于开发，`main` 用于发布。推送和合并只运行 CI；在 Actions 的 **Production deploy → Run workflow** 手动选择 `deploy` 或 `rollback`。

## 运行结构

主机 Nginx 为 `qanda.zhoust.cn` 提供 HTTPS，转发到 `127.0.0.1:18083`。管理端位于根路径，API 前缀为 `/api/v1`。API、worker、monitor 分开运行，管理端镜像同时承担应用网关。PostgreSQL、RabbitMQ 和 Prometheus 独立运行，普通发布只更新应用服务。

运行目录为 `/srv/qanda`，生产配置为该目录内权限 `600` 的 `production.env`，字段见 `deploy/production.env.example`。数据库、队列、附件、指标分别保存在固定的 `qanda-production-*` Docker 卷中。部署不清理镜像或持久卷。

当前资源限制面向小规模起步：API 堆 256 MiB、worker 堆 192 MiB、monitor 堆 128 MiB；容器分别限制为 448、384、384 MiB，保留 JVM 本地内存空间。全套容器上限合计约 2.1 GiB；实际容量须依据内存、GC、延迟和同步积压测量。首次部署要求至少 1.5 GiB 可用内存、3 GiB 可用磁盘。

## 首次安装

1. 核对主服务器的 Tailscale 身份、已有服务、端口和 Docker 网络；`172.29.71.0/24` 需未被占用。
2. 使用仓库外的独立生产配置，填入官方微信和腾讯云 SES 提供端，生成生产专用数据库、队列、身份、邮件和命令摘要密钥。生产配置不得复用测试密钥。
3. 将配置安装为 `/srv/qanda/production.env`，所有者 `root:root`、权限 `600`。将仓库部署文件复制到服务器后，以管理员运行 `sudo bash deploy/install.sh`，建立基础服务、部署账号和每日备份计时器。
4. DNS 指向已核验的主机入口。先提供 HTTP ACME 验证位置，申请证书，再安装 `deploy/nginx-site.conf`。执行 `nginx -t`、平滑 reload 和证书续期检查。
5. 配置下节的 GitHub/Tailscale 身份，手动运行第一次部署。全新数据库由 `migrate` 初始化。
6. 在管理员交互终端中，使用当前 `BACKEND_IMAGE`、`WEB_IMAGE`、`REVISION` 调用应用 Compose 的 `run --rm -it api bootstrap` 创建首管。凭据只保存在密码管理器或仓库外私有文件中。
7. 小程序 API 地址设为 `https://qanda.zhoust.cn/api/v1`，并在微信后台配置合法域名。微信上传、审核和发布独立执行。

主机无法访问 Docker Hub 时，可临时设置仓库变量 `QANDA_PREPARE_INFRA=true`，手动部署的验证产物会额外包含官方 Linux/amd64 基础镜像归档。管理员下载该次 artifact，核对 SHA-256 后，通过 Tailscale SSH 将归档传给主机的 `sudo docker load`，再继续安装。完成后删除此变量，避免后续发布重复生成大归档。此步骤使用管理员已有的 SSH 权限，不增加 CI 账号的 Docker 权限。

生产主机不放置 Actions runner。服务器上的 Compose、脚本和配置均由 root 管理，`qanda-deploy` 账号只允许调用受限部署入口，不能直接操作 Docker。

## GitHub 与 Tailscale

仓库 Secrets：`DEPLOY_TARGETS`、`TS_OAUTH_CLIENT_ID`、`TS_AUDIENCE`。应用提供端密钥留在服务器。

在 Tailscale 建立 GitHub OIDC trust credential，scope 仅 `auth_keys`，标签为 `tag:qanda-ci`。使用 GitHub 的不可变仓库身份 subject，限定当前仓库和 `refs/heads/main`；同时限定 `workflow_ref` 为 `zhouycheng/QandA/.github/workflows/deploy.yml@refs/heads/main`。私有 Free 仓库使用仓库级 Secrets，不依赖 Environment。

合并以下权限到现有 Tailnet policy，保留已有成员和业务规则。目标服务器沿用已配置的生产标签：

```json
{
  "tagOwners": { "tag:qanda-ci": ["autogroup:admin"] },
  "grants": [
    { "src": ["tag:qanda-ci"], "dst": ["tag:prod"], "ip": ["tcp:22"] }
  ],
  "ssh": [
    { "action": "accept", "src": ["tag:qanda-ci"], "dst": ["tag:prod"], "users": ["qanda-deploy"] }
  ]
}
```

两个 GHCR 软件包 `qanda-backend`、`qanda-web` 及其构建缓存都应保持私有，授予本仓库 Actions 读写权限。Actions 使用短期 `GITHUB_TOKEN`。拉取凭据经 SSH 标准输入传入，仅在服务器 `/run` 临时保存，操作结束清除。

## 发布与回滚

手动部署固定使用触发时的 `main` SHA。验证阶段运行共享包、管理端、小程序和后端检查；JAR、管理端构建一次，通过带 SHA-256 清单的 artifact 交给镜像阶段。服务器只接受两个固定 GHCR 仓库的镜像摘要。

流程为：资源预检 → 拉取镜像 → 在线备份 → 停止应用组 → 使用临时数据库和队列验证镜像及重复迁移 → 正式迁移 → 启动应用组 → 检查容器 readiness、公网 API 和管理端。普通更新可能短暂停机；学习记录、会话、写入凭证、附件与队列均保留，客户端沿用原幂等键重试。

失败时恢复上一成功应用版本。数据库不自动降级，不用旧备份覆盖当前数据。Flyway 基线复用现有完整 schema，后续迁移必须兼容上一应用版本；新增迁移不能修改已发布的基线内容。客户端合同、队列正文及仍在使用的密钥版本必须兼容。

`/api/v1/health` 保持原响应。容器使用内部 `/actuator/health/readiness` 检查数据库、队列、附件目录及 worker 消费状态。Actuator 不经公网网关转发。入口覆盖外来转发头，后端只信任固定的应用网关地址。

操作由 systemd 服务执行，SSH 或 Actions 断开不会终止已开始的更新。状态为 `/var/lib/qanda-deploy/operation.json`，当前、上一版本和期望版本保存在同目录。管理员查询：

```sh
sudo /usr/local/sbin/qanda-deployctl status
sudo journalctl -u qanda-release --no-pager -n 100
```

若服务器在操作中重启，先对照 `current.json`、`desired.json` 和容器状态恢复上一成功应用组；确认后由管理员将操作状态标记为失败。不要直接覆盖未核对的状态或排队请求。

## 备份与隔离恢复

每天 UTC 03:30 及发布前备份 PostgreSQL、附件、运行配置和部署状态，输出到 `/var/backups/qanda`，使用 `/etc/qanda/backup.key` 加密并记录 SHA-256。密钥应单独保管到仓库外；备份不包含解密密钥，不自动删除历史备份。

```sh
sudo /usr/local/sbin/qanda-backup
sudo /usr/local/lib/qanda/restore-check.py /var/backups/qanda/<备份文件>.tar.enc
```

恢复检查解密到进程内存，在随机命名的临时 PostgreSQL 容器中恢复，逐项核验题库图片摘要，最后删除该次临时容器及其匿名卷。它不会连接或写入生产数据库。

RabbitMQ 持久卷保存未消费的答题正文，数据库备份不能代替队列备份。普通发布始终保留队列卷；整机恢复还需数据库、附件和队列的一致性恢复方案。主机内备份不能覆盖整台服务器丢失，后续应接入独立备份存储。

## 管理员备份与恢复

服务器管理员通过 `qanda-db` 导出备份或向空库恢复备份。数据库端口保持在私有 Docker 网络内，业务数据通过管理端 Excel 导入。

```sh
sudo qanda-db export /受保护目录/qanda.dump
sudo qanda-db restore /受保护目录/数据.dump
```

导出通过在线一致性快照生成 `pg_dump` 自定义格式文件及 SHA-256，文件权限为 `600`，目标文件必须不存在。它只包含专用数据库，附件和运行密钥使用完整加密备份一并迁移。导出包含账号与密码摘要等私有数据，迁移后按保管规则处理文件。

恢复与部署共用互斥锁，先备份，再暂停应用写入，以单事务和遇错退出方式执行。完整 dump 仅恢复到经过检查的空库；失败时保留暂停状态，供管理员核对。备份中的附件和运行密钥需要配套恢复，恢复前在隔离环境演练。

日常用户及题库数据使用[管理端 Excel 导入导出](excel-import-export.md)，由业务层校验权限、唯一性、关联关系及内容版本。

## 多服务器扩容

目标地址统一维护在仓库外权限 `600` 的 `~/.config/qanda/production/targets.json`，结构见 `deploy/targets.example.json`。`frontend.server` 和 `backend.server` 填 Tailscale 设备名；相同时按合并节点部署，不同时分别部署管理端和后端。修改这一份文件后执行：

```sh
python3 deploy/targets.py "$HOME/.config/qanda/production/targets.json"
```

该命令使用现有管理员 Tailscale SSH，将节点职责和私网路由写入目标服务器 root 管理的 `node.json`、`node.env`，并同步仓库 Secret `DEPLOY_TARGETS`。Actions 按后端、管理端顺序发布，同一服务器只执行一次。各节点分别保存上一版本；管理端失败时先前已完成的后端节点会回滚。

新服务器需先安装 Docker、Tailscale、受限部署入口和相应生产配置；迁移时暂停原 API、worker 的写入，完成最后一批数据、附件和队列迁移并核验，再切换目标。沿用原有效生产密钥，避免账号摘要、会话和待处理命令失效。地址配置不代替数据迁移。原后端角色需在迁移时明确停用，避免继续写入旧库。管理端节点仅运行 `web`，不安装数据库或队列，生产提供端密钥仅保存在后端节点。

分机模式的后端 API、monitor 分别仅绑定本机 Tailscale 地址的 `18084`、`18085`，需在 Tailnet policy 中仅允许管理端节点访问这两个端口；数据库仍不发布端口。`qanda-ci` 的权限继续只有部署 SSH，不增加 API 或数据库访问权限。

管理端与后端分机时，在服务器私有配置中设置 `PRODUCTION_API_UPSTREAM`、`PRODUCTION_MONITOR_UPSTREAM` 指向后端的 Tailnet 私网入口；前端域名和客户端 API 地址保持稳定。跨服务器入口只绑定 Tailscale 地址，并用 Tailnet policy 限定前端节点访问后端 API。数据库版本迁移随应用发布执行，备份与恢复使用 Tailscale SSH 和 `qanda-db`，不开放公网数据库或额外管理 HTTP API。文件可通过 Tailscale SSH 的标准输入输出传输，接收端先设置 `umask 077` 并校验摘要。

API、worker、monitor 和基础设施已分开；数据库地址和 RabbitMQ 主机可由部署配置指定，接口域名和 `/api/v1` 路由稳定。后续节点运行同一镜像摘要，经 Tailnet 访问共享数据库和队列，Nginx 上游增加 API 节点；worker 可独立增加消费者，monitor 先保留一个实例。

正式多 API 节点分流前，将进程内请求限流迁移到共享实现，将本地附件卷替换为共享存储，并在各节点同步有效密钥版本。核验网络延迟、数据库连接池总量和重复消息幂等。入口、数据库及队列仍集中在主机时，应用扩容不提供整机容灾。

## 学习资料流程升级

先执行 V2 增量迁移并发布后端，再发布新版小程序。V2 增加账号级首次引导标记，并将题库范围改为按学院、专业、年级逐级匹配；数据库基线及学习记录保留。资料完整的账号初始化为完成引导，资料未齐全的存量账号首次进入新版时展示一次填写页。

新客户端依赖 `/me.profileSetupSeen` 和 `POST /me/profile-setup/acknowledgement`。首次展示后登记账号状态，同步失败由本机按账号保存待重试记录。后续冷启动或重新登录只弹窗提醒。

旧小程序仍执行旧的页面跳转逻辑，返回循环的修复随小程序新版本生效。应用回滚不会自动回退数据库可见范围函数；需要恢复筛选规则时使用新的增量迁移。
