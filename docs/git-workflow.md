# Git 工作流

本文档是题小搭当前项目阶段的 Git 协作规则。开发者手册和 Agent Skill 均以本文档为准。

## 分支与发布

```text
<username>/<type>/<description> → Pull Request → main
```

`main` 是默认分支和唯一长期保留分支。每项工作从最新 `origin/main` 创建个人任务分支，完成后通过目标为 `main` 的 Pull Request 合入；合并后删除任务分支。

推送到 `main` 和 Pull Request 会运行 CI。合并或推送不会部署。管理端和后端部署分别由 Actions 的 **Deploy admin**、**Deploy backend** 手动触发，来源必须为 `main`，操作可选 `check`、`deploy` 或 `rollback`。

## 创建与推送任务分支

先确认工作区状态，再同步远程引用并从最新 `origin/main` 创建分支。名称采用 `<username>/<type>/<description>`，例如 `zhouycheng/feat/practice-interactions`、`zhouycheng/docs/project-documentation`。用户名使用 GitHub 登录名，类型说明工作性质，描述采用简洁的英文小写短横线形式，说明实际任务。

```bash
git status --short
git fetch origin --prune
git switch --no-track -c zhouycheng/docs/project-documentation origin/main
```

`--no-track` 使任务分支不会把 `origin/main` 设为 upstream。首次推送前没有 upstream 是正常状态。

```bash
git add <本次任务文件>
git diff --cached
git diff --cached --check
git commit -m "feat(scope): 中文描述"
git push -u origin HEAD
```

首次推送设置同名远程 upstream；后续推送提交到当前任务分支。提交信息采用 `type(scope): 中文描述`，一个提交表达一个完整主题。

## 提交与同步

提交前核对暂存差异和 `git diff --cached --check`，只提交本次任务文件。远程同名任务分支若包含本地没有的提交，先检查并处理提交关系再推送。合并前核对 PR 目标、完整差异、冲突和 CI 状态；需要更新基线时，以最新 `origin/main` 为准并检查集成影响。

## Pull Request

所有任务 PR 的目标分支均为 `main`。标题采用 `type(scope): 中文描述`，正文简洁说明改动及原因；仅在需要时补充迁移、兼容性或风险说明：

```markdown
## Summary

- 改动内容及原因。

## Notes

- 仅填写必要的迁移、兼容性或风险说明。
```

CI 通过并完成差异核对后，将 PR 合并到 `main`，再删除已合并的任务分支。推送与 PR 不会触发部署；需要部署时，单独在对应 Actions 中选择 `main` 和操作类型。

## Agent 操作边界

Agent 先检查分支、工作区、冲突和远程同步，再说明本次变更范围。

提交、推送、创建 PR、合并和删除分支均按用户本次授权范围执行。授权提交不自动包含其他外部操作或仓库后台设置修改。

Agent 必须保留用户已有修改，只暂存本次授权的文件；失败后保留现场并报告实际结果，不擅自采用破坏性替代操作。与用户沟通使用中文。
