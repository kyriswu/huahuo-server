# 知识库双模式重构验收（2026-11-10）

后续变更：2026-11-12 已移除 MinerU 适配器及相关配置。下文 PDF/OCR 绑定与 Mock 解析测试属于当日历史证据，当前仅支持原生文本/Markdown/CSV 导入；以[移除验收](mineru-removal.md)为准。

本记录以本轮代码、唯一初始化基线及测试结果为准。旧进度里的 Qwen 4096、来源分路集合、PG 关键词召回和 LangChain token 窗口只属于历史验证，不是当前实现或兼容路径。

## 交付状态

- Server 代码、基线、配置、测试与镜像已完成。没有修改 App、Agent、解析器适配器或图片/OCR 绑定算法。
- 宿主 `.env`、全部6份环境变量示例（含部署规范示例）、Compose、代码默认值和测试已统一到 `BAAI/bge-m3` / 1024 / `bge-m3-1024`，凭据未轮换。Rerank 保持独立配置。配置契约测试防止示例继续携带旧模型、tokenizer、集合或失效参数。
- 独立空环境使用真实 PostgreSQL、Redis、Milvus 与官方 BGE tokenizer 验证通过；模型为明确标注的确定性替身，没有调用真实付费模型。
- 已在现有云 Milvus `default` database 创建、加载并核验两个新空集合。资料集合无 Dense 字段，笔记集合 Dense=1024；两者都有原生 BM25 Function 和稀疏索引，ready count 均为 0。已按实际执行审批定向删除旧 `huahuo_chunks`、`huahuo_manual_text`，没有删除 database 或实例。
- 开发 RDS `huahuo` 已按用户进一步明确的清理授权及实际命令审批重置，初始化58张表、物理外键0，两个旧归档 Schema 已删除；原有1个管理员账号及凭据原样保留。四角色已切换到 `huahuo-server:kb-search-dev` 且 healthy，API/Admin readiness HTTP200；一次性 migrate 校验 `applied=[]/current=1`。

## 真实复用点与入口

| 责任 | 实现 |
| --- | --- |
| 文件下载、解析检查点、原始 Markdown、OCR、图片资产 | `src/modules/rag/jobs.ts` / `RagIngestionJobs`、`document-preparation.ts`、既有 parser / MinerU binding |
| H1–H6、TOC 和互斥正文范围 | `src/lib/document-processing/structure.ts` / `analyzeDocumentStructure` |
| 两种字符规则、Unicode 和原文坐标 | `src/modules/kb/split.ts` / `splitKnowledgeContent` |
| 独立纯关键词批次入库 | `src/modules/kb/keyword-indexing.ts` / `indexKeywordChunks` |
| 通用模型向量化与向量写入 | `src/lib/rag-indexing/index.ts` / `indexChunks` |
| 来源、正文、快照、构建与索引发布 | `src/modules/kb/{repository,profile,jobs}.ts` |
| 原生 Milvus Schema、BM25、Dense、Hybrid RRF | `src/modules/rag/adapters/{milvus-schema,milvus}.ts` |
| 三个薄 Tool | `src/tools/document-processing.ts` / `createDocumentProcessingTools` |
| 真实 Note 保存与同事务 Task/Outbox | `src/modules/assets/service.ts`、`src/modules/ingestion/service.ts` / `NoteIndexService` |
| 独立导入业务 | `src/modules/text-ingestion/{service,jobs}.ts` |
| 查询、授权、正文与修订复核 | `src/modules/rag/query-service.ts` / `RagQueryService` |

调用链：

```text
真实 Note 的 raw part 保存
  → 同事务固定 raw part 修订、目标/配置快照、Build、Task、Outbox
  → 现有 Worker → H1–H6 或自然段范围 → ≤500 码点，约50字 overlap
  → PG 元数据 → BGE-M3 1024 → 笔记集合 BM25 + Dense
  → 事务复核来源、归属、任务/租约 → 发布

OSS 资料或独立导入内容
  → 原有解析/正文保存 → 固定正文 hash 与关键词规则/目标
  → 现有 Worker → 自然段/句界 → ≤2000 码点，overlap=0
  → PG 元数据 → 资料集合原生 BM25 → 事务复核并发布
```

独立导入内容不是 Note。WEB_CRAWL、IMAGE_OCR、MEDIA_ASR、BOOK_OCR 中尚未接通的来源仍返回真实不可用状态，不伪造成功。本阶段不接入新供应商。

## 存储与配置

