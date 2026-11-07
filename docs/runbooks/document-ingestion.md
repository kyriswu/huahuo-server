# Note 手动文本入库

本接口属于 Note 业务；PDF/OSS 文件入库见[文件入口](rag-url-ingestion.md)。两类业务复用[章节/切分/索引类库](modular-document-processing.md)，分别保存正文和 Chunk，使用明确绑定的向量目标。

```http
POST /api/v1/workspaces/{workspaceId}/notes/{noteId}/document-ingestion
Authorization: Bearer <USER_JWT>
X-Idempotency-Key: <request-key>
Content-Type: application/json
```

请求可包含 UTF-8 `content` 或 `contentBase64`、`fileName`、`mimeType` ；省略内容时读取 Note 最新 raw revision。接受纯文本/Markdown 等既有文本格式，不调用 PDF 解析服务。保存的原文不 trim、不规范化换行、不静默截断，输入上限按现有接口校验。

接口返回 `jobId` 与 processing 状态，由现有 Task/Outbox/Worker 执行。启用手动文本 Profile 后，Note 创建和 raw 编辑也会在保存事务中自动创建同一入库任务；纯标题等元数据编辑不重复排队。

Worker 保存本次任务的正文快照和 TOC，以 `note_index_state.canonical_content` 及当前块的核心 UTF-16 切点为比较基线。对差分覆盖到的范围保留可用切点，按需局部重切。字符 diff 达到编辑量或耗时上限时，用通用切块器重切本条 Note，再按正文和最终 embedding 输入匹配可复用点。

`document_ingestion_chunks` 维护每条 Note 的当前块。块的正文、最终 embedding 输入和模型配置一致时，继续引用原 Milvus ID。改动块可以沿用逻辑 `block_id`，但由任务分配独立的 Milvus 点 ID。失效点退出检索后，Worker 批量计算并写入待更新块。每批成功的块立即标记 `ready`，进入该 Note 的向量和 BM25 检索范围。失败重试继续处理未就绪的块。

`note_index_jobs` 用于入库任务、重试和按任务读取章节。`documentVersion` 对应保存 Note 时已有的正文来源标识。RAG 发布范围由当前块的 `index_status` 决定。正文切分目标为 300 个 Unicode 码点，500 字为硬上限（含重叠），最终 embedding 输入另受模型 token 限制。

必须明确配置 `MANUAL_TEXT_ENABLED`、目标 database/collection 与本地模型 tokenizer。未启用或目标缺失时明确失败，不静默落到文件 Collection。两类业务可共享同一 Milvus 实例，业务目标保持独立。

`GET` 同一路径列出任务的 `jobId`、`tocStatus` 和处理状态。把该路径记为 `base`，所有读取使用用户 JWT。

| 请求 | 返回 |
| --- | --- |
| `GET {base}/{jobId}` | 该次入库的 `documentVersion`、嵌套 `toc`、`tocStatus`、`offsetUnit` |
| `GET {base}/{jobId}/sections/{sectionId}` | 该任务快照的精确正文切片，以及 `documentVersion`、`sourceStart`、`sourceEnd`、`offsetUnit` 和 `format` |

`sectionId` 从 TOC 选取。父章范围包含子章，坐标为 UTF-16 半开区间。无标题时返回 `section-body`，标题前有非空正文时另列 `section-preamble`。目录未就绪返回 `409 DOCUMENT_TOC_NOT_READY`，未知章节、非所属工作区或删除的 Note 返回 404。使用旧 `jobId` 可精确读回其正文快照，只要仍有权访问该 Note。

检索通过现有 RAG API 的 `sourceType=note` 走已固定的业务目标。索引期间可召回仍有效的旧块和已经就绪的新块。

详见[模块化文档处理](modular-document-processing.md)中的完整配置、薄 Tool、Mock 测试、真实 tokenizer、重试与清理说明。
