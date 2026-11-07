# 独立文本导入

`TextIngestionJob` 是独立导入内容记录，不要求 Note ID，也不会为入库创建占位 Note。完整正文、来源和处理状态保存于 `public.text_ingestion_jobs`；Child 正文保存于 `public.text_ingestion_chunks`。数据库为现有 RDS `huahuo`，执行沿用原 Task、Outbox 和 Worker。

## 来源和原文规则

| source_type | 当前预处理能力 | 原文编辑 |
|---|---|---|
| `MANUAL_INPUT` | 精确保留用户文本 | 允许 |
| `FILE_UPLOAD` | 下载文本/Markdown；PDF/Office 复用现有 MinerU 与图文绑定 | 不允许 |
| `WEB_CRAWL` | 尚无已接通的爬虫 | 不允许 |
| `IMAGE_OCR` | 尚无独立图片识别适配器 | 不允许 |
| `MEDIA_ASR` | 尚无已接通的 ASR | 不允许 |
| `BOOK_OCR` | 尚无独立拍书适配器 | 不允许 |

未配置来源通过 `503 TEXT_SOURCE_ADAPTER_UNAVAILABLE` 明确拒绝；没有以 Mock 冒充真实能力。新增来源可以在预处理边界返回文本，后续复用同一切分和索引核心。

手动输入最多 50,000 个 Unicode 码点，正文保留首尾空白、换行和 Unicode。外部来源解析前 `raw_content=null`；非手动来源禁止提交或编辑解析正文。仅限制原文编辑，不将此策略扩展成禁止所有业务字段编辑。

这六个来源表示获取方式；向量中 `source_type='text'` 表示独立导入内容的业务归属。已有 `note`、`file` 业务及向量数据保持各自真实语义。

## API

所有接口采用用户 JWT，`created_by` 只取已验证 `JWT.sub`，工作区取该用户当前有效默认工作区。客户端不能指定创建人、状态、任务指针或向量目标。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/text-ingestions` | 创建异步导入，要求 `X-Idempotency-Key` |
| GET | `/api/v1/text-ingestions` | 当前用户列表，支持 `limit`、`before` 游标 |
| GET | `/api/v1/text-ingestions/:id` | 详情及响应 ETag |
| PATCH | `/api/v1/text-ingestions/:id` | 手动原文编辑，要求 `If-Match`、幂等键 |
| POST | `/api/v1/text-ingestions/:id/retry` | 重试当前失败执行，要求幂等键 |

HTTP 仅保存记录与任务，不同步等待解析和向量写入。JSON 请求体采用严格白名单，在 AJV 类型转换前校验正文，不接受数值正文或普通字段伪造身份。

```bash
# TOKEN 使用现有登录接口签发的用户 JWT。
curl -X POST http://127.0.0.1:3000/api/v1/text-ingestions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Idempotency-Key: text-example-001' \
  -d '{"source_type":"MANUAL_INPUT","raw_content":"Economic growth 与 PostgreSQL。"}'

# FILE_UPLOAD 只有原始 URI；元数据由服务端下载结果及文件字节核验。
curl -X POST http://127.0.0.1:3000/api/v1/text-ingestions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Idempotency-Key: file-example-001' \
  -d '{"source_type":"FILE_UPLOAD","origin_resource_uri":"https://<allowed-oss-host>/example.pdf"}'
```

响应 `data` 为已确定的九个核心字段，时间统一 Unix 毫秒。外部文件 URI 必须符合现有 `RAG_SOURCE_ALLOWED_HOSTS`；下载逐跳重验，限制字节数和完整接收超时。AWS/TOS 签名按签发时间加 TTL 判断，不将 TTL 当作绝对过期时间。生产拒绝 IP 字面量、本地域名和 HTTP；未实现 DNS 地址固定，白名单必须限制为受控存储域名。

## 共用处理链

`text_ingestion_jobs` → 现有 `tasks/task_inputs/task_outbox` → `TextIngestionJobs` → 预处理 → 精确保留完整正文 → `splitTextIntoChunks()` → PostgreSQL Child → `indexChunks()` → 当前 Embedding → Milvus。

文件预处理和原文件 Worker 共用 `rag/document-preparation.ts`。它保留原始 Markdown、所有图片和未绑定 OCR，复用现有稳定 `asset://` 与有界上传实现；不改解析器适配器、阅读顺序或图片绑定算法。新独立来源的产物 manifest 由 `artifact_uri` 定位，使用当前统一 StoragePort；不会因原始文件是 OSS URL 就假定解析产物必然写入 OSS。

切分使用既有 LangChain 和模型 tokenizer 配置，默认 500/800/64 tokens、正文硬上限 2,000 个 Unicode 码点。只生成检索 Child，不新增 Parent 表。Chunk 的物理列 `parent_id` 直接指向导入记录 ID；章节不充当父级，不保留独立变化的同义关联列。

