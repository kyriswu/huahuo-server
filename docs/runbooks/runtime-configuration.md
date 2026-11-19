> 搜索功能确定需要，现有技术实现保留；具体业务细节尚未确定。本文记录当前代码，不作为未来产品需求，后续可按明确业务调整。见[需求边界](search-status.md)。

# 运行配置与处理节点

2026-11-15：业务配置改由 PostgreSQL 管理，入口为独立 Admin 的 `/admin#configuration`。页面沿用 `http://localhost:4111/studio-login` 的黑白灰、字体、间距与表单风格；没有改变管理员 Session 登录协议。管理端继续只绑定原有私网/回环入口，不新增公开监听。

| 分类 | 数据库管理内容 | 生效边界 |
| --- | --- | --- |
| 处理节点 | CPU/GPU、文档/音频能力、ECS/常驻服务、地域/实例/IP/服务地址、健康路径、鉴权变量名、整机并发、自动调度开关、空闲/启动/排队时限、可选 A10 ECI 回退 | 新任务选址；已有任务保留节点快照 |
| 解析与模型 | 文档试用入口；调用参数在各处理节点的高级设置中管理 | 试用读取配置、直连同一客户端；正式任务走持久调度 |
| RAG 与检索 | 向量/关键词/融合候选数、RRF、检索客户端并发、Embedding索引批次/并发/超时/重试、重排超时/等待预算、手动正文上限 | 后续请求一致快照；索引构建持久化自己的批次/时限/重试 |
| 任务策略 | 新任务最大次数、重试退避、四队列并发 | 次数在创建时保存；执行和每轮调度分别取快照；并发约 5 秒同步 |
| 上传与容量 | 业务上传上限、统一用户存储额度 | 后续申请/容量检查；不删除旧对象 |
| 计费策略 | 选择已有不可变 `billing_policies` 版本 | 后续发放使用；已发月度额度不重复发、不重写账本 |
| 功能开关 | 文档入库、Note正文索引、标签提供器选择 | 后续请求/执行；不新增模型或知识库 |
| 部署配置 | 变量名、云端控制与内网API调用开关（只读） | 修改部署环境并重建对应进程 |

每个 HTTP 业务请求/Worker 执行读取一版 DB 配置，通过 AsyncLocalStorage 隔离；执行中不随后台保存而改变。TXT、Markdown、CSV、PDF、Office 等源文件统一由外部服务读取 OSS 链接并解析；Server 不下载或转发源文件。CPU/GPU 参数不会自动互转。各文档节点分别保存 `documentApi`，无需共用 CPU/GPU 提取 JSON。现有 LLM/Dify 标签适配器仍未接入，选择它们不会凭空产生能力；生产拒绝 deterministic。

Scheduler每轮只读取一次运行配置，上传过期清理、任务恢复、定时任务创建和Outbox投递共用该轮快照；轮次中途保存配置不影响在途轮次，下一轮采用新版本。配置读取失败或校验失败时，本轮不执行清理/调度、不刷新扫描成功时间，按原间隔再次尝试。健康接口读取配置用于检查就绪，不代替后台轮次的配置上下文。

`tasks.maxAttempts`在所有新任务的INSERT中写入；补投、回调唤醒和自动恢复只操作投递，不重写任务原来的执行上限。后台手动启动节点同样在已鉴权路由内获取配置快照。人工重试仍沿用原有追加执行机会规则，不因这次修复改变含义。没有新增配置键、缓存或额外扫描定时器；单个Scheduler每轮增加一次单行配置查询，创建任务省去原先补写上限的UPDATE。

## 环境变量边界

[16核32GiB目标配置](../../resources/runtime-configuration/16c-32g.json)当前保留内容队列8、维护2、AI/商业各1、业务上传上限200MiB、每用户10GiB；自动执行3次、重试基础1秒/封顶基准60秒。它是部署目标的初始策略，不是按硬件自动推算的吞吐保证，也不修改本地Compose资源限额。配置保存在数据库，预设文件仅供核对/新环境按类别保存，不作为第二套自动覆盖来源。

