# Note 正文入库

仅对已存在的真实 Note 原文建立混合索引。用户保存 `parts.raw` 后，业务事务固定真实 raw part 修订和授权归属，并创建 `kb_note_hybrid_builds`、Task 与 Outbox。标题等不改变 raw 正文的编辑不重新向量化。来源可以是手写、ASR、图片识别或链接解析，但必须先由业务创建 Note；未产生 Note 的导入资料使用关键词流程。

在Admin「功能开关」启用 `features.noteIndexing` 后，后续正文变更创建索引任务；旧KB_NOTE_INDEXING_ENABLED环境项已移除。旧的“单独提交任意content覆盖Note索引”接口和MANUAL_TEXT配置已删除。正文只保留在note_part_revisions，不复制到索引任务或chunk表。

Worker 使用 H1–H6 或自然段临时范围切分，上限 500 Unicode 码点，同范围重叠目标约 50 字，最终输入由固定 BGE-M3 tokenizer 校验。`kb_note_hybrid_chunks` 仅保存范围、核心范围、哈希和点 ID。完整构建发布前不可召回；编辑后旧正文立即退出查询，未变点可复用，失效点在准确目标中清理。

`GET /api/v1/workspaces/{workspaceId}/notes/{noteId}/ingestions` 返回当前可授权的构建任务概况。搜索与精确读取使用已有 App 路径，搜索命中包含 `part=raw`、整篇 Note `revisionId`，RAG 详细结果另含 `partRevisionId`/`sourceRevision`。请求 `GET notes/{id}?revisionId=...` 时不符当前整篇版本返回 409；`GET notes/{id}/parts/raw?partRevisionId=...` 按真实 part 修订读取，仍执行用户/归属/删除校验。

没有 Parent 表、父 chunk 外键或章节向量。章节、切分、独立入库核心和薄 Tool 见 [模块化文档处理](modular-document-processing.md)，完整集合与发布策略见 [知识库手册](milvus.md)。
