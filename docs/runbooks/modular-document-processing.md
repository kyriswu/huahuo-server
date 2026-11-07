# 文档结构、子 Chunk 与 RAG 入库模块化

独立多来源文本导入现使用 `TextIngestionJob`，与既有真实 Note、文件文档分别保存，但共用下述切分和索引能力。新记录的接口、原文编辑规则及恢复机制见[独立文本导入](text-ingestion.md)。

本手册描述当前唯一的文档处理架构。文件向量目标统一命名为 `huahuo_chunks`，Note 正文使用 `huahuo_manual_text`；代码、Profile、脚本和配置没有按架构迭代号并行运行的路径。模型版本、依赖版本、正文修订和供应商文件名保持真实含义。

## 1. 真实复用点与边界

| 位置 | 本轮用途 |
| --- | --- |
| `src/modules/rag/jobs.ts` / `RagIngestionJobs.parse()` | 复用文件下载、现有 MinerU 适配器及明确 Mock 模式；解析成功后可从已保存正文恢复 |
| `src/modules/rag/adapters/mineru.ts` | 复用现有解析服务，未新建 PDF 解析器或改写阅读顺序 |
| `src/modules/rag/mineru-bindings.ts` | 复用图片、OCR、稳定 `asset://` 引用及 enriched Markdown；生产不读取 `layout.json` |
| `src/modules/ingestion/document-parser.ts` / `parseDocument()` | 手动文本入口只处理既有 UTF-8 文本/Markdown 输入，保留原文，不调用 PDF 服务 |
| `src/modules/ingestion/service.ts` / `DocumentIngestionService` | 复用 Note 身份、工作区权限、原始 revision、幂等及自有正文/Chunk 表 |
| `src/modules/tasks` | 复用 Task、Outbox、BullMQ、attempt/lease、重试与清理调度 |
| `src/modules/rag/adapters/embedding.ts` | 复用当前 Qwen OpenAI-compatible 请求；按 provider index 校验并还原向量顺序 |
| `src/modules/rag/adapters/milvus.ts` | 复用稳定 upsert、Dense/BM25/Hybrid、scope、schema 校验和连接实现 |
| `src/modules/storage` / `src/integrations/object-storage` | 复用已有源对象与解析产物的存储边界，不创建第二套图片资产体系 |

两类来源分别是 **知识库文档**（`knowledge_document`，后端 `source_type=file`）和 **Note 正文**（`source_type=note`）。OSS 上传的 Markdown 属于 file，保存到 Note 的 Markdown 属于 note。代码中的 `manual-text` Profile 处理 Note 正文，来源判定与是否人工输入无关。

## 2. 三个核心类库与薄 Tool

| 能力 | 入口与输入 | 输出 / 不负责的事项 |
| --- | --- | --- |
| 章节分析 | `src/lib/document-processing/structure.ts`，`analyzeDocumentStructure(content, options?)` | `DocumentStructure`：同一次解析生成 `toc`、嵌套 `sections` 和不重叠的 `ranges`；无数据库、PDF、Embedding 或向量写入 |
| 子 Chunk | `src/lib/document-processing/splitter.ts`，`splitTextIntoChunks({content,format,options,structureHints?})` | `ChunkDraft[]`；不生成业务 ID，不读取 TOC 表，不调用结构分析，不保存数据 |
| 通用索引 | `src/lib/rag-indexing/index.ts`，`indexChunks(records, dependencies)` / `deleteVectors(boundAdapter, selector)` | 部分成功结果、逐条状态、错误码及可重试标记；不解析、不切分、不选择业务库、不修改任务状态 |
| 薄 Tool | `src/tools/document-processing.ts`，`createDocumentProcessingTools(dependencies)` | `huahuo_analyze_document_structure`、`huahuo_split_text_chunks`、`huahuo_index_chunks`；仅验证输入、调用同一核心及使用注册目标 |

依赖方向是 `业务 Service/Worker → 类库` 和 `Tool → 同一类库`。核心不依赖 Tool、Agent、具体 Service、PostgreSQL 或 Milvus SDK。当前只有 LangChain 子 Chunk 切分路径。没有引入新 Agent 框架、跨库 ORM、动态 DSL、任务平台或 `ParentDocumentRetriever`。

