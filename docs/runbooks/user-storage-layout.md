# 通用上传、资源归属与存储清理

2026-11-17 本地候选说明。通用上传只负责文件传输授权、元数据确认、临时归属和清理；上传之后用于笔记、头像、消息还是文档解析，由后续业务 API 决定。本次没有实施目录迁移、OSS 对象复制、套餐计价或新的扣费模型，也没有修改真实 Bucket、凭据或共享数据库。验证与未验边界见[通用上传验收](../acceptance/generic-uploads.md)，本文不代表已经发布或完成真实 OSS 联调。

## 项目现状

| 内容 | 当前实现 | 对套餐容量的影响 |
| --- | --- | --- |
| 普通图片、音频和文件上传 | `StorageService` 在 Redis 登记有效期为 24 小时的临时上传，签发只允许 part 1 的 OSS PUT URL；Server 控制初始化、完成和取消，complete 校验分片与 HEAD 元数据，不下载正文。此时不写 PG 上传表、资源表或容量记录 | 不计用户实际占用，不读取额度汇总或检查剩余空间；不建立临时字节计数，不增加临时上传数量／总量限制 |
| 业务首次使用上传文件 | `ResourceClaims` 在该业务事务中核对有效临时回执，建立 `resources`、confirmed 容量记录及对应业务关系，并条件递增用户 `storage_used_bytes`；文件 UUID、resourceId 和 OSS Key UUID 保持相同 | 业务真正使用时才检查正式额度并计入 used；提交后尽力移除 Redis 临时记录，移除失败不重复计算占用，也不影响正式空间判定 |
| 用户头像 | 复用普通资源，以 `resource_refs.ref_kind=avatar` 关联用户 | 不应另存一份或重复计量 |
| Note 正文图片／导入附件 | 正文在 PG revision 表；图片统一 KBIMAGE 资源 UUID，当前关联和历史 revision pin 分开 | 正文移除引用不等于原文件可删；历史仍可读则仍保留文件 |
| 手动文本图片 | 规范正文统一 KBIMAGE；已有 resource_refs 的 text-image 记录当前引用 | 编辑时同事务解除旧图并固定新图，不引入历史正文表 |
| 文件入口的原始文档 | Server 接收链接与业务元信息；提交已完成的自有 resourceId 时由业务事务认领，不下载／复制原文件 | 只对经通用上传认领的自有原文件计入该占用；外部链接与衍生产物不等同于普通上传容量 |
| 结构化解析产物 | `extractions/{sourceResourceId}/{parseRunId}/{hash}.md`、`.json.gz`、`.assets.json`；图片实际位置来自解析上传回执 | 文件入口资产在 `rag_document_assets`，FILE_UPLOAD 在提取清单；尚无覆盖所有产物的用户容量台账 |
| 套餐与已有存储预留 | 套餐业务沿用原约定；已有 `BillingService` 的 storage reserve／confirm／release 同事务维护用户 reserved／used 汇总 | 本次只维护字节占用一致性，不扩展 credits、扣费、套餐定价或新的支付功能 |
| 清理 | Worker maintenance 每轮最多扫描 10 条到期／取消的临时上传，约每 60 秒再次运行；已进入 `resources` 的只移除 Redis 回执，其他才取消分片并删除对象。正式资源仍走引用检查后的删除任务 | 临时清理不增减用户占用；正式资源删除确认与用户 used 递减同事务，重试不重复扣减；文档 cleanup_status=ready 仍不能解释为 OSS 物理清理完成 |

依据：[上传与读取](../../src/modules/storage/service.ts)、[Redis 临时登记](../../src/modules/storage/temporary-uploads.ts)、[业务认领](../../src/modules/storage/resource-claims.ts)、[临时清理](../../src/modules/storage/temporary-upload-cleaner.ts)、[头像](../../src/modules/workspaces/service.ts)、[正式资源删除](../../src/modules/storage/jobs.ts)、[文件处理](../../src/modules/rag/jobs.ts)、[解析产物](../../src/modules/ingestion/document-extraction.ts)、[FILE_UPLOAD](../../src/modules/text-ingestion/jobs.ts)、[套餐](../../src/modules/billing/service.ts)。

## 上传接口与业务边界

客户端只需配置一个 API Base URL，可在客户端上传组件中封装“申请 → 直传 → 确认”。实际文件连接使用 API 下发的 OSS 临时地址，文件字节不经过 Server；业务 JWT 只发给自己的 API，不发给 OSS。客户端可统计 PUT 的发送进度，但最终成功以 complete 响应为准。本仓库没有修改 App 或交付客户端 SDK，以下是其应遵守的协议。