## 无业务版本号的并发和恢复

- 没有 `rag_chunk_version` 或独立版本表。`current_task_id`、`active_task_id` 是既有 Task 的执行和发布指针，不对外作为业务版本号。
- 手动编辑覆盖同一条原文记录，固定新的执行任务与配置快照。旧任务失效，由原调度补偿处理其终态。
- 每次正文/状态/发布写入均先锁 Job，再锁并重验 Task 租约、attempt、执行标识；旧任务不能覆盖新正文。
- 相同任务重试使用相同稳定 Chunk Key；成功批次跳过向量化，失败批次可以恢复。PostgreSQL 不保存向量。
- 所有新 Chunk ready 后才切换 active 指针；构建期间旧 active 继续可查询。发布后按旧任务捕获的原向量目标清理，不使用当前默认目标猜测旧位置。
- 失败重试沿用失败执行的配置快照；手动编辑才捕获新的配置。缺少旧目标时明确失败。
- 任务终态是聚合状态的事实依据之一；工作区停用使执行失败后，恢复工作区仍可重试。
- 外部重新导入使用新的记录和幂等键，旧内容保留。相同幂等键重放不重复创建记录或任务。

## 检索

使用现有接口，明确选择独立导入来源：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/rag/query \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"Economic","sourceType":"text","mode":"hybrid","topK":10}'
```

Agent 调用 `/internal/v1/rag/query` 时继续同时携带用户 JWT 与方向 Service Key。Dense、BM25 和 Hybrid 使用已有 Milvus 原生检索与 RRF；正文回查 PostgreSQL，同时检查用户、工作区、active Task 和 ready Chunk，再执行可插拔 Rerank。图片只在响应时按权限解析为短期签名 URL，原文和索引不保存签名 URL。

本轮不改变现有查询默认的 `file` 来源；`note`、`file`、`text` 是明确的业务筛选值，不能用获取方式枚举替代。

## 验证和部署

运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`、`pnpm test:integration`。集成脚本创建独立临时 PostgreSQL/Redis，不读取业务 `.env`，模型、向量与供应商使用明确 Mock。预处理另有真实本地 HTTP 下载测试。

唯一初始化基线包含两张新表、普通关联索引、唯一约束和业务 CHECK，物理外键为 0。已有开发环境通过受控单次结构同步核验完整 Schema 后更新基线账本；应用启动不自动改库，没有旧字段别名或兼容回填。

### 2026-11-07 实际验收

- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。
- 33 文件 **317 项**单元/契约测试通过；12 文件 **132 项**隔离真实 PostgreSQL/Redis 集成测试通过，供应商、Embedding、Milvus、Rerank 为明确 Mock。另用本地 HTTP 文件验证真实下载、正文精确保留和相同处理核心。
- 50,000 个 emoji 输入完成原文保存、切片、向量 Mock 写入和状态发布，50,001 个码点明确拒绝。非法 NUL/孤立代理字符明确失败，不交给数据库静默替换。
- 覆盖并发重放、外部原文只读、跨用户/工作区隔离、ETag 冲突、旧执行失效、部分向量失败、Milvus 成功而 PostgreSQL 回写失败、旧目标清理失败和晚到向量自清；检索测试验证 native Dense/BM25/Hybrid 调用及 ready/active 权威正文过滤。
- 真 RDS `huahuo.public` 已添加两张新表，现为 **58 张实体表、0 外键**。真实库先匹配运行基线，再在一个事务中添加表和权限；完整目录比较与全新基线一致，所有原有业务记录摘要及封存归档保持不变，没有清库。
- 基线 checksum 为 `b85ada72bfefdb9117d3d37a848317a7bdaf385ce5e992390407385f9eeea79d`，源码、镜像和 RDS 账本一致。migrate 重放 `applied=[]/current=1`；四运行角色 healthy，API/Admin readiness 200，新接口未认证请求为 401。
- 当前运行环境是 live Provider，Qwen/Qwen3-Embedding-8B、4096 维，Embedding 配置和 tokenizer 文件存在；**本轮没有调用真实模型或执行真实 Milvus 写入**，不能将 Mock 全链路描述为真实外部服务验收。
- 当前统一存储实际为 `local`。源文件可来自 OSS，解析图片和 manifest 的保存方式仍由 StoragePort 配置决定，本轮没有擅自切换或重置 OSS 配置。
- App 仓库只读核对，未发现新 `text-ingestions` 客户端调用；本轮交付 Server API 与 Worker，不声称已完成 App UI 接入。

执行证据位于忽略提交的 `.local/text-ingestion/`，质量日志位于 `.local/text-ingestion-*.log`，不含真实密钥或完整业务正文。
