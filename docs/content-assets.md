# 资产与搜索术语

**资产（ContentAsset）是用户创作或导入后可管理的内容。** 资产归用户持有，正文、录音或原文件可以通过对应关系挂在同一个资产上。后续分类、处理和使用方式围绕资产建立。

| 概念 | 当前 Server 表达 |
| --- | --- |
| 资产身份与归属 | PostgreSQL 的 `content_assets.content_asset_id` 和 `user_id`。API 使用 `contentAssetId` 和 `contentAssetRevisionId`。 |
| 正文 | `content_asset_parts` 保存各部分的当前内容。常用部分为 `raw`、`outline`、`germination`。正文部分的修订使用 `partRevisionId`。 |
| 文件与录音原件 | `Resource`，表为 `resources`，API 使用 `resourceId`。`content_asset_resource_refs` 建立资产与原文件的引用。 |
| 可见范围与整理 | `content_asset_workspaces` 表示工作区可见关系，`content_asset_folders` 表示文件夹位置。`folderId` 是按当前工作区返回的关系投影。 |
| 标签与关系 | `content_asset_tags` 建立资产与标签的关联。`content_asset_relations` 保存资产间的显式关系。 |
| 来源 | 资产的 `sourceKind`、`sourceRef` 描述来源。索引的 `source_type` 指定原始记录类别，取值为 `content_asset`、`file`、`text`。 |

## 写入入口

- `/api/v1/workspaces/{workspaceId}/content-assets` 管理资产，`content-asset-imports` 导入可编辑纯文本或 Markdown 并创建资产。详情返回正文和资源引用，列表返回元信息和预览。 [接口对照](contract-compatibility.md)
- 通用上传完成后交付可供业务认领的 `resourceId`。资产可引用录音、PDF 或其他原文件。 [上传与资源](runbooks/user-storage-layout.md)
- `/api/v1/rag/ingestions` 和 `/api/v1/text-ingestions` 当前分别保存独立的文件解析记录和文本导入记录，用于各自的状态与检索。形成可管理的资产时，由业务调用资产写入入口。 [文件入库](runbooks/rag-url-ingestion.md) · [文本入库](runbooks/text-ingestion.md)

## 搜索与观测

*Hybrid search* 对应 `hybrid`，支持关键词和向量召回。*Keyword search* 对应 `keyword`，使用关键词召回。业务来源决定表与集合，搜索模式决定索引能力。当前资产原文使用 `hybrid` 索引，独立文件和文本记录使用 `keyword` 索引。 [索引与查询](runbooks/milvus.md)

资产查询入口为 `/api/v1/kb/content-assets/query`。资产查询的指标标签为 `operation="content_asset_query"`，结构化日志使用 `sourceType="content_asset"`，任务按 `kb.content-asset-index`、`kb.content-asset-cleanup` 和 `content-asset.tag-extract` 观测。 [指标说明](observability/metrics.md)
