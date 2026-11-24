# Server 契约与阶段记录

## 当前资产契约

Server 使用 `ContentAsset` 表达用户可以管理的资产，中文显示为「资产」。PostgreSQL 主表为 `content_assets`，归属字段为 `user_id`，标识字段为 `content_asset_id`。正文、原文件、文件夹和标签按关系挂到资产。上传原文件使用 `Resource` 和 `resourceId`。 [资产与搜索术语](content-assets.md)

资产管理入口为 `/api/v1/content-assets`，资产 ID 和修订分别使用 `contentAssetId` 和 `contentAssetRevisionId`。全文查询入口为 `/api/v1/kb/content-assets/query`，业务来源为 `content_asset`。AI 纲要场景使用 `content_asset_outline`。编辑器润色继续用一次生成请求返回提示词定义的文本，支持 JSON 和 SSE。 [AI 模板](runbooks/ai-templates.md)

`0020` 完成业务表、字段和任务命名收敛。本地候选 `0021` 更正索引列名和存量快照，底层索引使用 `hybrid`、`keyword`，集合按业务来源绑定。资产默认集合名随已有集合原地更名生效。 [索引与切换](runbooks/milvus.md)

`0023` 把资产保存、图片引用、标签关系、索引和 AI 运行切到登录账号，移除资产工作区关系表与相关字段。独立文档入库继续走各自的业务读写范围。「我的标签」是 App 本机记录，已应用的资产标签可用于检索。 [索引迁移](runbooks/milvus.md)

`0024` 把单文件夹位置迁入 `content_assets.folder_id`。列表和详情只显示当前账号的有效文件夹。软删时保留存储位置，恢复时重新显示；已清除或已移动的资产按新位置显示。搜索的文件夹筛选只匹配有效文件夹。

以下带日期的段落记录当时的实现与验收，保留对应版本的协议和数据库命名。

## 笔记归属与组织关系（2026-11-19，本地候选）

笔记用 `note_id` 标识，账号归属直接保存在 `notes.user_id`。现有工作区可见范围读 `note_workspaces`，文件夹位置读 `note_folders`。数据库允许笔记没有组织关联。现有路由继续校验账号和工作区，列表和详情从当前关系投影 `folderId`。

删除文件夹时，文件夹及其子目录进入回收状态，关联的笔记保持原状态，未删除的笔记仍可从笔记列表读取。已删除的文件夹在笔记列表和搜索中视为无活动位置。恢复文件夹会恢复仍存在的组织关联。升级前由旧级联删除产生的标记随关联迁移，可按原有流程找回对应笔记，单独删除的笔记仍由笔记恢复操作处理。

迁移 `0019` 把原工作区账号、文件夹位置和历史恢复标记转入新结构，保留笔记 ID、正文、附件和版本。同库的 API 和 Worker 需要协调更新。隔离演练检查从旧版本升级和重复执行，真实目标的数据量与锁时长待部署前核对。

## 禁用标签服务时的请求结果（2026-11-18，本地候选）

`features.tagProvider=disabled` 时保存/编辑 Note 不再创建必败的自动标签任务，显式 tag-extractions 返回已声明的 `503 TAG_PROVIDER_UNAVAILABLE`；权限/归属校验仍先执行，成功 key 仍可重放，内容、手动标签、事件与索引照常。没有新增请求/响应字段、产品接口或 App 接线。队列与 chunk 写入仅优化底层交接与批量操作，搜索产品细节仍待定。见[验收](acceptance/pg-row-growth-optimization-20261118.md)，未部署。

## 搜索实现的需求边界（2026-11-17，本地候选）

用户明确搜索功能确定需要，现有实现保留；业务范围、交互、接口及具体策略尚未定。查询Service/入口、技术配置、指标及测试保持现有实现；不把当前实现当成既定产品需求，不继续扩展功能或接线App/Agent。此前历史债务清理和正确性修复保留。见[需求边界](runbooks/search-status.md)及[本期验收](acceptance/debt-cleanup-20261117.md)。未修改共享库或部署。

## 当前契约收敛（2026-11-17，本地候选，未发布）

用户授权直接断开旧客户端与混合版本兼容。任务仅 state；删除 regenerate、keywordAttemptId、无效 restore 参数、contentLineId/defaultContentLine 别名和固定空字段；认证状态只给真实用户/工作区/时区。查询输入仅 note/file，File统一查询 file/text 真实来源；空正文不得声明 JSON；JWT仅当前 kid；运行配置未知字段严格拒绝。以下旧阶段表格只作历史证据，不能当作候选仍保留的接口。完整断开清单、App只读依据、SQL及验证见[本期验收](acceptance/debt-cleanup-20261117.md)。此候选兼容项 false，未部署，App也未修改。

## 用户资源、文件复用与当前笔记（2026-11-17，本地候选）

资源只按用户归属；`resources` 移除工作区、重复上传 ID、解析处理状态及软删除时间，新增 `reference_count`。文件不可覆盖、无业务版本；按用户最终决定不做内容去重，App 不计算 MD5/SHA，也无 content_md5 字段/索引。每次新上传分配新 UUID；业务直接引用同一 resourceId 时可跨自己的工作区，空间按 ID 只计一次，跨用户禁止。引用次数随实际业务关系同事务增减；最后一个引用解除时同事务提交现有删除任务，Worker 删除 OSS 后硬删资源行并释放空间，不留零引用保留期。原任务完成回执保障重试不重复扣减。

`POST /api/v1/media/upload-token` 接收文件名/MIME/大小及可选工作区，JWT＋X-Idempotency-Key；同用户同键/同元数据只用于请求重试，不进行内容比较。新上传响应 `uploadRequired=true`；同次上传已完成且 Redis 回执仍在时，同键重试响应 `uploadRequired=false` 和原 ID，跳过重复 PUT/complete。签名绑定单片会话、长度与 MIME，不要求 Content-MD5；完成核对分片/HEAD 元信息而非文件内容。Redis 仍限首次起 24 小时，不落 PG、不占额度、不触发业务，业务成功后正式登记并清 Redis。`sha256` 可空备用，新上传不填写；完整协议见[资源说明](runbooks/user-storage-layout.md)。

Note 只保存当前 `note_parts`，每个 note/part 一行；noteRevisionId/partRevisionId 仅作当前修订和异步防旧写标记。移除历史正文读取 query `partRevisionId` 和 PUT 字段 `basePartRevisionId`，更新仍强制整篇 Note 的 If-Match；GET part 只返回当前内容。旧参数不保留旁路，历史图片 pin 一并退役，当前引用和回收站语义保留。

新增 0009–0011，冻结历史 SQL 不变，无物理外键；旧写入方必须排空后迁移，不支持新旧混跑，发布 API/database/tasks/configuration 兼容项维持 false。当前本地证据及未验边界见[验收](acceptance/user-resources-and-current-notes.md)，不代表已部署。

## 内部 HTTP 协定与入口收敛（2026-11-17，本地实现）

Server内部接口统一由src/http/internal-routes.ts注册到/internal/v1，RAG、gateway、解析回调按业务拆分；有限策略中间件集中处理可信身份头、网关会话与单次回调能力，禁止缓存并隐藏公开OpenAPI。内部RAG与公开入口复用严格Schema、业务handler和运行配置。Server当前没有主动调用Agent的业务；不新增无调用客户端、方向ServiceKey或JWT第二验证分支。

解析回调从/api/v1/document-parser/callbacks迁到/internal/v1/document-parser/callbacks，Server生成URL与trace识别同步，旧路径404。现有Agent→Server RAG与gateway URL不变。出站手写HTTP共用ServiceHttpClient，统一trace、deadline、取消、重定向拒绝、受限JSON和响应释放，业务provider继续拥有协议与重试策略。详见[双方协定](runbooks/internal-services.md)及[本地验收](acceptance/internal-services.md)；Agent仓库未修改/联调，未部署。

## 通用上传与业务认领分离（2026-11-17，本地候选，待发布）

客户端可只配置一个 API Base URL，通过统一上传组件完成申请、OSS part PUT 和 complete；文件字节不经过 Server，临时 OSS 地址仍可在客户端网络层看到。本仓库只实现 Server 协议，没有修改 App 或声称客户端 SDK 已接线。当前 `upload-token` 接受 `fileName/mimeType/sizeBytes/workspaceId?`，移除 `sourceScene/durationSeconds/distillToDigitalTwin/sha256`，不保留旧参数兼容。新文件返回 `uploadId=resourceId=Object Key UUID`、短期签名 `expiresAt` 与 24 小时 `retentionExpiresAt`；同次上传请求的重试沿用其上传 ID，独立重传不合并，详见上项。

