# OSS URL RAG 文档入库

本入口处理独立文件业务，章节分析、切分与通用索引的完整接口见[模块化文档处理](modular-document-processing.md)，检索 Schema 和验收命令见[Milvus 手册](milvus.md)。

## HTTP 入口

`POST /api/v1/rag/ingestions` 创建现有任务体系中的异步任务，不等待解析和 Embedding。需要用户 JWT；可通过 `X-Idempotency-Key` 或 body 的 `idempotencyKey` 传入幂等键。

```http
POST /api/v1/rag/ingestions
Authorization: Bearer <USER_JWT>
Content-Type: application/json
```

```json
{
  "ossUrl": "https://<允许的OSS域名>/example.pdf",
  "fileName": "example.pdf",
  "mimeType": "application/pdf",
  "idempotencyKey": "file-demo"
}
```

返回 `jobId`、`documentVersionId` 和当前阶段。此链路对应知识库文档（`knowledge_document`），检索来源字段为 `sourceType=file`。入库使用当前用户的默认工作区，无需 Note 或 Resource ID。

`GET /api/v1/rag/ingestions/:jobId` 返回任务、嵌套 TOC、`tocStatus`、`offsetUnit`、Chunk 与索引状态。使用同一 `jobId` 和目录项中的 `sectionId` 调用 `GET /api/v1/rag/ingestions/:jobId/sections/:sectionId`。响应返回 `content`、`format`、`documentVersion`（即详情中的 `documentVersionId`），以及该节的 UTF-16 半开区间。父章节包含其子节。服务端校验归属和删除状态后，从该版本的 canonical 对象读取对应字节范围。

目录未就绪返回 `409 DOCUMENT_TOC_NOT_READY`。索引成功但目录失败的任务可用 `POST /api/v1/rag/ingestions/:jobId/retry-toc` 单独补偿。删除使用同一路径的 `/delete`，删除后按节读取返回 404。

URL 必须满足项目协议和 `RAG_SOURCE_ALLOWED_HOSTS` 校验，不含用户名/密码；生产使用 HTTPS。重定向逐跳重新校验，下载限制字节数并计算 SHA-256。业务 OSS 原文件复用 URI 和 checksum。

## Worker 调用链

```text
固定来源/正文修订/处理配置和目标快照
  → 下载源文件或复用已保存正文
  → 调用现有解析模块
  → 图片/OCR 绑定及 enriched Markdown
  → 保存完整 Markdown
  → 同次分析 TOC 和临时章节范围
  → LangChain 子 Chunk（可使用章节提示）
  → PostgreSQL 业务 Chunk
  → 独立 indexChunks
  → Qwen Embedding
  → huahuo_chunks upsert
  → 发布业务索引状态
```

PDF/Word 复用已存在的解析适配器。MinerU 正文顺序来自 `full.md`；`content_list_v2.json` 提供图片索引，`model.json` 顺序提取 OCR，整个 `images/` 目录进入资产 manifest。图片流式、有界上传自有 OSS，稳定引用使用 `asset://<source_asset_key>`。原始 Markdown 与 enriched Markdown 分开保留；生产不读取 `layout.json`，不重排 PDF 版面。`content_list_v2` 是供应商产物名，必须保留。

纯文本和 Markdown 复用 UTF-8 文本输入与现有整篇字符限制。完整正文保留首尾空白、换行和 Unicode，超限明确失败。Markdown 提取实际标题，普通文本或无标题的 Markdown 生成一个「正文」入口。

## 身份、正文和状态

文件完整正文记录为 `rag_ingestion_versions`，正文位于配置的对象存储 URI，纯文本另保留 `canonical_content`。TOC 及独立状态保存在该文档字段，图片/OCR 使用 `rag_document_assets`。`rag_child_chunks` 保存正文、Embedding 文本、源 offset、hash、长度与索引状态；`parent_id` 确定映射该整篇文档记录的 ID。

章节关系只在结构分析内存中使用，不建立章节 Parent，不把章节 ID 写入 `parent_id`，查询不回溯章节块。ChunkKey 包含来源、整篇 ID、正文修订、处理配置和 ordinal，重试可复现。

任务复用 PG task/outbox、BullMQ、attempt/lease 和阶段状态。解析成功后索引重试复用已保存正文；TOC 失败与索引成功分开表达，可仅补偿 TOC。向量和 PG 无共享事务，业务发布前重新验证来源状态与 lease，过期任务不能覆盖新修订或恢复已删除文件。新索引完成前保留原有有效索引，随后按原目标和旧修订清理。

每个写入 Milvus 的正文 Chunk 最多 2,000 个 Unicode 码点，计入重叠和空白。默认 token 目标为 500，最终 Embedding 上限为 800，overlap 目标为 64，使用配置的本地模型 tokenizer。位置为 UTF-16 半开区间，原文切片与 `content` 一致。切分配置与 tokenizer hash 固定到任务快照。

## 查询与权限

```http
POST /internal/v1/rag/query
Authorization: Bearer <USER_JWT>
X-Huahuo-Service-Key: <HUAHUO_AGENT_TO_SERVER_API_KEY>
Content-Type: application/json
```

```json
{"query":"international poverty","mode":"hybrid","topK":10,"sourceType":"file"}
```

APP 用户入口为 `/api/v1/rag/query` 和 `/api/v1/huahuo_rag/query`，仅需用户 JWT。内部用户接口同时验证 JWT 与方向 Service Key；当前用户只来自 JWT `sub`。调用方不需要 `documentVersionId` 或 `indexBuildId`，也不能任意指定 Collection。

Dense、BM25 和 Hybrid/RRF 均在 Milvus；PG 只做权限、状态和实际正文回查，随后由独立 Reranker 精排。结果包含整篇 `parentId` 与 Child evidence；章节 context 为 null。`asset://` 只在授权响应中解析为短期 OSS URL，不写回索引或数据库。连接或 Schema 不符明确失败，没有 PG 召回回退。

## 验证

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
node scripts/verify-rag-fixture.mjs /Users/kyriswu/Downloads/c8d85ccd-acc0-4cd2-a48c-b23f7efcd241
node --env-file=.env scripts/verify-milvus.mjs --schema-only
```

真实本地 fixture 的已记录结果：238资产、235图片引用、3 orphan、1002 OCR（1002 unresolved）、91临时章节、0章节 Parent、152 Child。全部 OCR 保留，未能可靠关联的 OCR 不冒充已绑定图片。该流程不发送供应商请求；Chunk 数量以固定配置实际输出为准。

独立测试库的 PG/Redis 集成测试验证异步创建、幂等、完整正文、整篇 `parent_id`、TOC 降级和补偿、更新/删除 fence、用户隔离；解析、Embedding、Milvus 和 Rerank 均明确 Mock。真实 Milvus 与模型验收需按[Milvus 手册](milvus.md)单独执行和记录，不把 Mock 当作 live 通过。
