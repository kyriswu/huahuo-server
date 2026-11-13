# 知识库入库与检索

当前实现是两个并列的业务模式，不是迭代版本。只复用现有 Milvus 连接及 `default` database，不重建数据库或迁移旧向量。

| 业务 | Collection | PostgreSQL 构建 / 分段 | 模型调用 |
| --- | --- | --- | --- |
| 真实 Note 正文 | `huahuo_kb_note_hybrid_chunks` | `kb_note_hybrid_builds` / `kb_note_hybrid_chunks` | BAAI/bge-m3，1024 维；可选独立 Rerank |
| 文件 / 独立导入资料 | `huahuo_kb_keyword_chunks` | `kb_document_keyword_builds` / `kb_document_keyword_chunks` | Embedding、模型 tokenizer、Rerank 均为零 |

资料集合只有文本 analyzer、BM25 Function 和稀疏索引，没有 Dense 字段或占位向量。笔记的 BM25 与 Dense 位于同一条记录，原生 Hybrid Search + `RRFRanker(k=60)` 完成融合。一次查询只访问对应业务绑定的一个集合；不同技术归属可以在同一集合中分组查询，不跨集合融合。知识图谱仍由标签关系驱动。

## 入口与身份

- 正常 Note 创建/编辑保存 `parts.raw` 后，在同一个业务事务创建构建、Task、Outbox；只有真实 Note 可以走混合流程。
- `POST /api/v1/rag/ingestions`：OSS URL 文件入库，沿用现有文件名、MIME、幂等键与任务查询契约。原解析器、图片 OSS 转存、OCR 和 enriched Markdown 不变；解析后的资料走纯关键词流程。
- `/api/v1/text-ingestions`：独立导入业务正文没有变成 Note，所以接入资料关键词流程。只有 MANUAL_INPUT 可以编辑原文；FILE_UPLOAD 复用现有解析；其它未接通渠道继续返回不可用，不伪造正文或成功。
- `POST /api/v1/kb/notes/query`：笔记 Dense / Keyword / Hybrid。
- `POST /api/v1/kb/documents/query`：资料 BM25。
- 仍被 Agent 消费的 `POST /internal/v1/rag/query` 与通用用户入口 `POST /api/v1/rag/query` 使用同一查询实现；未指定 `sourceType` 时选择 Note。`sourceType=file|text` 由业务绑定资料关键词流程，即使请求包含 `mode=hybrid`，实际返回的 `mode` 也明确为 `keyword`，不会调用模型。
- 已移除无人消费的 `/api/v1/huahuo_rag/query` 别名与可提交任意正文覆盖 Note 索引的旧入口。业务 ID 不能被用来选择任意数据库或集合。

用户接口验证 `Authorization: Bearer <USER_JWT>`。内部用户接口同时验证 `X-Huahuo-Service-Key`（Agent→Server 方向）和用户 JWT；用户身份只来自验证过的 JWT `sub`。数据库再次验证用户、技术归属、删除状态及当前正文修订。

```json
{"query":"数据库 MVCC","sourceType":"note","mode":"hybrid","topK":10}
```

资料请求使用 `sourceType=file`；独立导入记录使用 `text`。可选 `documentKey` 是所属业务整篇记录 ID；没有 documentVersionId/indexBuildId 必填参数。结果包含 `documentKey`、整篇 `parentId`、`sourceRevision`、UTF-16 命中范围、Chunk 顺序、原始证据以及召回/重排分数。没有章节 Parent 表或章节父块回溯。`context` 当前为 null；显式章节读取继续从原文按范围读取，不复制持久化章节正文。

App 的现有工作区搜索仅沿用其技术路径和授权，不新增“工作区”产品概念；其中笔记关键词与混合检索都走笔记集合。命中返回 `part=raw`、整篇 Note 的 `revisionId`，并另外提供 `partRevisionId`，整篇精确读取校验 Note 修订；part 精确读取校验 part 修订，不再混淆两者。普通列表、状态和名称筛选仍由 PostgreSQL 负责；标签搜索/图谱关系没有改成向量关系。

## 实现位置与切分

| 能力 | 位置 |
| --- | --- |
| 文本/Markdown 下载及完整正文检查点 | `rag/jobs.ts`、`rag/document-preparation.ts`、原生 UTF-8 parser；二进制文档解析已移除 |
| H1–H6 分析、TOC、无重叠章节遍历 | `lib/document-processing/structure.ts` |
| 两种字符规则与 UTF-16 映射 | `modules/kb/split.ts` / `splitKnowledgeContent` |
| 纯关键词批量写入、超时、局部失败 | `modules/kb/keyword-indexing.ts` / `indexKeywordChunks` |
| 独立 Embedding + Vector 入库 | `lib/rag-indexing/index.ts` / `indexChunks` |
| 目标、模型和 tokenizer 快照 | `modules/kb/profile.ts` |
| 统一业务编排、发布与精确清理 | `modules/kb/jobs.ts` / `KnowledgeIndexJobs` |
| Milvus Schema / BM25 / Dense / Hybrid | `modules/rag/adapters/milvus-schema.ts`、`milvus.ts` |
| 薄 Tool | `tools/document-processing.ts` |
| 查询、授权、原文回查、最终复核 | `modules/rag/query-service.ts` |

