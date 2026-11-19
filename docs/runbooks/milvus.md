# 入库、索引与现有查询实现

搜索功能确定需要，现有技术实现保留；业务范围、交互和具体细节尚未确定。本文只说明代码现状，不要求未来沿用当前API、参数、分类、排序或预算。见[需求边界](search-status.md)。

## 当前入库链路

| 来源 | 现有处理 | 索引目标 |
| --- | --- | --- |
| 资产 正文 | 保存当前 raw，按配置创建 Task/Outbox，分段、Embedding、写索引 | huahuo_kb_note_hybrid_chunks |
| OSS 文件 | 外部解析器读取 OSS URL，持久化规范正文、目录与图片回执，分段写入 | huahuo_kb_keyword_chunks |
| 手动文本 | 保存原文，按现有分段规则写入 | huahuo_kb_keyword_chunks |

两个既有集合不删除、不重建。资产 现有模型为 qwen3.7-text-embedding-flash，原生1024维 FP16；文件/独立文本的索引构建不调用 Embedding。标签图谱仍由有效标签关系形成，不使用搜索结果生成关系。

## 现有查询实现（技术现状）

- `/api/v1/rag/query` 与 `/internal/v1/rag/query` 使用同一个 RagQueryService。
- `/api/v1/kb/content-assets/query`、`/api/v1/kb/documents/query` 分别接到现有Note/File查询线路；File查询覆盖file/text真实来源。
- `/api/v1/workspaces/:workspaceId/search` 复用现有Note查询。
- 当前实现保留来源分页、精确已发布point范围、正文/哈希/权限复核、全局分支融合及可选重排；它们不是产品需求决定。
- 当前 App 首页搜索仍为本地筛选，未接这些接口。本轮未接线 App 或其他项目。

## 实现与数据边界

- lib/document-processing/structure 独立生成正文 TOC 与临时章节范围；临时章节不是业务实体。
- modules/kb/split 按当前入库规则保留 UTF-16 原文范围。资产 每段最多500码点、目标重叠50码点；文件/独立文本每段最多2000码点、零重叠。
- lib/rag-indexing/index 与 lib/search-index/keyword-indexing 负责已准备记录的批次写入。
- modules/kb/profile 固定存储目标、模型与构建快照；modules/kb/jobs、ingestion、rag/jobs、text-ingestion/jobs 负责各自授权、租约、发布和清理。
- PostgreSQL 保存正文身份、修订、构建、范围、哈希、点ID与状态；向量及索引文本写 Milvus，不在关系表重复保存。
- 用户/工作区归属、正文修订、租约及当前发布状态在事务边界复核。删除通过既有任务精确清理；编辑和恢复不信任已清理点的旧 ready 标记。

Embedding仍用现有百炼同步接口，单HTTP批次最多20条；输入预算用UTF-8字节数加16保守估计，不冒充供应商真实token用量。端点/模型/凭据在授权部署配置中提供，后台仅管理索引批次、并发、超时、重试及正文上限。已有可选重排仍使用 RAG_RERANK_* 技术配置；不因保留配置自动启用或调用真实模型。

## 验证

pnpm test:integration --milvus 创建本项目独立临时 PostgreSQL/Redis/Milvus，不读取业务 .env。验证解析、写入、索引发布、重复执行、失败恢复、删除、权限和普通CRUD；模型/解析/OSS使用明确替身。adapter级读回用于确认索引内容，不代表搜索产品需求或真实业务验收已确定。

脚本 rag:consistency 和 rag:verify-milvus 用于索引一致性与 schema 检查；真实目标操作仍须按具体授权执行，不因本地测试通过自行访问或修改共享集合。
