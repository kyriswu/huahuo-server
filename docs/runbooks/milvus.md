# 知识库入库与检索

当前业务映射使用下列两个索引目标；底层能力按关键词、向量、混合检索封装，业务名称与引擎实现分开。复用现有 Milvus 连接及 `default` database。2026-11-16 另一专项按用户授权删除旧稠密向量集合且不备份，原名重建为 FP16；纯关键词集合保留，详见[模型切换验收](../acceptance/qwen37-vector-switch.md)。本次底层封装没有操作这些共享集合。

| 业务 | Collection | PostgreSQL 构建 / 分段 | 模型调用 |
| --- | --- | --- | --- |
| 真实 Note 正文 | `huahuo_kb_note_hybrid_chunks` | `kb_note_hybrid_builds` / `kb_note_hybrid_chunks` | qwen3.7-text-embedding-flash 原生1024维 / Float16Vector；qwen3.7-text-rerank |
| 文件 / 独立导入资料 | `huahuo_kb_keyword_chunks` | `kb_document_keyword_builds` / `kb_document_keyword_chunks` | Embedding、模型 tokenizer、Rerank 均为零 |

资料集合只有文本 analyzer、BM25 Function 和稀疏索引，没有 Dense 字段或占位向量。当前笔记的 BM25 与 Dense 位于同一条记录，默认原生 Hybrid Search + `RRFRanker(k=60)` 完成融合。现有业务默认查询仍访问它绑定的集合；底层也已提供分别访问关键词/向量集合后由应用融合的能力。知识图谱仍由标签关系驱动。

## 底层接口与后端替换

`src/lib/search-index/types.ts` 是不依赖Milvus SDK、业务表、Note/File枚举的契约：

| 能力 | 写入 | 召回 |
| --- | --- | --- |
| KeywordIndex | 文本、稳定ID、用户/工作区及来源标识；禁止占位向量 | searchKeyword |
| VectorIndex | 文本证据、稳定ID、来源标识和必填向量 | search |
| HybridIndex | 同一逻辑记录的文本和向量 | searchKeyword / search / hybridSearch；实现可以原生或组合 |

`IndexBinding`仅包含connectionId、逻辑index及可选namespace；数据库/Collection、Elasticsearch index/alias、SDK参数由具体适配器映射。`createSearchIndex`通过独立的keyword/vector/hybrid工厂选择能力，缺失提供器或能力不符明确失败。现有业务的`knowledgeIndex`是接线位置，默认创建Milvus关键词或原生混合适配器；业务快照、目标名称、构建/点ID算法与现有Schema保持。500/2000切片规则继续由业务快照/切分层负责，适配器只检查接线传入的存储上限与向量规格。

每次查询必须携带可信userId、workspaceId和已授权的pointIds；空集合拒绝执行。可选filter仅允许sourceIds、sourceTypes，并与必填范围取交集；底层不接受任意Milvus表达式或Elasticsearch DSL。当前sourceType是普通元数据字符串，不限定Note/File业务命名。未来扩展过滤字段时须同时定义其索引映射和校验，不能绕过上层PG归属、当前修订与published检查。结果的score只在同次召回中排序，不保证不同引擎或不同召回方式的分值可比较。

`src/integrations/search-index/milvus.ts`提供createMilvusKeywordIndex、createMilvusVectorIndex、createMilvusHybridIndex，共享一个驱动实现。可独立建立仅BM25、仅Dense、BM25+Dense三种技术Schema；纯向量集合不创建BM25 Function或稀疏索引。当前业务仍使用原来的两个集合，新增纯向量能力没有自动新增业务集合或部署配置。

### 应用层组合召回

下面是后端接线函数，不是面向用户的HTTP参数；providers由拥有连接配置的接线层提供：

```ts
import { createSearchIndex, type IndexFactories } from '../../src/lib/search-index/factory.js';
import { createCompositeHybridIndex } from '../../src/lib/search-index/composite.js';
import type { IndexBinding } from '../../src/lib/search-index/types.js';

function composeHybrid(keywordTarget: IndexBinding, vectorTarget: IndexBinding, providers: IndexFactories) {
  const keyword = createSearchIndex('keyword', keywordTarget, providers);
  const vector = createSearchIndex('vector', vectorTarget, providers);
  return createCompositeHybridIndex(keyword, vector, {
    keywordCandidates: 20, vectorCandidates: 20, rrfK: 60,
  });
}
```

