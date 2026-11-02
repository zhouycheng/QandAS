# QandA 题库导入协议 v1.0

题库文件由管理员在「题库工作台 → 目标题库 → 批量导入」中选择、预览和导入。管理端负责映射本地章节及图片标识，后端负责正式内容校验、版本校验及事务写入；发布后，小程序按目录与练习规则读取内容。

## 文件与入口

| 产物 | 用途 |
| --- | --- |
| [JSON Schema](question-bank-import/schema.json) | 文件结构、字段类型、长度与题型条件 |
| [空白模板](question-bank-import/template.json) | 开始编写文件；补齐来源和题目后才可导入 |
| [代码题示例](question-bank-import/examples/code-content.json) | 两道输出填空、一道程序理解 |
| [六类内容示例](question-bank-import/examples/six-types.json) | 六条记录、七道实际作答题 |
| [示例原材料](question-bank-import/examples/materials.md) | 核对题目来源、缺失选项补全和讲义编题 |
| [AI 提取 SKILL](../.agents/skills/qanda-question-bank/SKILL.md) | 材料提取、编题、解析与复核流程 |

使用 UTF-8 JSON。图片放在文件相邻的 `assets/` 目录中，PNG、JPEG、WebP，每张最多 5 MiB。可以把文件、图片与复核报告打包交付；管理端当前选择 JSON 和对应图片，分别上传。

仓库根目录执行校验，复用管理端解析器：

```sh
npm --prefix apps/admin run validate:bank -- docs/question-bank-import/examples/six-types.json
npm --prefix apps/admin run validate:bank -- /path/to/package/bank.json
```

校验器检查格式、引用、答案、题数和图片存在性、格式、大小。错误包含文件与 JSON 路径，例如 `$.questions[5].subQuestions[0].correctValue`。后端还会检查映射后的资源归属及实时内容版本。

## 顶层字段

| 字段 | 规则 |
| --- | --- |
| `format` / `version` | 固定为 `qanda-question-bank` / `1.0` |
| `bank` | `name` 为文件题库名称，`description` 为说明；目标题库由管理员选择，文件不会自动改名或创建题库 |
| `sources` | 来源清单，至少一项；`id`、`name`、`kind` 必填，`uri` 可填实际网页或材料相对路径 |
| `chapters` | 文件章节的 `id`、`name`；无章节时用空数组 |
| `assets` | 图片 `id`、`path`、`sourceRefs`；路径为 `assets/` 下的相对路径 |
| `questions` | 题目或阅读题组，至少一条；标识在文件中唯一，包括所有阅读小题 |

来源类型：`text`、`pdf`、`word`、`slides`、`spreadsheet`、`image`、`web`、`audio`、`video`。来源位置写在引用的 `location` 中，例如「第 12 页，第 3 题」「Sheet1!A2:H2」「00:03:12–00:03:40」。位置必须来自实际读取的材料。

本地标识为 1–80 位字母、数字、点、下划线或短横线，首字符为字母或数字。章节、来源、图片各自去重；题目和小题共享一个标识空间。各文件独立映射。文件不携带数据库 ID；阅读小题在一次导入预览中生成稳定 UUID，网络重试保持原 UUID 和幂等键。

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

选项标识使用 1–8 位大写字母或数字，内容最多 4000 字。填空候选答案最多 500 字。简答参考答案最多 10000 字。题目、来源、选项、空位、图片引用必须完整且一致；额外的拼错字段会报错。

每批最多 **20 个 JSON 文件、3000 道实际作答题、8 MiB JSON 文件合计**，映射后的实际请求体也不得超过 8 MiB。阅读材料不计题数，小题分别计数。图片使用独立上传接口，不占 JSON 请求体。

JSON Schema 校验结构；共用解析器进一步校验答案对应关系、空位标记、跨对象引用、唯一标识、实际题数和 AI 解析标题。两者一起构成协议。

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

AI 为每道作答题编写五部分教学解析，放在现有 `explanation` 中，每个标题独占一行，Markdown 使用 `### 标题`，依次为：

