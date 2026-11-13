# 模块化文档处理

当前知识库只有“资料关键词”和“笔记混合”两种模式，具体接口、配置和验收见 [知识库手册](milvus.md)。

- UTF-8 文本/Markdown/CSV 保持本地解析；启用 Xberg 后 PDF/Office 通过完整配置及持久批次 UUID 提取，再进入已有关键词索引。规范正文和完整 KB 产物分别保存，图片按已确认资源 UUID 授权读取；接线和失败恢复见[文档提取手册](document-extraction.md)。
- `analyzeDocumentStructure` 独立产生 H1–H6 TOC 和临时章节范围，不访问数据库或向量库。
- `splitKnowledgeContent` 独立按模式输出字符范围、核心范围、正文哈希和实际 Embedding 输入；没有业务数据库依赖。资料上限 2000 码点且不依赖模型 tokenizer，笔记上限 500 码点、约 50 字 overlap，最终输入用真实 BGE-M3 tokenizer 校验。
- `indexKeywordChunks` 通过窄 KeywordIndex 写资料文本；`indexChunks` 独立对已准备的笔记记录向量化并写目标。两者不选择业务数据库、不解析文档、不保存业务状态。
- `KnowledgeIndexJobs` 组合这些能力，负责固定配置与路由、事务中的授权/修订/租约、元数据持久化、发布和清理。
- `createDocumentProcessingTools` 是相同核心方法的薄封装，只允许应用注册的目标，不接受调用者提供数据库凭据。普通 Worker 可以直接调用核心，不依赖 Tool 协议。

临时章节不是业务 Parent；公共 `parentId` 指向整篇 Note 或资料记录。没有 Parent 表、章节外键或 ParentDocumentRetriever。旧 token 目标型切分实现与不再使用的 LangChain 依赖已移除，运行时只有当前两种规则，没有按版本号选择旧实现的逻辑。
