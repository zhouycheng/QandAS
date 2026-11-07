# 生产部署与恢复

题小搭尚未进入正式生产，当前数据均为测试数据。双服务器部署在新后端使用空库初始化，不迁移原测试数据。项目使用私有仓库、GHCR 和 Docker Compose；`main` 是唯一长期保留分支，任务通过 PR 合入 `main`。推送到 `main` 和 PR 会运行 CI；管理端与后端分别在 Actions 的 **Deploy admin**、**Deploy backend → Run workflow** 手动选择 `check`、`deploy` 或 `rollback`。`check` 验证 Tailscale、受限 SSH 和节点角色并查询发布状态；`deploy` 自动完成验证、构建、发布和健康检查。部署工作流仅接受 `main`。

后端工作流部署到后端所有者的服务器，管理端工作流部署到管理端所有者的服务器，各自连接所属 Tailnet。两个入口独立触发、独立构建镜像、独立记录版本和回滚，可以并行运行。

## 运行结构

主机 Nginx 为 `qanda.zhoust.cn` 提供 HTTPS，转发到 `127.0.0.1:18083`。管理端位于根路径，API 前缀为 `/api/v1`。API、worker、monitor 分开运行，管理端镜像同时承担应用网关。PostgreSQL、RabbitMQ 和 Prometheus 独立运行，普通发布只更新应用服务。

运行目录为 `/srv/qanda`，生产配置为该目录内权限 `600` 的 `production.env`，字段见 `deploy/production.env.example`。数据库、队列、附件、指标分别保存在固定的 `qanda-production-*` Docker 卷中。部署不清理镜像或持久卷。

当前资源限制面向小规模起步：API 堆 256 MiB、worker 堆 192 MiB、monitor 堆 128 MiB；容器分别限制为 448、384、384 MiB，保留 JVM 本地内存空间。全套容器上限合计约 2.1 GiB；实际容量须依据内存、GC、延迟和同步积压测量。首次部署要求至少 1.5 GiB 可用内存、3 GiB 可用磁盘。

## 首次安装

1. 核对主服务器的 Tailscale 身份、已有服务、端口和 Docker 网络；`172.29.71.0/24` 需未被占用。
2. 将仓库部署文件复制到服务器后，以管理员在交互式终端运行 `sudo bash deploy/install.sh`。后端首次完整安装会提示录入官方微信和腾讯云 SES 参数，并为数据库、队列、身份、邮件及命令摘要生成独立随机密钥，自动创建 `/srv/qanda/production.env`（`root:root`、权限 `600`）。启用腾讯云 SES 实际发信前须在提示中明确确认。已有配置会保留；发现已有数据库或队列数据卷但配置文件缺失时，安装会停止并要求先恢复原配置。
3. 安装器继续建立基础服务、部署账号和每日备份计时器。`--control-only` 仅安装运维入口和网络，不创建应用环境配置。
4. DNS 指向已核验的主机入口。先提供 HTTP ACME 验证位置，申请证书，再安装 `deploy/nginx-site.conf`。执行 `nginx -t`、平滑 reload 和证书续期检查。
5. 配置下节的 GitHub/Tailscale 身份，手动运行第一次部署。全新数据库由 `schema-init` 初始化为统一 V1。
6. 在管理员交互终端中，使用当前 `BACKEND_IMAGE`、`WEB_IMAGE`、`REVISION` 调用应用 Compose 的 `run --rm -it api bootstrap` 创建首管。凭据只保存在密码管理器或仓库外私有文件中。
7. 小程序 API 地址设为 `https://qanda.zhoust.cn/api/v1`，并在微信后台配置合法域名。微信上传、审核和发布独立执行。

主机无法访问 Docker Hub 时，可临时设置仓库变量 `QANDA_PREPARE_INFRA=true`，手动部署的验证产物会额外包含官方 Linux/amd64 基础镜像归档。管理员下载该次 artifact，核对 SHA-256 后，通过 Tailscale SSH 将归档传给主机的 `sudo docker load`，再继续安装。完成后删除此变量，避免后续发布重复生成大归档。此步骤使用管理员已有的 SSH 权限，不增加 CI 账号的 Docker 权限。