组合实现分别召回、按稳定点ID去重并做RRF排名融合，不相加BM25/余弦原始分数；同一ID的证据正文冲突时拒绝。模型Rerank继续在候选授权和正文回查之后单独执行，融合本身不调用模型。上层也可以直接调用两个基础端口，选择自己的融合/重排策略。默认业务目前仍用Milvus原生混合；组合模式通过工厂显式接入，没有新增隐式切换或界面开关。

组合写入/删除不是跨引擎事务：等待两路结束，一路失败就拒绝成功，由现有PG构建发布和稳定ID重试控制可见性；不将超时/取消解释成远端回滚。组合查询一路失败也明确失败，不静默降级为另一种检索。组合实例拥有传入的两个适配器，close会处理两路；接线时不把它们同时交给别的生命周期拥有者。

### 未来Elasticsearch关键词适配器

关键词后端可独立替换为实现KeywordIndex的Elasticsearch适配器，向量后端仍用Milvus，再由组合实现融合。适配器负责text/analyzer/BM25映射、过滤条件转换、批量逐项错误和写入可见性；业务服务不传原生DSL。Elasticsearch默认支持BM25，但分词与评分配置仍需迁移验收，见[官方Similarity说明](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity)。

端口要求稳定ID幂等写入/删除，成功返回后后续搜索能观察到结果，批量部分失败必须拒绝。本次用Milvus Strong验证这一语义；未来ES适配器需检查[Bulk逐项错误](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-bulk)，并以[refresh=wait_for或等价策略](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/refresh-parameter)满足搜索可见性。更换后端时仍需准备物理索引、存量迁移和验证；本次没有引入ES SDK/服务，也没有声称ES实测通过。

本次验证：914项unit/contract、48项定向真实隔离PG/Redis/Milvus集成、类型/Lint/构建通过。包含只有关键词方法的class测试适配器接入真实PG任务/发布/查询，以及真实独立关键词/向量集合的应用层融合；模型/解析端点为替身。无Milvus环境时新增底层三项集成明确跳过。日志在`.local/search-index-refactor/`，本次临时容器及自有测试集合已清理，未发布或重启业务服务。

## 入口与身份

- 正常 Note 创建/编辑保存 `parts.raw` 后，在同一个业务事务创建构建、Task、Outbox；只有真实 Note 可以走混合流程。
- `POST /api/v1/rag/ingestions`：OSS URL 文件入库，沿用现有文件名、MIME、幂等键与任务查询契约。原解析器、图片 OSS 转存、OCR 和 enriched Markdown 不变；解析后的资料走纯关键词流程。
- `/api/v1/text-ingestions`：独立导入业务正文没有变成 Note，所以接入资料关键词流程。只有 MANUAL_INPUT 可以编辑原文；FILE_UPLOAD 复用现有解析；其它未接通渠道继续返回不可用，不伪造正文或成功。
- `POST /api/v1/kb/notes/query`：笔记 Dense / Keyword / Hybrid。
- `POST /api/v1/kb/documents/query`：资料 BM25。
- 仍被 Agent 消费的 `POST /internal/v1/rag/query` 与通用用户入口 `POST /api/v1/rag/query` 使用同一查询实现；未指定 `sourceType` 时选择 Note。`sourceType=file|text` 由业务绑定资料关键词流程，即使请求包含 `mode=hybrid`，实际返回的 `mode` 也明确为 `keyword`，不会调用模型。
- 已移除无人消费的 `/api/v1/huahuo_rag/query` 别名与可提交任意正文覆盖 Note 索引的旧入口。业务 ID 不能被用来选择任意数据库或集合。

当前在途统一鉴权实现从受信任的网关/Agent身份头取得用户与会话，数据库再次验证用户、会话、技术归属、删除状态及当前正文修订。调用方接入边界见[身份契约](gateway-auth.md)。公开RAG与 `/internal/v1/rag/query` 在onRequest阶段加载同一套请求级运行配置快照；后台更改对后续请求生效，在途请求保持其原快照。

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
| 纯关键词批量写入、超时、局部失败 | `lib/search-index/keyword-indexing.ts` / `indexKeywordChunks` |
| 独立 Embedding + Vector 入库 | `lib/rag-indexing/index.ts` / `indexChunks` |
| 目标、模型和输入预算快照 | `modules/kb/profile.ts` |
| 统一业务编排、发布与精确清理 | `modules/kb/jobs.ts` / `KnowledgeIndexJobs` |
| Milvus Schema / BM25 / Dense / Hybrid | `integrations/search-index/milvus-schema.ts`、`milvus.ts` |
| 薄 Tool | `tools/document-processing.ts` |
| 查询、授权、原文回查、最终复核 | `modules/rag/query-service.ts` |

