# 入库、索引与现有查询实现

搜索功能确定需要，现有技术实现保留；业务范围、交互和具体细节尚未确定。本文只说明代码现状，不要求未来沿用当前API、参数、分类、排序或预算。见[需求边界](search-status.md)。

## 当前入库链路

| 来源 | 索引模式 | 现有处理 | 默认集合 |
| --- | --- | --- | --- |
| 资产正文 | `hybrid` | 保存当前 raw，按配置创建 Task/Outbox，分段、Embedding、写索引 | `huahuo_kb_content_asset_hybrid_chunks_asset_v2` |
| OSS 文件 | `keyword` | 外部解析器读取 OSS URL，保存规范正文、目录与图片回执，分段写入 | `huahuo_kb_keyword_chunks` |
| 独立导入文本 | `keyword` | 保存原文，按现有分段规则写入 | `huahuo_kb_keyword_chunks` |

资产正文当前使用 `qwen3.7-text-embedding-flash`，原生 1024 维 FP16。资产使用应用侧稀疏向量，独立文档关键词索引仍按配置选择 BM25 或稀疏向量。标签图谱由有效标签关系形成。

## 现有查询实现（技术现状）

- `/api/v1/rag/query` 与 `/internal/v1/rag/query` 使用同一个 RagQueryService。
- `/api/v1/kb/content-assets/query` 查询已发布的资产正文，支持 `keyword`、`dense` 和 `hybrid`。
- `/api/v1/kb/documents/query` 按 `keyword` 查询文件和独立文本，结果保留 `file` 或 `text` 来源。
- `/api/v1/content-assets/search` 复用资产查询，支持 `keyword` 和 `hybrid`。
- 资产直接在 Milvus 按账号和可选条件召回，按命中的分片 ID 回读 PostgreSQL，再复核正文、哈希和权限。独立文档保留精确的已发布分片范围。
- 当前 App 首页搜索仍为本地筛选，未接这些接口。本轮未接线 App 或其他项目。

## 实现与数据边界

- lib/document-processing/structure 独立生成正文 TOC 与临时章节范围；临时章节不是业务实体。
- modules/kb/split 按索引模式保留 UTF-16 原文范围。`hybrid` 每段最多 500 码点、目标重叠 50 码点。`keyword` 每段最多 2000 码点、零重叠。
- lib/rag-indexing/index 与 lib/search-index/keyword-indexing 负责已准备记录的批次写入。
- modules/kb/profile 按业务来源固定存储目标、模型与构建快照。modules/kb/jobs、ingestion、rag/jobs、text-ingestion/jobs 负责各自授权、租约、发布和清理。
- PostgreSQL 保存正文身份、修订、构建、范围、哈希、点ID与状态；向量写 Milvus。资产正文只在 PostgreSQL 保存，原生 BM25 文档集合另存其索引文本。
- 用户/工作区归属、正文修订、租约及当前发布状态在事务边界复核。删除通过既有任务精确清理；编辑和恢复不信任已清理点的旧 ready 标记。

Embedding仍用现有百炼同步接口，单HTTP批次最多20条；输入预算用UTF-8字节数加16保守估计，不冒充供应商真实token用量。端点/模型/凭据在授权部署配置中提供，后台仅管理索引批次、并发、超时、重试及正文上限。已有可选重排仍使用 RAG_RERANK_* 技术配置；不因保留配置自动启用或调用真实模型。

## Zilliz Cloud 连接

使用 Zilliz Cloud 作为索引目标时，API 和 Worker 沿用 Node.js SDK `2.6.17`，通过 gRPC 连接。在私有环境文件中设置集群的公网 `MILVUS_ADDRESS`、`MILVUS_TLS=true` 和该集群的 `MILVUS_USERNAME`、`MILVUS_PASSWORD`。

已发布的构建快照绑定原来的 Milvus 连接标识、数据库和集合。对于已有索引的环境，切换前需要在新目标重建并发布索引，使用已发布的快照验证 RAG 查询。


## 0021 集合名称切换

切换通过现有不兼容升级维护流程执行。API、Admin、Worker 和 Scheduler 采用同一版运行配置。若本地进程与测试环境共用数据库和 Milvus，一同排空相关工作。 [标准发布](standard-release.md)