RDS 仍使用 `.env` 的 `huahuo` 数据库，没有切回本地开发 PG。完整正文由业务 Note part 修订、独立导入原文或 OSS canonical Markdown 管理；正文不复制进下面四张索引表。

| PostgreSQL 表 | 内容 |
| --- | --- |
| `kb_note_hybrid_builds` | Note ID、raw part 修订、用户/技术归属、任务、正文和配置 hash、目标/规则/模型/tokenizer 快照、TOC、发布/清理状态 |
| `kb_note_hybrid_chunks` | build ID、ordinal、point ID、section ID、原文及核心范围、正文/input hash、字符/token 统计、ready 状态 |
| `kb_document_keyword_builds` | file/text 来源及整篇 ID、正文修订、归属/任务、关键词规则和目标快照、发布/清理状态 |
| `kb_document_keyword_chunks` | build ID、ordinal、point ID、原文范围、正文 hash、字符统计、ready 状态；无 Embedding 或 token 字段 |

上述分段表均不保存 `content`、`embedding_text` 或向量。索引文本写 Milvus，同一 Note 子块的文本与 Dense 属于同一行；查询按 PG 中的当前源修订、位置与哈希回查正文。

唯一基线：`migrations/0001_initial_schema.sql`。构建有来源/ID/修订/配置唯一约束，同一对象只允许一个 published 构建。关联为普通 ID 与普通查询索引；独立初始化实测物理外键为 **0**，未创建章节 Parent 表或章节外键。

| Milvus 目标 | 字段与索引 |
| --- | --- |
| `default.huahuo_kb_keyword_chunks` | 稳定 `id`、`source_id`、`source_type`、`user_id`、`workspace_id`、`text`、`language`、`index_status`、BM25 输出 `sparse_vector`；SPARSE_INVERTED_INDEX / BM25；没有 Dense |
| `default.huahuo_kb_note_hybrid_chunks` | 同上，另有 `dense_vector` FLOAT_VECTOR(1024)；HNSW / COSINE，M=16、efConstruction=128 |

连接使用原有 Milvus 实例及凭据，不创建 database/partition。按 `language` 选择 English、Jieba 或 ICU analyzer；英文查询对英文块与中英块分别选择对应 analyzer，在同集合原生 RRF 内合并，不在 Node.js 二次融合。

```env
RAG_EMBEDDING_MODEL=BAAI/bge-m3
RAG_EMBEDDING_DIMENSIONS=1024
RAG_EMBEDDING_PROFILE=bge-m3-1024
RAG_TOKENIZER_PATH=resources/tokenizers/bge-m3/tokenizer.json
RAG_TOKENIZER_CONFIG_PATH=resources/tokenizers/bge-m3/tokenizer_config.json
RAG_TOKENIZER_MAX_INPUT_TOKENS=8192
KB_NOTE_INDEXING_ENABLED=true
KB_NOTE_HYBRID_COLLECTION=huahuo_kb_note_hybrid_chunks
KB_DOCUMENT_KEYWORD_COLLECTION=huahuo_kb_keyword_chunks
MILVUS_DATABASE=default
MILVUS_SEARCH_CONCURRENCY=50
```

官方 tokenizer 固定 BAAI/bge-m3 修订 `5617a9f61b028005a4858fdac845db406aefb181`，文件随镜像交付。`manifest.json` 固定 SHA-256：tokenizer `21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08`；config `a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4`。`@huggingface/tokenizers@0.2.0` 对最终 Embedding 输入真实计数，含特殊 token，上限8192；校验不通过失败关闭。资料模式及所有 keyword 查询均不加载它。

## 查询与实际消费者

| 入口 | 业务及认证 |
| --- | --- |
| `POST /api/v1/kb/notes/query` | 真实笔记；用户 JWT；Dense / Keyword / Hybrid |
| `POST /api/v1/kb/documents/query` | OSS 资料；用户 JWT；BM25 |
| `POST /api/v1/rag/query` | 仍在消费的通用业务入口；用户 JWT；由 sourceType 绑定上述唯一目标 |
| `POST /internal/v1/rag/query` | Agent 入口；用户 JWT + Agent→Server Service Key；未传 sourceType 默认 Note |
| 现有 App `/workspaces/{workspaceId}/search` | 原 JWT/归属校验，raw 正文的 keyword/hybrid 接笔记集合，普通列表/标签查询保留 PG |

请求示例：`{"query":"数据库 MVCC","mode":"hybrid","topK":10}`。资料入口可传 `documentKey`；独立导入内容通过通用入口指定 `sourceType=text`。文件/文本实际模式始终返回 `keyword`，不因调用方传 `hybrid` 而触发模型。

