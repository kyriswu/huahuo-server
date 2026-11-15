# 运行配置与处理节点

2026-11-15：业务配置改由 PostgreSQL 管理，入口为独立 Admin 的 `/admin#configuration`。页面沿用 `http://localhost:4111/studio-login` 的黑白灰、字体、间距与表单风格；没有改变管理员 Session 登录协议。管理端继续只绑定原有私网/回环入口，不新增公开监听。

| 分类 | 数据库管理内容 | 生效边界 |
| --- | --- | --- |
| 处理节点 | CPU/GPU、文档/音频能力、ECS/常驻服务、地域/实例/IP/服务地址、健康路径、鉴权变量名、整机并发、空闲/启动/排队时限、可选 A10 ECI 回退 | 新任务选址；已有任务保留节点快照 |
| 解析与模型 | 同步/异步/关闭、完整提取 JSON（模型/设备/DPI/图片策略）、轮询间隔、响应上限 | 新文档任务持久化完整快照，重试沿用 |
| RAG 与检索 | 向量/关键词/融合候选数、RRF、检索客户端并发、Embedding索引批次/并发/超时/重试、重排超时/等待预算、原生文本上限 | 后续请求一致快照；索引构建持久化自己的批次/时限/重试 |
| 任务策略 | 新任务最大次数、重试退避、四队列并发、源文件下载超时 | 次数在创建时保存；其他每次执行取快照；并发约 5 秒同步 |
| 上传与容量 | 业务上传上限、统一用户存储额度、解析源文件上限 | 后续申请/容量检查/执行；不删除旧对象 |
| 计费策略 | 选择已有不可变 `billing_policies` 版本 | 后续发放使用；已发月度额度不重复发、不重写账本 |
| 功能开关 | 文档入库、Note正文索引、标签提供器选择 | 后续请求/执行；不新增模型或知识库 |
| 部署配置 | 变量名与部署总开关状态（只读） | 修改部署环境并重建对应进程 |

每个 HTTP 业务请求/Worker 执行读取一版 DB 配置，通过 AsyncLocalStorage 隔离；执行中不随后台保存而改变。原生文字、OCR、表格、图片、关键词处理逻辑沿用现有实现，CPU/GPU 参数不会自动互转。同一文档节点池的节点必须兼容该完整请求 JSON。现有 LLM/Dify 标签适配器仍未接入，选择它们不会凭空产生能力；生产拒绝 deterministic。

## 环境变量边界

保留DATABASE/Redis连接、密钥/证书、OSS连接与RAM凭据、应用监听/公开URL、模型服务地址/凭据/提供器及固定模型规格、Milvus库和集合绑定、tokenizer部署路径、源文件域名白名单、付费提供器总开关 `BILLING_MODE`、节点总开关 `PROCESSING_NODES_ENABLED=false`、HTTP硬上限及协调租约/去重保留/排队容量。主模板为 `.env.example`；完全重复的 `.env.document-parser.example` 已删除。模型规格固定匹配现有1024维集合，不能把换模型/维度当作普通性能调参。