内容并发限制每个Worker当前正在执行的阶段，提交解析请求和结果入库会占槽；远端异步等待让出槽位，不把“8”当作同时解析文档总数。云端另按节点整机名额协调，当前节点仍16；检索请求不通过该内容队列。源文件大小、下载超时和重定向限制由读取 OSS 链接的外部解析服务负责；Server 的业务上传额度不作为解析源文件或外部产物上限。此前中转方式的容量记录仅是[历史验收](../acceptance/runtime-capacity-16c32g.md)。

`tasks.downloadTimeoutMs`、`storage.maxSourceBytes` 已从运行配置注册表、应用类型和预设删除，不再展示或接受保存。已有数据库中的这两个键沿用通用未知键过滤，不参与运行配置；无需迁移或改写已执行迁移，也不增加旧逻辑入口。外部解析正文与图片清单分别采用固定16MiB产物上限，正文接收、索引恢复和图片清单读取按对应上限检查。`rag.plainTextMaxChars` 用于手动文本和 Note 正文索引，不限制外部文件的解析内容。

保留DATABASE/Redis连接、密钥/证书、OSS连接与RAM凭据、应用监听/公开URL、模型服务地址/凭据/提供器及固定模型规格、Milvus库和集合绑定、源文件域名白名单、付费提供器总开关BILLING_MODE、云端控制与私网API调用开关、HTTP硬上限及协调租约/去重保留/排队容量。主模板为`.env.example`；完全重复的`.env.document-parser.example`已删除。模型规格固定匹配现有1024维集合，不能把换模型/维度当普通性能调参。

环境由 `APP_ENV` 区分：`development` 为本地开发，`test` 为线上测试，`production` 为线上生产；分支名称和 Docker 的 `NODE_ENV=production` 不决定业务环境。

处理节点登记并配置好后直接接收匹配任务，不再设置部署级解析调用开关。未登记匹配节点时报告节点不可用；已配置但连接失败时按实际健康探针和调用结果报告不可达，保留现有超时、取消和提交后未知结果恢复。`PROCESSING_NODES_CLOUD_CONTROL_ENABLED`仅控制云端启停，省略或为空时测试/生产默认允许；开发环境在完整RAM凭据存在时默认允许。任何环境均可显式false禁止本部署开机及空闲停机。默认允许不提供凭据，实际云操作仍要求完整RAM凭据及其权限，并受超级管理员/业务调度授权和既有机器锁约束，不绕过会话或CSRF。

测试部署使用 `APP_ENV=test`，建议显式 `PROCESSING_NODES_CLOUD_CONTROL_ENABLED=true`，四常驻角色注入已有授权的 `ALIYUN_RAM_ACCESS_KEY_ID` 和 `ALIYUN_RAM_ACCESS_KEY_SECRET`。本期发布在写库前逐角色校验；migrate只校验环境，不需要云凭据。旧ENV明确false时必须先改为true，使用同一配置快照重新创建四角色，单纯restart不会更新ENV。隔离CI虽然也使用test，但显式关闭云控制且不继承真实凭据。生产执行器尚未接入，生产默认值通过本地配置解析验收，不代表已部署。见[环境与云控制验收](../acceptance/cloud-control-environments.md)。

这里的网络环境是发起请求的Admin/Worker服务器，不是浏览器所在网络。浏览器从外网访问同VPC的后台时，后台仍可走内网解析；本地外网部署可以通过阿里云公网控制接口开机，但保持私网API调用关闭。控制专用部署可用[外网配置片段](../../resources/processing-nodes/external-control.env.example)，Worker仅消费maintenance；同VPC部署用[内网片段](../../resources/processing-nodes/test-control.env.example)。配置片段合入原环境，不替换已有凭据和连接。

