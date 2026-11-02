# 题库导入

正式题库由管理端导入、维护和发布，小程序按 `/api/v1` 目录与练习接口读取。

请使用统一的 [QandA 题库导入协议 v1.0](../../../docs/question-bank-import.md)，其中包含 JSON Schema、空白模板、六类题型和代码题示例、校验工具和 AI 提取 SKILL。

操作顺序：管理端选择目标题库 → 选择 JSON → 预览题目、来源和 AI 补全 → 映射章节与图片 → 确认导入 → 检查并发布 → 小程序主动刷新目录并创建练习。

`scripts/import-question-bank.cjs` 与 CSV 模板保留用于开发样例和 Playground 的本地数据维护。生产目录由后端维护；用户上传入口保持关闭，本地样例不会自动写入云端。

新模板显式设置 `contentFormat: MARKDOWN` 与展示属性；小程序使用共享解析规则展示题干、材料、选项、参考内容和解析。主观题交卷后显示参考内容，背题直接显示。已有快照按绑定修订读取；导入后创建的新练习读取新内容。详见[题型与答题交互](../../../docs/question-content-and-practice.md)。
