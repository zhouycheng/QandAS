# 用户交流群与入群公告

管理端“用户交流群”维护一张当前群二维码及其有效期，支持 PNG、JPEG，原图不超过 5 MiB。保存使用版本校验与幂等键，图片经服务端校验并转为 PNG 后保存。

小程序首页“我的学习空间”下方及“关于 QandA”提供“加入用户交流群”卡片，点击后预览最新群码。公告编辑支持“置顶公告”和“展示交流群二维码”：置顶内容在分页前排序，群码读取同一份管理配置，替换后各入口同步使用新图片。

群码到期后停止提供图片，小程序提示等待更新；图片加载失败可点击重试。有效期由管理端按实际群码配置。

| 接口 | 权限与用途 |
| --- | --- |
| `GET /api/v1/community/group` | 公开读取当前版本、到期时间与可用状态 |
| `GET /api/v1/community/group/image` | 公开读取有效 PNG；未配置或过期返回 `404` |
| `GET /api/v1/admin/community/group` | 管理员读取当前配置 |
| `PUT /api/v1/admin/community/group` | 管理员提交 `expectedVersion`、图片 data URI、`expiresAt`；携带 `Idempotency-Key` |

`AnnouncementInput` 的 `pinned`、`showCommunityGroup` 默认均为 `false`，已有调用方可继续省略。公告的发布状态、展示端及接收范围仍参与可见性校验。数据库按当前完整 `schema.sql` 初始化。