节点 Bearer Token 在部署中设置 `PROCESSING_NODE_TOKEN_DOCUMENT` 或 `PROCESSING_NODE_TOKEN_AUDIO`，DB 只保存变量名。自定义变量名须以 `PROCESSING_NODE_TOKEN_` 开头，并显式注入需要它的 Admin/Worker/Scheduler；Compose 已提供上述两个标准名。RAM 继续使用唯一一套 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`、可选 `ALIYUN_RAM_SECURITY_TOKEN`。DB/API/页面/审计均不接受或返回这些值。

正式运行路径不再读取旧 `DOCUMENT_PARSER_*`、`DOCUMENT_EXTRACTION_*`、`BILLING_POLICY_VERSION`、`TAG_EXTRACTOR_PROVIDER`、`MAX_UPLOAD_BYTES`、`STORAGE_QUOTA_BYTES`、`RAG_INGESTION_ENABLED`、`RAG_MAX_SOURCE_BYTES`、`RAG_DOWNLOAD_TIMEOUT_MS`。旧ENV加载器已删除；节点和提取配置只通过显式类型化构造器创建，不提供旧ENV兼容入口。既有非秘密业务值已核对导入当前开发库；本轮RAG参数同样先保存当前生效值、再清理主ENV，不覆盖已有后台设置。旧私有核对副本位于 `.local/runtime-config/previous-nonsecret-settings.json`，本轮记录在 `.local/env-cleanup/`。

RAG运行参数也只读数据库：`rag.denseCandidates`、`rag.bm25Candidates`、`rag.hybridCandidates`、`rag.rrfK`、`rag.searchConcurrency`、`rag.embeddingBatchSize`、`rag.indexConcurrency`、`rag.embeddingTimeoutMs`、`rag.embeddingMaxRetries`、`rag.rerankTimeoutMs`、`rag.contentAssetRerankBudgetMs`、`rag.plainTextMaxChars`；资产索引开关是 `features.contentAssetIndexing`。对应旧ENV、Compose注入及示例已清理，没有环境变量回退。修改后新查询生效；检索参数变化会替换缓存客户端，旧客户端等在途查询结束才关闭，不积累空闲历史客户端。已创建索引构建的批次/并发/时限/重试沿用原快照。

仍保留本地/云端Compose和宿主调试模板，因为角色URL、Profile和宿主地址各有用途；独立GPU预检配置及Xberg镜像运行模板属于不同进程，不是后台数据库配置的重复来源。`grpc_proxy` 是SDK传输环境，继续保留。应用无人读取的 `TOOL_TOKEN_SECRET`、`INTERNAL_API_BASE_URL`、`TOOLS_PUBLIC_BASE_URL` 和早已失效的分块/分析器ENV声明已删除，未改现用JWT/服务密钥/RAM凭据。

## 节点登记与调度

初始清单包含一台默认可接收任务的CPU文档ECS：`i-2zejbbo2svjieb44tqy8`，北京、`172.18.102.103:8000`、`/health`、初始并发1、空闲60秒；现有开发库已保存的并发16保留。该ECS已部署Xberg：文档任务按需唤醒，等内网`/health`就绪后POST`/extract-async`，默认省略config沿用服务端参数，无需镜像名或CPU提取JSON。手动开机只等实例Running，不等待此健康检查。当前本地私网API调用关闭，真实解析仍待内网验收。

每个节点只占 `processing_nodes` 一行：`id`、`config jsonb`、`revision`、`created_at`、`updated_at`。名称、能力、CPU/GPU、运行方式、云实例/地址、并发、超时、自动调度开关及可选 ECI 回退全部保存在 `config`；编辑覆盖同一行，版本号只递增，不保存配置版本表或版本分支。真实电源状态不存成配置布尔值。页面/API继续使用完整类型化节点字段，由服务校验后写入 JSON；凭据仍只引用部署变量。保留必要的操作审计和任务归属快照，不把任务快照当作节点版本记录。

节点清单只随代码发布新增：后台无新增入口，编辑接口只UPDATE已存在节点，未知ID返回404，不能通过revision=0创建。当前已执行0001冻结；未来确需新增节点时，使用受审查的后续编号迁移登记普通ID/JSON，不改旧初始化或在应用启动时自动导入覆盖。现有节点参数仍可经后台权限、版本与排空检查编辑。

页面主要展示名称、ECS 实例 ID、服务地址、整机并发、空闲停机等待及只读运行状态，并提供“开机”和“刷新状态”。服务器名称旁的胶囊标签自动显示“按需启停”（由系统控制已有ECS）或“常驻运行”（直接调用已有HTTP服务），来自已保存的唤醒方式，不新增字段或配置来源。它表示运行方式，不据此推断按量付费/包年包月。

云实例主状态只取Describe：Running为在线，Starting/Pending或本次开机任务仍进行时为开机中，Stopped为不在线，Stopping为停机中，查询失败为状态未知。解析API独立返回ready/unreachable/not_checked/not_running；未启用私网调用时不探测内网，serviceReady为null，不能把未检测写成失败。实例Running但API不可达仍显示在线，并标明API连通性。常驻HTTP节点没有云端电源状态，只按其可检测的服务连通性显示。历史启动成功不充当当前运行证明。

开机中、已在线、停机中及状态未知时不提供重复开机操作，没有手动关机控件。状态通过Redis机器事件、PG启动任务事件与SSE更新，心跳只保活；外部控制台修改可通过刷新状态/重新聚焦页面核对。

2026-11-16：移除“参与自动调度／接收新任务”配置，节点登记后默认可选，不再以config.enabled筛选；默认可选不表示机器常驻在线。0003将旧JSON字段固定true以兼容交接中的旧容器，新接口不再接收/返回它。地域、处理类型、健康检查、鉴权引用、超时和可选完整提取覆盖同样收在高级设置，当前CPU不显示GPU ECI镜像配置。ECS私网IP从服务地址提取并校验，常驻服务无需云实例信息；ECI缺货回退需要独立的容器镜像/网络配置。

`documentApi` 默认 `mode=async`、`parameters=null`、`timeoutSeconds=3120`、`pollMs=2000`、`maxResponseBytes=67108864`，节点仅接受 async。null 表示完全省略 JSON 请求的 `config`，不是发送 `null` 或空对象；显式覆盖仍须完整 JSON。省略该节点字段也使用同样默认值，正常保存时写入本节点同一个 config JSON。全局 `document.mode/parameters/pollMs/maxResponseBytes` 已移除，无全局提取参数或 ENV 回退。既有安装升级前需核对各节点覆盖和异步协议；不得将历史 GPU 配置复制给 CPU。当前开发库已完成调整，新环境从空 values 使用节点默认值。正式任务收到 202 后让出 Worker，由认证回调唤醒；约60秒一次补偿检查，`pollMs` 不是正式任务的持续轮询频率。

手动开机只将已有ECS的任务和快照写入维护队列，立即返回202；重复操作复用进行中的任务。Worker短步骤只调用云控制接口，观测到Running即完成，内网健康不通或缺少API Bearer变量不影响开机，不会偷偷回退申请ECI。等待时释放执行槽，不为每台机器常驻进程。关闭自动调度仍可提前手动开机；即使没有解析请求，也从开机任务完成时开始按idleSeconds计时，达到时限后自动节省停机。有请求时，从最后一个请求结算后重新计时；排队、执行中或结果未知的请求会阻止停机，状态查看/健康检查不重置业务空闲时间。监控由独立云控制权限决定，常驻运行节点不适用此停机规则。

只有云控制被显式禁止、缺少必要凭据/查询条件，或实例控制状态不允许启动时才禁用开机；私网API调用开关关闭不影响它。文档解析路径仍要求内网调用已启用并通过健康检查。部署配置变更需同一快照重建对应四角色，docker restart不重新读取env文件；不修改解析机私网地址为公网，也不通过Admin数据库保存真实凭据。

母文件/批次 UUID 在业务受理时冻结；实际选中节点时冻结该节点的地址、唤醒方式和调用配置。异步恢复只查询原节点；明确文件级失败后的安全重试继承原分配的调用参数，机器路由变更时拒绝换机重试。服务默认模式的 configHash 只标识“省略覆盖”，不证明远端模型/服务配置未改变；需要稳定模型版本时应由部署版本或显式完整覆盖保证。

同一 JSON 中的 `(regionId, instanceId)` 由表达式唯一索引保证只登记一次；常驻节点的 `baseUrl` 同样唯一。JSON GIN 索引用于自动调度开关与处理类型筛选。文档和音频可共用节点，统一计数；音频已支持登记和通用 `withNode('audio', ...)` 占用接口，具体音频 HTTP 协议尚未接入，不能据此声称 ASR 已可用。常驻 HTTP 节点不执行云开停机。

新任务按“未结算分配数 / 节点并发”从低到高选择具备对应能力的已登记节点，事务锁防止并发登记/分配冲突。`processing_node_assignments`保存稳定请求身份、不可变节点快照和结算状态；异步GET、取消、结果领取始终使用原节点。节点没有单独的停领开关，已有任务继续按原快照恢复。更新地址、能力、并发等运行参数要求DB无未结算分配、Redis无排队/执行/未知/ECI归属；已有ECS协调状态还须已确认StopCharging。变更在持有控制锁时更新协调签名，失败不绕过签名检查。

未知远端结果继续占用，不能按租约过期自动释放或重发。提交前先保存 bound，再保存 intent；只有持久状态仍为 bound 的恢复才可重新领取未提交名额。已记录 job 的恢复只 GET；无 job 的模糊 intent 阻断。Redis 丢失时，DB 已开始的未结算占用会阻止新提交；停机也检查整台机器 DB 分配。需要核实的故障保留占用，不用清 Redis、改配置或删除 DB 分配掩盖。

A10 回退作为 GPU 文档 ECS 节点的 `eciFallback` 完整 JSON 可选填写，CPU/音频节点拒绝。只有指定 A10 ECS 明确缺货才进入原 NoSpot ECI 流程，其他错误不申请第二台；网络、内网镜像、ACR、存储参数在 DB，凭据仍在运行环境。详情见 [解析机手册](document-parser-machine.md)。

## 管理 API

全部在独立 Admin，使用管理员 Cookie；不能用 App JWT。operator 只读，superadmin 可写。写操作同时校验 Origin、CSRF、事务内有效 Session/角色；修改与 before/after 审计同事务提交。

- `GET /admin/api/v1/configuration`：当前版本、分类定义/范围/生效方式、值、部署状态、已有计费策略。
- `PUT /admin/api/v1/configuration/{rag|tasks|storage|billing|features}`：`{"revision":1,"values":{"tasks.maxAttempts":4}}`，只能提交该分类的白名单键。
- `GET /admin/api/v1/processing-nodes`：已登记节点与私网API调用开关，**不是实时云库存/健康探测**；独立云控制权限见configuration的bootstrap。
- `PUT /admin/api/v1/processing-nodes/{uuid}`：只编辑已发布节点，携带当前revision与完整节点字段，成功递增；未知ID返回404，不创建记录。
- `POST /admin/api/v1/processing-nodes/{uuid}/start`：superadmin 手动启动已有 ECS，202 返回任务身份，不同步等待开机。
- `GET /admin/api/v1/processing-nodes/{uuid}/status`：只读实例/健康状态、检查时间、是否可开机及最近启动任务；禁止缓存。
- `GET /admin/api/v1/processing-nodes/{uuid}/events`：SSE推送运行与启动状态；初次读取、机器/任务事件触发检查，没有数据库或云状态轮询定时器。离开页面/发布排空时释放订阅。旧Admin页面在升级后刷新。
- `pnpm document-parser:machine status`：只读 DB/Redis 登记与协调状态；不查询/修改云资源。配置修改走 Admin，无 configure-idle 绕过命令。

并发保存版本冲突返回 409，页面保留当前表单并提示刷新核对。未知键、越类修改、类型/范围/完整 JSON、部署硬上限和已知秘密字段均受校验，不允许任意 KV。计费只选择已有不可变版本，本轮不提供改写历史策略/账本操作。

## 当前部署与后续拆分

现有本地四个独立角色已更新且healthy/readiness200，地址 http://127.0.0.1:3001/admin#configuration ，使用原账号。当前私网API调用关闭，RAM配置允许独立云控制；CPU节点未参与自动调度，实例只读确认为Stopped。未触发真实开机、CPU文档解析或音频验收。完整证据见[验收](../acceptance/processing-node-status.md)。

配置表初始化同步属于[此前验收记录](../acceptance/runtime-configuration.md)，不作为后续操作模板。测试服务器首次发布后，0001及所有已执行迁移均冻结；新环境按编号顺序创建，后续Schema或节点清单变更使用受审查的新编号迁移。禁止重写checksum、重跑初始化或在应用启动时覆盖已有配置。本轮节点状态与控制权限调整无需迁移。

四个角色可拆到不同主机：分别使用自己的SERVICE_ROLE、数据库连接/连接池和运行配额；共享同一PostgreSQL、Redis及一致的REDIS_KEY_PREFIX。Worker可按WORKER_QUEUES拆分/扩容，节点并发和云启停归属仍由共享状态协调。管理员入口保持受控，迁移只由独立的一次性migrate执行。拆分时配置可达的内网服务地址、相同JWT校验资料与所需密钥引用。

当前文件存储为local、API/Worker共用现有卷；跨主机部署前应切换现有aliyun-oss适配器并保持同Bucket/前缀，不能让不同主机使用各自不共享的本地目录。音频目前只完成节点登记/占用边界，实际HTTP协议接入另行验收。

## 管理员解析试用

访问 `/admin#configuration`，切到“解析与模型”，点击标题旁的“文档解析试用”打开弹窗；没有独立试用菜单或页面。关闭弹窗不取消任务，在当前配置页重新打开可继续查看；提示中的“解析配置”关闭弹窗并返回该页。使用已保存的配置，未保存的编辑不会被提交为试用参数。

