# Milvus 检索与入库

文件 RAG 使用唯一的 `huahuo_chunks` Collection。Note 正文使用其业务 Profile 明确绑定的 `huahuo_manual_text`。二者是不同业务的目标，不是同一架构的迭代副本。没有 Collection 别名、按版本号选择适配器或旧检索回退。

完整文档处理、正文存储、TOC、稳定身份与恢复流程见[模块化文档处理](modular-document-processing.md)。

## 职责与数据流

```text
业务正文 → LangChain 子 Chunk → PostgreSQL 业务 Chunk
                                  ↓
                         独立 indexChunks
                                  ↓
               Qwen Embedding → Milvus upsert

Query → Query Embedding ── Dense ┐
原始 Query ─────────────── BM25 ├─ Milvus Hybrid/RRF
                               ┘          ↓
                       PostgreSQL 权限复核及正文回查
                                          ↓
                               独立 HTTP Reranker → 响应
```

PostgreSQL 是完整正文、TOC、Chunk、业务归属和处理状态的事实来源。Milvus 的 `text` 是原生 BM25 的输入索引副本；向量不保存到 PostgreSQL。RAG 没有 PostgreSQL 关键词召回或 Node.js 本地 RRF。独立 Note 业务搜索的全文/ILIKE 查询不属于 RAG 召回，继续保留。

`parent_id` 表示整篇来源内容的 ID；PDF 映射 `rag_ingestion_versions.id`，Note 映射 `notes.note_id`。不创建章节 Parent，不进行命中后的章节块回溯。临时章节仅用于 TOC 和可选切分提示。

## 实际实现

| 能力 | 入口 |
| --- | --- |
| Milvus SDK 连接、Schema 校验、upsert、召回及删除 | `src/modules/rag/adapters/milvus.ts` / `MilvusRepository` |
| Schema、BM25 Function、多语言 Analyzer、语言判定 | `src/modules/rag/adapters/milvus-schema.ts` |
| 通用目标绑定与索引适配器 | `src/modules/rag/vector-store.ts` |
| 独立批量入库、部分失败与删除 | `src/lib/rag-indexing/index.ts` |
| 用户权限、业务路由、PG 正文、Rerank 与结果组装 | `src/modules/rag/query-service.ts` |
| HTTP Reranker | `src/modules/rag/search.ts` / `HttpRerankAdapter` |

安装的 Node SDK 为 `@zilliz/milvus2-sdk-node@2.6.17`。当前 Dense 模型为 `Qwen/Qwen3-Embedding-8B`，配置和真实返回维度均为 4096。模型名称中的数字及 SDK 版本是外部依赖标识，不是架构版本。

## Collection 与索引

当前 Schema 的关键字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定 Chunk Key，VARCHAR 主键，非自动生成 |
| `doc_id` | 业务文档分组 |
| `parent_id` | 整篇来源内容记录 ID |
| `source_type` / `source_revision` | 业务来源与正文修订 |
| `user_id` / `workspace_id` | 服务端提供的权限过滤范围 |
| `text` / `language` | BM25 原文输入及 Analyzer 选择 |
| `dense_vector` | 当前模型的 FLOAT_VECTOR |
| `sparse_vector` | Milvus BM25 Function 自动生成的 SPARSE_FLOAT_VECTOR |
| `document_version` / `index_build_id` / `embedding_profile` | 当前业务正文和有效索引的隔离范围 |
| `index_status` / `chunk_index` | building/ready 状态及实际顺序 |
| `embedding_model` / `embedding_dimensions` / `embedding_text_hash` | 实际输入及模型校验信息 |

Dense 索引 `huahuo_dense_hnsw` 使用 HNSW / COSINE；Sparse 索引 `huahuo_sparse_bm25` 使用 SPARSE_INVERTED_INDEX / BM25。BM25 Function `huahuo_text_bm25` 为 `text → sparse_vector`。BM25 Function 产物必须使用 BM25 metric，不能把普通稀疏 IP 示例直接套入该字段。应用仅写文本和 Dense Vector，不生成 Sparse Vector。