索引 Tool 只接收 `{targetId,records}`；应用通过 `ReadonlyMap<string,IndexDependencies>` 注入已绑定的适配器。调用方不能传连接、数据库凭据或任意 Collection。其他工具准备好的合法索引记录也能独立使用核心，无需携带本项目业务字段；本项目业务编排会补齐自己的身份元数据。

## 3. `parent_id` 的唯一含义

`parent_id` 表示整篇来源记录。临时 `sectionId`、`parentSectionId`、标题锚点或旧章节 Chunk ID 都不能成为该字段的值。

| 来源 | 真实业务记录 | Chunk 表 | `parent_id` 的数据库映射 | `source_revision` |
| --- | --- | --- | --- | --- |
| file | `rag_ingestion_versions.id`，一份完整解析/文本内容记录 | `rag_child_chunks` | `GENERATED ALWAYS AS (version_id)`，普通索引关联 `rag_ingestion_versions` | 已保存 canonical 正文 SHA-256 |
| note | `notes.note_id`，整份正文所属 Note | `document_ingestion_chunks` | `document_id`，普通索引关联 `notes` | 当前块按 `index_status` 可见 |

`document_id`、`version_id` 为现有关系字段，生成列做确定映射，不能双写后独立变化。两类业务各自保留普通关联ID和业务归属校验，不创建物理外键或跨两张表的公共假外键。

业务来源用 `source_type + parent_id` 标识；具体正文和索引再包含 revision、正文 hash、处理配置。file Chunk Key 由 `fileChunkKey()` 对来源、整篇记录、正文修订、配置和 ordinal 生成稳定 hash。Note 块使用任务确定的 Milvus 点 ID，未变化的块直接沿用已写入的 ID。相同 ID 在不同业务不会互相覆盖。

不生成章节 Parent。当前初始化 Schema 不包含章节 Parent 表、章节块关联字段或旧算法兼容入口。现有查询响应返回整篇 `parentId`、Child evidence 和 `context:null`，不执行章节 Parent JOIN 或回溯。

## 4. 正文、TOC、Chunks 和状态的存储

| 数据 | file | note |
| --- | --- | --- |
| 完整正文 | 复用对象存储 `canonical_content_uri` / `enriched_canonical_markdown_uri`；纯文本输入另存 `canonical_content` | `note_index_jobs.canonical_content` 精确保留本次输入；来源可为请求正文或 Note 最新 raw revision |
| 原始解析 Markdown | `raw_markdown_uri`，保持原始解析结果 | 不调用 PDF 解析、不生成该产物 |
| TOC | `rag_ingestion_versions.toc`、`toc_status`、`toc_error`，包含内部 UTF-8 对象范围 | `note_index_jobs.toc`、`toc_status` |
| 临时章节树 | Markdown 章节边界用于切分 | Markdown 章节边界用于切分 |
| Child 正文 | `rag_child_chunks.content` / `embedding_text`、offset、hash、token 数 | `document_ingestion_chunks.text` / `embedding_text`、offset、hash、token 数 |
| 处理与路由 | `processing_snapshot`、`processing_info`、既有任务/索引状态 | `processing_snapshot`、既有 version/task/index/cleanup 状态 |
| 图片和 OCR | 复用原 Asset Manifest、自有 OSS 和稳定 `asset://`；不做图片 Embedding | 原文中的稳定引用继续作为文本处理，不建立新资产体系 |

两类原文均不因切分被 trim、换行规范化或覆盖。空白文本不会产生空 Chunk；既有保存/入库接口对不可索引的空白输入明确失败。纯文本既有字符/字节上限继续生效，超限失败，不能静默截断。

## 5. LangChain、模型 tokenizer 与位置

