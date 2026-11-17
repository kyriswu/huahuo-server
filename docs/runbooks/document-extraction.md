# 文档提取接入与关键词索引

现有 `/api/v1/rag/ingestions` 和 `FILE_UPLOAD` 已接入 Xberg 提取；解析结果进入原来的 `document-keyword` / BM25 流水线，不新增 Embedding、Rerank 或第二套知识库。PDF、Office、TXT、Markdown、CSV 都由外部服务解析，Server 只传客户端已经上传的 OSS URL，不读取或中转源文件。手动正文不属于文件解析入口；独立图片 OCR 不改成文档任务。未开启处理节点时，文件受理明确返回 `DOCUMENT_PARSER_NOT_CONFIGURED`，没有本地解析兜底。

大文件测试前须确认外部解析服务器的下载限制、内存/临时磁盘容量及异步结果保留规则覆盖完整处理流程。当前 Worker 不缓存源文件，以下旧中转测试只作历史记录。历史2026-11-14的325页 VPC 复测先遇128MiB临时磁盘 `ENOSPC`，随后旧服务异步任务约5分钟后返回404，全文未完成入库及查询，见[失败记录](../acceptance/document-extraction.md#完整325页复测未通过解析机已停止2026-11-14)。当前调用侧已改为持久回调接收，但不能据此将该次失败改记为通过；真实CPU全文与回调网络仍待内网复测。

## 当前配置入口

每个节点独立保存唤醒方式与 Xberg 调用配置，入口为 Admin「处理节点」；「解析与模型」保留读取同一配置和客户端的试用弹窗，直接探测已可访问的API，结果仅内存、不进入正式调度。详见[运行配置手册](runtime-configuration.md)。不再读取 DOCUMENT_EXTRACTION/DOCUMENT_PARSER 旧 ENV，也不再配置全局提取 JSON。

当前 CPU ECS `i-2zejbbo2svjieb44tqy8` / `172.18.102.103:8000` 已部署解析服务。默认分步骤启动既有 ECS、检查 `/health`，再异步调用 `/extract-async`，JSON 请求省略 `config`，直接使用服务端默认配置；无需镜像名，也不发送历史 GPU/CUDA JSON。解析按已登记节点直接调用；本机若无法访问节点私网，健康检查和调用会报告不可达。PDF/Office 真实验收仍需在网络可达环境完成。

节点固定异步模式，高级设置可选完整提取参数覆盖；覆盖整体替换、不递归合并，仅作用于该节点。母文件/批次 UUID 在受理时保存，调用配置在分配节点时保存，已有任务恢复和安全重试继续沿用原节点配置。明确提交前的 bound 阶段可安全恢复；intent 模糊提交不重发，匹配的认证回调可将其收敛到已知 job；job 恢复只处理该次结果。健康检查、云唤醒、提交、查询与取消继续使用原客户端及状态机。

单次提取最多16个 URL，提交 JSON 包含 `inputs` 和 `file_contexts`；没有源文件字节、Blob 或 multipart。源文件实际下载、重定向、大小和下载超时限制由外部解析服务器负责，Server 不再展示不会生效的 `tasks.downloadTimeoutMs` / `storage.maxSourceBytes`。运行配置仅保留真实生效的约束：外部响应默认64MiB，规范正文接收/恢复与图片清单回读各16MiB，超出明确失败、不截断；完整JSON gzip保存。源文件 URL 在受理及真正提交前校验白名单和有效期，已经提交的 job 恢复不再依赖源 URL 有效期或当前白名单。features.documentIngestion 控制资料受理，继续使用现有关键词流水线，不新增模型/向量知识库。当前 CPU 服务真实解析待实际验证，不因单元或隔离测试通过而声称线上解析可用。

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

示例 UUID 必须替换成实际业务值。`sourceResourceId` 如提供，必须是当前用户/default workspace 中已上传且 ready 的资源；OSS 链接的 bucket、endpoint 与对象 key 必须指向该资源，签名不是资源身份；不允许资源 A 的 ID 搭配文件 B 的链接，不再次保存母文件。Server 建立资源引用，文档删除时解除引用；越权资源拒绝受理。同一母资源/批次即使受理 key 不同也复用原任务；同批次变更文件声明或配置冲突则拒绝。

两个 UUID 也可省略：Server 使用持久文档版本 UUID 作为母文件身份，在受理事务中生成解析批次 UUID，再将两者与配置一起持久保存；重投递/自动重试复用快照。此情况下 HTTP 重试应复用 `X-Idempotency-Key`。不是每次 Worker 尝试生成一组新 UUID。

返回仍是原有 envelope，其中 `data.jobId` / `data.documentVersionId` 用于跟踪。任务查询继续使用原有 Task 和文件状态接口。完成后取得完整解析产物的 OSS 直读链接：

```bash
curl --fail-with-body "$SERVER_BASE_URL/api/v1/rag/ingestions/$JOB_ID/extraction" \
  -H "Authorization: Bearer $APP_ACCESS_TOKEN"
```

该接口现在返回业务 envelope，`data` 示例：

```json
{
  "url": "https://your-bucket.example/extractions/source/run/hash.json.gz?SIGNED_QUERY",
  "expiresAt": "2026-11-17T12:15:00.000Z",
  "mimeType": "application/json",
  "contentEncoding": "gzip"
}
```

示例中的地址和时间不是有效凭证。客户端直接 GET `data.url`；链接约15分钟有效，接口使用 `Cache-Control: no-store`，过期后重新鉴权取链接。未完成返回409，其他用户或已删除文档返回404。签发前校验对象路径属于该文档保存的母资源和解析批次；URL 签名不是用户归属依据。

存储对象仍是完整原始 JSON 的无损 `.json.gz`，不是预先解压的文件。签名 URL 固定 OSS 响应 `Content-Type: application/json` 与 `Content-Encoding: gzip`，浏览器 Fetch／支持 gzip 的 HTTP 客户端按响应头自动解码后得到 `summary/results/errors`，正文在 `results[i].content`；不要对已自动解码的结果再次 gunzip。命令行可使用 `curl --compressed "$OSS_URL"`。Server 只签名，不下载、解压或转发 JSON。规范正文另存 UTF-8 Markdown，内容不改写、不由 metadata 重建。

文档图片的链接接口为 `/api/v1/rag/ingestions/{jobId}/assets/{resourceUUID}`，同样沿用 JWT 鉴权并返回 envelope，`data` 包含 `url`、`expiresAt`、`mimeType`、`sizeBytes`。它只为本用户该文档的已确认图片签发链接，校验 OSS bucket 和配置前缀，不读取图片、不把 UUID 当任意对象路径。API/worker 的 OSS bucket/prefix 应覆盖提取服务写入位置，前缀只添加一次。客户端直接读取 OSS；解析 JSON 本身仅包含 UUID/元数据，图片不进入 Base64 或字节数组响应。

`STORAGE_ALIYUN_OSS_ENDPOINT` 用于 Server 访问 OSS；配置内网 endpoint 时，使用 `STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT` 为客户端签发可访问的公网 URL。关联 `sourceResourceId` 时仅接受这两个已配置 endpoint 对应的同一 bucket／对象路径，仍需通过来源白名单和资源归属校验，不接受任意 CDN 或同名文件路径。

章节接口 `/api/v1/rag/ingestions/{jobId}/sections/{sectionId}` 仍返回业务章节正文，服务端按 Range 读取已解析的 canonical Markdown。索引、检索校验和目录重建仍可读取该产物；这不重新下载或解析客户端原始文件。旧验收记录中 extraction 直接返回 JSON、assets 返回图片流的行为属于历史版本，当前不保留该下载代理路径。

现有 `FILE_UPLOAD` 文本导入也使用相同提取器；母文件身份使用持久导入 UUID，批次使用持久 Task UUID。其他 `IMAGE_OCR` 等来源保持原入口状态，本次没有新增独立图片 OCR 业务接口。

## URL JSON 协议与结果归属

- 请求是 `application/json`：`inputs: [{kind: "uri", uri: "https://…", mime_type: "application/pdf"}]` 和 `file_contexts` 从同一有序输入数组生成，`config` 如提供则为完整 JSON 对象。文档必须有非 nil UUID；独立图片可为 null 上下文，低层客户端保留其原有响应语义。
- 成功项按 `input_index` 回绑上下文，错误项按 `index` 保留。中间文件失败不会让后续文件的上下文前移。低层客户端保留部分成功和错误；业务每个母文件独立任务，失败项不发布成功索引。
- 正式任务只 POST 一次 `/extract-async`，同时传入本次专用 callback_url，先持久化意图、回调身份，再关联 job_id。202后释放Worker执行槽，回调先验证并事务保存完整结果，成功后才2xx；继续执行时从持久收件箱读取 `result.results[i].content`。回调丢失时约60秒单次查询 `/jobs/{job_id}`，完成后通过 `/result` 补取并存入同一收件箱，不在Worker内循环等待。202继续等待、200完整输出会消费，410表示已消费；明确已消费但本地无结果时报 `DOCUMENT_EXTRACTION_RESULT_CONSUMED`，不重新跑OCR。恢复不重新提交或读取源文件，旧状态内嵌result协议不作兼容分支。
- `content_format=kb-markdown-v1`、普通 Markdown 表格、已有合并 HTML、KBIMAGE/KBFORMULA、pages/metadata/tables/counts/kb/source_nodes 等完整保存在原始产物。真实图片必须使用 KBIMAGE，返回 Markdown 图片或 HTML img 视为协议错误；代码示例、注释和 OCR CDATA 内的字面示例不算图片。图片引用须有匹配的 `kb.uploaded_resources` 回执；UUID、上下文、hash、大小和 MIME 必须一致。拒绝图片 Base64、字节数组及容器路径字段。原始 content/JSON 不经接收端改写；查询展示沿用[统一 KBIMAGE 扫描](../acceptance/kbimage-unification.md)。
- `source_content_byte_range` 和 provider 的页边界属于转换前 core 内容，不能拿来截取返回的 `content`。原始定位数据保留在产物；Server TOC/片段位置重新基于已保存的规范正文生成，沿用现有 UTF-16 契约，资产 char_start/char_end 不填错误偏移。

## 关键词流水线与恢复

完整 `content` → 原有分段（最多2000字符、无重叠）→ 原有 `document-keyword` BM25 索引 → 原有查询接口。图片 CDATA 已有 OCR 文字作为正文的一部分参与检索，不再次 OCR；只有 UUID/空 CDATA 时不虚构图片内容。上传回执和定位 JSON 另存，不把整包 metadata 塞进索引。

运行库先经 Redis 去重/FIFO/全局并发，再检查 ECS；Running 复用，Stopped 启动并分步骤检查健康。机器侧名额覆盖远端执行、产物保存和 PG 提交，等待期间不释放实际远端占用；Worker租约和执行槽则在步骤间释放。无排队/执行/未知请求满60秒后触发节省停机；事件唤醒、每分钟临时兜底及确认停机后休眠的约定保持。

PG 的外部提交意图先于 POST 持久化。返回 job_id 时只允许关联同一已持久意图；即使取消或 lease 变化恰好赶上返回，也不丢弃已接受 job_id，但旧 Worker 不能发布业务结果。保存正文/产物引用/资产关联与外部完成状态在同一 Task lease 事务中提交，失联恢复只处理既有任务；没有 job_id 的模糊提交不盲目重发。阶段接续通过 resume_count 与实际失败重试分开计数，不因等待耗尽业务重试预算；上游 job 已过期且没有本地结果时需要人工对账。

现有 Task 取消意图驱动 DELETE；先持久记录取消已发出，再查询任务终态，DELETE 结果不明时只 GET、不重复 DELETE。远端已经 completed 的取消竞态也不发布被取消的正文/索引，不把本地取消当远端停止证明。删除正在解析的文档会同时取消原任务，晚到结果不能发布。

终态取消/失败会 POST `/jobs/{id}/ack` 释放服务的未消费记录；成功领取已由GET结果接口消费，不再发送额外ack。完整执行配置仍是 [kbxml-request.json](../../resources/document-extraction/kbxml-request.json)，与用户本次JSON一致；服务端环境另见[无凭据模板](../../resources/document-extraction/a10-fast-callback-runtime.env.example)。当前样本镜像固定 `152b65be…31a6c7` digest，ECS与ECI必须一起更新到新异步协议，再启用这版客户端，不能只换调用端。

API 已装载 `/internal/v1/document-parser/callbacks/{id}/{token}`，令牌每次提交独立生成，持久保存摘要及加密重试副本。先认证再接收大响应，结果需匹配母文件/批次、请求指纹、job 和上传回执；重复通知幂等，冲突拒绝。事务保存完整结果、记录唤醒后才2xx，最终业务产物提交成功后清理收件正文；取消和删除后晚到结果不能发布。回调URL用可从解析机访问的 `API_SERVICE_BASE_URL`，配置规则见[服务地址](service-addresses.md)。不记录含令牌的原始URL。

补偿GET的HTTP完整输出仍只能确认服务端发送完成；下载中断且上游已消费、本地又没有持久回调结果时会明确失败，不声称无损恢复。真实云端回调及长文档尚未复测，当前只完成替身协议和真实独立PG/Redis验证，见[本轮验收](../acceptance/document-async-events.md)。

Worker lease 变化会通知排队/启动步骤及时退出；已经提交的解析不使用该本地取消信号冒充远端停止，而由持久取消意图、回调和终态查询收尾。不因为前端取消就提前释放已提交请求的 Redis 名额。

验证分为 loopback 模拟解析与隔离依赖测试、VPC 真实文件测试；历史2页样本通过，325页全文失败，详细边界见[验收记录](../acceptance/document-extraction.md)。本轮 URL 输入与 OSS 直读改造尚未部署或重启现有角色，未启动远端解析机。签名与禁止下载代理的本地单元测试不能代替真实 OSS／浏览器的网络验收。`/version` 可核对引擎版本，build-id 应核对镜像清单/标签；保存的 `kb-markdown-v1` 是输出协议标记，不冒充镜像版本。
