# 模块化文档处理

索引能力使用通用的 `keyword` 和 `hybrid`。`snapshotForSource` 按业务来源选择索引能力与存储目标，`tablesForSource` 选择对应构建表和分块表。 [知识库手册](milvus.md)

- 所有文件（TXT、Markdown、CSV、PDF、Office）均通过 OSS URL、节点配置及持久批次 UUID 交给外部服务提取，再进入已有关键词索引。规范正文和完整 KB 产物分别保存，图片按已确认资源 UUID 授权读取；接线和失败恢复见[文档提取手册](document-extraction.md)。
- `analyzeDocumentStructure` 独立产生 H1–H6 TOC 和临时章节范围，不访问数据库或向量库。
- `splitKnowledgeContent` 独立按模式输出字符范围、核心范围、正文哈希和实际 Embedding 输入；没有业务数据库依赖。`keyword` 上限为 2000 码点。`hybrid` 上限为 500 码点，目标重叠 50 码点，用 UTF-8 字节保守估算 Qwen 输入预算。
- `indexKeywordChunks` 通过 `KeywordIndex` 写文本。`indexChunks` 把准备好的分块向量化并写入指定目标。两者由入库服务调用。
- `KnowledgeIndexJobs` 组合这些能力，负责固定配置与路由、事务中的授权/修订/租约、元数据持久化、发布和清理。

临时章节不是业务 Parent；查询响应的 `parentId` 指向整篇资产或资料记录。没有 Parent 表、章节外键或 ParentDocumentRetriever。旧 token 目标型切分实现与不再使用的 LangChain 依赖已移除，运行时只有当前两种规则，没有按版本号选择旧实现的逻辑。
