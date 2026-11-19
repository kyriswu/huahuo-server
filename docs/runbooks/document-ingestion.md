# 资产正文入库

内容资产的当前原文保存在 `content_asset_parts`。保存或修改 `parts.raw` 时，如果已启用 `features.contentAssetIndexing`，业务事务固定原文修订和授权归属，并创建 `kb_content_asset_hybrid_builds`、Task 与 Outbox。仅改标题、纲要或其他原文之外的字段时复用当前原文索引。

Worker 使用 `hybrid` 规则按 H1–H6 或自然段切分，上限为 500 Unicode 码点，同范围目标重叠 50 码点。Embedding 使用 `qwen3.7-text-embedding-flash`，输入预算按 UTF-8 字节数加 16 保守估计。`kb_content_asset_hybrid_chunks` 保存范围、哈希和点 ID。只召回当前已发布构建，编辑后复用未变点，在构建保存的目标中清理失效点。 [模块化文档处理](modular-document-processing.md)

请求以 `/api/v1/workspaces/{workspaceId}/content-assets/{contentAssetId}` 为基础路径。

| 方法及路径 | 结果 |
| --- | --- |
| `GET` 基础路径 | 资产详情。可用 `revisionId` 验证整篇资产的当前修订，版本不符返回 409。 |
| `GET /parts/{part}` | 当前部分的正文和 `partRevisionId`。 |
| `PUT /parts/{part}` | 携带 `If-Match` 和幂等键更新当前部分。 |
| `GET /ingestions` | 当前工作区内可见的构建任务概况。 |

工作区搜索返回 `part=raw` 和整篇资产的 `revisionId`。RAG 详细结果还返回原文修订、命中范围和正文。索引依照资产的当前可见范围与原文版本查找。 [资产与入口](../content-assets.md) · [索引配置与维护](milvus.md)