1. 结论：答案或参考思路；主观题允许多种合理表达。
2. 核心知识点：概念、条件和适用范围。
3. 解题过程：选择题逐项辨析；判断题纠错；填空逐空解释；主观题对应参考要点；阅读题定位材料。
4. 记忆方法：理解线索、对比或合适的记忆技巧。
5. 易错题型：常见误判、条件变化与相关变式。

来源与 AI 说明保留在文件及管理端预览中；正式题目写入现有内容字段。学生端解析继续遵守即时／统一反馈、提交和自评规则。

## 管理端操作与重试

1. 选择目标题库，下载示例或选择自己的 JSON 文件。
2. 查看每个文件的校验结果，展开预览核对材料、小题、答案、解析、来源和 AI 参与字段。
3. 将文件章节映射到现有章节。同名唯一章节会预选；缺少章节时点击「新建此章节」，使用现有章节表单创建，保存后选择。也可以用顶部「归入章节」统一指定。
4. 按 `assets` 路径选择图片，完成上传与预览。缺少引用图片时禁止导入。
5. 确认导入，调用现有 `import-preview` 后调用 `imports`。整批失败保留文件和预览；同一次内容的网络重试复用幂等键。内容版本冲突时，查看变化并点击「刷新题库版本」，再确认导入。
6. 检查题目与章节，完成发布检查后发布。小程序主动刷新目录，再创建练习读取本次快照。

简式 JSON（题目数组或 `{questions:[...]}`）继续经同一内容校验器处理；新模板及 SKILL 输出标准 v1.0 文件。API 和后端版本保持 v1.0，来源元数据不会进入学生题目 DTO。

## Markdown 与代码题

`presentation` 默认 `STANDARD`。`CONCEPT`（概述）、`CODE_ANALYSIS`（代码分析）可搭配填空或简答。代码题提供完整程序，输出结果使用填空，程序理解使用简答；代码语言在围栏中注明。作答题型决定是否客观计分。参考内容、参考要点与解析沿用同一格式；标准答案值、题名和学生文字答案保留普通数据。

支持段落、换行、标题、强调、删除线、列表、引用、分隔线、行内／围栏代码和简单表格。普通换行显示为换行。代码块首批高亮 C、C++、Java、Python、JavaScript、TypeScript、SQL、JSON、HTML、CSS、Bash；未知语言以等宽原文显示。链接限 HTTPS。HTML 显示为文字，代码仅展示。图片通过 `assets` 和 `assetIds` 映射，正文中的图片语法会提示改用附件。

[代码导入示例](question-bank-import/examples/code-content.json) 包含两道客观输出填空和一道主观程序理解。JSON 字符串用 `\n` 表示换行，`\"` 表示双引号，`\\` 表示字面量反斜线；反引号无需转义。只执行一次 JSON 解析，正文不再次编码，也不预先转成 HTML。

```json
{"stem":"输出为 {{1}}。\n\n```javascript\nconsole.log(\"hello\");\n```","contentFormat":"MARKDOWN","presentation":"CODE_ANALYSIS"}
```

空位标记写在题干正文中，学生在原位置的横线上填写答案。代码块用于展示完整示例。旧题在代码块内的标记仍按原编号匹配，对应输入显示在代码块后。字面量标记用反斜线转义，如 JSON 中的 `\\{{1}}`；该标记不参与空位匹配。填空答案按编号逐空匹配，全空正确才得分；内部空白、标点、全半角保持原意，代码默认区分大小写。

五部分解析按真实标题顺序校验重复与空内容，代码块内的同名文字不算标题。管理端的完整预览支持学生作答、即时反馈、交卷复盘三个状态；主观题的参考内容只在复盘状态出现。

公告正文采用同一 Markdown 规则，上限 40000 字，标题与摘要保持纯文本。更新日志通过现有公告入口发布。导入协议和 API 版本继续为 v1.0；内容改动产生新修订，已创建练习与下载快照保持原修订。
