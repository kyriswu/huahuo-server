# OSS 资料入库

```http
POST /api/v1/rag/ingestions
Authorization: Bearer <USER_JWT>
Content-Type: application/json

{"ossUrl":"https://<allowed-oss-host>/<file>.md","fileName":"file.md","mimeType":"text/markdown","idempotencyKey":"file-request"}
```

HTTP 只创建现有 Task/Outbox 异步任务，返回 jobId、documentVersionId 和状态；不要求 Note/Resource 关联。URL、协议、允许域名、重定向和文件类型继续按现有下载/解析规则校验。私有 OSS 需要有效的服务端可访问签名 URL。凭据、连接串和正文不写日志。

所有支持文件（TXT、Markdown、CSV、PDF、Office）均由已配置外部解析服务读取 OSS URL；Server 不下载再转发，不保留本地文件解析旁路。完整配置、异步恢复、原始产物和图片读取见[文档提取手册](document-extraction.md)。

固定完整正文 hash 后，用资料关键词模式切分，不调用 Embedding、模型 tokenizer 或 Rerank。重试沿用已保存的完整正文，不重复下载/解析；自有 OSS 原文件不重复上传。

`rag_ingestion_versions` 保留来源、处理状态、完整正文 URI、TOC、任务与删除信息；已有图文资产记录保持授权读取，当前导入不生成图片/OCR 资产。索引职责由 `kb_document_keyword_builds/chunks` 接管，不再有旧的 Child 正文表、Chunk 视图或业务源表内的 Embedding 状态字段。分段正文只写 `huahuo_kb_keyword_chunks`，上限 2000 Unicode 码点、零重叠。

状态及目录/章节读取沿用 `/api/v1/rag/ingestions/{jobId}` 下已有接口。删除先撤销业务可见性，再由既有任务按构建目标及点ID清理。

现有查询入口与实现保留，但搜索业务具体细节待定，见[需求边界](search-status.md)。本页只说明解析与入库；当前索引维护见[手册](milvus.md)。