上传阶段只在 Redis 登记临时归属、幂等和清理索引，不写 PG 上传／资源／容量记录，不计用户实际用量，也不读取额度汇总或判断剩余空间。本次不增加异常上传限流或临时上传数量／总量限制。Server 初始化 OSS multipart，仅签发 part 1 PUT，complete 核对分片、完成远端对象并 HEAD 校验大小、声明 MIME、上传身份和版本；不下载正文、不做内容嗅探／音频时长／SHA 实测，也不触发解析或收费。`sha256` 返回 null。Complete 成功后的远端 uploadId 失效，原 part 签名无法在删除后重新创建对象。

只有后续业务 API 调用 `ResourceClaims`，才按既有正式额度规则在同一个业务事务里建立 `resources`、confirmed 占用和业务关系，提交后立即尽力移除 Redis 回执；该移除失败只留下临时回执，不重复计算用量，也不影响正式空间判定。临时认领有效期从首次申请起最多 24 小时，重试、续签和上传完成不延长，到期后不能再认领。它不是 Redis 自动 TTL 或精确物理删除时限，清理完成前保留必要元信息。Worker maintenance 约每 60 秒扫描最多 10 条，持同资源锁查统一 `resources`：已认领只清 Redis，未认领才取消／核对／删除 OSS 并清理回执。不新增临时清理 PG 任务、不复制对象、不引入 OSS 回调或新的计费模型。

业务真正使用文件时，正式额度判断使用 `users.storage_used_bytes + storage_reserved_bytes + 本次新认领大小`，不计任何 Redis 临时记录，也不逐次 SUM 明细。业务认领条件递增 used，正式删除确认同事务递减 used；旧独立 storage reserve／confirm／release 方法已在历史债务清理中删除；正式用量仅由资源认领与删除任务维护，重复提交与重试不重复增减。已有 PG reserved 事实仍参与容量保护，与 Redis 临时上传无关。明细及普通索引继续用于细分统计与对账，不新增统计表、后台对账任务或 credits／扣费功能。`0008` 迁移新增两个汇总字段并以现有明细初始化；此调整不改变上传 HTTP DTO。

playback 仍返回 15 分钟 OSS GET 签名；extraction/assets 保持含 `url/expiresAt/mimeType` 的 JSON，gzip 产物另含 `contentEncoding:gzip`。签名与 UUID 识别继续分离，KBIMAGE、解析产物和模型契约保持各自既有边界。临时完成但尚未认领的自有文件可在有效期内取得播放链接；正式资源已删除时不能通过旧临时回执恢复读取。

新增 `0007_generic_direct_upload.sql` 退役 PG 上传表及资源业务字段，后续 `0008` 增加用户存储汇总字段，与旧二进制不兼容；发布前必须停止旧签名受理并处理在途远端写入，SQL guard 不能证明 OSS PUT 已停止。完整对象不能配置“24 小时 OSS 自动删除”，否则会删除已认领文件；未完成分片生命周期须实际检查。Redis 灾难性丢失需要 OSS 清单对账，不承诺零残留恢复。当前实现及本轮测试范围见[通用上传验收](acceptance/generic-uploads.md)；[旧 OSS 直读验收](acceptance/oss-direct-access.md)仅保留历史证据，不代表本次迁移已通过或已发布。

## 笔记列表20条分页与摘要（2026-11-17，待发布）

`GET /api/v1/workspaces/:workspaceId/notes`固定每页20条，以响应`nextCursor`继续读取；最后一页为null。列表项保留身份、归属、标题、状态、版本、来源和时间等元信息，新增纯文本`preview`（最多200个Unicode码点，允许为空），移除完整`parts/resourceRefs`。详情及part接口继续读取完整正文，列表不生成图片播放链接。排序为更新时间降序、ID升序，游标保留微秒并绑定工作区；无效游标400，跨请求并发编辑需刷新首屏。

这是用户确认的列表/详情拆分，API兼容声明为false，不提供旧全文模式。当前App HEAD bf23c1b的首页读取本地SQLite，尚无远程笔记列表接线；旧P06文档所引用的其他App提交不代表当前消费契约。42项真实依赖与11项接口契约验证见[验收](acceptance/note-pagination.md)，未部署。

## KBIMAGE 统一正文（2026-11-17，待发布）

Note及MANUAL_INPUT在哈希/幂等/版本前，将Markdown、引用式图片与HTML img统一成已授权资源的KBIMAGE；底层不再混存图片语法，外部解析原有KBIMAGE属性与OCR保持。无法映射到已上传自有图片的地址返回NOTE_IMAGE_UPLOAD_REQUIRED，不读取外链。此项替代11月14日“asset:// Markdown及未知外链保留”的存储策略；入口多格式是当前输入适配，读取没有历史格式兼容路径。

展示/检索共用轻量KBIMAGE扫描器。按用户明确要求，Note HTTP的contentMarkdown直接返回唯一可编辑标准Markdown，不再额外返回displayMarkdown/imageLinks；手动文本HTTP raw_content同样转换，内部存储与任务仍使用KBIMAGE。Note响应contentSha256计算实际返回Markdown，稳定版本使用ETag/partRevisionId，内部canonical哈希不受签名变化影响。

图片URL的#kbimage节点指纹用于保存时恢复OCR/属性，不发往OSS；旧链接即使失效也按资源路径/Object Key查UUID，不请求图片。新图片必须先上传并完成元数据确认，首次保存到业务时由同一事务认领为正式资源。指纹必须匹配当前正文，同UUID多套OCR不盲选；原key重试在恢复元数据前完成幂等重放。局部写入运输上限8MiB/200万字符，canonical原业务上限保持。RAG机器证据content/evidence/hash/坐标契约保持，RAG displayMarkdown仅用于预览。KBIMAGE规范化本身没有新增SQL/环境变量；通用上传迁移见文首。真实App未接线，既存数据需发布前盘点，详见[实现、性能与验收](acceptance/kbimage-unification.md)。

## 文件入口底层约定（2026-11-17，已实现，待发布）

所有文件默认由客户端自行上传OSS，Server接收OSS链接和业务元信息；外部解析服务通过链接读取文件。上传到Server的能力必须由用户另行提出独立需求，不把下载再上传、multipart转发或旧中转作为默认路径或兼容兜底。该约定优先于早期规格中的Server接收上传设计。

正式文档、FILE_UPLOAD 与 Admin 试用统一提交 URL JSON 给外部解析服务；TXT/Markdown/CSV/PDF/Office 都没有本地解析分支。删除 Server 二进制上传及 DOCX Base64 导入；媒体 upload-token 返回 OSS 单分片 PUT 签名，complete 只确认临时文件，正式资源由后续业务事务认领，完整下载检查已移除。Note imports 只接受已提取的 text/plain 或 text/markdown 正文。任务意图、回调、取消和租约保护继续生效，URL 与资源 ID 必须指向同一对象。协议与验证见[验收](acceptance/document-parser-url-contract.md)，未部署。

## 任务基础能力加强、计费扩展暂缓（2026-11-17）

任务载荷与公开HTTP结构不变；通用终态与数据库事务内业务适配分离。Scheduler恢复改为逐条提交并返回内部错误摘要，其他任务继续；Worker在取得锁后重新验证owner/version/attempt和数据库租约，拒绝过期续租及迟到外部提交。沿用此前预留释放修复，未新增计价或扣费模型。任务基础专项及此前323项隔离依赖结果见[验收](acceptance/task-reservation-recovery.md)；当前trace严格Schema的升级边界以本页trace章节为准，不声明历史二进制兼容。

## 简单traceId贯通（2026-11-17）

统一X-Trace-Id/Envelope traceId，删除X-Request-Id别名；所有任务创建时写入必填trace，Worker只读取，队列仍只传taskId。回调始终使用任务trace；token鉴权与幂等协议不变。0005无默认值且不支持旧二进制省略字段，清单database=false；后续按严格新Schema统一更新四角色，不保留旧写入路径。两仓分别发布，不修改宿主入口，见[验收](acceptance/trace-id.md)。

## 发布顺序与按角色清单（2026-11-17）

