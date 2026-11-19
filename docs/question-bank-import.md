# 富媒体题库 ZIP

在题库详情的题目管理中选择「导入 ZIP」。工作台按 4 MiB 分块上传，一次预览一个题库。唯一同名章节自动匹配，缺失章节随提交创建。题号相同且内容一致的记录会跳过。更新已有题目前展开差异并确认。提交绑定题包摘要、章节映射和库版本。

根目录使用 UTF-8 `bank.json`，附图放入 `assets/images/`，可附 `review-report.md`。支持 PNG、JPEG 和 WebP，单图最多 5 MiB。ZIP 和展开内容各最多 256 MiB，清单最多 32 MiB，条目最多 10000 个。每题及阅读小题都使用稳定 UUID。章节、图片和来源使用包内标识。题库可从详情页导出，题目缺席时保留目标库已有记录。

题目、选项、阅读材料和解析使用 `![图注](asset:图号)` 引用原图，例如 `![电路图](asset:fig-01)`。视频使用 HTTPS 链接。存量资料缺少来源时，迁移核验清单逐题记录。旧小程序沿用原目录、题目和练习接口，练习仍按创建时的修订读取。

规范和样例见[题包 Schema](question-bank-import/schema.json)和[六类题型示例](question-bank-import/examples/six-types.json)。在题库详情下载两份 Skill，解压后在制题 Skill 目录中运行 `node scripts/validate.cjs /path/to/bank.json`。

## 顶层字段

| 字段 | 规则 |
| --- | --- |
| `format` / `version` | 固定为 `qanda-question-bank` / `1.0` |
| `bank` | `name` 为文件题库名称，`description` 为说明；目标题库由管理员选择，文件不会自动改名或创建题库 |
| `sources` | 来源清单，可为空；`id`、`name`、`kind` 必填，`uri` 可填实际网页或材料相对路径 |
| `chapters` | 文件章节的 `id`、`name`；无章节时用空数组 |
| `assets` | 图片 `id`、`path`、`sourceRefs`；路径为 `assets/images/` 下的相对路径 |
| `questions` | 题目或阅读题组，可为空；标识在文件中唯一，包括所有阅读小题 |

来源类型：`text`、`pdf`、`word`、`slides`、`spreadsheet`、`image`、`web`、`audio`、`video`。来源位置写在引用的 `location` 中，例如「第 12 页，第 3 题」「Sheet1!A2:H2」「00:03:12–00:03:40」。位置必须来自实际读取的材料。

阅读小题与普通题共用 UUID 标识空间，跨库复制保留标识。

## 题目字段与限制

共同字段为 `id`、`type`、`stem`、`explanation`、`provenance`。根题目可带本地 `chapterId`；`assetIds` 引用文件图片。每项通过 `contentFormat` 指定正文格式，新内容使用 `MARKDOWN`，旧内容缺少字段时按 `PLAIN_TEXT` 读取。公式使用 Unicode 或独立图片。正文最多 10000 字，阅读材料最多 20000 字，每题图片最多 20 张。

| `type` | 专用字段与规则 |
| --- | --- |
| `SINGLE_CHOICE` | `options[{key,content}]`，2–26 项；`correctAnswer` 恰好一个有效选项标识 |
| `MULTIPLE_CHOICE` | 同上，正确答案至少两个，不能重复 |
| `TRUE_FALSE` | `correctValue` 必须为 JSON 布尔值 `true` 或 `false` |
| `FILL_BLANK` | `blanks[{answers:[...]}]`，1–20 空，每空 1–20 个可接受答案；题干中的 `{{1}}` 到 `{{n}}` 各出现一次；`blankMatch` 显式设置 `ignoreCase`、`trimWhitespace` |
| `SHORT_ANSWER` | `referenceAnswer` 必填；`scoringPoints` 选填，最多 30 条，每条最多 1000 字；主观题不计分，交卷后可按参考内容自评 |
| `READING` | `passage`、`subQuestions` 必填，1–50 小题；小题使用前五种题型，禁止嵌套，章节由材料继承 |

选项标识使用 1–8 位大写字母或数字，内容最多 4000 字。填空候选答案最多 500 字。简答参考答案最多 40000 字。题目、来源、选项、空位、图片引用必须完整且一致；额外的拼错字段会报错。

## 来源与 AI 参与