Actions runner 使用 GitHub 托管环境。服务器上的 Compose、脚本和配置均由 root 管理。`qanda-deploy` 负责发布、回滚和发布状态；`qanda-debug` 负责题小搭应用容器的状态、日志、Shell 和重启，权限通过受限入口校验。

分包配置可以先单独验证运维连接：安装对应的 `node.json` 和 `node.env` 后运行 `sudo bash deploy/install.sh --control-only`。此模式安装运维入口并准备网络，保留正在运行的应用、基础服务和备份计时器；登记 SSH 公钥、完成容器节点登录并启动运维服务后，运行 Actions 的 `check`。业务切换时再执行完整安装和 `deploy`。

## GitHub 与 Tailscale

仓库 Secret `DEPLOY_TARGETS` 保存两个节点的私有配置；应用提供端密钥留在服务器。每个工作流只引用对应所有者的凭据：

| 工作流 | Tailscale 身份 | 受限 SSH 凭据 |
| --- | --- | --- |
| `deploy-backend.yml` | `BACKEND_TS_OAUTH_CLIENT_ID`、`BACKEND_TS_AUDIENCE` | `BACKEND_DEPLOY_SSH_KEY`、`BACKEND_DEPLOY_SSH_KNOWN_HOSTS` |
| `deploy-frontend.yml` | `FRONTEND_TS_OAUTH_CLIENT_ID`、`FRONTEND_TS_AUDIENCE` | `FRONTEND_DEPLOY_SSH_KEY`、`FRONTEND_DEPLOY_SSH_KNOWN_HOSTS` |

两位所有者分别在自己的 Tailnet 建立 GitHub OIDC trust credential，scope 仅 `auth_keys`，标签为 `tag:qanda-ci`。使用 GitHub 返回的当前仓库身份前缀构造 Subject，限定 `refs/heads/main`；自定义 claim `workflow_ref` 分别限定为 `<当前仓库全名>/.github/workflows/deploy-backend.yml@refs/heads/main` 和 `<当前仓库全名>/.github/workflows/deploy-frontend.yml@refs/heads/main`。当前仓库名为 `QandAS`，仓库级 Secrets 分别保存两位所有者的凭据。