节点 Bearer Token 在部署中设置 `PROCESSING_NODE_TOKEN_DOCUMENT` 或 `PROCESSING_NODE_TOKEN_AUDIO`，DB 只保存变量名。自定义变量名须以 `PROCESSING_NODE_TOKEN_` 开头，并显式注入需要它的 Admin/Worker/Scheduler；Compose 已提供上述两个标准名。RAM 继续使用唯一一套 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`、可选 `ALIYUN_RAM_SECURITY_TOKEN`。DB/API/页面/审计均不接受或返回这些值。

正式运行路径不再读取旧 `DOCUMENT_PARSER_*`、`DOCUMENT_EXTRACTION_*`、`BILLING_POLICY_VERSION`、`TAG_EXTRACTOR_PROVIDER`、`MAX_UPLOAD_BYTES`、`STORAGE_QUOTA_BYTES`、`RAG_INGESTION_ENABLED`、`RAG_MAX_SOURCE_BYTES`、`RAG_DOWNLOAD_TIMEOUT_MS`。旧ENV加载器已删除；节点和提取配置只通过显式类型化构造器创建，不提供旧ENV兼容入口。既有非秘密业务值已核对导入当前开发库；本轮RAG参数同样先保存当前生效值、再清理主ENV，不覆盖已有后台设置。旧私有核对副本位于 `.local/runtime-config/previous-nonsecret-settings.json`，本轮记录在 `.local/env-cleanup/`。

RAG运行参数也只读数据库：`rag.denseCandidates`、`rag.bm25Candidates`、`rag.hybridCandidates`、`rag.rrfK`、`rag.searchConcurrency`、`rag.embeddingBatchSize`、`rag.indexConcurrency`、`rag.embeddingTimeoutMs`、`rag.embeddingMaxRetries`、`rag.rerankTimeoutMs`、`rag.noteRerankBudgetMs`、`rag.plainTextMaxChars`；Note开关是 `features.noteIndexing`。对应旧ENV、Compose注入及示例已清理，没有环境变量回退。修改后新查询生效；检索参数变化会替换缓存客户端，旧客户端等在途查询结束才关闭，不积累空闲历史客户端。已创建索引构建的批次/并发/时限/重试沿用原快照。

仍保留本地/云端Compose和宿主调试模板，因为角色URL、Profile和宿主地址各有用途；独立GPU预检配置及Xberg镜像运行模板属于不同进程，不是后台数据库配置的重复来源。`grpc_proxy` 是SDK传输环境，继续保留。应用无人读取的 `TOOL_TOKEN_SECRET`、`INTERNAL_API_BASE_URL`、`TOOLS_PUBLIC_BASE_URL` 和早已失效的分块/分析器ENV声明已删除，未改现用JWT/服务密钥/RAM凭据。

## 节点登记与调度

基线只登记一台**不在线**的 CPU 文档 ECS：`i-2zejbbo2svjieb44tqy8`，北京、`172.18.102.103:8000`、`/health`、整机并发 1、空闲 60 秒。CPU 服务完整参数/协议尚未实测，文档解析模式也保持 disabled；不能把历史 CUDA JSON 自动发给它。

每个节点只占 `processing_nodes` 一行：`id`、`config jsonb`、`revision`、`created_at`、`updated_at`。名称、能力、CPU/GPU、运行方式、云实例/地址、并发、超时、在线状态及可选 ECI 回退全部保存在 `config`；编辑覆盖同一行，版本号只递增，不保存配置版本表或版本分支。页面/API继续使用完整类型化节点字段，由服务校验后写入 JSON；凭据仍只引用部署变量。保留必要的操作审计和任务归属快照，不把任务快照当作节点版本记录。

同一 JSON 中的 `(regionId, instanceId)` 由表达式唯一索引保证只登记一次；常驻节点的 `baseUrl` 同样唯一。JSON GIN 索引用于在线状态与处理类型筛选。文档和音频可共用节点，统一计数；音频已支持登记和通用 `withNode('audio', ...)` 占用接口，具体音频 HTTP 协议尚未接入，不能据此声称 ASR 已可用。常驻 HTTP 节点不执行云开停机。

新任务按“未结算分配数 / 节点并发”从低到高选在线节点，事务锁防止并发登记/分配冲突。`processing_node_assignments` 保存稳定请求身份、不可变节点快照和结算状态；异步 GET、取消、结果领取始终使用原节点。设为不在线只停止接新任务，原任务仍可恢复。更新地址、能力、并发等运行参数要求 DB 无未结算分配、Redis 无排队/执行/未知/ECI 归属；已有 ECS 协调状态还须已确认 StopCharging。变更在持有控制锁时更新协调签名，失败不绕过签名检查。

未知远端结果继续占用，不能按租约过期自动释放或重发。提交前先保存 bound，再保存 intent；只有持久状态仍为 bound 的恢复才可重新领取未提交名额。已记录 job 的恢复只 GET；无 job 的模糊 intent 阻断。Redis 丢失时，DB 已开始的未结算占用会阻止新提交；停机也检查整台机器 DB 分配。需要核实的故障保留占用，不用清 Redis、改配置或删除 DB 分配掩盖。

A10 回退作为 GPU 文档 ECS 节点的 `eciFallback` 完整 JSON 可选填写，CPU/音频节点拒绝。只有指定 A10 ECS 明确缺货才进入原 NoSpot ECI 流程，其他错误不申请第二台；网络、内网镜像、ACR、存储参数在 DB，凭据仍在运行环境。详情见 [解析机手册](document-parser-machine.md)。

## 管理 API

全部在独立 Admin，使用管理员 Cookie；不能用 App JWT。operator 只读，superadmin 可写。写操作同时校验 Origin、CSRF、事务内有效 Session/角色；修改与 before/after 审计同事务提交。

- `GET /admin/api/v1/configuration`：当前版本、分类定义/范围/生效方式、值、部署状态、已有计费策略。
- `PUT /admin/api/v1/configuration/{document|rag|tasks|storage|billing|features}`：`{"revision":1,"values":{"tasks.maxAttempts":4}}`，只能提交该分类的白名单键。
- `GET /admin/api/v1/processing-nodes`：登记节点和总开关，**不是实时云库存/健康探测**。
- `PUT /admin/api/v1/processing-nodes/{uuid}`：`{"revision":0,"node":{...完整节点字段...}}` 创建；已有节点携带旧 revision，成功递增。
- `pnpm document-parser:machine status`：只读 DB/Redis 登记与协调状态；不查询/修改云资源。配置修改走 Admin，无 configure-idle 绕过命令。

并发保存版本冲突返回 409，页面保留当前表单并提示刷新核对。未知键、越类修改、类型/范围/完整 JSON、部署硬上限和已知秘密字段均受校验，不允许任意 KV。计费只选择已有不可变版本，本轮不提供改写历史策略/账本操作。

## 当前部署与后续拆分

用户随后授权启动现有环境：已保留数据地同步新增3张配置表及旧业务设置，四个独立角色更新至同一镜像且healthy/readiness200。地址 http://127.0.0.1:3001/admin#configuration ，使用原账号。CPU节点和节点总开关仍关闭，尚未进行真实CPU文档解析或音频服务验收。完整证据见 [验收](../acceptance/runtime-configuration.md)。

现有库同步先验证旧基线checksum与HEAD完全一致、新基线仅追加所需DDL，再在单事务中建表/索引/授权、保存业务配置、检查旧表行数及零外键，最后CAS更新checksum。没有自动重跑整份初始化、DROP、TRUNCATE、删除卷或重置凭据。唯一0001继续用于新空库；后续结构更新仍须先审阅实际差异，不能仅修改checksum掩盖不一致。

四个角色可拆到不同主机：分别使用自己的SERVICE_ROLE、数据库连接/连接池和运行配额；共享同一PostgreSQL、Redis及一致的REDIS_KEY_PREFIX。Worker可按WORKER_QUEUES拆分/扩容，节点并发和云启停归属仍由共享状态协调。管理员入口保持受控，迁移只由独立的一次性migrate执行。拆分时配置可达的内网服务地址、相同JWT校验资料与所需密钥引用。

当前文件存储为local、API/Worker共用现有卷；跨主机部署前应切换现有aliyun-oss适配器并保持同Bucket/前缀，不能让不同主机使用各自不共享的本地目录。音频目前只完成节点登记/占用边界，实际HTTP协议接入另行验收。

## 管理员解析试用

访问 `/admin#configuration`，切到“解析与模型”，点击标题旁的“文档解析试用”打开弹窗；没有独立试用菜单或页面。关闭弹窗不取消任务，在当前配置页重新打开可继续查看；提示中的“解析配置”关闭弹窗并返回该页。使用已保存的配置，未保存的编辑不会被提交为试用参数。

上传文件或提供允许域名下的直链，查看临时结果；不写业务资料/笔记/入库任务/索引。PDF/Office继续使用同一完整配置及节点占用，原生文本直接走既有文本解析。试用上限32MiB、全局一个并行任务，结果保留15分钟，重启丢失；Admin多副本需要试用请求实例亲和。

此功能仅superadmin可用，保留操作审计与节点占用。图片上传仍按镜像原配置执行，不在本窗口登记为业务素材。当前CPU完整参数及节点尚未启用，原生文本可直接试用，不能声称PDF已上云验证。详见[试用验收](../acceptance/admin-document-trial.md)。

当前电脑只是本地开发环境，不在解析机的可达内网中；云机开机不会使本地自动具备内网路由。用户会将代码部署至真正的内网测试机，届时先核对健康/协议与完整CPU参数，再启用解析配置和节点；本轮不开云机，不将节点改成公网地址。