每个题目、阅读材料及小题有 `provenance`：

```json
{
  "origin": "extracted",
  "sourceRefs": [{ "sourceId": "notes", "location": "第 2 页，第 3 题" }],
  "ai": {
    "fields": ["options", "explanation"],
    "note": "保留原题干、原选项 A/B 及答案，补充 C/D 干扰项并编写教学解析。"
  }
}
```

`origin=extracted` 表示提取原题，`authored` 表示依据知识材料编题。`ai.fields` 逐项列出 AI 修改或生成的内容；允许 `stem`、`options`、`correctAnswer`、`correctValue`、`blanks`、`referenceAnswer`、`scoringPoints`、`explanation`、`passage`。有参与字段时必须填写说明。

完整原题保留题干、选项与明确答案；不完整选择题可补齐为四项。知识材料可直接编题。无法辨认、答案冲突、条件不足的内容列入复核报告，解决后进入可导入文件。

AI 编写的教学解析保存在 `explanation` 中。按顺序使用五个独立标题「结论」「核心知识点」「解题过程」「记忆方法」「易错题型」，在每个标题下写出对应内容。提取已有解析时保留原文与来源。

## 管理员 MCP

在安全规则中复制 MCP 地址，用管理员账号核对客户端回调地址和申请的权限。读取授权支持查询和导出，编辑授权可维护草稿，发布授权支持编辑线上题库和变更发布状态。安全规则中的「撤销」对后续请求和短时文件地址立即生效。

连接后加载 `qanda-question-bank-mcp`，提供目标课程、题库、章节及原始资料。该 Skill 调用 `qanda-question-bank` 完成提取、制题和校验。单题或阅读题组使用逐题工具，整份资料使用 ZIP 预览。可从题库详情下载同一版本的本地安装包。

部署时为 API 和 MCP 进程设置相同的 `QANDA_MCP_RESOURCE`，值为管理端 HTTPS 来源加 `/mcp`。管理端代理同时提供授权服务器发现和受保护资源发现。支持客户端动态注册，也可通过 API 的 `QANDA_MCP_CLIENTS` 配置客户端标识到回调地址数组的映射。后端发布从同一源码版本构建 API 与 MCP 镜像，记录两个镜像摘要。前后端分机部署时，MCP 默认经前端转发到后端业务网关。发布检查与回滚见[部署说明](deployment.md)。

## 存量核验

使用 `apps/api/scripts/verify-bank-migration.py` 对单个源库导出，在本机隔离 API 的指定课程下创建草稿并回导。脚本比较题目 UUID、阅读顺序、答案、解析、状态、章节和图片摘要，在报告中记录源库版本及缺失来源。来源端只执行读取。凭据分别从 `QANDA_SOURCE_TOKEN` 和 `QANDA_ISOLATED_TOKEN` 读取。

```sh
python3 apps/api/scripts/verify-bank-migration.py \
  --source "$SOURCE_API" --bank "$BANK_ID" \
  --isolated http://127.0.0.1:8083 --isolated-subject "$SUBJECT_ID" \
  --report "$REPORT_DIR/$BANK_ID.json"
```

按库保存报告，源库内容版本变化后重新核验。

## v1 旧脚本与工作台接口

旧版 JSON 脚本使用管理员会话，向以下两个地址提交同一份 `{expectedContentVersion, questions}`。预览返回 `valid`、`questionCount` 和逐题 `issues`，提交返回 `questionIds` 和新的 `contentVersion`。每次提交传入 `Idempotency-Key`，网络重试沿用原键和原请求体。

- `POST /api/v1/admin/question-banks/{id}/import-preview`
- `POST /api/v1/admin/question-banks/{id}/imports`

`GET /api/v1/admin/question-banks` 的可选参数 `quality` 支持 `missingExplanation`（启用题目缺解析）、`unassigned`（有题目未分章）、`empty`（没有可作答题目）。可与课程、发布状态和分页组合使用。

`POST /api/v1/admin/question-banks/{bankId}/chapters/{id}/dissolve` 使用管理员会话和幂等键。请求体包含章节的 `expectedVersion`、题库的 `expectedContentVersion` 以及可选的 `targetChapterId`。解散操作将题目移到同库的目标章节，目标留空时归入「未分章」。版本冲突返回 409，刷新后重新确认。