在 [Tailscale Trust credentials](https://console.tailscale.com/admin/settings/trust-credentials) 中选择 **Credential → OpenID Connect**，Issuer 选择 GitHub，填入 Subject 和本节点的 `workflow_ref`，权限只选 **Auth Keys → Write**，授权标签选择 `tag:qanda-ci`。生成后把 Client ID 和 Audience 分别存入上表对应的 GitHub Secrets。该方式使用 GitHub 的短期身份令牌；Client ID 和 Audience 是身份标识。[官方配置说明](https://tailscale.com/docs/features/workload-identity-federation)

Subject 使用 `gh api repos/<当前仓库全名>/actions/oidc/customization/sub` 返回的 `sub_claim_prefix`，再追加 `:ref:refs/heads/main`。实际账号、仓库 ID 和完整授权值保存在仓库外的私有配置中。仓库更名后重新核验 Subject 与 `workflow_ref`，因为浏览器地址重定向不会更新 OIDC 字段。

每位所有者在自己的策略中允许 CI 访问本地题小搭节点的 `2222`。下面以后端节点为例；管理端使用指向容器私网地址的 `qanda-frontend` 主机别名，模板见 `deploy/tailnet-frontend-policy.example.json`。保留现有个人管理规则，移除与本次授权冲突的全网放行规则以及旧 CI 对宿主机 SSH 的授权。

```json
{
  "tagOwners": { "tag:qanda-ci": ["autogroup:admin"] },
  "grants": [
    { "src": ["tag:qanda-ci"], "dst": ["tag:qanda-backend"], "ip": ["tcp:2222"] }
  ]
}
```

`2222` 使用经过 Tailscale 的普通 OpenSSH，服务器强制执行 `remote-entry.py`，并关闭 SSH 转发、SFTP 和主机交互 Shell；Docker 操作由服务器端白名单检查。这里使用 OpenSSH 的强制命令能力实现权限边界。两个 GHCR 软件包 `qanda-backend`、`qanda-web` 及其构建缓存保持私有，授予本仓库 Actions 读写权限。Actions 使用短期 `GITHUB_TOKEN` 发布镜像；部署时把对应的单镜像归档作为短期 workflow artifact，经现有受限 SSH 入口流式传输。runner 和服务器分别校验归档 SHA-256，服务器还核对 Docker manifest、固定仓库标签和源码提交标签，再加载镜像。拉取凭据经标准输入传入，仅在服务器 `/run` 临时保存。

SSH 私钥在 runner 的私有临时目录中使用，结束时删除。`*_DEPLOY_SSH_KNOWN_HOSTS` 分别使用 `qanda-backend`、`qanda-frontend` 主机别名和所有者核验过的服务器公钥；连接强制检查服务器身份。首次安装后，从受信任的管理通道读取 `/etc/qanda/ssh_host_ed25519_key.pub` 并保存到对应 Secret。

## 发布与回滚

手动部署固定使用触发时的 `main` SHA。后端工作流运行后端验证并生成 JAR；管理端工作流运行共享内容包和管理端验证并生成静态资源。每个工作流只构建自己的产物，通过带 SHA-256 清单的缓存交给镜像阶段，发布各自固定 GHCR 仓库的镜像摘要。Docker 镜像归档用摘要派生的本地标签，服务器的 Compose 仍按发布摘要记录版本。网络网关使用独立固定摘要的 Nginx 镜像。

发布产物使用提交、运行编号及尝试次数组成的精确缓存键中转，发布阶段使用验证任务实际输出的缓存键，要求精确命中并核对 SHA-256；仅重跑发布任务时继续使用此前验证成功的产物。缓存缺失或校验失败会停止部署。常规发布保留验证阶段生成的同一份 JAR 与管理端文件；离线基础设施包按 `QANDA_PREPARE_INFRA` 配置单独保留下载入口。

后端流程为：资源预检 → 校验并加载后端镜像归档 → 在线备份 → 停止后端应用组 → 使用临时数据库和队列验证镜像及重复初始化 → 初始化或校验 V1 → 启动 API、worker、monitor → 检查 readiness。管理端流程为：资源预检 → 校验并加载管理端镜像归档 → 保存静态资源 → 更新 web → 检查公网管理端和 API。普通更新可能短暂停机；持久数据保留，客户端沿用原幂等键重试。

失败时恢复上一成功应用版本。数据库不自动降级，不用旧备份覆盖当前数据。应用版本固定为 `1.0.0`，数据库由单个 V1 初始化定义。已有 V1 结构按校验值核验；开发阶段修改初始结构时，通过明确授权的测试库重建上线。客户端合同、队列正文及仍在使用的密钥版本必须兼容。

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

RabbitMQ 持久卷保存未消费的答题正文，数据库备份不能代替队列备份。普通发布始终保留队列卷。当前备份保存在服务器本机，不能覆盖整机故障；正式生产前需配置独立备份存储，并验证数据库、附件和队列的一致性恢复。

## 管理员备份与恢复

服务器管理员通过 `qanda-db` 导出备份或向空库恢复备份。数据库端口保持在私有 Docker 网络内，业务数据通过管理端 Excel 导入。

```sh
sudo qanda-db export /受保护目录/qanda.dump
sudo qanda-db restore /受保护目录/数据.dump
```

导出通过在线一致性快照生成 `pg_dump` 自定义格式文件及 SHA-256，文件权限为 `600`，目标文件必须不存在。它只包含专用数据库，附件和运行密钥使用完整加密备份一并迁移。导出包含账号与密码摘要等私有数据，迁移后按保管规则处理文件。

恢复与部署共用互斥锁，先备份，再暂停应用写入，以单事务和遇错退出方式执行。完整 dump 仅恢复到经过检查的空库；失败时保留暂停状态，供管理员核对。备份中的附件和运行密钥需要配套恢复，恢复前在隔离环境演练。

日常用户及题库数据使用[管理端 Excel 导入导出](excel-import-export.md)，由业务层校验权限、唯一性、关联关系及内容版本。

## 双服务器与容器运维

管理端和公网 HTTPS 网关留在现有服务器；API、worker、monitor、PostgreSQL、RabbitMQ、附件和指标放在后端所有者的服务器。新后端使用空库初始化，原服务器上的测试数据不迁移。切换验收后停用原后端应用和题小搭基础服务；原有测试卷保留，是否清理另行核对。

两位所有者分别在自己的 Tailnet 登记题小搭容器节点。每台运行独立的 `qanda-tailnet` Compose 项目，Tailscale 拥有容器身份；HTTP 网关与其共享网络命名空间，连接题小搭 Docker 网络。后端节点使用 `tag:qanda-backend`；管理端节点以管理端所有者的用户身份登录，保留无标签状态以接收节点共享。两端部署工作流分别进入各自 Tailnet，读取相应凭据并操作本地题小搭节点。

### 部署、调试与业务访问

| 连接 | 用途 | 权限范围 |
| --- | --- | --- |
| 后端 Actions → 后端题小搭节点 `2222` | 发布、回滚、发布状态 | 后端镜像与 API、worker、monitor |
| 管理端 Actions → 管理端题小搭节点 `2222` | 发布、回滚、发布状态 | 管理端镜像与 web |
| 获授权的操作者 → 题小搭节点 `2222` | 容器状态、日志、Shell、重启 | 当前节点所属应用容器 |
| 管理端 → 共享的后端节点 `18084/18085` | 正常业务请求 | 只允许指定管理端容器作为请求来源 |

跨 Tailnet 业务连接使用单节点共享：后端所有者将题小搭后端容器节点共享给管理端所有者，由后者接受共享。管理端的用户所属网络容器即可访问该共享节点，后端网关再按管理端容器来源地址限制 `18084/18085`。公网域名、小程序 API 地址和微信回调入口保持稳定。

[Tailscale 节点共享](https://tailscale.com/docs/features/sharing)只对接收共享的用户生效，接收端的标签设备不能访问共享节点。因此管理端网络容器保持用户身份，CI 继续分别在两位所有者的 Tailnet 中使用 `tag:qanda-ci`。管理端所有者为这个长期运行的容器节点单独关闭密钥过期，并保存其状态卷。

你本人使用同一份节点共享调试后端：两端策略允许你的用户访问 `2222`，服务器登记个人调试公钥。共享节点和受限 SSH 权限共同限定操作范围。共享授权只涉及题小搭容器节点。

共享后核对两端实际看到的地址。私有目标文件的 `service_ip` 保存节点在本方 Tailnet 中的地址，供本方 CI 使用；若发生地址重映射，`peer_ip` 保存该节点在对方看到的地址，渲染器用它生成业务上游或来源限制。策略模板中的地址同步替换为本方实际看到的地址。

### 服务器端权限

`qanda-ops.service` 运行独立 OpenSSH 实例，只监听题小搭 Docker 网桥地址的 `2203`。Tailscale 容器把私网 `2222` 转发到这里。CI 和调试账号分别使用部署公钥、个人调试公钥；`ForceCommand` 固定执行 `remote-entry.py`，`DisableForwarding` 禁用 SSH 转发。

`qanda-deploy` 可提交发布、回滚和查询状态。`qanda-debug` 可对后端的 `api/worker/monitor` 或管理端的 `web` 执行 `containers`、`logs`、`shell`、`restart`。脚本检查 Compose 项目、服务、挂载、网络和容器权限，再调用 Docker；Shell 在目标容器内执行。调试权限能够读取该应用容器中的运行文件及项目密钥，应只授予需要排障的操作者。

操作者在仓库外的 SSH 配置中登记节点别名、端口 `2222`、账号 `qanda-debug`、个人私钥和已核验的服务器公钥后，可运行：

```sh
ssh qanda-backend-ops containers
ssh qanda-backend-ops logs api --follow
ssh -t qanda-backend-ops shell api
ssh qanda-backend-ops restart api
```

`network-guard.py` 只管理带 `QANDA-` 前缀的规则和题小搭网桥：保留连接回复，仅允许网关容器访问宿主机的受限 `2203`，阻止其他新增宿主机连接、其他私网、云元数据和其他项目的映射端口。后端自己的应用和数据网络保留正常通信。当前要求 Docker 使用 iptables 后端，并具备 `iptables` 和 `ip6tables`。

`qanda-tailnet.service` 在隔离规则和受限 SSH 就绪后启动容器；网络容器由 systemd 管理重启。日常应用发布保留控制连接，回读防火墙规则、节点身份、转发配置和健康状态。容器使用宿主机内核，宿主机管理员仍负责系统更新和容器边界维护。

### 首次接入与切换

1. 各所有者记录已有服务、网络、资源和原部署文件，在私有文件中保存节点参数。后端首次完整安装时由安装器交互生成权限 `600` 的 `production.env`；管理端只保留自身所需参数。
2. 各自建立 CI 身份和受限访问规则。分别参考 `deploy/tailnet-backend-policy.example.json` 与 `deploy/tailnet-frontend-policy.example.json`，替换模板地址并填入实际操作者。合并到各自现有策略并核对原有管理权限，限制可能覆盖隔离规则的全网授权。
3. 所有者通过现有管理通道安装部署工具和项目网络，登记 Tailscale 容器身份；首次认证只针对容器节点。后端所有者把后端容器节点共享给管理端所有者，后者接受后核对地址。节点地址记入私有目标文件的 `service_ip`，必要时填写 `peer_ip`，宿主机管理地址保留在 `server`。通过下面的渲染命令生成 `node.json`、`node.env`，以 root 所有、权限 `600` 安装到对应服务器。
4. 将两种 SSH 公钥分别安装为 `/etc/ssh/qanda-authorized-keys/qanda-deploy` 和 `qanda-debug`，目录权限 `755`、文件权限 `644`，均由 root 管理。部署私钥进入对应 GitHub Secret，调试私钥留在操作者本地。完成服务器公钥核验后启用受限入口。
5. 启动受限入口并验证节点共享和端口授权，通过后端 Actions 初始化空库和发布后端。管理端网关实测后端健康接口后，再通过管理端 Actions 更新管理端；分别验证业务、附件、监控流和微信回调。
6. 确认新路径正常后，停用旧 API、worker、monitor 和题小搭基础服务，核对其他项目。管理端角色安装会停用旧题小搭备份计时器。首次拓扑切换保留原节点配置和镜像作为恢复入口；之后两个工作流各自回滚自己的应用版本。

```sh
python3 deploy/targets.py "$HOME/.config/qanda/production/targets.json" \
  --render "$HOME/.config/qanda/production/rendered"
```

渲染只写本地私有文件。分别通过各所有者的管理通道安装，再更新仓库 Secret `DEPLOY_TARGETS`。真实地址、账号和凭据保存在仓库外；两个工作流各自的部署身份在自己的 Tailnet 生效。

### 验收

本地先运行 `python3 -m unittest discover -s deploy/tests -v`。在隔离 Linux Docker 主机运行 `sudo python3 deploy/tests/tailnet_integration.py` 与 `sudo python3 deploy/tests/operations_integration.py`，验证代理、防火墙和实际 OpenSSH 调试入口；网络测试遇到已有项目防火墙链会停止。

线上分别验证两个 Actions 的部署与回滚、个人容器日志和 Shell、禁止访问的主机与其他项目、原有管理连接，以及管理端到后端的实际业务链路。跨账号连接、直连／中继状态与延迟需要真实节点验收。

## 配套版本与内容检测

应用和 API 保持 `1.0.0`，使用统一 V1 初始化及结构校验。已有数据库结构不一致时停止启动，按核实后的专用开发／测试重建流程处理；API、worker、monitor、小程序和管理端使用配套源码验收。部署前核实备份、恢复和队列处理条件。

官方内容检测使用仓库外私有配置，参数和回调要求见[内容安全接入](content-safety.md)。公网网关对专用取件和平台回调关闭访问日志，应用不记录媒体取件令牌。平台登记、实际权限、真机分享、备案、合法域名和隐私指引分别核验后记录证据。