提供允许域名下的 OSS 链接，查看临时结果；不写业务资料、笔记、入库任务、索引、审计、节点分配或持久回调。所有文件类型读取已保存节点配置，通过同一客户端将链接提交给已启动且可访问的解析API；功能探测允许在内存中查询异步状态，不进入正式任务调度和机器开停流程。每进程一个并行任务，结果保留15分钟；刷新、重启或换副本后允许中断并重新发起，不新增持久化或强制实例亲和。

此功能仅superadmin可用，保留认证、配置读取和 OSS 链接校验。图片产物上传仍由外部解析服务执行，不在本窗口登记为业务素材。当前本地私网API调用未启用，所有源文件解析均需外部服务，不能声称已上云验证；此限制不阻止节点页面通过云控制接口开机。详见[试用验收](../acceptance/admin-document-trial.md)和[正式异步链路验收](../acceptance/document-async-events.md)。

当前电脑只是本地开发环境，不在解析机的可达内网中；云机开机不会使本地自动具备内网路由。用户会将代码部署至真正的内网测试机，届时先核对健康/协议与完整CPU参数，再启用解析配置和节点；本轮不开云机，不将节点改成公网地址。

Admin文档试用对已配置的健康路径先执行一次有界GET；不就绪时明确返回ADMIN_TRIAL_SERVICE_UNREACHABLE，尚不提交文件。提交后的网络未知仍不自动重发。试用不启动机器、不延长业务空闲时限；正式用户任务继续按需唤醒。