资料按自然段、句界、字符窗口切分，上限 2000 Unicode 码点、零重叠。笔记复用 H1–H6 结构；无标题时按自然段确定临时父层范围，短章节保持完整，长章节在范围内切分，单块上限 500 码点，同父层目标重叠约 50 字。核心区间不重叠，合起来覆盖有效正文；范围始终是保存原文的 UTF-16 半开区间。标题前缀不是原文，不能冒充原文坐标。嵌套 TOC 只遍历互斥正文范围，避免重复索引。没有独立的章节 Parent 实体。

完整正文按正文修订保存在业务 Note 原文、独立导入原文或资料 canonical 对象中。四张索引表不保存 `content`、`embedding_text` 或向量；保存构建/修订/授权/目标/配置快照、顺序、范围、哈希、Milvus 点 ID 及状态。切片正文仅写 Milvus；查询必须按业务原文位置、哈希和有效修订复核，不能直接信任索引文本。

## 百炼 Qwen 与配置

按[同步 Embedding API](https://docs.bailian.console.aliyun.com/zh/model-studio/text-embedding-synchronous-api)和[Rerank API](https://docs.bailian.console.aliyun.com/zh/model-studio/text-rerank-api)使用 DashScope 原生请求：

- Embedding：`/services/embeddings/text-embedding/text-embedding`，`input.texts`、`parameters.text_type`；文档用 `document`，查询用 `query`。Flash 默认原生1024维，不做裁剪、补零或投影；逐条验证返回维度和 `text_index`，按原输入顺序复位。HTTP批次最多20条，较大的历史后台批次在新构建快照中限制为20。
- Rerank：`/services/rerank/text-rerank/text-rerank`，`input.query/documents`、`parameters.top_n`，从 `output.results` 读取索引和分数。只重排已授权的候选；拒绝重复/缺失索引和异常分数，失败时沿用已授权的召回顺序，最后再次校验当前正文修订。
- 存储为 Milvus `Float16Vector`，1024维，每条原始稠密向量2048字节；写入和查询都显式编码为 IEEE FP16。原始向量字节数减半不代表整个 HNSW/集合内存减半。Dense索引保留HNSW/COSINE、M=16、efConstruction=128；BM25/RRF策略保留。
- 不再加载旧模型 tokenizer。托管模型没有随接口提供匹配的本地 tokenizer，这里用 UTF-8 字节数加16作为保守输入预算，上限128000；保存的 `token_count` 是预算估计，不是计费token数。真实计量只信供应商 usage。500码点切片、2000字符查询及原文offset规则保持。

```env
# 本机执行始终使用业务空间公网Host，即使APP_ENV=test或本地分支为test/main。
RAG_EMBEDDING_BASE_URL=https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1
RAG_EMBEDDING_MODEL=qwen3.7-text-embedding-flash
RAG_EMBEDDING_DIMENSIONS=1024
RAG_EMBEDDING_PROFILE=qwen3.7-text-embedding-flash-1024-fp16
RAG_RERANK_PROVIDER=http
RAG_RERANK_BASE_URL=https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1
RAG_RERANK_MODEL=qwen3.7-text-rerank
MILVUS_DATABASE=default
KB_NOTE_HYBRID_COLLECTION=huahuo_kb_note_hybrid_chunks
KB_DOCUMENT_KEYWORD_COLLECTION=huahuo_kb_keyword_chunks
```

云端test/main运行使用已开通的北京业务空间私网Host，形如 `https://ws-example-vpc-example.cn-beijing.maas.aliyuncs.com/api/v1`。本地与云端分别供给ENV，不按APP_ENV或Git分支自动推断网络位置，不做私网失败后自动走公网。两个模型共用本次授权的百炼Key，真实值只放私密ENV。云端配置片段已准备在忽略提交且权限0600的 `.local/qwen37-cloud-model.env`；发布时与现有云端ENV合并，不能拿本机整份ENV覆盖云端配置。

既有Note重排预算仍为后台保存的200ms；它独立于30秒HTTP超时。若真实模型超过预算，会回退召回顺序，`Server-Timing`和脱敏日志会记录fallback；本轮未擅自修改此设置，也未进行真实模型延迟或效果验收。

上面的ENV只描述连接/模型规格/部署路径和集合绑定。召回候选、RRF、检索并发、Embedding索引批次/并发/超时/重试、重排超时/Note预算和原生文字上限在Admin「RAG 与检索」，Note索引开关在「功能开关」；不再使用这些参数的旧ENV。Embedding和Rerank端点/模型/凭据在部署环境维护，旧供应商配置已退役。资料关键词和Note纯关键词完全不调用这两个模型或模型tokenizer。

Milvus SDK 2.6.17连接及就绪状态按目标与当前检索参数复用，应用闸门与SDK池max默认50，可在后台设1–50；min不超过2，排队最多32。调参创建新客户端，在途查询沿用旧实例，结束后释放已淘汰客户端。索引构建沿用持久化快照。新建集合幂等，Sparse使用SPARSE_INVERTED_INDEX/BM25，Dense使用HNSW/COSINE（M=16、efConstruction=128）。SDK数值Strong=0的默认值问题以明确枚举名称处理。启动和正常任务不DROP集合或清库。

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

集成 runner 只启动本项目独立 tmpfs PostgreSQL/Redis/Milvus，不读取开发 `.env`；用明确标注的保守输入预算与确定性 Embedding 替身验证两条正常业务入口、中文/英文/混合检索、App/Agent 契约、局部编辑、部分失败、租约丢失、恢复、删除与越权。真实模型和真实解析供应商没有通过 Mock 测试被声称验证。

### 使用云端 Milvus 验收

本地 Docker 资源不足时，可明确选择已有云端 Milvus。PostgreSQL/Redis 仍由 runner 创建独立临时容器；不会改用 `.env` 中的 SQL 数据库或 OSS/模型服务。

```bash
# 显式加载连接配置；runner 仅取 MILVUS_ADDRESS/USERNAME/PASSWORD/TLS。
node --env-file=.env scripts/integration.mjs --milvus-cloud
# 本机需要 HTTP CONNECT 代理时，单独指定测试进程使用的地址。
TEST_MILVUS_GRPC_PROXY=http://127.0.0.1:1082 \
  node --env-file=.env scripts/integration.mjs --milvus-cloud
```

此模式忽略业务的 MILVUS_DATABASE 和集合绑定，随机创建 `huahuo_test_<32位十六进制>` database 及同批次两个专用 collection。账号需具备新建/删除测试 database 和集合的权限。连接、快照、写入、检索、Schema 检查均使用该测试目标；缺少云端隔离参数会失败，不回退到业务集合。

测试结束后，先核对 database 的服务端 ID、创建时间和集合白名单，再删除本轮新建目标并确认消失；发现身份不符或额外集合则保留并报清理失败。异常退出的本轮库名会留在日志，不自动接管或清理历史测试库。`--milvus` 与 `--milvus-cloud` 互斥。

测试进程不继承普通 gRPC/HTTP 代理；仅使用显式 `TEST_MILVUS_GRPC_PROXY`。容器里的 `host.docker.internal:1082` 与宿主机的 `127.0.0.1:1082` 地址含义不同，不为测试修改真实 `.env`。远端模式输出详细用例进度，单用例上限 30 秒；业务 SQL 和 SDK 超时没有放宽。

本阶段验收与实际重置结果见 `docs/acceptance/knowledge-base.md`；运行和命令原始证据在忽略提交的 `.local/kb-refactor/`。旧切片表、旧视图、旧 Collection 路由与旧分路索引实现均已由新代码替换，不双写、不兼容回读、不补算旧向量。

## 显式重建稠密集合

`scripts/rebuild-note-vectors.mjs` 是手动维护工具，不接入启动、迁移或自动发布。默认只读计划，执行必须指定 `--discard-without-backup --expected-id <实际旧集合ID>`。它仅重建ENV绑定的Note集合，拒绝production、与资料集合别名、非稠密集合、身份变化及已有PG构建/切片/未完成索引任务；不会导出正文/向量或DROP database。非空业务安装须先评估停止写入和从原文重新索引的独立计划，不能通过清空PG元数据绕过检查。本次真实目标PG和Milvus都为空，不需要历史回填；只删除了原来的空稠密集合。

执行前停用或退役旧模型写入方，确认没有索引任务；若重建后创建/验收失败，不重复删除，使用新代码的幂等schema创建恢复。切换后不能把旧模型应用重新接到同名FP16集合。新旧schema不兼容时正常应用只报错，不自动重建。迁移历史保持冻结。