每个业务请求只访问其绑定的一个集合；同集合内允许按技术归属分组检索。过滤 ready 点、合法用户、当前归属与当前正文修订。Milvus 返回文本再与源正文范围及 hash 校验，Rerank 后再次复核当前修订。资料及 keyword 无 Rerank；Note Rerank 使用独立200ms预算和授权结果回退。

App 真实契约使用 `part=raw`、整篇 Note 的 `revisionId`；raw part 另外返回 `partRevisionId`。整篇精确读取及 part 精确读取分别校验各自修订，不能互换；错误修订返回冲突。真实 Dart 路径/哈希见 `docs/app-reference.md` 本轮追加记录。没有修改或构建 Flutter。

章节父层只用于分析/切分；整篇来源 ID 为 `parentId`，响应不伪造章节 Parent，`context=null`。现有显式章节读取按原文范围返回，不增加章节父块回溯模型。

## 发布、重试、复用与清理

- 构建固定源修订、正文 hash、处理规则、业务存储和 Milvus 目标；配置变化不能让旧任务写到新目标。
- Task/Outbox/BullMQ/Worker 仍为单份原系统。来源 advisory lock 覆盖远端请求结束；PG 短事务同时检查当前源、build.task_id、任务 owner/version/attempt 与数据库时钟的租约。
- 相同输入使用稳定点 ID；部分失败只重试未 ready 的行。Milvus 已成功但 PG 未确认时，以同 ID upsert 恢复，不增加逻辑点。
- Note 未变块仅在目标、规则和实际 Embedding 输入相同且旧点尚未清理时复用。编辑提交即过滤旧修订，未先删除唯一旧物理索引。新构建全部成功后再发布、精确清理旧点。
- 删除、清空或正文替换立即阻止旧命中。清理按旧快照集合和准确点 ID，保护当前有效/正在构建的复用点；恢复已清理的内容重新建立点，不能只信历史 ready 元数据。
- 逻辑 ready 数按当前有效构建/唯一点检查；Milvus `row_count` 是物理诊断，不能据此断言重复或成功。

## 移除的旧实现

- 删除旧 `document_ingestion_chunks`、`rag_child_chunks`、`text_ingestion_chunks`、`note_index_state`、`note_index_jobs` 及 `rag_chunks` 视图的基线定义、索引和调用。
- 业务解析表保留原文引用、图片、解析状态、任务/删除等消费者需要的数据；去掉旧 Embedding/向量/Child 职责。
- 删除旧 Note PG 全文向量、函数、触发器和 GIN，以及旧分路 Query/Vector Store、embedding-cache、稳定键/差分模型等死代码。
- 删除旧 Qwen Embedding 默认值、旧集合/配置别名与旧任意 Note 内容覆盖入口；移除无人消费的 huahuo_rag 查询别名。
- 删除旧 token 窗口切分实现和未使用的 `@langchain/textsplitters`；当前明确采用两种业务码点规则，没有新旧切分并行。
- 普通 SQL 列表、LIKE/ILIKE、状态/目录/标签、CRUD、权限、知识图谱标签关系保留。JWT/JWKS、Refresh Token 和 Service Key 契约未重写。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过；Vite 管理端现有大 bundle 提示仍在 |
| `pnpm test` | 31 文件、196 项 unit/contract 通过 |
| `pnpm test:integration --milvus` | 10 文件、117 项通过；独立 tmpfs PG17.9 / Redis7.4.8 / Milvus2.6.26 |
| `docker compose config --quiet` | 通过 |
| `git diff --check` | 通过 |
| 镜像 `huahuo-server:kb-search-dev` | 构建成功，关键 JS 与基线 SHA 和宿主构建一致 |
| 云 Milvus Schema | 两个新空集合真实创建/索引/加载/Strong ready count=0；模型调用0 |
| 开发 RDS 重置 | 58表、0外键、旧表/视图及两个旧归档Schema已移除；新基线checksum与schema_migrations一致 |
| 本机四角色与 migrate | 同一新镜像；四角色healthy；API/Admin readiness=200；migrate成功退出 |
| 实际运行配置/连接 | 四角色BGE-M3/1024/profile一致；API容器可连接两个新云集合，重复ensureReady成功；PG/Milvus一致性计数均0 |
| 真实模型、真实 MinerU/Volcengine | 本轮未调用；不能以替身结果声称通过 |