1. `POST /api/v1/media/upload-token`：传 `fileName`、`mimeType`、`sizeBytes` 和可选 `workspaceId`，带 JWT 与幂等键。已移除 `sourceScene`、`durationSeconds`、`distillToDigitalTwin` 和上传 SHA 参数。返回稳定的 `uploadId=resourceId`、`uploadUrl`、`method=PUT`、必需请求头、签名 `expiresAt` 与 24 小时 `retentionExpiresAt`。
2. 客户端按返回的 URL／请求头直接 PUT 文件。URL 绑定具体 OSS uploadId、partNumber=1 和长度，不能改成普通对象 PUT、其他分片或 Complete 请求。签名最多一小时，未完成期间可在临时记录有效期内用原申请重试；24 小时有效期不因重试重新开始。
3. `POST /api/v1/media/uploads/{uploadId}/complete`：Server 核对唯一分片的大小和 ETag，调用 OSS Complete，再 HEAD 校验字节、声明 MIME、上传身份和对象版本；完成记录仍只在 Redis。响应丢失可按同一个 uploadId 重试或查询状态，不应立即另开上传。`POST .../cancel` 只标记取消并让清理优先处理，返回 `cancel_pending` 不代表已经物理删除。
4. 后续业务 API 通过 `resourceId` 调用 `ResourceClaims`，在业务事务中建立资源及归属。上传成功本身不创建笔记、文档、解析任务或计费事件，也不意味着完成了业务保存。

complete 仅核对元数据，不做病毒扫描、真实文件格式识别、音视频时长测量或整文件 SHA-256。返回 `sha256:null`，不能把 OSS ETag 当作 SHA-256。后续业务需要解析或内容检查时，由该业务另行执行。

