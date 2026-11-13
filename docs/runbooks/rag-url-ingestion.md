# OSS 资料入库

```http
POST /api/v1/rag/ingestions
Authorization: Bearer <USER_JWT>
Content-Type: application/json

{"ossUrl":"https://<allowed-oss-host>/<file>.md","fileName":"file.md","mimeType":"text/markdown","idempotencyKey":"file-request"}
```

HTTP 只创建现有 Task/Outbox 异步任务，返回 jobId、documentVersionId 和状态；不要求 Note/Resource 关联。URL、协议、允许域名、重定向和文件类型继续按现有下载/解析规则校验。私有 OSS 需要有效的服务端可访问签名 URL。凭据、连接串和正文不写日志。

UTF-8 文本、Markdown、CSV 本地解析，保留原文的空格、换行和 Unicode，不依赖模型或外部解析凭据。开启文档提取后，PDF/Word/Excel/PowerPoint 接入 Xberg 并进入同一资料关键词流水线；关闭时仍返回 `RAG_FILE_TYPE_UNSUPPORTED`。完整配置、UUID/异步恢复、原始产物和图片读取见[文档提取手册](document-extraction.md)。类型伪装返回 `RAG_FILE_TYPE_MISMATCH`；原文件下载继续受域名、签名、重定向、大小和超时限制，Worker 检查真实字节。

固定完整正文 hash 后，用资料关键词模式切分，不调用 Embedding、模型 tokenizer 或 Rerank。重试沿用已保存的完整正文，不重复下载/解析；自有 OSS 原文件不重复上传。

`rag_ingestion_versions` 保留来源、处理状态、完整正文 URI、TOC、任务与删除信息；已有图文资产记录保持授权读取，当前导入不生成图片/OCR 资产。索引职责由 `kb_document_keyword_builds/chunks` 接管，不再有旧的 Child 正文表、Chunk 视图或业务源表内的 Embedding 状态字段。分段正文只写 `huahuo_kb_keyword_chunks`，上限 2000 Unicode 码点、零重叠。

```http
GET /api/v1/rag/ingestions/{jobId}
POST /api/v1/kb/documents/query
Authorization: Bearer <USER_JWT>
Content-Type: application/json

{"query":"资料关键词","documentKey":"<documentVersionId>","topK":10}
```

查询仅访问资料集合，返回前从当前授权业务正文验证修订、UTF-16 原文范围和哈希。删除动作先撤销业务可见性，再按原构建目标及点 ID 清理。TOC 补偿独立于成功索引；已有图片签名解析逻辑继续用于受权读取。完整字段、模型零调用与验收说明见 [知识库手册](milvus.md)。