Schema 创建幂等，已存在时校验维度、Function、Analyzer 和索引。应用启动或任务执行均不 DROP Collection。Schema 不符明确失败，不通过创建另一个带迭代号的 Collection 自动绕过。目标SQL基线切换不改变默认Collection或Schema，不触发向量清空、Collection重建或付费向量补建。

## 中英文 Analyzer

`text.multi_analyzer_params.by_field=language`，每条记录只选择一个 Analyzer：

| language | Analyzer |
| --- | --- |
| `zh` | Jieba + `cnalphanumonly` + lowercase |
| `en` | English Analyzer |
| `mixed` | Jieba + `cnalphanumonly` + lowercase |
| `unknown` | alias 到 ICU + lowercase |

`detectChunkLanguage()` 使用 Han 字符和 Latin 词单元的轻量规则，不调用模型、不手工分词。查询使用同一规则选择 Analyzer。真实多语言 `runAnalyzer` 和 BM25 Query 行为由下述脚本验证。

## 配置与业务路由

```env
MILVUS_DATABASE=default
MILVUS_COLLECTION=huahuo_chunks
RAG_DENSE_CANDIDATES=20
RAG_BM25_CANDIDATES=20
RAG_HYBRID_CANDIDATES=30
RAG_RRF_K=60
MANUAL_TEXT_MILVUS_DATABASE=default
MANUAL_TEXT_MILVUS_COLLECTION=huahuo_manual_text
```

连接、TLS、凭据、超时和有界并发使用项目全局 `MILVUS_*`。标准 `grpc_proxy` 仅用于传输代理；直连留空，本机Compose使用 `http://host.docker.internal:1082`，宿主机验证覆盖为 `http://127.0.0.1:1082`。根 `.env` 是部署配置来源；不在文档打印凭据或完整连接串。手动文本仅在 `MANUAL_TEXT_ENABLED=true` 且目标明确配置时运行。每个任务保存无凭据的目标快照；重试、读取和清理不能切到当前默认目标。

现有 API 为 `POST /api/v1/rag/query`、`POST /api/v1/huahuo_rag/query`、`POST /internal/v1/rag/query`。用户入口使用 JWT；内部用户入口同时要求 JWT 与方向 Service Key。用户身份来自 JWT `sub`，正文回查再次执行归属和有效状态校验。`sourceType=file|note` 选择注册的业务路由，调用方不能传任意 Collection。

Dense/BM25 两路使用相同 scope。`keyword` 仅发送原始 Query，不调用 Query Embedding。`hybrid` 使用 SDK 原生 Hybrid Search 与 `RRFRanker(RAG_RRF_K)`，不在本地二次融合。原生 Hybrid 返回融合分数；响应中未单独测量的 `denseScore` / `keywordScore` 为 0 占位，不能解释为两路真实分数。Reranker 使用从 PostgreSQL 查回的真实正文。

## 幂等和一致性

稳定 ID 包含来源、整篇 ID、正文修订、切分配置和顺序。相同任务重试使用同一主键 upsert；ready 状态只在向量写入和业务发布条件满足后更新。新正文索引完成前保留原有有效索引，发布后按原目标和旧修订定向清理。

`pnpm rag:consistency` 分别输出 PG ready、Milvus ready 唯一逻辑键、building、物理 `row_count`、重复逻辑键及两侧缺失数。统计接口可能未覆盖 growing/unflushed 数据，不能用物理行数代替实时逻辑行数。查询按稳定 Chunk Key 去重，并经过 PG 权限及当前业务状态复核。

## 可执行验收

```bash
pnpm build
# 仅连接、Schema、索引和 Analyzer；不调用模型
node --env-file=.env scripts/verify-milvus.mjs --schema-only
# 包含真实 Embedding 和可配置 Rerank；仅在明确授权真实模型调用时执行
pnpm rag:verify-milvus
# 只读一致性诊断
pnpm rag:consistency
```

