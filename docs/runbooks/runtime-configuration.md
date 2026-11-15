# 运行配置与处理节点

2026-11-15：业务配置改由 PostgreSQL 管理，入口为独立 Admin 的 `/admin#configuration`。页面沿用 `http://localhost:4111/studio-login` 的黑白灰、字体、间距与表单风格；没有改变管理员 Session 登录协议。管理端继续只绑定原有私网/回环入口，不新增公开监听。

| 分类 | 数据库管理内容 | 生效边界 |
| --- | --- | --- |
| 处理节点 | CPU/GPU、文档/音频能力、ECS/常驻服务、地域/实例/IP/服务地址、健康路径、鉴权变量名、整机并发、空闲/启动/排队时限、可选 A10 ECI 回退 | 新任务选址；已有任务保留节点快照 |
| 解析与模型 | 文档试用入口；调用参数在各处理节点的高级设置中管理 | 试用读取配置、直连同一客户端；正式任务走持久调度 |
| RAG 与检索 | 向量/关键词/融合候选数、RRF、检索客户端并发、Embedding索引批次/并发/超时/重试、重排超时/等待预算、原生文本上限 | 后续请求一致快照；索引构建持久化自己的批次/时限/重试 |
| 任务策略 | 新任务最大次数、重试退避、四队列并发、源文件下载超时 | 次数在创建时保存；其他每次执行取快照；并发约 5 秒同步 |
| 上传与容量 | 业务上传上限、统一用户存储额度、解析源文件上限 | 后续申请/容量检查/执行；不删除旧对象 |
| 计费策略 | 选择已有不可变 `billing_policies` 版本 | 后续发放使用；已发月度额度不重复发、不重写账本 |
| 功能开关 | 文档入库、Note正文索引、标签提供器选择 | 后续请求/执行；不新增模型或知识库 |
| 部署配置 | 变量名与部署总开关状态（只读） | 修改部署环境并重建对应进程 |

每个 HTTP 业务请求/Worker 执行读取一版 DB 配置，通过 AsyncLocalStorage 隔离；执行中不随后台保存而改变。原生文字、OCR、表格、图片、关键词处理逻辑沿用现有实现，CPU/GPU 参数不会自动互转。各文档节点分别保存 `documentApi`，无需共用 CPU/GPU 提取 JSON。现有 LLM/Dify 标签适配器仍未接入，选择它们不会凭空产生能力；生产拒绝 deterministic。

## 环境变量边界

当前现有开发库已通过Admin保存[16核32GiB目标配置](../../resources/runtime-configuration/16c-32g.json)：内容队列8、维护2、AI/商业各1，下载超时300秒，单文件上传及解析源文件各200MiB，每用户10GiB；自动执行3次、重试基础1秒/封顶基准60秒。它是部署目标的初始策略，不是按硬件自动推算的吞吐保证，也不修改本地Compose资源限额。配置保存在数据库，预设文件仅供核对/新环境按类别保存，不作为第二套自动覆盖来源。

内容并发限制每个Worker当前正在执行的阶段，下载/提交/结果入库会占槽；远端异步等待让出槽位，不把“8”当作同时解析文档总数。云端另按节点整机名额协调，当前节点仍16；检索请求不通过该内容队列。200MiB文件上线前，现有解析服务需要应用[配套HTTP限额](../../resources/document-extraction/http-limits-200m.env.example)并重建容器；本地不启动云机替代这一步。Admin功能试用仍以32MiB为上限。见[验收](../acceptance/runtime-capacity-16c32g.md)。

保留DATABASE/Redis连接、密钥/证书、OSS连接与RAM凭据、应用监听/公开URL、模型服务地址/凭据/提供器及固定模型规格、Milvus库和集合绑定、tokenizer部署路径、源文件域名白名单、付费提供器总开关 `BILLING_MODE`、节点总开关 `PROCESSING_NODES_ENABLED=false`、HTTP硬上限及协调租约/去重保留/排队容量。主模板为 `.env.example`；完全重复的 `.env.document-parser.example` 已删除。模型规格固定匹配现有1024维集合，不能把换模型/维度当作普通性能调参。