1. 在当前 Milvus 数据库读回旧集合 `huahuo_kb_note_hybrid_chunks` 的 collection ID、索引与加载状态，确认新名称可用。候选配置的 `KB_CONTENT_ASSET_HYBRID_COLLECTION` 指向 `huahuo_kb_content_asset_hybrid_chunks`，并使用 `MILVUS_CREATE_IF_MISSING=false` 验收。
2. 在已审维护安排中原地更名。Node SDK 的 gRPC 调用为 `renameCollection({ collection_name: 旧名称, new_collection_name: 新名称 })`。确认 collection ID 相同，并检查运行角色对新名称的权限和读取状态。 [Zilliz 集合更名](https://docs.zilliz.com/docs/modify-collections)
3. 用候选环境运行发布的外部依赖检查，再应用 `0021_content_asset_search_terminology.sql`。迁移更新快照模式及默认集合名，原地更正 PostgreSQL 索引列名，沿用构建、任务和点 ID。
4. 用候选环境通过数据库和运行角色验收，再切换四角色。比对已发布点及抽样查询。若切换在数据库提交前中断，可按维护方案把原集合改回原名。0021 提交后，应用前进至候选版本或按独立审查的恢复方案处理。

`configHash` 是持久化的构建和点身份输入。既有编码保留在 `indexIdentityHash` 中，使改名后的相同配置可以复用已建立的索引点。

## 验证

pnpm test:integration --milvus 创建本项目独立临时 PostgreSQL/Redis/Milvus，不读取业务 .env。验证解析、写入、索引发布、重复执行、失败恢复、删除、权限和普通CRUD；模型/解析/OSS使用明确替身。adapter级读回用于确认索引内容，不代表搜索产品需求或真实业务验收已确定。

脚本 rag:consistency 和 rag:verify-milvus 用于索引一致性与 schema 检查；真实目标操作仍须按具体授权执行，不因本地测试通过自行访问或修改共享集合。

## 0023 资产索引改用账号归属

资产集合的物理名称由 `snapshotForSource` 计算。原生 BM25 使用配置前缀加 `_account_v1`，`sparse-v1` 使用前缀加 `_sparse_v1_account_v1`。新集合用 `user_id` 和 PostgreSQL 当前已发布点 ID 限制召回范围。独立文档集合沿用现有方案。

维护时先核对旧资产构建的快照目标是否与部署配置一致，按当前索引布局准备并验证新的资产集合。0023 会让旧资产点退出服务，并把当前构建重新排队。已存在的命中可能在重建完成前暂时不可用。上线验收包括检查重建积压、真实查询和跨账号隔离；旧集合的云端清理由后续维护处理。

## 0025 资产按元数据直接召回

资产统一使用 `_asset_v2` 集合。九字段和 API 条件见[资产搜索集合](../content-assets.md#资产搜索集合)。独立文档的集合布局由已有配置决定。

1. 在已授权的目标和维护窗口内预建、加载新集合，并核对运行角色访问权限。候选构建可用 `MILVUS_CREATE_IF_MISSING=true pnpm rag:verify-milvus --asset-only` 准备新集合，此命令不重建旧集合或调用模型。运行服务仍使用已审的 Milvus 配置。
2. 本次测试／开发共享库只读盘点确认没有旧资产、正文和索引构建。排空旧写入方后再次确认资产及关联仍为空，再应用 0024、0025。迁移不调度旧资产重建。
3. 检查资产索引队列是否有积压或失败，抽查账号隔离、创建和编辑时间范围、资产类型以及分片原文。用 `rag:consistency` 对账新集合。旧集合只交由单独授权的维护处理。

更新时间增量同步使用 Milvus 2.6.2 及以上版本的部分更新。 [Milvus 部分更新](https://milvus.io/docs/v2.6.x/upsert-entities.md)

## 0026 链接资产分类同步

在已审维护窗口内核对目标的 `content_assets` 表规模、待转换链接数及已发布分块数，确认迁移的表锁和更新可在配置的预算内完成。核对测试环境实际成功提交并排空旧写入和索引 Worker，再应用 `0026_asset_link_kind.sql`。迁移只转换原类型为 `creative` 且来源明确标记 `link` 的资产，保留正文、修订和时间戳。

在入口恢复前，用同一套候选配置运行能消费 `content` 队列的 Worker 和 Scheduler。用部署的迁移环境变量执行 `node dist/entrypoints/refresh-link-asset-index.js` 查看当前页。核对目标后追加 `--apply`，每次最多为 100 个已发布链接构建登记现有的元数据刷新任务。若输出包含 `nextCursor`，用 `--apply --after <nextCursor>` 继续。从首页重查可核对 `pending`、`failed`、`unscheduled` 和 `succeeded`，任务按构建去重，失败按现有任务恢复流程处理。

所有页的任务完成后，在同一目标的 API 环境执行 `node scripts/rag-consistency.mjs --asset-only`。检查资产集合的 `missing_in_milvus_count` 和 `asset_kind_mismatch_count` 都为零，再验收 `assetKinds: ["link"]` 的搜索。元数据通过现有 `chunk_id` 就地更新，沿用当前集合、索引和向量。新建索引直接读取 PostgreSQL 保存的分类。 [标准发布](standard-release.md)
