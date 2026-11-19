# 资产与搜索术语

**资产（ContentAsset）是用户创作或导入后可管理的内容。** 资产归用户持有，正文、录音或原文件可以通过对应关系挂在同一个资产上。后续分类、处理和使用方式围绕资产建立。

| 概念 | 当前 Server 表达 |
| --- | --- |
| 资产身份与归属 | PostgreSQL 的 `content_assets.content_asset_id` 和 `user_id`。API 使用 `contentAssetId` 和 `contentAssetRevisionId`。 |
| 正文 | `content_asset_parts` 保存各部分的当前内容。常用部分为 `raw`、`outline`、`germination`。正文部分的修订使用 `partRevisionId`。 |
| 文件与录音原件 | `Resource`，表为 `resources`，API 使用 `resourceId`。`content_asset_resource_refs` 建立资产与原文件的引用。 |
| 可见范围与整理 | 按登录账号读取资产。`content_assets.folder_id` 保存唯一的可空文件夹位置。文件夹软删后，API 的 `folderId` 显示为空；恢复文件夹后重新显示原位置。 |
| 标签与关系 | `content_asset_tags` 建立资产与标签的关联。`content_asset_relations` 保存资产间的显式关系。「我的标签」是 App 本机的最近使用记录。 |
| 来源 | 资产的 `sourceKind`、`sourceRef` 描述来源。索引的 `source_type` 指定原始记录类别，取值为 `content_asset`、`file`、`text`。 |

## 写入入口

- `/api/v1/content-assets` 管理资产，`content-asset-imports` 导入可编辑纯文本或 Markdown 并创建资产。详情返回正文和资源引用，列表返回元信息和预览。 [接口对照](contract-compatibility.md)
- 通用上传完成后交付可供业务认领的 `resourceId`。资产可引用录音、PDF 或其他原文件。 [上传与资源](runbooks/user-storage-layout.md)
- `/api/v1/rag/ingestions` 和 `/api/v1/text-ingestions` 当前分别保存独立的文件解析记录和文本导入记录，用于各自的状态与检索。形成可管理的资产时，由业务调用资产写入入口。 [文件入库](runbooks/rag-url-ingestion.md) · [文本入库](runbooks/text-ingestion.md)

## 搜索与观测

*Hybrid search* 对应 `hybrid`，支持关键词和向量召回。*Keyword search* 对应 `keyword`，使用关键词召回。业务来源决定表与集合，搜索模式决定索引能力。当前资产原文使用 `hybrid` 索引，独立文件和文本记录使用 `keyword` 索引。 [索引与查询](runbooks/milvus.md)

资产查询入口为 `/api/v1/kb/content-assets/query`。资产查询的指标标签为 `operation="content_asset_query"`，结构化日志使用 `sourceType="content_asset"`，任务按 `kb.content-asset-index`、`kb.content-asset-cleanup` 和 `content-asset.tag-extract` 观测。 [指标说明](observability/metrics.md)

## 正文编辑与索引复用

资产原文更新后按当前版本重新生成分块范围。混合索引根据分块正文哈希、向量化输入哈希、相同块出现次数和索引配置计算稳定点 ID。已有可用点直接复用，向量化和写入只处理本次缺失点。新构建完整写入后发布，随后清理旧版本独有的点。原文修订变更到新构建发布之间，查询会暂时排除该资产。独立文件和文本的 `keyword` 建索引按新版本写入分块。 [索引执行](../src/modules/kb/jobs.ts) · [版本筛选](../src/modules/rag/query-service.ts)

隔离 PostgreSQL、Redis 和 Milvus 实测四个章节。单改一个独立章节只向量化一块，复用三块，替换后的旧点从集合中查询不到。删除一个独立章节时向量化零块，其余点 ID 一致，删除点从集合中查询不到。切分验证中，修改重叠区的一个字符影响两块，修改标题会改变该节各块的向量化输入。 [集成用例](../tests/integration/knowledge-base.test.ts)

## 无正文检索

Server 的 `sparse-v1` 集合保存向量、稳定分块 ID 和筛选字段。资产用稠密与稀疏向量，文件与独立文本用稀疏向量。Milvus 返回点 ID 和分数，Server 从权威正文批量取片段并校验当前修订。旧部署使用原生 BM25，经测试维护切换后使用稀疏向量。 [集合切换与验收](runbooks/milvus-textless-search.md)

### 资产搜索集合

资产使用 `<KB_CONTENT_ASSET_HYBRID_COLLECTION>_asset_v2`，保留 `chunk_id` 主键、`source_id`、`user_id`、`asset_kind`、`created_at`、`updated_at`、`build_id`、`sparse_vector` 和 FP16/1024 的 `dense_vector`。`build_id` 记录写入批次。正文由 PostgreSQL 按命中的 `chunk_id` 回读。Milvus 先按账号、可选资产类型和时间筛选，PostgreSQL 再校验账号、当前正文和其余条件。时间以资产的 UTC 毫秒时间戳存储。

创建资产可指定 `assetKind` 为 `audio`、`image`、`file` 或 `creative`。搜索可传 `assetKinds`、`from`、`to` 和 `timeField`。时间范围含端点，`timeField` 默认是 `updated_at`，也可指定 `created_at`。RAG 查询通过 `filters` 传递这些字段。类型或时间有变化时，由索引 worker 同步到 Milvus。独立文件和文本的关键词索引继续使用 `KB_INDEX_LAYOUT`。

切换前需在目标 Milvus 预建和加载新集合，并核实支持部分更新。0025 遇到遗留资产索引或未结束索引任务会停止。测试／开发共享库已核对无旧资产，维护时排空旧写入方后再次确认。