脚本要求配置目标为 `huahuo_chunks`，使用固定隔离身份 `__huahuo_smoke__` 和 `milvus-smoke` 文档键。完整模式写入3条公开中文/英文/混合测试文本，重复 upsert，另写 building 与其他用户哨兵；验证5类 Dense/BM25/Hybrid Query 以及配置的 HTTP Rerank。稳定 ID 保证重复执行不增加逻辑样本。隔离样本不对应业务 PG 文档，不会进入业务 API 授权结果。

报告写入 `.local/milvus-live-verification.json`，不包含密钥、完整向量或真实用户正文。脚本不操作解析器和 PostgreSQL，不再维护旧 Collection 保留检查。BM25 产物通过 Function/索引与原始文本正召回证明：Milvus 不允许将该 Function 输出作为普通 output field 返回。

## 现有 huahuo 库切换结果与RAG验收边界

已在原阿里云 `huahuo` 库完成安全切换，未新增数据库。旧 `public` 整体改名封存为 `initialization_backup`，58表4149行及OID/relfilenode/视图内容摘要保持一致；新 `public` 已按唯一 `migrations/0001_initial_schema.sql` 初始化，版本1重放幂等、全库FK0。四角色已部署统一模型且healthy，readiness与JWKS真实检查通过。

旧业务数据完整保留在封存Schema，四运行角色无其USAGE/CREATE；新 `public` 未复制产品用户或会话，`users/user_sessions`均为0。Milvus默认目标仍为`huahuo_chunks`与`huahuo_manual_text`，连接、Schema、Qwen模型、4096维和索引配置不变；本次未清理Milvus或OSS，也未付费重建历史向量。

SQL切换没有删除任何旧行，Milvus旧smoke也未作为当前业务查询结果。新模型后续RAG验收须建立新的合法用户会话，经过Workspace、正文和有效状态校验，再以受控来源记录验证入库；本轮未执行真实文件RAG入库，部署healthy不能替代这一验收。

新业务验收应核对：

1. 新用户JWT与数据库active用户/会话一致，跨用户或Workspace请求不能返回正文。
2. 新文档正文、Chunk、目标快照与索引状态在业务库中真实保存，Child使用稳定ID写入正确Collection。
3. Dense、原始文本BM25、MilvusHybrid/RRF和独立Rerank各自按实际依赖完成验证；Mock与真实模型调用分开报告。
4. 使用新用户范围核对PG与Milvus的ready逻辑数量，确认重复任务、building及其他用户记录不会进入响应。

```bash
# 构建后执行，只读；以新入库用户为业务验收范围
node --env-file=.env scripts/rag-consistency.mjs --user-id "<new-user-uuid>"
```

不带`--user-id`的全Collection诊断会如实包含仅存在于Milvus的公开样本和旧索引记录；当SQL业务范围与这些记录不匹配时，它们可能计入`missing_in_postgres_count`。必须明确统计范围，不能把全库物理行数当成新用户的业务Chunk数量，也不能为使数字相等而删除未经授权的数据。

本次typecheck、lint、build、229项unit/contract、115项隔离PG/Redis integration及额外6项Schema归档安全检查通过。真实RDS基线、归档保护、运行部署与JWKS结果见[RDS基线验收](rds-relations.md)；模型和短信调用均为0，不把这些检查描述成新一次真实文件RAG或Rerank验收。

## 历史依赖证据与当前边界

2026-11-03公开固定样本曾真实验证Qwen4096维、Dense、BM25、多语言Analyzer、MilvusHybrid/RRF、HTTP Rerank、稳定upsert和权限过滤。2026-11-04通用索引核心对两个业务目标执行过隔离写入、读取和删除，使用已保存公开向量，没有新增模型调用。这些记录只证明当时样本与依赖行为，不等于本次新 `public` 已完成真实文件RAG入库。

2026-11-05命名整理历史证据确认了无迭代号的两个业务Collection、BM25 Function和Dense/Sparse索引。服务端不能原地修改BM25 Function的限制属于该次维护记录，不是SQL基线切换需要再次重建Collection的理由。

本次不以真实付费解析、Embedding或Rerank作为Schema整理的隐含步骤。新文档完整链路、实际供应商调用、生产规模性能和部署连通性须分别记录真实结果；未执行的项目明确为待验证。
