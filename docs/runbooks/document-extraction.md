# 文档提取接入与关键词索引

现有 `/api/v1/rag/ingestions` 和 `FILE_UPLOAD` 已接入 Xberg 提取；解析结果进入原来的 `document-keyword` / BM25 流水线，不新增 Embedding、Rerank 或第二套知识库。原生 UTF-8 文本、Markdown、CSV 继续本地解析；独立图片 OCR 不改成文档任务。默认不开启外部解析。

## 测试环境配置

仅在能访问 ECS 私网的测试环境启用，合并 `.env.document-parser.example` 中的配置到部署环境：

```dotenv
DOCUMENT_PARSER_MODE=ecs
DOCUMENT_PARSER_BASE_URL=http://172.18.102.101:8000
DOCUMENT_PARSER_HEALTH_PATH=/health
DOCUMENT_PARSER_ECS_REGION_ID=cn-beijing
DOCUMENT_PARSER_ECS_INSTANCE_ID=i-2zegwjwejyvpxoluhyx8
DOCUMENT_PARSER_ECS_PRIVATE_IP=172.18.102.101
DOCUMENT_PARSER_CONCURRENCY=1
DOCUMENT_PARSER_IDLE_SECONDS=60
DOCUMENT_EXTRACTION_MODE=async
DOCUMENT_EXTRACTION_CONFIG_PATH=resources/document-extraction/kbxml-request.json
DOCUMENT_EXTRACTION_POLL_MS=2000
DOCUMENT_EXTRACTION_MAX_RESPONSE_BYTES=67108864
```

ECS 控制使用已有共享 RAM 环境变量；API/worker 共用提取模式及配置文件，只有 worker/scheduler 收到机器控制配置。worker 在启用提取但未配置运行模式时拒绝启动。构建已包含 resources 文件，不在启动/请求时下载模型。本轮没有修改真实 `.env`、重建业务服务、请求 ECS/解析私网或执行云端写操作。

`resources/document-extraction/kbxml-request.json` 是用户提供的完整请求配置：Markdown、关闭缓存与 force_ocr、PP-OCRv5 server/chi_sim/batch 6、CUDA 0、3000 秒、150 DPI/JPEG85、每页最多16图、无图片 Base64、native-first 80/32 等全部字段原样保留。覆盖文件必须提供完整配置；不做默认值合并，不接受省略必需部分的局部配置。每个任务创建时将整份配置及 hash 写入 PG 快照，重试不读取新默认值。客户端总期限默认 3120 秒，覆盖 3000 秒提取上限并留传输预算。

单次请求最多16个文件，总文件字节预算略低于服务100MiB上限（预留multipart开销）；响应上限64MiB，规范正文沿用存储侧16MiB文本上限，超出明确失败而不截断。完整JSON压缩保存，避免大量定位元数据占用文本文件预算。所有资料入口只依赖关键词索引，不因全局模型提供方关闭而拒绝资料导入；`RAG_INGESTION_ENABLED` 仍控制业务功能开关。

将 `DOCUMENT_EXTRACTION_MODE` 改为 `sync` 使用同步 `/extract`。切换长期在线的同协议 API 时用 `DOCUMENT_PARSER_MODE=always-on` 和配置的服务基址，不需 ECS 凭据，其余去重/排队/并发不变；具体排空切换步骤见[运行库手册](document-parser-machine.md)。

## 现有文件 API

```bash
# 在测试环境执行；使用原有 Server JWT 与已允许的 OSS 文件 URL。
curl --fail-with-body "$SERVER_BASE_URL/api/v1/rag/ingestions" \
  -H "Authorization: Bearer $APP_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "X-Idempotency-Key: $DOCUMENT_REQUEST_KEY" \
  --data @ingestion.json
```

`ingestion.json` 示例：

```json
{
  "ossUrl": "https://your-allowed-bucket.example/document.pdf",
  "fileName": "document.pdf",
  "mimeType": "application/pdf",
  "sourceResourceId": "11111111-1111-4111-8111-111111111111",
  "parseRunId": "22222222-2222-4222-8222-222222222222"
}
```

示例 UUID 必须替换成实际业务值。`sourceResourceId` 如提供，必须是当前用户/default workspace 中已上传且 ready 的资源；重用其已保存对象，不再次保存母文件。Server 建立资源引用，文档删除时解除引用；越权资源拒绝受理。同一母资源/批次即使受理 key 不同也复用原任务；同批次变更文件声明或配置冲突则拒绝。

两个 UUID 也可省略：Server 使用持久文档版本 UUID 作为母文件身份，在受理事务中生成解析批次 UUID，再将两者与配置一起持久保存；重投递/自动重试复用快照。此情况下 HTTP 重试应复用 `X-Idempotency-Key`。不是每次 Worker 尝试生成一组新 UUID。

返回仍是原有 envelope，其中 `data.jobId` / `data.documentVersionId` 用于跟踪。任务查询继续使用原有 Task 和文件状态接口。完成后读取完整解析产物：