节点 Bearer Token 在部署中设置 `PROCESSING_NODE_TOKEN_DOCUMENT` 或 `PROCESSING_NODE_TOKEN_AUDIO`，DB 只保存变量名。自定义变量名须以 `PROCESSING_NODE_TOKEN_` 开头，并显式注入需要它的 Admin/Worker/Scheduler；Compose 已提供上述两个标准名。RAM 继续使用唯一一套 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`、可选 `ALIYUN_RAM_SECURITY_TOKEN`。DB/API/页面/审计均不接受或返回这些值。

正式运行路径不再读取旧 `DOCUMENT_PARSER_*`、`DOCUMENT_EXTRACTION_*`、`BILLING_POLICY_VERSION`、`TAG_EXTRACTOR_PROVIDER`、`MAX_UPLOAD_BYTES`、`STORAGE_QUOTA_BYTES`、`RAG_INGESTION_ENABLED`、`RAG_MAX_SOURCE_BYTES`、`RAG_DOWNLOAD_TIMEOUT_MS`。旧ENV加载器已删除；节点和提取配置只通过显式类型化构造器创建，不提供旧ENV兼容入口。既有非秘密业务值已核对导入当前开发库；本轮RAG参数同样先保存当前生效值、再清理主ENV，不覆盖已有后台设置。旧私有核对副本位于 `.local/runtime-config/previous-nonsecret-settings.json`，本轮记录在 `.local/env-cleanup/`。

RAG运行参数也只读数据库：`rag.denseCandidates`、`rag.bm25Candidates`、`rag.hybridCandidates`、`rag.rrfK`、`rag.searchConcurrency`、`rag.embeddingBatchSize`、`rag.indexConcurrency`、`rag.embeddingTimeoutMs`、`rag.embeddingMaxRetries`、`rag.rerankTimeoutMs`、`rag.noteRerankBudgetMs`、`rag.plainTextMaxChars`；Note开关是 `features.noteIndexing`。对应旧ENV、Compose注入及示例已清理，没有环境变量回退。修改后新查询生效；检索参数变化会替换缓存客户端，旧客户端等在途查询结束才关闭，不积累空闲历史客户端。已创建索引构建的批次/并发/时限/重试沿用原快照。

仍保留本地/云端Compose和宿主调试模板，因为角色URL、Profile和宿主地址各有用途；独立GPU预检配置及Xberg镜像运行模板属于不同进程，不是后台数据库配置的重复来源。`grpc_proxy` 是SDK传输环境，继续保留。应用无人读取的 `TOOL_TOKEN_SECRET`、`INTERNAL_API_BASE_URL`、`TOOLS_PUBLIC_BASE_URL` 和早已失效的分块/分析器ENV声明已删除，未改现用JWT/服务密钥/RAM凭据。

## 节点登记与调度

基线只登记一台**不在线**的 CPU 文档 ECS：`i-2zejbbo2svjieb44tqy8`，北京、`172.18.102.103:8000`、`/health`、整机并发 1、空闲 60 秒；现有开发库已保存的并发 16 保留。该 ECS 已部署 Xberg：按需唤醒既有实例，等 `/health` 就绪后 POST `/extract-async`；默认省略 `config`，沿用服务端现有参数，不要求镜像名或 CPU 提取 JSON。云端真实解析仍待在内网验收，部署总开关和当前节点保持关闭。

每个节点只占 `processing_nodes` 一行：`id`、`config jsonb`、`revision`、`created_at`、`updated_at`。名称、能力、CPU/GPU、运行方式、云实例/地址、并发、超时、在线状态及可选 ECI 回退全部保存在 `config`；编辑覆盖同一行，版本号只递增，不保存配置版本表或版本分支。页面/API继续使用完整类型化节点字段，由服务校验后写入 JSON；凭据仍只引用部署变量。保留必要的操作审计和任务归属快照，不把任务快照当作节点版本记录。

页面默认只展示名称、ECS 实例 ID、服务地址、整机并发、空闲停机等待和在线状态，并提供“手动启动”。地域、处理类型、健康检查、鉴权引用、超时和可选完整提取覆盖收在高级设置；当前 CPU 不显示 GPU ECI 镜像配置。ECS 的私网 IP 从服务地址提取并校验；常驻服务无需云实例信息。ECI 缺货回退需要创建容器，仍有自己的镜像和网络配置，不能等同于已有 ECS 的 API 调用。

`documentApi` 默认 `mode=async`、`parameters=null`、`timeoutSeconds=3120`、`pollMs=2000`、`maxResponseBytes=67108864`，节点仅接受 async。null 表示完全不发送 multipart `config`，不是发送 `null` 或空对象；显式覆盖仍须完整 JSON。省略该节点字段也使用同样默认值，正常保存时写入本节点同一个 config JSON。全局 `document.mode/parameters/pollMs/maxResponseBytes` 已移除，无全局提取参数或 ENV 回退。既有安装升级前需核对各节点覆盖和异步协议；不得将历史 GPU 配置复制给 CPU。当前开发库已完成调整，新环境从空 values 使用节点默认值。正式任务收到 202 后让出 Worker，由认证回调唤醒；约60秒一次补偿检查，`pollMs` 不是正式任务的持续轮询频率。

手动启动只将已有 ECS 的启动任务和快照写入维护队列，立即返回 202；重复操作复用进行中的任务。Worker 分步骤启动/检查服务，等待时释放执行槽；状态通过 SSE 推送，不为每台机器常驻一个进程。节点“不在线”时也可提前手动启动，但不会因此接收新业务；部署总开关关闭时按钮禁用且服务端拒绝入队。就绪后仍遵守原空闲停机等待。

母文件/批次 UUID 在业务受理时冻结；实际选中节点时冻结该节点的地址、唤醒方式和调用配置。异步恢复只查询原节点；明确文件级失败后的安全重试继承原分配的调用参数，机器路由变更时拒绝换机重试。服务默认模式的 configHash 只标识“省略覆盖”，不证明远端模型/服务配置未改变；需要稳定模型版本时应由部署版本或显式完整覆盖保证。

同一 JSON 中的 `(regionId, instanceId)` 由表达式唯一索引保证只登记一次；常驻节点的 `baseUrl` 同样唯一。JSON GIN 索引用于在线状态与处理类型筛选。文档和音频可共用节点，统一计数；音频已支持登记和通用 `withNode('audio', ...)` 占用接口，具体音频 HTTP 协议尚未接入，不能据此声称 ASR 已可用。常驻 HTTP 节点不执行云开停机。

新任务按“未结算分配数 / 节点并发”从低到高选在线节点，事务锁防止并发登记/分配冲突。`processing_node_assignments` 保存稳定请求身份、不可变节点快照和结算状态；异步 GET、取消、结果领取始终使用原节点。设为不在线只停止接新任务，原任务仍可恢复。更新地址、能力、并发等运行参数要求 DB 无未结算分配、Redis 无排队/执行/未知/ECI 归属；已有 ECS 协调状态还须已确认 StopCharging。变更在持有控制锁时更新协调签名，失败不绕过签名检查。

未知远端结果继续占用，不能按租约过期自动释放或重发。提交前先保存 bound，再保存 intent；只有持久状态仍为 bound 的恢复才可重新领取未提交名额。已记录 job 的恢复只 GET；无 job 的模糊 intent 阻断。Redis 丢失时，DB 已开始的未结算占用会阻止新提交；停机也检查整台机器 DB 分配。需要核实的故障保留占用，不用清 Redis、改配置或删除 DB 分配掩盖。

A10 回退作为 GPU 文档 ECS 节点的 `eciFallback` 完整 JSON 可选填写，CPU/音频节点拒绝。只有指定 A10 ECS 明确缺货才进入原 NoSpot ECI 流程，其他错误不申请第二台；网络、内网镜像、ACR、存储参数在 DB，凭据仍在运行环境。详情见 [解析机手册](document-parser-machine.md)。

## 管理 API

全部在独立 Admin，使用管理员 Cookie；不能用 App JWT。operator 只读，superadmin 可写。写操作同时校验 Origin、CSRF、事务内有效 Session/角色；修改与 before/after 审计同事务提交。

- `GET /admin/api/v1/configuration`：当前版本、分类定义/范围/生效方式、值、部署状态、已有计费策略。
- `PUT /admin/api/v1/configuration/{rag|tasks|storage|billing|features}`：`{"revision":1,"values":{"tasks.maxAttempts":4}}`，只能提交该分类的白名单键。
- `GET /admin/api/v1/processing-nodes`：登记节点和总开关，**不是实时云库存/健康探测**。
- `PUT /admin/api/v1/processing-nodes/{uuid}`：`{"revision":0,"node":{...完整节点字段...}}` 创建；已有节点携带旧 revision，成功递增。
- `POST /admin/api/v1/processing-nodes/{uuid}/start`：superadmin 手动启动已有 ECS，202 返回任务身份，不同步等待开机。
- `GET /admin/api/v1/processing-nodes/{uuid}/start-status`：最近启动任务状态；ready 表示上次启动已就绪，不是持续健康探测。
- `GET /admin/api/v1/processing-nodes/{uuid}/start-events`：SSE 推送启动任务变化，终态关闭；心跳只保活连接。
- `pnpm document-parser:machine status`：只读 DB/Redis 登记与协调状态；不查询/修改云资源。配置修改走 Admin，无 configure-idle 绕过命令。

并发保存版本冲突返回 409，页面保留当前表单并提示刷新核对。未知键、越类修改、类型/范围/完整 JSON、部署硬上限和已知秘密字段均受校验，不允许任意 KV。计费只选择已有不可变版本，本轮不提供改写历史策略/账本操作。

## 当前部署与后续拆分

用户随后授权启动现有环境：已保留数据地同步新增3张配置表及旧业务设置，四个独立角色更新至同一镜像且healthy/readiness200。地址 http://127.0.0.1:3001/admin#configuration ，使用原账号。CPU节点和节点总开关仍关闭，尚未进行真实CPU文档解析或音频服务验收。完整证据见 [验收](../acceptance/runtime-configuration.md)。

现有库同步先验证旧基线checksum与HEAD完全一致、新基线仅追加所需DDL，再在单事务中建表/索引/授权、保存业务配置、检查旧表行数及零外键，最后CAS更新checksum。没有自动重跑整份初始化、DROP、TRUNCATE、删除卷或重置凭据。唯一0001继续用于新空库；后续结构更新仍须先审阅实际差异，不能仅修改checksum掩盖不一致。

四个角色可拆到不同主机：分别使用自己的SERVICE_ROLE、数据库连接/连接池和运行配额；共享同一PostgreSQL、Redis及一致的REDIS_KEY_PREFIX。Worker可按WORKER_QUEUES拆分/扩容，节点并发和云启停归属仍由共享状态协调。管理员入口保持受控，迁移只由独立的一次性migrate执行。拆分时配置可达的内网服务地址、相同JWT校验资料与所需密钥引用。

当前文件存储为local、API/Worker共用现有卷；跨主机部署前应切换现有aliyun-oss适配器并保持同Bucket/前缀，不能让不同主机使用各自不共享的本地目录。音频目前只完成节点登记/占用边界，实际HTTP协议接入另行验收。

## 管理员解析试用

访问 `/admin#configuration`，切到“解析与模型”，点击标题旁的“文档解析试用”打开弹窗；没有独立试用菜单或页面。关闭弹窗不取消任务，在当前配置页重新打开可继续查看；提示中的“解析配置”关闭弹窗并返回该页。使用已保存的配置，未保存的编辑不会被提交为试用参数。

上传文件或提供允许域名下的直链，查看临时结果；不写业务资料、笔记、入库任务、索引、审计、节点分配或持久回调。PDF/Office读取已保存节点配置，通过同一客户端直接调用已启动且可访问的解析API；功能探测允许在内存中查询异步状态，不进入正式任务调度和机器开停流程。原生文本直接走既有文本解析。试用上限32MiB、每进程一个并行任务，结果保留15分钟；刷新、重启或换副本后允许中断并重新发起，不新增持久化或强制实例亲和。

此功能仅superadmin可用，保留认证、配置读取和上传校验。图片上传仍按镜像原配置执行，不在本窗口登记为业务素材。当前节点总开关和节点尚未启用，原生文本可直接试用，不能声称PDF已上云验证。详见[试用验收](../acceptance/admin-document-trial.md)和[正式异步链路验收](../acceptance/document-async-events.md)。

当前电脑只是本地开发环境，不在解析机的可达内网中；云机开机不会使本地自动具备内网路由。用户会将代码部署至真正的内网测试机，届时先核对健康/协议与完整CPU参数，再启用解析配置和节点；本轮不开云机，不将节点改成公网地址。
