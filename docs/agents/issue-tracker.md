# Issue tracker: GitHub

任务与规格保存在本仓库的 GitHub Issues，使用 `gh` CLI 操作。

## 操作约定

- 首次创建 issue 前，使用 `gh repo view --json nameWithOwner`
  确认目标为 `imagebuilder1837/video-workspace`。
- 创建：`gh issue create --title "..." --body "..."`
  多行正文使用 heredoc 配合 `--body-file -`。
- 读取：`gh issue view <number> --json number,title,body,labels,comments`
- 列表：`gh issue list --state open --json number,title,body,labels`
  按需添加标签和状态过滤。
- 评论：`gh issue comment <number> --body "..."`
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭：先发表评论说明结果，再执行 `gh issue close <number>`。
- 父子关系优先使用 GitHub 原生 sub-issues；
  不可用时，在子 issue 顶部写 `Part of #<parent>`，
  并在父 issue 中维护任务列表。
- 阻塞关系优先使用 GitHub 原生 issue dependencies；
  不可用时，在正文顶部写 `Blocked by: #<n>`。
  所有阻塞项关闭后才可开始。

技能要求“发布到 issue tracker”时创建 GitHub issue；
要求“获取相关 ticket”时读取对应 issue。

## Pull requests as a triage surface

**PRs as a request surface: no.**