资料按自然段、句界、字符窗口切分，上限 2000 Unicode 码点、零重叠。笔记复用 H1–H6 结构；无标题时按自然段确定临时父层范围，短章节保持完整，长章节在范围内切分，单块上限 500 码点，同父层目标重叠约 50 字。核心区间不重叠，合起来覆盖有效正文；范围始终是保存原文的 UTF-16 半开区间。标题前缀不是原文，不能冒充原文坐标。嵌套 TOC 只遍历互斥正文范围，避免重复索引。没有独立的章节 Parent 实体。

完整正文按正文修订保存在业务 Note 原文、独立导入原文或资料 canonical 对象中。四张索引表不保存 `content`、`embedding_text` 或向量；保存构建/修订/授权/目标/配置快照、顺序、范围、哈希、Milvus 点 ID 及状态。切片正文仅写 Milvus；查询必须按业务原文位置、哈希和有效修订复核，不能直接信任索引文本。

## BGE-M3 与配置

官方来源：[BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)，固定 tokenizer 文件修订 `5617a9f61b028005a4858fdac845db406aefb181`。文件随 Server 镜像交付，不在每次任务下载。Manifest 位于 `resources/tokenizers/bge-m3/manifest.json`：

- tokenizer.json SHA-256：`21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08`
- tokenizer_config.json SHA-256：`a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4`

使用 `@huggingface/tokenizers@0.2.0` 真实编码，包含特殊 token，输入硬上限 8192 tokens。文件哈希不符时失败关闭。缓存键不受 JSONB 字段排序影响，同一进程复用模型 tokenizer。模型与维度/profile 固定匹配当前业务，不维护多模型兼容路径。

```env
RAG_EMBEDDING_MODEL=BAAI/bge-m3
RAG_EMBEDDING_DIMENSIONS=1024
RAG_EMBEDDING_PROFILE=bge-m3-1024
RAG_TOKENIZER_PATH=resources/tokenizers/bge-m3/tokenizer.json
RAG_TOKENIZER_CONFIG_PATH=resources/tokenizers/bge-m3/tokenizer_config.json
RAG_TOKENIZER_MAX_INPUT_TOKENS=8192
MILVUS_DATABASE=default
MILVUS_SEARCH_CONCURRENCY=50
KB_NOTE_INDEXING_ENABLED=true
KB_NOTE_HYBRID_COLLECTION=huahuo_kb_note_hybrid_chunks
KB_DOCUMENT_KEYWORD_COLLECTION=huahuo_kb_keyword_chunks
```

现有 Embedding 凭据沿用；Rerank 端点、模型、密钥和 Note 200ms 预算独立配置，不随 Embedding 模型切换。资料关键词和 Note 纯关键词完全不调用这两个模型或模型 tokenizer。服务端连接及对象存储配置仍是全局配置。

Milvus SDK 2.6.17 连接及就绪状态按进程复用，应用并发闸门与 SDK 池 max 同为 50（min=2，按需增长）；排队最多 32。新建集合幂等，Sparse 使用 SPARSE_INVERTED_INDEX / BM25，Dense 使用 HNSW / COSINE（M=16、efConstruction=128）。SDK 数值 Strong=0 的默认值问题以明确的 Strong 枚举名称处理。启动和正常任务不 DROP 集合或清库。

## 修订、发布与恢复

构建身份固定来源类型、整篇 ID、正文修订和配置哈希。Note 修订使用真实 raw part 修订 UUID；资料使用解析正文 hash。Note 点 ID 还包含目标/规则/实际 Embedding 输入哈希和相同内容出现序号，因此局部编辑可复用未变点，同时不把重复段落误合并。文件和独立文本共用关键词模式但来源类型不同，不互相覆盖。

Task lease 与同来源 advisory lock 防止并发晚到写入。PG 事务复核归属、正文修订与有效租约后才发布，同一业务对象只允许一个 published 构建。编辑提交后旧修订立即不能命中；旧点在新构建成功前仍可作为复用资源，但不能当作新正文查询结果。远端写成功、PG 未确认时按同一 ID upsert 重试，不增加逻辑点。部分批次失败只重新处理未 ready 的记录。

删除/清空正文立即过滤命中，再通过正常 Task 精确清理原目标、原点 ID；仍被当前有效或正在构建的修订引用的点受到保护。恢复已删除内容时不能信任已清理的 ready 元数据，必须重新建立缺失点。Rerank 后再次复核修订，避免在途结果泄露已替换/删除的正文。Rerank 超时按已授权初排结果回退；资料与纯关键词不执行 Rerank。

`pnpm rag:consistency` 使用强一致 Query 检查逻辑 ready 点及 PG 对应关系，`getCollectionStatistics.row_count` 仅作为物理诊断。物理行数可能含历史写入和未压缩数据，不用于判断重复或发布成功。

## 验收与复现

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration --milvus
docker compose config --quiet
git diff --check
# 仅检查/幂等创建已配置集合，不调用任何模型、不删除旧数据
node --env-file=.env scripts/verify-milvus.mjs --schema-only
pnpm rag:consistency
```

集成 runner 只启动本项目独立 tmpfs PostgreSQL/Redis/Milvus，不读取开发 `.env`；用真实 BGE tokenizer、确定性 Embedding 替身验证两条正常业务入口、中文/英文/混合检索、App/Agent 契约、局部编辑、部分失败、租约丢失、恢复、删除与越权。真实模型和真实解析供应商没有通过 Mock 测试被声称验证。

本阶段验收与实际重置结果见 `docs/acceptance/knowledge-base.md`；运行和命令原始证据在忽略提交的 `.local/kb-refactor/`。旧切片表、旧视图、旧 Collection 路由与旧分路索引实现均已由新代码替换，不双写、不兼容回读、不补算旧向量。