services控制实际更新的1–4个运行角色，未选角色保留成功镜像和ENV；配置生效使用方不得漏选，新增SQL仍全角色。成功记录增加逐角色镜像身份，用于混合版本下的同SHA幂等复核；固定云命令SHA输入及原version/stage/status/code终态协议不变，没有新增App API、鉴权入口或自动回滚参数。267项发布专项及真实宿主原地验证分别留证，见[验收](acceptance/release-order-and-services.md)。

## 任务终态与预留事务修复（2026-11-17）

公开Task请求/响应、队列载荷与事件结构不变。失败/取消与预留释放同事务，自动重试保留预留；用户手动重试重新预留，余额不足不改变任务，幂等重放无额外预留。Admin无预留重试不变，有预留任务从财务只读入口返回BILLING_NOT_CONFIGURED，防止绕过准入。真实App当前未找到通用Task消费者；新增权限迁移、真实PG回归及未验边界见[验收](acceptance/task-reservation-recovery.md)。

## 原生认证子请求与配套Agent（2026-11-16）

业务路径/载荷和可信身份头保持：公开Server为/api/v1，Agent公开前缀/agent，内部API仍为/api。Server认证子请求不再直接返回302，而以401和登录提示头交给入口处理；Cookie刷新/清理采用独立响应头。Agent删除重复注销和匿名跳转，保留原生用户隔离。内部Server地址必须为稳定origin。首次切换仍与旧线上鉴权不兼容，需两端和宿主入口一起切换；见[契约](runbooks/gateway-auth.md)和[验收](acceptance/ingress-auth.md)。

## 搜索底层端口收敛（2026-11-16）

用户最新决定先按关键词、向量、混合检索能力封装底层，业务名称与获取方式留在上层映射。KeywordIndex支持替换提供器，HybridIndex可使用Milvus原生能力或组合独立关键词/向量索引；模型Rerank不进入存储接口。公开/内部HTTP路由、请求和正文响应沿用现有在途实现；Server-Timing及日志阶段名milvus_ready/milvus_search改为index_ready/index_search。上层Note/File/text来源分派、最新200来源限制和其余审计问题没有在本次底层封装中改写。

