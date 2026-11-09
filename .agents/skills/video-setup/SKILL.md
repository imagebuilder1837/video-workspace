---
name: video-setup
description: 人工为指定视频项目按需配置 Git 和本地 Markdown tracker。
disable-model-invocation: true
---

# 项目管理 setup

仅在使用者明确调用时执行，只配置指定视频项目；制作起点与忽略规则见 [项目约定](../video-produce/references/project-layout.md)。

1. **检查现状**：解析目标实际路径，读取已有本地指引、tracker 和忽略规则，核对 Git 根目录；区分项目自己的仓库与工作台父仓库。目标不明先澄清。
2. **逐项确认**：展示现状与建议。尚未配置时，默认启用项目 Git 和本地 Markdown tracker，允许分别关闭；已有配置沿用，替换已有约定前确认。
3. **只配置所选能力**：
   - **Git**：对照模板补足必要忽略规则，保留用户内容；在目标项目初始化独立仓库。
   - **tracker**：采用 [本地任务约定](../video-tasks/references/issue-tracker.md)。在项目 `AGENTS.md` 中写入实际任务位置及该共享说明的可解析路径；已有其他本地指引入口则沿用。只写短指针。
4. **返回并停止**：列出实际配置、保留内容与限制。新仓库尚无制作基线；后续提交、拆票和委派分别按实际授权执行。

已有手工配置同样有效，可中途补启用能力；以实际仓库和本地指引为准。