集成覆盖正常 Note 保存、正常 OSS PDF 入库（明确的 Mock 解析样本）、独立导入全文保存、中文/英文/混合 BM25、Dense、同集合原生 RRF、App part/修订精确读取、Agent 双凭证、未变点复用、重复请求、部分失败、编辑/删除/恢复、迟到任务、远端成功后租约丢失、替换同修订任务、跨用户/技术归属隔离。切分测试覆盖短章节、长段/表格/代码、嵌套标题、重复段落、emoji、正文覆盖、UTF-16 半开区间、零/有 overlap 与真实 tokenizer。

原始日志位于忽略提交的 `.local/kb-refactor/{unit,integration,typecheck,lint,build,docker-build}.log`；云 Schema 证据为 `cloud-schema.log`、`cloud-collections.json`。第一次镜像构建在同时运行临时依赖时被资源限制终止，隔离测试退出后单独重建成功，没有将该失败隐藏为第一次成功。

## 开发数据重置结果与剩余条件

只读核对的目标是 `.env` RDS `pgm-2ze7o54d25m8kn53no.pg.rds.aliyuncs.com:5432/huahuo`，迁移账号 `huahuo_admin`。旧 public 59表及两个明确属于本项目的 initialization_backup Schema 已盘点；本轮不做迁移、回填或备份。现有管理员凭据需原样保留，禁止重置用户密码/密钥。

第一次实际执行在任何 DROP 之前因其它连接返回 `DATABASE_CONSUMERS_STILL_CONNECTED`，没有改动数据。说明剩余连接来源后，用户进一步明确授权“直接清理，不要管其他地方在不在用”。最终按审批执行：临时禁止 `huahuo` 新连接、核对并终止该库剩余连接（执行时剩余为0），在事务中替换唯一基线，恢复允许连接。PostgreSQL 不允许从当前库禁止自身连接，因此管理命令通过同实例 `postgres` 控制连接执行；没有清理 `postgres` 或其它数据库。

最终核验：

- `huahuo.public` 为58张表，4张新索引元数据表存在；旧6个关系（包括视图）不存在，两个项目归档Schema不存在，物理外键为0。
- baseline SHA-256 为 `39973a12ec585c781330975c8e4ba7c45c14850ea2e85da3232d20517d5f7636`，与 `schema_migrations` 记录一致；管理员账号数1、凭据未变，连接已恢复。
- 原 Milvus `default` database 保留，仅删除已核验的2个旧集合。新资料/笔记集合Strong ready分别为0/0；PG有效分段亦为0/0，无missing或stale点。
- 本机API/Admin/Worker/Scheduler使用 `huahuo-server:kb-search-dev`；四角色healthy，两个公开就绪端点200。migrate同镜像完成校验、退出0。API容器中两个集合的实际gRPC连接/重复就绪检查通过，没有模型调用。
- `.env` 只切换本轮索引配置和镜像标签；数据库实例、名称、凭据、服务密钥、Redis和OSS配置未重置，没有删除数据卷。没有备份、迁移或补算旧业务/向量数据。

证据：`.local/kb-refactor/database-reset.json`、`database-after.json`、`milvus-reset.json`、`cloud-consistency.json`、`container-milvus.json`、`runtime-start.log`。运行状态只证明本机Compose已切换；另一部署未代为发布，若继续使用该开发库，必须使用本分支的新Schema对应镜像，旧运行包不受支持。真实付费模型、真实解析供应商、Flutter运行时及远端部署发布仍未验证。

## 可执行复现

独立完整验收，不读开发 `.env`、不调用生产模型：

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration --milvus
docker compose config --quiet
git diff --check
```

这组集成测试已经通过正常业务 Service/HTTP 入口造数并执行真实 Milvus 写入和查询；不是直接向四表插假行模拟业务成功。运行时需要本机已有测试镜像，runner 只清理本次带所有权标签的临时容器，不删除数据卷。

开发库已完成受控初始化。后续可用正常 Note 创建接口提交 `parts.raw`（如 `# 数据库\n\nPostgreSQL 支持 MVCC。`），等现有任务成功，再调用笔记查询；资料使用既有 OSS 入库接口，等解析/关键词任务成功，再调用资料查询。使用真实模型的 Note 入库/Hybrid 查询仍需要本次范围之外的付费调用授权；资料解析如调用付费供应商也需单独授权，不能从本轮确定性替身测试推定已获授权。

三个能力可以独立调用：`analyzeDocumentStructure(content, options)`；`splitKnowledgeContent(content, mode, options)`（Note 注入真实 tokenizer，资料无需）；`indexChunks(records, dependencies)` 或纯关键词 `indexKeywordChunks(points, keywordIndex, options)`。业务代码和薄 Tool 使用同一核心，不引入第二个任务或 Agent 框架。
