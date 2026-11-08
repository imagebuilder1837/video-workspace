# Domain Docs

采用 single-context 布局：根目录 `GLOSSARY.md` 和 `docs/adr/`。

## 探索前读取

- 阅读根目录 `GLOSSARY.md`。
- 阅读 `docs/adr/` 下与当前工作相关的 ADR。

文件不存在时直接继续，不提示补建。
由 domain-modeling 在术语或决策明确后按需创建。

## 术语与决策

- Issue 标题、方案、假设和测试名称使用词汇表定义的术语，
  避免使用词汇表明确排除的同义词。
- 缺少所需术语时，先检查是否偏离项目语言；
  确有缺口则交由 domain-modeling 处理。
- 建议与现有 ADR 冲突时，明确指出对应 ADR 和重新讨论的理由。