客户端获得的是 UploadPart 能力。OSS Complete 成功后该 uploadId 失效，原分片 URL 不能在文件删除后重新创建完整对象，见 [CompleteMultipartUpload](https://www.alibabacloud.com/help/en/oss/developer-reference/completemultipartupload)。取消也由 Server 控制；仍在传输中的分片残留与初始化响应丢失，需要部署时核对 OSS 的未完成分片生命周期策略，不能声称单次 Abort 已证明全部物理字节消失。

## 客户端读取契约

图片、音频、普通文件、文档提取图片以及完整解析 JSON 均通过短期 OSS 签名 URL 由客户端直接读取。Server 负责身份、用户／工作区归属、删除状态及对象位置校验；获取链接的 API 返回 JSON，不转发对象字节。普通资源沿用 `/api/v1/media/resources/{resourceId}/playback`，文档提取图片使用 `/api/v1/rag/ingestions/{jobId}/assets/{resourceId}`，完整解析产物使用 `/api/v1/rag/ingestions/{jobId}/extraction`。

链接响应沿用业务 envelope，`data` 包含 `url`、`expiresAt`、`mimeType`；已知物理大小时提供 `sizeBytes`。解析产物仍是 `.json.gz`，返回 `mimeType: application/json`、`contentEncoding: gzip`，并将对应 OSS 响应头覆盖写入签名。浏览器按 HTTP Content-Encoding 解码后得到原始解析 JSON；Server 不再读取、解压再转发。具体示例见[文档提取接口](document-extraction.md#现有文件-api)。链接接口使用 `Cache-Control: no-store`，到期重新取得链接；URL 是短期访问凭证，不能作为持久资源身份或写回规范正文。

服务端索引、检索回源、目录重建仍读取解析后的 canonical Markdown；章节接口仍读取指定字节范围并返回业务正文；外部文件导入的图片预览仍可读取图片清单以核对上传回执。这些是正文处理与资源映射所需的读取，不属于客户端下载代理。旧验收中 Server 代理下载、complete 后再次完整 inspect 的记录仅描述当时版本，不作为当前接口契约。

## 对象定位与容量

普通上传保持 `uploadId = resourceId = Object Key UUID`；OSS 适配器仅叠加已有的环境 `keyPrefix`，不加入用户目录、临时目录或文件后缀。临时文件被业务认领后不移动、不复制、不改标签。`resources.object_key` 继续使用 UUID，文件名只用于展示；Note／手动文本的 KBIMAGE、解析批次目录和衍生产物路径保持各自已有约定。

申请上传、直传、complete 和临时预览都不计入用户实际占用，也不读取用户额度汇总或判断剩余空间。Redis 仅保存临时回执、幂等和到期清理索引，不维护 pending 字节计数。本次不增加异常上传限流，也不增加临时上传数量或总量限制；现有身份、归属、文件参数及完成元数据校验仍保留。

业务首次使用文件时才按已有正式额度规则受理。按用户主键读取 `users.storage_used_bytes`（已确认占用）和 `users.storage_reserved_bytes`（已有持久预留），以条件更新原子判断并增加本次新认领文件大小，不查询并 SUM 用户全部容量明细：

```text
storage_used_bytes + storage_reserved_bytes + 本次新认领大小 <= storage.quotaBytes
```

业务认领在同一业务事务内条件递增 `storage_used_bytes`，同时插入资源、confirmed 明细与业务关系；正式删除确认在同一事务内递减 used 并释放明细。现有 `BillingService` 的 storage reserve 增加 reserved，confirm 将预留转为实际 used，release 按当前状态释放对应计数。用户锁／条件更新保护并发修改，幂等状态保证重试不重复增减；一个资源被多处引用不重复计量。

`resources` 和 `storage_reservations` 继续保存明细及必要的普通索引，供后续按资源、类型或业务维度统计，以及人工核对汇总值；它们不再是每次准入的 SUM 数据源。本轮不新增统计表、后台对账任务或收费功能。上传阶段没有 PG `upload_sessions` 或 storage reservation 写入。已有 PostgreSQL reserved 基础逻辑与临时上传无关，此次不扩展其业务规则。

PG 业务事务提交后的 Redis `forget` 是尽力操作，不是跨数据库原子提交。若 Redis 短暂失败，只会留下待清理的临时回执；正式用量只以 PG 事务维护的计数为准，不重复计算，也不因此改变剩余空间判定。到期清理看到已有 `resources` 后只移除 Redis 回执，不删除已认领对象。套餐、解析产物计量、历史／回收站保留政策仍是后续业务范围，不能把当前普通上传计数描述成全桶物理字节账本。

## 24 小时到期与失败恢复

临时上传与认领的有效期最多一天，即首次申请的 Redis TIME 起 24 小时；重试、续签和上传完成都不延长，到期后不能再由业务认领。业务事务成功提交后立即尽力删除 Redis 临时记录。未认领记录不靠 TTL 自动消失，而是保留到期 ZSET 索引及清理所需元信息，直到清理成功后同时移除记录、索引和幂等映射。故障期间文件与记录可以超过 24 小时保留；这避免丢掉清理所需的归属信息，因此 24 小时不是物理删除时限。临时清理失败不会增加正式用量或影响正式额度判断。本次有效期调整的复测状态见验收记录，不以此前七天方案的结果替代。

Worker 的 maintenance 执行路径约每 60 秒运行一轮，最多处理 10 条，不为这项扫描新增 PG 任务。单条失败延后 60 秒重试，只改变扫描时间，不延长上传有效期。多实例通过与业务认领相同的资源锁互斥：

1. 锁内只查询统一 `resources` 表，不逐个查询 Note、消息、头像等业务表。只要已有该 UUID 的正式资源记录，就仅 `forget` Redis 临时信息，不向 OSS 发删除请求。
2. 没有正式资源且已到期／取消时，先把临时记录保存为 `cancelled`，再尝试 Abort、HEAD 核对上传身份、按真实对象版本删除，最后 `forget`。
3. Complete 或 DELETE 响应丢失时保留恢复所需记录；不能把超时、未知 404 或 `NoSuchUpload` 一律解释成清理完成。版本桶删除必须使用实际 versionId，不能把 delete marker 当作数据已释放。

**不得给这些已完成对象设置 OSS“24 小时自动删除”生命周期。** 临时上传和正式资源共用 UUID Key，OSS 无法查询 PG 判断它是否已经被业务认领，固定天数删除会误删正式文件。只允许部署时单独核对未完成 multipart 的残片清理策略，其保留期应覆盖允许的上传窗口和重试时间；本次代码没有修改云端生命周期。

Redis 的持久化与 noeviction 是保留临时所有权信息的前提，现有 Compose 使用 AOF／noeviction。即便如此，灾难性清空、磁盘丢失或未持久化窗口仍可能丢失临时回执和清理索引；此时不能凭 Redis 缺失自动删除 OSS。需要通过 OSS 清单与 PG 资源对账，人工处理未认领对象。本轮没有增加全桶扫描平台，也不承诺 Redis 丢失后零残留恢复。

正式资源删除继续使用引用检查及现有 Worker 删除任务；历史 Note revision、文档来源或其他引用仍存在时，不承诺移除一处正文就立即释放物理空间。临时上传清理不改变这些业务删除语义。

## 迁移与发布边界

新增 `0007_generic_direct_upload.sql` 退役 PG `upload_sessions` 和资源上的 `source_scene`、`duration_seconds`，保留已登记资源、引用、实测 hash 和正式占用；不重写任何已执行迁移，也不增加物理外键。旧二进制与新 Schema 不兼容，需要停止旧上传受理、处理在途上传／预留／旧清理任务并排空相关角色后切换。

后续 `0008` 迁移为 `users` 增加 `storage_used_bytes`、`storage_reserved_bytes`，用已有容量明细初始化汇总，之后由相关写入事务同步维护。明细索引用于统计／对账，不引入周期聚合或新的统计表。目标实际数据规模、迁移初始化及汇总一致性需按本次发布清单验收，不能用默认零值代替已有占用。

迁移 guard 会拒绝仍活跃的旧记录、预留、授权期限和清理任务，但数据库检查无法证明 OSS 上已开始的普通 PUT 已经结束。发布前必须另行确认旧签名与在途远端写入已经处理完毕；不能只把数据库 expires_at 改成过去或等 guard 通过就认为云端安全。迁移不自动删 OSS、转移旧上传、释放旧预留或清库。具体验收与待执行项以[通用上传验收](../acceptance/generic-uploads.md)及本次发布清单为准。
