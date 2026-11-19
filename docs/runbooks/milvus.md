# 入库、索引与现有查询实现

搜索功能确定需要，现有技术实现保留；业务范围、交互和具体细节尚未确定。本文只说明代码现状，不要求未来沿用当前API、参数、分类、排序或预算。见[需求边界](search-status.md)。

## 当前入库链路

| 来源 | 索引模式 | 现有处理 | 默认集合 |
| --- | --- | --- | --- |
| 资产正文 | `hybrid` | 保存当前 raw，按配置创建 Task/Outbox，分段、Embedding、写索引 | `huahuo_kb_content_asset_hybrid_chunks` |
| OSS 文件 | `keyword` | 外部解析器读取 OSS URL，保存规范正文、目录与图片回执，分段写入 | `huahuo_kb_keyword_chunks` |
| 独立导入文本 | `keyword` | 保存原文，按现有分段规则写入 | `huahuo_kb_keyword_chunks` |

资产正文当前使用 `qwen3.7-text-embedding-flash`，原生 1024 维 FP16。关键词索引构建使用 BM25。标签图谱由有效标签关系形成。

## 现有查询实现（技术现状）

- `/api/v1/rag/query` 与 `/internal/v1/rag/query` 使用同一个 RagQueryService。
- `/api/v1/kb/content-assets/query` 查询已发布的资产正文，支持 `keyword`、`dense` 和 `hybrid`。
- `/api/v1/kb/documents/query` 按 `keyword` 查询文件和独立文本，结果保留 `file` 或 `text` 来源。
- `/api/v1/workspaces/:workspaceId/search` 复用资产查询，支持 `keyword` 和 `hybrid`。
- 当前实现保留来源分页、精确已发布point范围、正文/哈希/权限复核、全局分支融合及可选重排；它们不是产品需求决定。
- 当前 App 首页搜索仍为本地筛选，未接这些接口。本轮未接线 App 或其他项目。

## 实现与数据边界

- lib/document-processing/structure 独立生成正文 TOC 与临时章节范围；临时章节不是业务实体。
- modules/kb/split 按索引模式保留 UTF-16 原文范围。`hybrid` 每段最多 500 码点、目标重叠 50 码点。`keyword` 每段最多 2000 码点、零重叠。
- lib/rag-indexing/index 与 lib/search-index/keyword-indexing 负责已准备记录的批次写入。
- modules/kb/profile 按业务来源固定存储目标、模型与构建快照。modules/kb/jobs、ingestion、rag/jobs、text-ingestion/jobs 负责各自授权、租约、发布和清理。
- PostgreSQL 保存正文身份、修订、构建、范围、哈希、点ID与状态；向量及索引文本写 Milvus，不在关系表重复保存。
- 用户/工作区归属、正文修订、租约及当前发布状态在事务边界复核。删除通过既有任务精确清理；编辑和恢复不信任已清理点的旧 ready 标记。

Embedding仍用现有百炼同步接口，单HTTP批次最多20条；输入预算用UTF-8字节数加16保守估计，不冒充供应商真实token用量。端点/模型/凭据在授权部署配置中提供，后台仅管理索引批次、并发、超时、重试及正文上限。已有可选重排仍使用 RAG_RERANK_* 技术配置；不因保留配置自动启用或调用真实模型。

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