```bash
curl --fail-with-body "$SERVER_BASE_URL/api/v1/rag/ingestions/$JOB_ID/extraction" \
  -H "Authorization: Bearer $APP_ACCESS_TOKEN"
```

该下载接口直接返回原始结果对象 `summary/results/errors`，不是业务 envelope。成功正文在 `results[i].content`。未完成返回409，其他用户或已删除文档返回404。存储层将完整 JSON 无损 gzip 保存，HTTP 下载时解压；规范正文另存 UTF-8 Markdown，内容不改写、不由 metadata 重建。

文档图片的受控读取地址为 `/api/v1/rag/ingestions/{jobId}/assets/{resourceUUID}`，沿用 JWT 鉴权。它只读取本用户该文档的已确认图片，校验 OSS bucket 和配置前缀；不会把 UUID 当任意对象路径。API/worker 的 OSS bucket/prefix 应覆盖提取服务写入位置，前缀只添加一次。解析 JSON 本身仅返回 UUID/元数据，图片不进入 Base64 或字节数组响应。

现有 `FILE_UPLOAD` 文本导入也使用相同提取器；母文件身份使用持久导入 UUID，批次使用持久 Task UUID。其他 `IMAGE_OCR` 等来源保持原入口状态，本次没有新增独立图片 OCR 业务接口。

## Multipart 与结果归属

- `files` 和 JSON `file_contexts` 从同一有序文件数组生成，`config` 为完整 JSON 文本。文档必须有非 nil UUID；独立图片可为 null 上下文，低层客户端保留其原有响应语义。
- 成功项按 `input_index` 回绑上下文，错误项按 `index` 保留。中间文件失败不会让后续文件的上下文前移。低层客户端保留部分成功和错误；业务每个母文件独立任务，失败项不发布成功索引。
- 同步读取 `results[i].content`；异步只 POST 一次 `/extract-async`，先持久化 job_id 再 GET `/jobs/{job_id}`，completed 后解包 `result`。拿到可查询 job_id 的恢复只发 GET，不重新提交，也不重新下载母文件。
- `content_format=kb-markdown-v1`、普通 Markdown 表格、已有合并 HTML、KBIMAGE/KBFORMULA、pages/metadata/tables/counts/kb/source_nodes 等完整保存在原始产物。图片引用须有匹配的 `kb.uploaded_resources` 回执；UUID、上下文、hash、大小和 MIME 必须一致。拒绝图片 Base64、字节数组及容器路径字段。
- `source_content_byte_range` 和 provider 的页边界属于转换前 core 内容，不能拿来截取返回的 `content`。原始定位数据保留在产物；Server TOC/片段位置重新基于已保存的规范正文生成，沿用现有 UTF-16 契约，资产 char_start/char_end 不填错误偏移。

## 关键词流水线与恢复

完整 `content` → 原有分段（最多2000字符、无重叠）→ 原有 `document-keyword` BM25 索引 → 原有查询接口。图片 CDATA 已有 OCR 文字作为正文的一部分参与检索，不再次 OCR；只有 UUID/空 CDATA 时不虚构图片内容。上传回执和定位 JSON 另存，不把整包 metadata 塞进索引。

运行库先经 Redis 去重/FIFO/全局并发，再检查 ECS；Running 复用，Stopped 启动并等待健康。名额覆盖上传提取请求、异步轮询、产物保存和 PG 提交，最后释放。无排队/执行/未知请求满60秒后触发节省停机；事件唤醒、每分钟临时兜底及确认停机后休眠的约定保持。

PG 的外部提交意图先于 POST 持久化。返回 job_id 时只允许关联同一已持久意图；即使取消或 lease 变化恰好赶上返回，也不丢弃已接受 job_id，但旧 Worker 不能发布业务结果。保存正文/产物引用/资产关联与外部完成状态在同一 Task lease 事务中提交，失联恢复只查询既有任务；没有 job_id 的模糊提交保持待核实，不盲目重发。恢复继续遵循原有最大尝试预算，耗尽或上游 job 过期时需要人工对账。

现有 Task 取消意图驱动 DELETE；先持久记录取消已发出，再查询任务终态，DELETE 结果不明时只 GET、不重复 DELETE。远端已经 completed 的取消竞态也不发布被取消的正文/索引，不把本地取消当远端停止证明。删除正在解析的文档会同时取消原任务，晚到结果不能发布。

Worker lease 变化会通知排队/启动等待及时退出；已经提交的解析不使用该本地取消信号冒充远端停止，而由持久取消意图和终态查询收尾。同步请求无法按 job_id 取消时，继续等待其响应再确认终态；不因为前端取消就提前释放已提交请求的 Redis 名额。

实际验收见[本轮记录](../acceptance/document-extraction.md)。本轮测试仅访问 loopback 模拟提取服务和独立 PG/Redis/Milvus，真实私网解析质量、时延和服务镜像身份留待测试环境验证。`/version` 可核对引擎版本，build-id 应核对镜像清单/标签；保存的 `kb-markdown-v1` 是输出协议标记，不冒充镜像版本。