既有Collection Schema、构建ID、point ID和业务快照/configHash输入与本轮开始时工作区一致，无数据库迁移。实际SDK类型、原生查询表达式与Schema管理只在Milvus适配器；过滤端口保留必填用户/工作区/授权ID，并只接受受控来源条件。914项单元/契约与48项定向真实隔离PG/Redis/Milvus集成通过；替代关键词class是测试适配器，不能替代未来ES验收。完整说明见[底层接口](runbooks/milvus.md#底层接口与后端替换)。

## 内部RAG运行配置与Qwen切换（2026-11-16）

公开与内部RAG请求Schema、响应及授权边界沿用当前在途实现；内部/internal/v1/rag/query现与公开入口读取同一请求级运行配置。隔离真实PG通过Admin保存候选7时四个入口均读取7，改为11后新请求读取11、在途请求保持7。配置/入口是真实依赖，检索spy与真实Milvus集成证据分别记录。新模型与FP16不兼容旧模型向量/任务快照；本次共享PG元数据与旧Milvus逻辑行均0，显式删除重建无需回填，不能泛化到非空历史库。模型网络按执行位置配置，本机test也走公网，云端test/main走私网；没有根据分支或APP_ENV自动切换。见[验收](acceptance/qwen37-vector-switch.md)。

# 契约兼容性（P01 历史与 P02 增量）

## 解析排队与图片复用（2026-11-16）

共用解析客户端接受远端 queued 作为非终态；Admin 继续显示处理中，正式任务按原 singleStep 返回等待，不新建请求或 Task。跨页复用同一图片可重复返回一致的存储回执，归属、路径、哈希、大小、类型或 etag 冲突仍拒绝。保留原响应与 Markdown，不改变 App/Admin 公共 Schema、鉴权、任务/回调载荷或数据库格式。旧失败的纯内存 Admin 试用不会自动复活；刷新后可重新试用，但应先核实旧远端任务状态，避免重复提交。

## 节点启用字段退役（2026-11-16）

App路径和用户任务协议不变；仅Admin节点API删除enabled输入/输出，旧管理页面需刷新后编辑，传退役字段返回400。配置健康路径不可达的试用返回ADMIN_TRIAL_SERVICE_UNREACHABLE且不POST文件；真实提交未知仍不重发。

## 线上环境云控制默认值（2026-11-16）

仅调整部署权限：APP_ENV=test/production 默认允许云端开停机，显式false继续禁用，RAM、管理员鉴权与CSRF要求保持。私网解析调用开关、App路由、认证/envelope、任务载荷、数据库结构均不改。已有测试/生产私密ENV仍需独立准备；不把本地配置与隔离依赖通过声称为线上开机或解析验收，见[验收](acceptance/cloud-control-environments.md)。

## 服务端异常诊断（2026-11-15）

日志补充脱敏异常链/堆栈、路由和状态，沿用既有traceId；客户端错误envelope、状态码、通用提示及X-Trace-Id不变，不返回内部原因。DomainError新增可选cause但保留原commit参数，无API/任务载荷或Schema变化。四角色HTTP、契约及隔离回归证据见[验收](acceptance/error-diagnostics.md)，尚未线上发布。

## Admin实例状态、云控制与固定节点清单（2026-11-15）

Admin节点状态改用status/events，替换历史start-status/start-events；升级后旧管理页刷新。主state反映实例电源，serviceStatus/serviceReady单独反映API，未探测时serviceReady为null。bootstrap增加cloudControlEnabled，与enabled私网调用权限分离；开机任务Running即完成，不要求私网健康或API Token，仍受认证/CSRF/机器锁保护。原config.enabled仍控制自动选址，手动开机后仍按空闲策略停机。运行方式胶囊只映射已保存mode。PUT节点仅更新现存ID，未知ID404，不再创建；清单随代码发布维护。App业务路径、认证、Task及持久回调载荷不变；冻结迁移未改。见[验收](acceptance/processing-node-status.md)。

## 发布冒烟沿用现有 API（2026-11-15）

固定读取 live/ready、me/status、workspaces、tasks/running，验证现有 Envelope、身份归属和非终态任务；匿名访问仍应 401。专用会话正常更新 last_seen_at，不新增业务写接口、永久 JWT 或鉴权旁路。4 项真实 API 集成与 27 项 HTTP 替身测试分别记录，见[验收](acceptance/release-smoke.md)。

## Worker 优先交接，无新增业务协议（2026-11-15）

发布方案采用共享队列和消费端先行，保留现有Task载荷、JWT、幂等、结果读取及App DTO；不新增按API实例/宿主/版本的任务归属。新增真实PG/Redis回归验证两个旧Worker停领后，由新Worker执行旧/新API受理的任务，各一次attempt，旧JWT与跨实例重放保持。证据为同代码多实例和Fastify inject，不冒充历史镜像或宿主入口验收；见[验收](acceptance/worker-first-release.md)。

## 手动启动与正式异步任务接续（2026-11-15）

Admin新增节点start/start-status/start-events，启动202入队、状态SSE推送；节点调用只接受async，空config仍省略。正式用户解析经每提交独立认证回调、Outbox和原Task接续，App路由/envelope/KB Markdown及图片UUID不变；阶段接续不占业务失败次数。Admin试跑保留直接API与纯内存结果，不新增持久协议。473项unit/contract、241项隔离PG/Redis通过（1项跳过），真实云机和内网回调未验收；现有开发角色继承与测试最小权限的区别见[验收](acceptance/document-async-events.md)。

## Admin 试跑零持久化（2026-11-15）

试跑只保留当前“运行配置 → 解析与模型”入口，原有Admin认证/CSRF/归属与上传限制保留，状态/结果仍用临时接口回传；不创建试跑审计、节点分配、任务或持久回调。刷新或重启丢失后重新发起，前端不保存试跑ID、不自动恢复。正式用户任务的持久回调只允许API/Worker访问，Schema不再接受trial_id；App业务接口不变。473项unit/contract、239项隔离集成通过（1项跳过），见[验收](acceptance/admin-document-trial.md)。

## 独立 Admin 的 API 服务地址（2026-11-15）

增加部署字段 API_SERVICE_BASE_URL 供认证解析回调使用；不更改 App 公共 API、Admin 路由或 Session 协议。服务地址可与 APP_PUBLIC_BASE_URL/ADMIN_PUBLIC_BASE_URL 分离，已有公开 API 地址可作为默认值；缺失时显式拒绝回调准备，不生成猜测的本机地址。

## 独立角色可组合部署与实际演练（2026-11-15）

用户明确统一代码、按角色独立进程，可同机任意组合或跨机增副本。当前镜像的普通用户JWT、任务幂等结果、上传文件和Admin会话在真实容器交接/回切中保留；未知可选配置仍受严格输入与版本约束。历史镜像因不同基线不能直接升级，未推导跨版本回滚成立。跨机文件共享和云节点副作用仍待验收；用户已接受Admin试跑进程内状态丢失后重新发起，不要求持久化或跨副本恢复。App源码只读，未运行Flutter。见[演练](acceptance/release-rehearsal.md)。

## 应用发布基础契约（2026-11-15）

新增运维信号 SIGUSR2（不新增公共控制路由），draining时ready503/live200；ready同时校验运行配置。配置存储缺省v1，未知可选字段在同契约版本下保留但不应用/回显，Admin写入仍严格；不兼容版本返回503。解析回调保持现有HTTP结构，增加匹配身份/指纹后收敛intent，取消标记及结果提交fencing保留。App接口/envelope不改，未运行Flutter；同版实例交接/未来字段模拟不代表真实旧镜像回滚。见[验收](acceptance/release-hardening.md)。

## Prometheus 监控增量（2026-11-15）

HTTP 全局钩子只观测最终响应，不改变业务路由/Envelope/鉴权。抓取口为独立 9464–9467 端口的 /metrics，使用客户端库格式和 Content-Type，不向业务/Admin 端口增加重复指标路径。labels 无用户/任务 ID 或 URL 查询值；APP_ENV 决定环境，App 仍沿用现有契约。见[监控手册](runbooks/prometheus.md)。

## 按节点调用既有 ECS（2026-11-15）

App文档入口、FILE_UPLOAD、Markdown/KB标签、图片UUID和关键词入库协议不变；内部调用配置由全局快照移到实际节点分配快照，CPU默认省略Xberg config并使用现有服务参数。Admin退役全局四项document设置，改用节点documentApi高级配置；当前节点/API/UI同步。App请求与认证两份参照文件只读哈希保持一致，未修改App。

## RAG后台分类与ENV退役（2026-11-15）

独立Admin配置分类增加rag，沿用Session/superadmin/Origin/CSRF/revision及同事务审计；App DTO/路径不变。原RAG调参ENV不再读取或注入，后台修改影响后续请求，构建保留持久快照，服务及固定模型/集合身份仍是部署配置。435项unit/contract、222项隔离集成通过，模型/Milvus为替身，见[验收](acceptance/runtime-configuration.md)。

## 试用入口与节点JSON（2026-11-15）

节点数据库配置合入单个config jsonb，Admin节点API仍接收/返回原类型化对象和递增revision；编辑不新建节点版本行。试用API、角色/CSRF、请求与结果归属保持，UI入口改为运行配置的解析与模型tab内Modal。App路径/envelope和任务快照协议未变；测试见[配置验收](acceptance/runtime-configuration.md)。

## 分类运行配置与管理 API（2026-11-15）

App既有路径/响应/鉴权不变，内部业务限额和解析参数改读DB快照；新路由只在独立Admin。GET configuration/processing-nodes 需要管理员Session；PUT分类配置/节点要求superadmin、Origin、CSRF及revision，事务内复核角色并审计。API-server不装载这些路由。215项隔离集成和435项unit/contract通过，非浏览器/移动端通过。见[验收](acceptance/runtime-configuration.md)。


## 通用文档解析ECS目标替换（2026-11-15）

仅内部电源目标切到CPU实例 `i-2zejbbo2svjieb44tqy8`，私网与配置基址同步103；无App DTO/路由/Task协议变更。原GPU请求JSON不改成未经验证的CPU配置，示例提取模式disabled；A10回退保持关闭。后续若已有旧Redis协调状态，仍按原排空/configure-idle规则切换，不清空或迁移活动请求。见[验收](acceptance/document-parser-cpu-target.md)。

## prod-callback提取协议（2026-11-14）

跟随用户新镜像：GET /jobs/{id}仅状态，完成后GET /result完整领取并消费；202等待、410已消费不可自动重跑，失败/取消终态POST /ack。旧状态内嵌result不保留兼容分支，ECS/ECI服务须同步升级。既有App envelope/任务/KB Markdown/图片UUID不变；没有新增公开业务回调路由。仅隔离小TXT接收器验证保存后2xx，325页通过结果接口领取。见[验收](acceptance/xberg-a10-prod-callback.md)。

## A10 ECS 缺货回退 ECI（2026-11-14）

仅内部解析机配置增加可选 ECI 回退；既有请求身份、异步 job 恢复、取消、KB Markdown与图片 UUID 协议继续复用。没有新增 App DTO、路由或云管理接口。关闭回退时旧 Redis配置签名保持；开启/更换配置需排空并释放已追踪ECI后 configure-idle。状态 CLI 新增 activeProvider/eciTarget/只读ECI快照。见[验收](acceptance/document-parser-eci-fallback.md)。

## 图片稳定身份与展示视图（2026-11-14）

Note create/update/part PUT/import 归一实际图片目标为 asset://UUID，验证同用户／工作区／ready 图片后再 hash 和 diff；外部 HTTP(S) 图保持外链，data/file/本地路径须先上传。正文引用自动同步、显式附件 update 生效、历史 part 保留图片 pin。签名变化不增加 revision／cursor／任务。

原 contentMarkdown/contentSha256 为规范正文；响应新增 displayMarkdown、imageLinks，服务端在幂等事务外生成，临时 URL 不写持久 receipt。既有公开／internal RAG 查询新增可选 assetMode（ids 默认、links 按需）；content/evidence/range 保持规范原文，图片 metadata 在最终权限复核与 topK 后填充。KBIMAGE uuid 不改成 URL。Note 与查询响应 no-store，服务 Key/JWT 校验保持。当前 Flutter 图片为 FileImage，未找到这些 DTO 的 HTTP 消费者，不能视为 App 接线通过。见[契约与验收](acceptance/markdown-images.md)。

## Admin 基础用户信息查询（2026-11-14）

新增 `GET /admin/api/v1/users`（仅 Admin Session），支持可选 search/status/page/pageSize，默认 20 条。返回 items/total/page/pageSize；单项仅 userId、displayName、phoneMasked、status、createdAt。普通用户 JWT/匿名返回 401，公开 API 的同路径返回 404；输入边界、参数绑定、稳定排序、脱敏和审计由新增 8 项隔离 PG 测试验证。

不新增用户写操作、导出或 JWT 功能，不修改 App 的登录、上传及资料接口。当前 App 的实际认证客户端和双 Base URL 声明已只读核对，哈希前后一致。见[验收记录](acceptance/admin-users.md)。

## Xberg 文件结果与关键词索引（2026-11-14）

USER：完整 config 替换默认，files/file_contexts 按输入索引绑定、非 nil UUID 同批次重试复用，kb-markdown-v1 仅保留 KBIMAGE/KBFORMULA、普通表格 Markdown/可靠合并 HTML，图片只返回已上传 UUID/元数据。CODE：同步 results[i].content、异步 completed.result.results[i].content 均接入现有文件 Task；最终 content 进入原有 document-keyword/BM25，原始 JSON/KB/图片信息另存，无 Embedding/Rerank 调用。

`POST /api/v1/rag/ingestions` 原 envelope 不变，可选 sourceResourceId/parseRunId（提供资源时校验归属/ready）；新增受控原始产物与图片 GET。FILE_UPLOAD 复用同一提取器。低层多文件客户端按 input_index/index 处理部分失败，独立图片 null 上下文透传。Task取消/恢复/删除不把本地超时视为远端停止，不重提模糊请求。

394项单元/契约、160项隔离依赖集成通过，包括真实BM25结果检索；外部解析由loopback替身提供。App只读CODE，真实内网解析/镜像身份/质量和Flutter消费仍未验收。见[接入手册](runbooks/document-extraction.md)。

## 解析机库边界（2026-11-14）

USER：单 ECS 按需启动、在线复用、默认空闲 1 分钟节省停机、Redis 去重与并发；后续可改长期在线 API；采用事件唤醒，确认停机后停止兜底。CODE：`withDocumentParser` 接受持久 requestId/fingerprint 和调用方解析 callback，返回业务结果或稳定协调错误；endpoint/token/模式只来自部署配置。没有新增公开开停机接口、App DTO 或旧解析兼容分支。

当前 App Base URL/鉴权源文件再次核对；375 项 unit/contract、146 项真实隔离依赖测试通过。真实解析 HTTP 合约、PG Task/Parser 客户端接线、云开停机闭环尚未验证，不将只读云状态或虚拟时钟当端到端结果。见[解析机验收](acceptance/document-parser-machine.md)。

## A10 KB协议同镜像对照（2026-11-13）

325页HTTP成功，97表格cells及768图片SHA与T4一致、751唯一资源UUID已核验。归一化批次ID后251页正文一致，其余74页差异导出；关键抽查无新丢失，既有19/62页漏字仍在。新KB协议仍为独立供应商验收，未写App DTO、业务资源关系或数据库，不宣称端到端业务接通。详见[验收](acceptance/xberg-a10-kbxml-retest.md)。

## Xberg KB Markdown协议独立验收（2026-11-13）

真实325页返回完整results[0].content/kb-markdown-v1、768 KBIMAGE及751资源UUID，无图片字节数组；97表格cells对照一致，正文表格定位2处和公式1处能力缺口保留。图片级OCR全部unavailable、已知关键文字仍漏，不能把HTTP200视为质量通过。仅独立供应商测试，未改App/业务DTO、素材关系或数据库。详见[验收](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg OSS/KBXML核对与申请未完成（2026-11-13）

新镜像digest c8ad143d…783e25/build xberg-kbxml-v1-20261113-r4已静态核对；新增北京I交换机已加入本机GPU配置。T4单区/四区及A10两档实际申请均NoStock，关闭缓存和570驱动也未成功，无325页解析或性能结果。所有自有调度实例和临时输入已清理，新镜像缓存Ready并保留。长期GPU仍disabled，未改业务/App/数据库。详见[本轮记录](acceptance/xberg-oss-kbxml-trial.md)。

## A10原生优先独立HTTP验收（2026-11-13）

用户完整config替换默认提取配置，未传force_ocr_pages；真实/extract返回325页、97表格、768张图片字节数组。768处图片引用已替换为本地相对路径，未发布业务OSS地址。HTTP200/errors=0及零逐页失败仍存在证书关键文字遗漏；响应只有1条告警，运行日志另有47条混合OCR拒绝、6条缺字形。未改变App公开契约或接入既有任务。详见[本轮验收](acceptance/xberg-a10-native-first-trial.md)。

## 当前 App 认证与短信（2026-11-12）

当前消费者为 `../huahuo-ai/lib/features/auth/data/http_auth_repository.dart`，已核实 `sendCode` 发送 `{phone,purpose:sign_in}`、`verifyCode` 发送 `clientType:app` 与持久 clientId，HTTP 使用 `x-idempotency-key` 和既有 success/data/error envelope。其短信票据解析需要 smsRequestId/cooldownSeconds，登录需要 user.userId 及令牌字段，均沿用现行后端契约，无旧参数兼容分支。

2026-11-24 只读复核 Flutter `fe6a02c`。验证码响应的 `providerMode` 增加飞书测试投递的 `mock`，现有 Flutter 客户端仅读取票据 ID 和冷却时间，登录继续提交同一手机号与验证码。 [飞书测试验证码](runbooks/sms.md#飞书测试验证码)

`tests/unit/identity-api-schema.test.ts` 和真实 PG identity 集成覆盖后端 Schema、OTP、登录及失败/重放；适配器只改变供应商实现，不增加 App 字段。当前这两项认证契约为 CODE（源码核对），未运行 Flutter 或真机 App 全链路。用户确认收信和运营商 delivered 是短信供应商证据，不等于 App 登录已做实机验收。

旧目录 `huahuo-app` 以及其 Flutter/packages 路径、旧 scene/deviceId 描述仅属于下方历史记录。当前参照由 [App 证据](app-reference.md) 和 `config/app-reference-files.json` 指定；其他业务的新 App 兼容性尚未复核。

## Xberg 新镜像独立接口验收边界（2026-11-12）

真实/extract multipart按用户新JSON+原257页清单返回325页/97表格、HTTP200且文件级errors=0，但22页recovered=true只代表保留原文，出现证书正文缺失；images字段未返回且counts.images=0。消费方必须检查逐页失败/恢复方式与告警。本轮未改App公开契约，也没有接入既有Task/Worker或PDF导入业务；图片OSS持久化/引用替换链路未触发，不能标验收通过。详见[本轮验收](acceptance/xberg-cuda-image-policy-trial.md)。

## 文件解析适配器移除（2026-11-12）

删除MinerU的供应商API客户端及PDF/Office处理分支。通用 `/api/v1/rag/ingestions` 保留JWT/幂等/任务与查询读取契约，只接受原生UTF-8文本、Markdown、CSV；真实JWT下PDF/Office返回400 / `RAG_FILE_TYPE_UNSUPPORTED`，不创建解析任务，字节伪装继续拒绝。FILE_UPLOAD不再调用外部解析或产生OCR资产；原始来源和已有可授权正文保留。App工作区Note导入接口并非该通用入口，本轮未改其声明或App源码。见[移除验收](acceptance/mineru-removal.md)。

## FunASR 实例部署边界（2026-11-12）

独立FunASR镜像实际 `/readyz` 为ready/cuda:0，GPU运算通过，`GET /v1/voiceprints` 无token401/有token200，`GET /docs` 为200。后续一次完整multipart `POST /v1/transcriptions` HTTP200，返回text、毫秒timestamps_ms、218个segments及4个speakers聚类标签；未开启identify_speakers或注册声纹。大量重复“嗯”使转写质量未通过，接口成功不代表语义准确或真人身份。未新增Server/App API、Task DTO或Worker接线。见[实例与音频记录](acceptance/funasr-eci.md)。

## Xberg全文HTTP成功仍含OCR失败（2026-11-12）

真实325页响应HTTP200、summary.errors=0、325页均非空，仍有18条ocr_page_failures/recovered=true；警告区分17页内嵌图片重试恢复、1页保留原生文本，不能认定原整页CUDA路径修复。调用方除summary/results外还须检查页失败和processing_warnings，不能把完整页号当图片文字全部识别。没有Server/App路由、Task DTO或Worker接线变化，见[全文CUDA验收](acceptance/xberg-cuda-full-trial.md)。

## Xberg CUDA错误与整份配置（2026-11-12）

默认CUDA请求可HTTP200同时results=[]、summary.errors=1、errors[0].code=1002/error_type=ocr，health仍healthy，必须检查正文业务结果。请求config整体替换默认，保留Paddle/chi_sim/CUDA后只改官方识别批次1才完成20页；mixed逐页标记缺失及issue1709仍记录。没有新增Server/App端点、Task DTO或Worker接线，见[CUDA验收](acceptance/xberg-cuda-trial.md)。

## Xberg全文超时契约实测（2026-11-12）

原生HTTP200可以返回results=[]、errors[0].code=1014/error_type=timeout、summary.errors=1，调用方必须验证业务结果。默认extraction_timeout_secs=600，官方参数设3000后原实例重试成功返回325页。混合路径仍无逐页backend标记，7条警告原样保留；Server/App端点、Task DTO及持久Worker未改。见[全文验收](acceptance/xberg-full-trial.md)。

## Xberg混合提取路径核对（2026-11-11）

官方force_ocr_pages路径返回method=mixed、ocr_used=true、20页，但没有纯OCR的逐页backend/confidence/hierarchy；表格多出columns/table_id，单元格/Markdown/坐标保持。采集器字段断言修正为记录差异并核查内容，不伪造标记。仍是镜像独立测试，无Server/App路由、Task DTO或Worker接线变化。详见[验收](acceptance/xberg-optimization-trial.md)。

## Xberg独立HTTP测试（2026-11-11）

实际1.3.9的health/version/info/formats/openapi/detect/extract已真实调用；multipart字段files、config，正文为results[0].content，不能套用旧huahuo-parse的markdown字段。前20页默认文本层与强制中文OCR分别导出并记录质量缺陷，异步/并发未验收。没有新增Server/App端点、Task DTO或持久Worker接线；App基线复核一致。详见[验收记录](acceptance/xberg-trial.md)。

## 新镜像独立HTTP测试（2026-11-11）

仅调用镜像内部4763的health/parse，10页complete且请求后常驻；未新增Server/App路由、Task类型或持久Worker接线。新组件light_ocr未在HTTP路径调用，不能据此标其契约或性能已验证。详见[对照验收](acceptance/gpu-parse-ocr-trial.md)。

## huahuo-parse 独立试验（2026-11-11）

仅针对镜像内部 `/health`、`/api/v1/parse` 的云端临时测试，不增加 Server/App 的公共接口或接入持久 Task/Worker。SDK POST 表单修复保留原参数、顺序与 ClientToken；105 项 GPU 单测与全量 306 项 unit/contract 通过。实际 App HEAD 和两个 Task 文件哈希再次核对一致；未执行 Dart/真机验收。

## 阿里云凭据环境命名（2026-11-11）

仅统一后端 AK 环境配置及部署示例：OSS 与 ECI 共用 RAM 变量，移除旧 OSS 名称；不改变 HTTP/Admin API、Task DTO 或对象存储端口。App HEAD/原任务文件哈希复核一致，305 项 unit/contract 通过；不代表 Flutter/真实 OSS 调用验收。

## GPU 底层增量（2026-11-11）

第二次授权的真实阶段计时仅扩展忽略提交的本地采集器与验收文档，未改模块接口、HTTP/Admin API 或 Task DTO；App HEAD/任务文件哈希复核一致。该次 31.785 秒确认 Ready，已释放，见 [计时验收](acceptance/gpu-spot-timing.md)；本轮 GPU 单测 104 项通过，没有重新运行全量契约测试。

本轮仅增加内部归属校验、预检和四档候选；真实试申请后修正初始化元数据等待，不新增 App/Admin API、不改变移动端 Task DTO。App 两个原参照文件哈希复核一致；后端 unit/contract 当前共 300 项通过。云端一次性创建、Nginx 启动/就绪、同实例恢复与释放已有独立证据；不作为 Dart/真机、模型推理或持久 GPU 任务验收。

只读核对本地 App `20f61b78887f9288d1fd3227f326e6374d516f27` 的 `endpoint_catalog.dart:805` 和 `work_ai_task_api.dart:16`，仍以 Task ID 查询/重试并使用 App DTO 解析。当前端点目录未定义 GPU/ECI 管理 API；本轮只新增内部集成模块，不改 Task DTO、App API 或新增 HTTP/Admin 路由。源码哈希与 dirty 范围见 `app-reference.md`；279 项后端 unit/contract 通过不代表 Flutter 或真实 GPU 联调。原 Pxx 记录保持各自时间和范围。

| 范围 | App 依据 | 后端处理 | 证据 | 状态 |
|---|---|---|---|---|
| Base URL | `core_provider_module.dart` 的 `HUAHUO_API_BASE_URL` | Compose `APP_PUBLIC_BASE_URL` 是根地址；路由自身使用 `/health`，P02 起业务路由保留 `/api/v1` | App 哈希基线；cloud/local 配置校验 | CODE/PROPOSED |
| 鉴权注入 | `api_client.dart` `resolveAuthHeader` | P01 不实现用户身份；健康无认证，未来 App 路由使用 Bearer 并从服务端 user/session 派生 | `tests/contract/api.test.ts` 验证 Admin 不接受 App Bearer | CODE/P01 boundary |
| 成功 envelope | `api_envelope.dart` `parseApiEnvelope` | `success(data, traceId)` | Fastify inject health 7 tests、`tests/unit/envelope.test.ts` | CODE verified |
| 错误 envelope | `parseApiError` | code/message/userMessageKey/retryable/traceId；未知错误脱敏 | 400/404/500 contract tests；不含 secret | CODE verified |
| 请求头/trace | `buildCommonHeaders` | 接受安全 `X-Trace-Id`/`X-Request-Id`，响应 `X-Trace-Id`；日志 base 含 service/instanceId | contract test + container HTTP | CODE verified |
| 管理隔离 | App 无管理身份契约；总规范要求独立 admin | API `/admin*` 404；Admin `/admin*` 在 P02 身份前 403；两个实例独立 | container-isolation + contract tests | USER/PROPOSED verified |
| 参数与敏感错误 | App `request_parsing.dart` | 严格 query schema，错误不回显 secret | contract test | CODE/PROPOSED |

P01 没有业务端点、workspace/session/幂等、SSE、上传或支付契约，因此不标“全 App 兼容”。App 源码未修改，也未运行 Flutter 构建。

## P02：CODE 源码核对与后端验证

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，工作树 clean。下表 CODE 表示已核对客户端源码；验证使用后端 JSON fixture/Fastify inject/真实 HTTP，没有执行 Dart 解析器或真机联调。上表 P01 的身份边界由本阶段实现替代。

| API/范围 | App 请求与解析证据 | 后端与验证 | 状态 |
|---|---|---|---|
| POST `/api/v1/auth/sms-code`、`/auth/login`、`/auth/refresh` | `AuthClient` → `AuthApi`，endpoint catalog；phone/scene、协议版本/deviceId、refreshToken；解析 tokens/user/workspace | identity routes/schemas/service；OTP 过期/次数/重复/并发，refresh 轮转/复用撤销；identity integration + p02-http | CODE，SMS 仅 mock |
| GET `/api/v1/me/status`、PUT `/me/timezone` | `AuthClient.getUserStatus/updateUserTimeZone`；AuthApi 会话恢复 userId/displayName/phoneMasked、workspaceId/status | status serializer；真实登录/恢复/时区校验 | CODE |
| GET/PATCH `/api/v1/me/profile` | `RemoteUserProfilePort.load/save`，`_parseRemoteProfile`：profile.displayName/avatarResourceId | 昵称读写与隔离；非空头像引用暂时 409，P05 才校验资源归属 | CODE，头像后置 |
| `/api/v1/workspaces`、`/:workspaceId`、`/set-default`、`/disable`、`/restore` | `WorkspaceLifecycleClient` → `SharedWorkspaceSummary/Detail/BootstrapResult`：workspaceId/state/etag、receipt/cursor；If-Match + 幂等键 | scope 显式核权、持久幂等、版本冲突 412；真实 PG 测试跨用户拒绝、创建重放及切换 | CODE |
| POST `/api/v1/onboarding/creative-positioning`；GET `/creative-positionings`、`/workspaces/current/profile` | `OnboardingApi.createFirstContentLine/readDefaultContentLine`、定位解析：creativePositioning/contentLine、creativePositioningId/contentLineId | 唯一 workspace profile，两个 ID 别名指同一对象；只保存答案，onboardingCompleted=false、conclusions=[] | CODE；AI 报告 P09 |
| GET/PATCH `/api/v1/workspaces/:workspaceId/onboarding-draft` | `OnboardingProgressRepository` 当前仅本地持久化；mode/stepIndex/answers/deferredAt | 云草稿持久化/版本/跨用户隔离测试 | PROPOSED；App 未接线 |
| POST `/api/v1/auth/logout`、`/auth/logout-all` | App 当前本地退出需补服务端调用，见改动提案 | 当前设备/全部设备撤销及测试 | PROPOSED；App 未接线 |
| `/admin/api/v1/login/me/logout`、session revoke | 独立管理身份来自阶段规范，无 App 管理员契约 | bootstrap、scrypt、Cookie、CSRF/Origin、RBAC、限流、审计；真实 HTTP/Admin PG 权限测试 | USER/PROPOSED |
| 空 JSON POST | `buildCommonHeaders` 对无 body 的 POST 仍发送 JSON Content-Type | 空 body 兼容；必填登录字段仍 400、错误 JSON 仍 400、未认证退出 401；contract 回归 | CODE |

主要 fixture：`tests/integration/identity.test.ts`、`tests/e2e/p02-http.mjs`。基础契约：`tests/contract/api.test.ts`（8 项）。完整本地校验共 12 unit + 8 contract + 25 integration 通过；HTTP 与四容器隔离另行通过。没有声明未实现的 storage usage、内容同步或 AI run 已兼容。

## P03：任务与 Run 读取证据

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，工作树 clean；只读核对以下客户端实际路径：

| App 证据 | 客户端行为 | P03 后端处理/状态 |
|---|---|---|
| `endpoint_catalog.dart:805-819`、`work_ai_task_api.dart:16-96` | GET `/api/v1/tasks/{taskId}`，POST retry/regenerate；任务字段 taskId/taskType/status/error/retryable | task detail、有限 retry、regenerate 明确 409 `REGENERATION_NOT_AVAILABLE`（业务重新生成留 P09）；`demo.digest` 仅内部 fixture |
| `endpoint_catalog.dart:535-542` | GET `/api/v1/tasks/running` | scope 隔离返回未终态任务 |
| `assistant_runtime.dart:220-246`、`domain_clients.dart:2140-2185` | Agent Run detail/events，`afterSequence`/`Last-Event-ID` 和 SSE | P03 提供通用 task events JSON 游标 `/tasks/{taskId}/events`；Agent Run/SSE 领域端点留 P08，未伪称兼容 |
| `chat_run_tracker.dart`、`remote_project_assistant_runtime.dart` | 断线后按序号补读事件，终态区分 succeeded/failed/cancelled/orphaned | task_events 持久化 sequence、结果先写 PG 再 succeeded；外部 unknown 转 reconciling，不自动重投 |
| `initial_positioning_task_coordinator.dart` | 定位流程保存 taskId 并轮询终态 | P03 提供稳定 taskId/状态/事件；P09 才接真实定位 AI 结果 |

P03 后端新增契约 fixture：`POST /api/v1/tasks/demo`（开发/测试显式启用）、GET task/running/events/result、POST cancel/retry；scope 来自 App session，body/userId 不可越权。真实验证为 14 unit、8 contract、34 PG/Redis integration、`node scripts/e2e-p03.mjs` 和容器隔离；未运行 Flutter/Dart 或真机。

## P04：会员、额度与运行用量

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，工作树 clean；只读核对 billing client、模型、home quota parser 和 repository。`AccountUsageClient` 请求 `GET /api/v1/membership`、`GET /api/v1/account/credits`、`GET /api/v1/runs/{runId}/usage`，`quotaBalances()` 复用 endpoint id `home` 并要求 `data.quotaSummary.balances`。后端保留 `{success,data,traceId}` envelope，credits/tokens/media/provider cost 分开字段，所有额度以 PostgreSQL bigint 结算并在安全范围内序列化。

| API | App 解析证据 | 后端验证 | 状态 |
|---|---|---|---|
| GET `/api/v1/membership` | `account_usage_client.dart`、`SharedAccountMembershipResponse`：`credit-policy-v1`、10,000,000 monthly quota、membership 枚举与 expiresAt 规则 | Fastify contract + 真实 HTTP；development policy 返回 membership/monthly/permanent/account | CODE |
| GET `/api/v1/account/credits` | `SharedAccountCreditSummary`：monthlyCredit、permanentCredit lots、account admission | 真实 PG lot/reservation/ledger 集成与 HTTP smoke | CODE |
| GET `/api/v1/home` | `account_usage_client.dart` endpoint id `home`、`parseAccountQuotaBalances`：`quotaSummary.balances` | credits quotaSummary 真实读取 | CODE |
| GET `/api/v1/runs/{runId}/usage` | `SharedRunUsage`：measurement status、tokens、media quantities、providerCost 字符串 | unknown provider -> uncovered/pending integration path；scope 隔离 | CODE/PROPOSED |

开发政策明确写入 `BILLING_MODE=development`，不接真实支付，也不把 10,000,000 视为正式商业套餐。生产默认 billing disabled，未配置 live policy 时稳定返回 `BILLING_NOT_CONFIGURED`/`BILLING_POLICY_UNAVAILABLE`。

## P05：通用上传当前契约

早期 P05 曾参照 App commit `20f61b78887f9288d1fd3227f326e6374d516f27` 的媒体客户端；该历史参照不能作为当前 App 消费新协议的证明。当前 Server 契约如下，App 只读核对与未接线边界见[通用上传验收](acceptance/generic-uploads.md)。本轮不修改 App、不运行 Flutter。

| API | 请求／响应约定 | 后端状态 |
|---|---|---|
| `POST /api/v1/media/upload-token` | Bearer + `X-Idempotency-Key`；`fileName/mimeType/sizeBytes/workspaceId?`；返回 uploadId/resourceId、绝对 uploadUrl、method、headers、expiresAt、retentionExpiresAt | 本地候选；Redis 幂等受理，不检查剩余空间或预留容量；只签发 OSS part 1 PUT；不写 PG 资源 |
| `POST /api/v1/media/uploads/{uploadId}/complete` | Bearer + 幂等键；body 可含 workspaceId；响应丢失可用同 uploadId 重试 | 本地候选；校验单分片和 HEAD 元数据，保存 Redis completed；返回 `resourceId/fileName/mimeType/sizeBytes/sha256:null`，不触发后续业务 |
| `GET /api/v1/media/uploads/{uploadId}` | Bearer；返回状态、大小与临时有效期 | 本地候选；Redis 临时状态；业务已认领则从 PG 返回 `claimed` 与 `expiresAt:null` |
| `POST /api/v1/media/uploads/{uploadId}/cancel` | Bearer + 幂等键；空 body；返回 `cancel_pending` | 本地候选；取消与业务认领互斥；已认领资源不能当临时上传取消 |
| `GET /api/v1/media/resources/{resourceId}/playback` | Bearer；返回 `resourceId/url/mimeType/fileName/expiresAt/sizeBytes`，`sizeBytes` 为必填正整数字节数 | 正式资源使用认领时保存的字节数，仍有效的已完成上传使用完成时校验的 OSS 对象字节数；跨用户拒绝；实际 GET／Range 由 OSS 承接 |
| 旧 `PUT /api/v1/media/uploads/{uploadId}/object`、`GET /api/v1/media/resources/{resourceId}/object` | 旧 Server 字节代理路径 | 已删除，不提供代理回退或兼容模式 |
| `DELETE /api/v1/workspaces/{workspaceId}/media/resources/{resourceId}` | Bearer + 幂等；解析 `resourceId/workspaceId/status`，status 接受 `deleted` 或 `delete_pending` | CODE；引用检查后返回 `delete_pending`，Worker 异步删除，不在 API 同步删文件 |

头像、资产、手动文本图片及自有文档入口首次使用临时上传时，在各自业务事务中调用 `ResourceClaims`，统一建立资源和归属；后续业务需通过同一入口接入，已有引用继续使用 `resource_refs`。上传完成不触发检查、解析、ASR 或文本任务。Redis 24 小时到期回收以 PG `resources` 是否存在为判定，不查看各业务表，不为每条临时上传生成数据库任务。

## P06 个人资产、文件夹、检索与图谱

以下路径以 `/api/v1` 为前缀，按登录账号鉴权。写入沿用幂等键，更新资产及正文部分携带当前资产 ETag。

| API | Server 当前行为 |
|---|---|
| `GET/POST /content-assets` | 分页读取资产元信息，或创建含 raw、outline、germination 的资产，返回 `contentAssetId`。 |
| `GET/PATCH/DELETE /content-assets/{contentAssetId}` | 资产详情、编辑与删除。返回 `contentAssetRevisionId`、`etag`、`resourceRefs` 和 `sourceRef`。整篇读取可校验 `revisionId`。 |
| `GET/PUT /content-assets/{contentAssetId}/parts/{part}` | 读取或更新当前正文部分，读取返回 `contentMarkdown`、`partRevisionId`、`contentSha256`。 |
| `POST /content-asset-imports` | 将纯文本或 Markdown 写为资产，可引用已有原文件。 |
| `POST /content-assets/batch-move` | 修改账号下资产的文件夹位置，逐项返回结果。 |
| `POST /content-assets/search` | 当前支持 `keyword`、`hybrid`，以及标签、来源、日期和文件夹过滤。返回 `ownerRef.kind=content_asset`、`part=raw` 和整篇资产修订。 |
| `GET /content-navigation/{map}` | 返回有界的资产与标签节点、共同标签边和 `totalContentAssets`。 |
| `GET/POST /content-assets/{contentAssetId}/relations` | 读取或创建资产间的显式关系，创建使用 `targetContentAssetId`。 |
| `DELETE /content-asset-relations/{relationId}` | 按关系 ETag 删除显式关系。 |

创建、列表、详情和搜索统一使用 `assetKind` 的五个值 `creative`（自由创作）、`image`（图片）、`audio`（音频）、`file`（文件）、`link`（链接）。列表在 `data.items[]` 的每一项返回，详情在 `data` 返回。创建时优先使用显式 `assetKind`，缺省时从 `sourceKind` 推断。带来源网址的导入文件仍为 `file`。搜索可通过 `assetKinds` 按一个或多个类型筛选，最多五项。 [资产路由](../src/modules/content-assets/routes.ts)

有效标签由 `content_asset_tags` 维护，自动提取由 `content-asset.tag-extract` 执行。标签写入使用标签自己的 ETag。 [标签与图谱](runbooks/p06-tags.md)

App 只读依据见 [App 源码参照](app-reference.md)。Server 中的搜索路由是当前技术实现。 [搜索业务边界](runbooks/search-status.md)

## 历史记录 · 知识库契约（2026-11-10）

解析器和图文绑定不变。Note 保存 raw 后异步走笔记混合模式，资料保留文件/导入身份并走纯 BM25。索引使用四张元数据表、两个 Collection；详见 [知识库手册](runbooks/milvus.md)。

- 用户入口由 Server 网关验证 JWT；Agent 的 `/internal/v1/rag/query` 传递可信用户/会话身份头，不使用服务间 Secret Key。现行约定见[内部身份](runbooks/internal-auth.md)。
- Agent 现有 Tool 只发送 query/mode/topK，不发版本和归属 ID；Server 默认 Note 混合业务。资料业务显式指定 sourceType=file/text 或使用 `/api/v1/kb/documents/query`，实际仅执行 keyword。
- App 搜索请求/响应保持既有路径和 Envelope。桌面端 `_openWorkspaceSearchResult` 要求 part，并将 revisionId 交给整篇 Note 的精确读取；因此搜索返回 `part=raw` 和整篇 Note 修订，不能用 raw part 修订代替。
- RAG 详情另返回 sourceRevision/partRevisionId 及 UTF-16 命中范围。整篇 GET 的 revisionId 与 part GET 的 partRevisionId 分别校验，错误版本不能静默读取当前内容。
- 不新增工作区产品概念；现有技术归属与权限过滤保留。知识图谱继续基于标签关系。

真实客户端源文件、hash 和测试夹具位置见 app-reference.md。本阶段未运行或修改 Flutter；集成通过只证明相应 HTTP/JSON 契约，不能代替真机验收。

## 历史记录 · 入库线路审计（2026-11-16）

下列内容记录当时的来源分派和调整计划。现行模式、来源和存储映射见 [资产与搜索术语](content-assets.md) 与 [知识库手册](runbooks/milvus.md)。

用户确认的是底层 Note / File 两条 ingestion 线路，未来在产品中叫什么另定。当前实现已有两种索引模式，并没有三套索引引擎。前次审计使用“文档存在两套模型”概括过重，更准确的问题是：原始记录来源被混用为入库/查询类别，造成 File 线路内的来源覆盖不完整。以下是源码事实与后续AI任务边界，本轮没有修改业务实现或执行迁移。

### 审计时的调用链

| 层次 | Note线路 | File线路 |
| --- | --- | --- |
| 接入 | Note创建/更新raw；note-imports最终创建Note | rag/ingestions接收文件URL；text-ingestions接收手工文本或FILE_UPLOAD链接 |
| 原始正文 | notes + note_parts 的当前 raw；修订字段仅作标记 | rag_ingestion_versions指向canonical对象；text_ingestion_jobs保存raw_content/产物引用 |
| 任务 | kb.note-index / kb.note-cleanup | rag.document-ingest / rag.document-cleanup；text.ingest用于另一种接入来源 |
| 编排 | NoteIndexService → NoteIndexJobs → KnowledgeIndexJobs | RagIngestionJobs或TextIngestionJobs准备正文 → 同一个KnowledgeIndexJobs |
| 索引模式 | note-hybrid | document-keyword（file和text来源都使用它） |
| 切分与模型 | 当前最多500码点、可带50码点重叠；qwen3.7-text-embedding-flash原生1024维/FP16、BM25，查询可选qwen3.7-text-rerank；规格以model-profile.ts为准 | 当前最多2000码点、零重叠、BM25；不调用Embedding |
| PostgreSQL索引记录 | kb_note_hybrid_builds / chunks | kb_document_keyword_builds / chunks |
| Milvus目标 | config.kb.noteCollection | config.kb.documentCollection |
| 查询 | RagQueryService；notes/query指定note | RagQueryService；documents/query目前仅指定file，漏掉同线路的text来源 |

Note索引依赖功能开关；只改outline/germination不会按raw变化重建正文索引。导入到Note的TXT/Markdown或可读DOCX仍走Note线路：目标记录决定线路，不能仅凭文件扩展名或“导入”这个动作决定线路。Admin解析试用是临时探针，不是第三条业务入库线路。

### 已确认的具体问题

1. `src/modules/kb/types.ts` 的 IndexMode 已经只有两值，但 KbSourceType 是 note/file/text。`text-ingestion/types.ts` 的注释还明确获取方式区别于note/file，执行时却以 `indexSource({type:'text',...})` 把第三种来源送入公共来源类型。需要分开“线路”和“原始记录引用”，不能让同一字段同时承担两个职责。
2. `rag/routes.ts` 的 documents/query 强制 sourceType=file，`query-service.ts` 再按 b.source_type 做等值筛选。因此 text-ingestions 接入的数据虽已在File的关键词索引中，却被该入口排除。上一轮隔离PG+模拟召回已复现：直接指定text可查到，file文档视图无结果。
3. `kb/repository.ts` 的 sourceState 按file/text选择不同表；`rag/image-links.ts` 也按file走rag_document_assets、按text读取解析manifest。这里的差异属于回源适配。直接把text全部重命名为file，会把text_ingestion_jobs的ID拿去查rag_ingestion_versions；只把查询条件扩大，也会让后续图片解析拿错来源。查询结果必须携带可信的内部原始记录引用，用它选择回源适配器。
4. File线路不同入口的生命周期能力不齐：rag入口有delete/cleanup、目录/章节和解析产物读取；text入口有修改/重试，没有同等的删除入口。需要统一索引层对当前版本、可见性、删除和旧索引回收的保证；业务接口是否都需要同样能力单独判断，不要求为了接口对称而新增产品功能。
5. source.type参与build ID、point ID、互斥锁键和清理选择条件，PG及Milvus中也已有file/text元数据。类型收敛必须评估既有ID、存量数据与索引的一致性，不能只改枚举/路由就宣告完成。旧标记若保留，只能有明确的内部来源语义，不得继续向调用方形成第三条入库线路。

### 当时的调整计划

目标：将入库与检索统一为Note / File两条技术线路，复用已有KnowledgeIndexJobs；获取方式、内容格式、原始记录引用分别表达，业务产品命名留待后续确定。

- 首先给出最小修改方案和原始记录引用映射。优先复用现有两种IndexMode、两个索引目标、Task/Outbox及解析器；不以新增统一业务文档表或合并所有来源表为验收条件，不新增第三套索引器。
- 将text-ingestion按File接入适配处理；Note导入仍以落地Note为准。File查询覆盖所有已发布、授权且当前有效的File来源，调用方无需知道原数据来自哪张表。
- 将回源、图片、权限、当前版本检查与清理按可信原始记录引用分派，避免公共查询类别与存储位置混用。共享索引层保证发布/替换/删除一致；获取方式特有的下载、解析和正文保存可留在适配器。
- 主要核对 kb/{types,repository,jobs}.ts、rag/{jobs,routes,query-service,image-links}.ts、text-ingestion/{types,service,jobs,routes}.ts、NoteIndexService及相关测试。不要连带调整切分参数、模型、计费或其他审计项。
- 同步Server公开/内部RAG参数、结果、OpenAPI和Agent调用契约；先只读核对独立Agent，所需调用方变更写清配套要求。旧接口要么保留为薄接入适配，要么明确随协调发布退出，不保留两份执行算法。
- 检查存量PG与Milvus来源标记及ID计算。若需数据变更，新增编号迁移并列出有界回填/重建和验收依据；不改已执行0001及后续历史、不加物理外键、不清库、不删已有卷、不调用真实付费模型、不自动部署。
- 验收覆盖：Note新建/修改/删除仍走Note；文本、TXT/Markdown和已支持的结构化文件接入同属File；File查询同时返回两种旧来源；Note与File互不串线；跨用户/工作区拒绝；正文/图片引用正确；旧版本不可见且清理不误删当前版本；重试不重复发布；存量索引可查且无新增孤儿点。真实PG/Redis与模拟模型/Milvus结果分别报告。

本轮证据沿用 `.local/architecture-review/reproductions.log`，没有为此次文字梳理重复跑测试。现有最新200个来源的查询范围限制、内部RAG运行时配置漏接属于另列审计项，不能把该限制当作File来源统一后的完整检索验收。

## AI 模板配置

支持资产纲要与编辑器润色目录、生成接口及纲要结果查询。两个场景的生成请求均可通过顶层 `variables` 给提示词中的同名变量传值。请求示例和隔离验证见 [AI 模板配置与 App 契约](runbooks/ai-templates.md)。
