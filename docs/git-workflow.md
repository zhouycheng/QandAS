# Git 工作流

本文档是 QandA 当前项目阶段的 Git 协作规则。开发者手册和 Agent Skill 均以本文档为准。

## 开发与发布分支

```text
develop → main → 手动运行生产部署 Actions
```

`develop` 用于日常开发，`main` 保存准备发布的版本并保持默认分支。仓库为私有，按 GitHub Free 配置，不设置分支保护、必需状态检查或部署审批。团队成员可以直接推送或使用 PR 协作；合并前核对差异并运行适用检查。

推送到 `main`、`develop` 和 PR 会运行 CI。生产部署仅由 Actions 的 **Run workflow** 手动触发，且来源必须为 `main`。合并或推送不会部署。

任务分支从最新 `origin/develop` 创建，完成后合入 `develop`。发布时将确认的代码合入 `main`，再手动选择部署；回滚也由同一工作流手动触发。服务器健康检查和失败恢复属于发布流程。

## 创建和推送任务分支

先确认工作区状态，不要丢弃或覆盖现有改动。再从最新 origin/develop 创建分支：

```bash
git status
git fetch origin --prune
git switch --no-track -c feat/your-task origin/develop
```

推荐名称包括 feat/question-list、fix/session-restore、chore/workspace-bootstrap。推荐格式是 type/description，使用能说明任务的名称；不把命名格式作为 CI 或 Agent 的硬性门禁。

--no-track 用来避免把任务分支的 upstream 误设成 origin/main。首次推送之前没有 upstream 是正常状态，不阻止本地提交。

```bash
git add <本次任务的文件>
git diff --cached
git diff --cached --check
git commit -m "feat(scope): 中文描述"
git push -u origin HEAD
```

首次推送成功后，后续可以使用 git push。推送目标必须是当前任务分支，不能是 main。

## 提交与同步

推荐提交信息采用 type(scope): 中文描述。一个提交表达一个完整逻辑；功能和与其不可分割的测试可以放在一起，不为凑提交数量机械拆分。不要混入无关格式化、临时文件或密钥。

同步检查区分两件事：

- 任务分支与同名远程任务分支的关系：fetch 后发现远程含有本地没有的提交时，停止推送并先处理，不能强推覆盖；本地无冲突的工作仍可提交保存。
- 任务分支与 origin/main 的关系：落后于 main 不阻止本地提交；合并前检查差异、冲突与集成影响，必要时经明确授权同步。

首次发布没有 upstream 时，应先检查是否已经存在同名远程分支；存在则检查提交关系，不能当作全新分支覆盖。upstream 指向 main 或其他非同名分支时，不据此认定任务分支已同步，也不要不加检查地执行 git push。

发现未解决冲突、正在进行的 merge/rebase 或不明确的历史状态时，先停止相关写操作并处理。Agent 不擅自 pull、merge、rebase、reset、stash、强推或改写历史。

## Pull Request

日常 PR 目标为 develop，发布 PR 目标为 main。推荐标题采用 type(scope): 中文描述，正文沿用仓库模板：

```markdown
## Summary

- 改动了什么，为什么修改。

## Notes

- 仅在存在迁移、兼容性、风险或其他必要说明时填写；无内容则删除。
```

在 GitHub 页面核对目标、差异、冲突和讨论状态，再由有写入权限的协作者合并。可以自愿邀请同伴审核，但不把等待他人批准作为前期强制步骤。

## Agent 操作边界

Agent 先检查分支、工作区、冲突和远程同步，再说明本次变更范围。

用户明确授权本次提交、推送、创建 PR 或合并后，可以在该授权范围内执行对应操作；没有授权时先给出计划并征得同意。授权提交不自动等于授权合并、删除分支或修改后台保护设置。

Agent 必须保留用户已有修改，只暂存本次授权的文件；失败后保留现场并报告实际结果，不擅自采用破坏性替代操作。与用户沟通使用中文。