实际锁定安装版本为 `@langchain/textsplitters@1.0.2`、`@huggingface/tokenizers@0.2.0`、`markdown-it@15.0.3`。LangChain 只位于内部适配器，不把其 Document 类型暴露给业务。递归分隔和 `lengthFunction` 的使用方式参见 [LangChain 官方文档](https://docs.langchain.com/oss/javascript/integrations/splitters/recursive_text_splitter)。

实时模式的 token 计数使用 Qwen 模型自己的本地 tokenizer 文件，来源固定为 [Qwen3-Embedding-8B revision c5446774f12cc9eadeb82c01d493043cf1795a23](https://huggingface.co/Qwen/Qwen3-Embedding-8B/tree/c5446774f12cc9eadeb82c01d493043cf1795a23)，无需下载模型权重。

| 文件 | 本机位置 | SHA-256 |
| --- | --- | --- |
| tokenizer.json | `.local/tokenizers/qwen3-embedding-8b/tokenizer.json` | `83cdf8c3a34f68862319cb1810ee7b1e2c0a44e0864ae930194ddb76bb7feb8d` |
| tokenizer_config.json | `.local/tokenizers/qwen3-embedding-8b/tokenizer_config.json` | `2f58f4bbd7bbce15d683f525954ef3a92cd82f5e06415a9c513859bf8ab72436` |

`loadModelTokenizer()` 从明确配置的两个文件加载，校验快照 hash，并以 `add_special_tokens=true` 计算实际输入；不回退字符估算。tokenizer ID 包含模型、实现版本和两个文件 hash。文件缺失、模型不匹配、hash 改变或配置不合法时明确失败。正式部署需把相同文件挂到各实例配置路径；`.local` 文件本身不提交 Git、不进入运行镜像。

默认正文目标为 500 tokens，最终 Embedding 上限为 800，overlap 目标为 64。模型输入限制通过 `RAG_TOKENIZER_MAX_INPUT_TOKENS` 配置。file 使用 `RAG_CHILD_*`，note 使用 `MANUAL_TEXT_*`，均校验 `0 <= overlap < target <= maxEmbeddingTokens <= tokenizer.maxInputTokens`。Note 正文以 300 字为目标，附近找不到换行或句末时可延长到 500 字。Note 的字符硬上限是 500，文件是 2,000，均按 Unicode 码点计，包含重叠和空白。两个限制同时生效，字符上限也由各自的 PostgreSQL Chunk 表约束。

长度字段含义固定：`token_count` 对正文，`embedding_token_count` 对最终模型文本；标题、补充表头和图片标识纳入后者。生成的前缀可缩减，原正文不能截断。测试中的 codepoint counter 必须处于明确 Mock/test 模式，不能描述成 Qwen tokenizer 的真实验证。

结构和 offset 处理：

- Markdown AST 识别标题、重复标题、跳级标题、代码围栏。代码内的 `#` 和开头的 YAML front matter 不产生标题项。读取目录可以加入标题前的「开头」入口，无标题的内容使用一个「正文」入口。
- 嵌套章节范围可能包含子章节；切分只遍历 `DocumentStructure.ranges`，该范围序列按原文顺序、不重叠且覆盖全文，避免嵌套重复索引。
- LangChain 递归拆分使用真实 tokenizer 长度；分隔符包括中文句号、问号、叹号、分号、逗号及段落。硬拆按 Unicode grapheme 边界处理，不拆坏 emoji。
- 原文 offset 为 UTF-16 半开区间。以单调源位置映射 LangChain 输出，每个 Chunk 都满足 `content === source.slice(source_start, source_end)`。过长的纯空白范围可跳过索引，按节读取始终使用完整原文快照。
- overlap 以同一范围内的 token 目标生成，不跨明确章节硬拼接。表格行、代码行和图文信息优先作为分隔/context，超限时允许继续拆分；稳定图片引用可补到 Embedding 文本，生成前缀不冒充原文位置。
- Embedding 文本清理临时 URL、base64 和二进制引用，正文仍保持完整；没有可靠 PDF 页映射时不按 Markdown 行号猜页码。

## 6. 业务编排、目标绑定和发布

### PDF / OSS 文件

`POST /api/v1/rag/ingestions` → `RagIngestionRepository.create()` 固定任务/配置快照 → `RagIngestionJobs` 下载或复用源对象 → 复用现有解析和图片/OCR绑定 → 保存完整 canonical Markdown → 章节分析 → TOC 保存与带提示的 Child 处理 → 自有 Chunk 表 → 通用 `indexChunks()` → 业务状态发布。

需要章节提示时，分析一定先完成。之后 TOC 保存与 Child 处理互不依赖。分析失败时，不带提示切分，`toc_status=failed`，实际提示使用情况进入 `processing_info` 和 Chunk metadata，配置 hash 也反映实际方案。

TOC 和索引分别记录状态。`processingComplete` 在两者均为 ready 时为 true。已完成索引的文档可通过 `POST /api/v1/rag/ingestions/:jobId/retry-toc` 仅补偿目录。章节读取使用 `GET /api/v1/rag/ingestions/:jobId/sections/:sectionId`，从版本化 canonical 对象读取该节 UTF-8 范围。文件删除入口为同一路径的 `/delete`，删除会阻断读取并安排定向清理。

### Note 正文

启用 Note 正文 Profile 后，现有 Note 创建和 raw 编辑在保存 `note_part_revisions` 的同一事务中，通过 `ingestNoteInTransaction()` 自动创建正文快照、索引任务、input和outbox；HTTP重放不会重复排队。标题等元数据编辑不重复排队，也不会使原文修订未变的pending任务失效。用户或业务仍可显式调用 `POST /api/v1/workspaces/:workspaceId/notes/:noteId/document-ingestion`，返回`jobId`及processing状态，不等待Embedding。

该流程不检查 `sourceKind=manual`；上游生成的内容只要经 Note 业务入口保存到 raw，也使用同一套笔记索引。现有导入支持传入文本/Markdown及DOCX文本提取；外链地址目前只保存来源信息，ASR和图片LLM的正文生成/回写未接入，不能据此宣称这些上游能力已完成。

`ManualTextIngestionJobs` 从既有队列读取完整原文并保存 TOC，再用同一子 Chunk 核心切分，写入 `document_ingestion_chunks` 并调用通用索引。Worker 按 Note 维护当前块，先撤下失效点，再逐批写入新点并标记就绪。入库详情通过 `GET .../document-ingestion/:jobId` 返回目录，按节读取使用同一路径下的 `/sections/:sectionId`。TOC 就绪后可读取正文，即使向量仍在生成或等待重试。

手动文本目标必须显式启用并配置，不从文件目标静默推断：

```env
MANUAL_TEXT_ENABLED=true
MANUAL_TEXT_MILVUS_DATABASE=default
MANUAL_TEXT_MILVUS_COLLECTION=huahuo_manual_text
MANUAL_TEXT_TARGET_TOKENS=500
MANUAL_TEXT_MAX_EMBEDDING_TOKENS=800
MANUAL_TEXT_OVERLAP_TOKENS=64
```

以上为启用示例；默认保持`MANUAL_TEXT_ENABLED=false`，避免未配置时误写。缺目标返回明确错误。没有新增第二台Milvus或第二个PostgreSQL实例。

### 向量目标与现有查询

file使用显式`MILVUS_DATABASE`、`MILVUS_COLLECTION`；note使用其单独配置的database/collection。连接由现有全局`MILVUS_*`提供，并生成无凭据的connection ID。目标绑定包含connection ID、database、collection，本阶段不启用partition；请求不能自行选择它们。

文件业务目标为阿里云 Milvus 的 `default/huahuo_chunks`，Note正文为同实例的 `default/huahuo_manual_text`，仍需显式启用。目标SQL基线切换不更改这些Collection或其Schema，不要求付费重新生成旧向量。现有 `huahuo` 库的新 `public` 已切换统一模型，旧Schema原样封存；本轮未做真实文件RAG入库，既有Milvus样本不能当作新业务正文已入库的证据。

配置目标绑定（不包含凭据；完整文件入库与连接配置分开验收）：

| 标识 | 实际值 |
| --- | --- |
| connection ID | `primary-29a8afa5e57541d5` |
| 主实例地址 | `c-850eb68e967e1f3a.milvus.aliyuncs.com:19530` |
| file database / Collection | `default` / `huahuo_chunks` |
| note database / 配置Collection | `default` / `huahuo_manual_text` |
| Note自动入库开关 | 默认 `MANUAL_TEXT_ENABLED=false`，部署值以根 `.env` 为准 |
| partition | 未配置；本阶段不支持任意partition路由 |

两类目标共享同一实例和database，通过明确Collection及`source_type`过滤区分；并非两套物理“Milvus库”。

现有三个查询入口保留：`/api/v1/rag/query`、`/api/v1/huahuo_rag/query`、`/internal/v1/rag/query`。`sourceType=file`或省略继续文件路由，`sourceType=note`走已保存的Note目标快照。调用方只传业务查询参数，不能传任意连接/表名。用户JWT仍提供当前身份；internal入口另需方向Service Key。Server执行最终工作区、来源状态和版本权限校验。

## 7. 修订、幂等、恢复和删除

`FileProcessingSnapshot`位于`src/modules/rag/processing-profile.ts`，`ManualTextSnapshot`位于`src/modules/ingestion/profile.ts`。快照固定profile、分析/保存选项、切分参数、tokenizer文件hash、Embedding模型/维度及目标，不包含密钥。核心只接收所需参数，不接收整份业务Profile。

同一来源/整篇ID/修订/配置重复处理使用相同稳定Chunk ID；逻辑版本创建使用事务级advisory lock，防止不同传输幂等键并发创建重复任务。索引按快照固定的批次/并发/超时/重试执行；当前执行中的写入重试复用向量，Worker重建后可通过业务层`embedding-cache.ts`复用现有对象存储阶段产物。缓存只含向量，键包含来源作用域、模型、维度和输入hash，不写PG或日志；损坏缓存修复、大小限制和流释放均有测试。部署存储可为`rag/index-artifacts/`配置生命周期，缓存失败会显式失败，不冒充索引完成。逐批成功状态由业务库保存，任务恢复跳过已ready的Chunk。超时停止后续排队批次，防止未响应适配器累积无界请求。

文件更新先构建完整新索引，再切换可见版本并清理旧点。Note 更新按当前块执行差分计划，先撤下失效点，再逐批开放 ready 的块。

Note Worker 检查正文来源、工作区和任务 lease 后更新块。Note 删除通过原任务系统清理当前点。文件同样检查删除状态和任务lease，较旧任务不能覆盖已发布较新版本。

任务快照缺失时不能猜测索引位置：明确失败并记录需修复的阶段，不以当前默认配置替代固定路由。connection ID不再匹配或目标不可用时失败关闭。正文、修订和既有索引仍属于业务数据，不通过兼容路由掩盖配置缺失。

`deleteVectors()`要求显式ID集合或非空scope，绑定目标不可变，ID分批默认128。当前Milvus scope删除至少要求`source_type + parent_id + source_revision`，字符串值经过转义；不接受任意SQL或无范围清空。业务库与Milvus没有跨库事务，用阶段状态、稳定upsert、发布检查和补偿恢复。

## 8. 最终数据库基线

数据库仅使用 `migrations/0001_initial_schema.sql` 初始化，不保留旧迁移链、升级分支或旧表别名。当前Schema直接定义：

- 统一身份：`users`、`user_identities`、`user_sessions`、`refresh_tokens`和`user_agreement_acceptances`；用户资料与登录身份分离，仅active用户可进入用户业务请求。
- 文件记录：TOC及其独立状态、处理快照、实际处理信息、删除与清理状态。
- 文件Child：整篇`parent_id`生成列、普通查询索引、`source_type`、`source_revision`和最终Embedding token数。
- Note 索引状态保存当前切块对应的正文和待清理点。Note 任务保存正文快照、TOC 和处理配置。块保存 Note ID、原始切点、重叠覆盖范围、Embedding 文本和索引状态。
- `rag_chunks`只读View表示文件Child；章节树仅作为临时结构提示，不存在持久化章节Parent表、章节关联列或回溯路径。
- 所有关联为普通ID；保留主键、唯一、NOT NULL、CHECK及必要查询索引，不创建物理外键或模拟外键触发器。规范见[RDS关联键](rds-relations.md)。

原阿里云 `huahuo` 库的统一模型切换属于上一轮验证，完整证据见[RDS基线验收](rds-relations.md)。本次 TOC 和字符约束直接进入唯一初始化基线，应用到新的空数据库即可。现有库的旧基线 checksum 需要通过单独的环境切换处理。

SQL旧数据完整保留在封存Schema，新 `public` 没有复制产品用户或会话。Milvus与OSS未清理，既有索引样本不会进入当前业务查询；后续仍须使用受控用户、来源和明确目标验证真实入库与逻辑数量。本轮健康与JWKS检查不等于完整文件RAG链路验收。

## 9. 独立调用与复现

先在Server根目录执行`pnpm build`。以下JavaScript可放入`node --input-type=module`执行，不需要Tool协议、数据库或Agent。

```js
import { analyzeDocumentStructure } from './dist/lib/document-processing/structure.js';
const body = '# 标题\n\n正文\n\n## 小节\n\n内容😀';
const structure = await analyzeDocumentStructure(body, { format: 'markdown' });
console.log(structure.toc, structure.ranges); // 临时关系不持久化为Parent
```

```js
import { loadModelTokenizer } from './dist/lib/document-processing/tokenizer.js';
import { splitTextIntoChunks } from './dist/lib/document-processing/splitter.js';
const tokenizer = await loadModelTokenizer({
  model: 'Qwen/Qwen3-Embedding-8B',
  tokenizerPath: '.local/tokenizers/qwen3-embedding-8b/tokenizer.json',
  tokenizerConfigPath: '.local/tokenizers/qwen3-embedding-8b/tokenizer_config.json',
  maxInputTokens: 32768,
});
const body = '  原文保留\r\n重复😀内容。\r\n重复😀内容。  ';
const drafts = await splitTextIntoChunks({ content: body, format: 'text',
  options: { targetTokens: 500, maxEmbeddingTokens: 800, overlapTokens: 64, targetSourceChars: 300, maxSourceChars: 500,
    respectSections: false, tokenizer } }); // 不传结构提示也可独立执行
console.log(drafts.map(d => [d.ordinal, d.source_start, d.source_end, d.embedding_token_count]));
```

通用入库离线示例使用明确的测试适配器；下面的字符计数/合成向量只验证接口，不代表真实Qwen或Milvus调用：

```js
import { indexChunks, deleteVectors } from './dist/lib/rag-indexing/index.js';
const store = { target: Object.freeze({ connectionId: 'offline-test', database: 'test', collection: 'test' }),
  async upsert(rows) { console.log('test upsert count', rows.length); },
  async delete() {} };
const result = await indexChunks([{ id: 'external-tool-stable-key', embeddingText: '准备好的内容',
  metadata: { parent_id: 'whole-item', source_type: 'external-demo', source_revision: 'r1' } }], {
  tokenizer: { id: 'explicit-test-counter', model: 'test-model', maxInputTokens: 100,
    count: text => [...text].length },
  embeddingAdapter: { model: 'test-model', dimensions: 2,
    async embed(texts) { return texts.map(() => [1, 0.5]); } },
  vectorStoreAdapter: store, options: { batchSize: 16, concurrency: 2, timeoutMs: 1000, maxRetries: 0 },
});
console.log(result.items);
await deleteVectors(store, { ids: ['external-tool-stable-key'] });
```

薄Tool通过`createDocumentProcessingTools({tokenizer,indexTargets:new Map([['registered-target',dependencies]])})`创建。结构Tool可单独执行；切分Tool注入tokenizer并调用同一`splitTextIntoChunks`；索引Tool用`registered-target`绑定上述或应用正式适配器，不接受任意连接参数。

业务API示例：使用Server当前登录得到的JWT，并替换真实文件URL、workspaceId和noteId。

```bash
curl -X POST http://127.0.0.1:3000/api/v1/rag/ingestions \
  -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' \
  -d '{"ossUrl":"https://<允许的OSS域名>/example.pdf","fileName":"example.pdf","mimeType":"application/pdf","idempotencyKey":"pdf-modular-demo"}'
# GET /api/v1/rag/ingestions/<返回jobId> 查看TOC和各阶段状态

curl -X POST "http://127.0.0.1:3000/api/v1/workspaces/$WORKSPACE_ID/notes/$NOTE_ID/document-ingestion" \
  -H "Authorization: Bearer $USER_JWT" -H 'X-Idempotency-Key: manual-modular-demo' \
  -H 'Content-Type: application/json' \
  -d '{"content":"  完整原文\r\n中文😀\r\n  ","mimeType":"text/plain"}'
# GET 同一路径查看版本；任务进度沿用现有Task接口
```

真实业务流程需要同一版本的schema、运行代码、tokenizer文件以及已注册Milvus目标；不能拿旧运行镜像的响应作为新实现验收。未授权时不调用生产付费解析/Embedding/Rerank服务。

## 10. 验证证据及当前边界

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
node scripts/verify-rag-fixture.mjs /Users/kyriswu/Downloads/c8d85ccd-acc0-4cd2-a48c-b23f7efcd241
git diff --check
```

测试必须区分：核心/Tool Mock、真实临时PG/Redis、真实本地tokenizer/文件fixture、真实供应商网络调用。`.local`验收输出不包含凭据、完整向量或真实用户正文，不把历史模型调用当作本次新链路通过。

本地Fixture历史证据（2026-11-04）记录238张图片资产、235个Markdown引用、3个orphan、1002条OCR且全部保留为unresolved OCR，91个临时章节范围、0个章节Parent、152个Child。它验证本地绑定和实际Qwen tokenizer，不调用供应商网络，也不代表新SQL库已有这些业务记录。Child数量由固定正文、切分配置和tokenizer决定，不凑固定数量。

上一轮统一用户基线的验收记录：

| 检查 | 本次结果 |
| --- | --- |
| typecheck / lint / build | 本次全部通过 |
| unit / contract | 27文件229项通过 |
| 独立临时PG/Redis integration | 10文件115项通过；外部服务按场景显式Mock |
| 唯一初始化Schema | `0001_initial_schema.sql`真实应用至新 `public`；checksum一致、全库FK0，重放`applied=[]/current=1` |
| 开发RDS目标与现状 | 仍原 `huahuo`；旧Schema封存为`initialization_backup`，58表4149行及对象/存储/视图摘要一致，旧行零删除 |
| 运行部署 | 统一用户代码四角色healthy；原huahuo目标/基线checksum/PG/schema/Redis通过，API/Admin readiness200及EdDSA/Ed25519/server-current JWKS真实通过 |
| 归档安全 | 额外6项隔离检查通过；四运行角色无归档Schema的USAGE/CREATE |
| Milvus目标 | 保持`huahuo_chunks`和`huahuo_manual_text`及当前Schema，不因SQL模型切换重建Collection |
| 新模型入库与查询 | 本轮未执行真实文件RAG入库；Milvus/OSS未清理，旧smoke不会作为当前业务结果 |

单元测试覆盖结构/目录、重复与跳级标题、代码伪标题、Unicode/重复文本offset、overlap、表格/代码/图片引用、token上限和三个类库独立性。集成测试覆盖各业务自有模型、原文保存、整篇parent_id、TOC失败降级及独立补偿、原生Hybrid后PG权限/正文回查、幂等、修订、删除和任务fence。缺失任务快照必须失败，不能使用当前默认配置猜测旧目标。

真实Milvus历史I/O证据曾复用已保存的公开Qwen向量验证两个目标的稳定写入、读取与定向删除，相关验证不新增模型调用；这不替代本次Query Embedding、Rerank或新文档入库的供应商验收。

当前边界：

- 数据库仍为 `huahuo`，旧模型和数据仅封存于 `initialization_backup`，新 `public` 已运行统一模型；不读取归档或添加旧模型兼容路径。
- SQL和Milvus不共享事务，未来新模型验证仍须核对来源、正文修订、目标快照、ready逻辑数量、权限和查询结果；Milvus已有物理样本不作为新模型已发布的依据。
- Note正文默认开关为false，部署时按明确配置启用；来自ASR或图片LLM的上游正文生成未实现。
- 本次模型和短信调用均为0，未重新上传Fixture图片、清理Milvus/OSS或执行真实文件RAG入库。真实服务验证必须单独记录授权范围和实际调用结果。
- 空白raw编辑使Note进入不可检索状态；向量缓存生命周期、可靠PDF页映射和生产规模吞吐/内存仍需对应环境验证。

