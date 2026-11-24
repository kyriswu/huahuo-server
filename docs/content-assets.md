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

## 原始音频附件

音视频导入或录音上传完成后，取完成响应中的 `data.resource.resourceId`。创建音频资产时传 `assetKind: "audio"` 和 `resourceRefs: [{ resourceId, usage: "original" }]`。服务端在创建事务中认领文件，把附件及用途写入已有的 `content_asset_resource_refs`，并登记资源引用。资源元数据保存在 `resources`。 [资产路由](../src/modules/content-assets/routes.ts) · [引用写入](../src/modules/content-assets/content-asset-images.ts)

`parts.raw` 存正文或转写。没有正文时可传空字符串，之后仅更新正文会保留原附件。播放器从资产详情的 `data.resourceRefs` 取 `usage` 为 `original` 的音频资源 ID，再调用 `GET /api/v1/media/resources/{resourceId}/playback` 读取 `data.url`。 [播放接口](../src/modules/storage/routes.ts)

## 资产分类

`AssetKind` 是代码中定义的全局资产分类，创建、列表、详情、搜索 Schema 和索引元数据共用同一个枚举。资产行直接保存 `content_assets.asset_kind`，PostgreSQL 通过 `CHECK` 约束校验，Milvus 使用同名字符串字段。类型的来源是公共契约中的 `assetKinds`。 [公共契约](../src/contracts/asset-kind.ts)

新增分类时，在公共枚举追加稳定的值，确保可存入 Milvus 现有 32 字节字段，并追加一条 PostgreSQL 迁移扩展 `CHECK`。更新已有客户端接口文档。需要给存量资产重新分类时，再评估对应的数据迁移与索引元数据刷新。隔离集成测试核对最新 PostgreSQL 约束与代码枚举。 [约束回归](../tests/integration/content-asset-pagination.test.ts) · [迁移和索引刷新](runbooks/milvus.md#0026-链接资产分类同步)

## 资产内容状态

列表中的每项资产和详情均返回 `contentStatus`，由服务端写入 `content_assets.processing_status`。自由创作、图片、音频、文件和链接共用同一组状态。资产的 `state` 记录是否软删除，原文件的上传状态由 `Resource` 管理。 [公共契约](../src/contracts/content-status.ts)

| 值 | 含义 |
|---|---|
| `draft` | 撰写中，或资产所需内容尚未就绪且没有正在处理的任务。 |
| `processing` | 后台任务正在处理资产内容。 |
| `ready` | 资产所需的内容已就绪。 |
| `failed` | 后台任务处理资产内容失败。 |

当前创建和编辑以保存的原文为准。空白原文进入 `draft`，保存非空原文或成功导入纯文本／Markdown 后进入 `ready`，仅修改标题、文件夹或资源关联时保留原状态。音频转写和链接内容提取尚未接入资产状态写回。标签提取和搜索索引各自管理任务状态。 [接口对照](contract-compatibility.md#p06-个人资产文件夹检索与图谱)

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

创建资产、读取列表和详情、搜索筛选共用 `audio`、`image`、`file`、`creative`、`link` 五个分类值。服务端把 `assetKind` 存为 PostgreSQL 的 `asset_kind`，索引 Worker 将该值同步到 Milvus 同名字段。搜索可传 `assetKinds`、`from`、`to` 和 `timeField`。时间范围含端点，`timeField` 默认是 `updated_at`，也可指定 `created_at`。RAG 查询通过 `filters` 传递这些字段。独立文件和文本的关键词索引继续使用 `KB_INDEX_LAYOUT`。

切换前需在目标 Milvus 预建和加载新集合，并核实支持部分更新。0025 遇到遗留资产索引或未结束索引任务会停止。测试／开发共享库已核对无旧资产，维护时排空旧写入方后再次确认。
