# 分类运行配置与 Admin 验收（2026-11-15）

## 16核32GiB目标策略

现有Admin已保存任务/容量新值，运行配置revision5；当前本地四角色已更新并验证。预设是数据库配置的核对副本，不自动覆盖后续管理员修改。内容并发8指每Worker的执行阶段，不限制远端等待中文档总数；200MiB文件还需内网解析服务应用配套HTTP限额。486项unit/contract、243项真实独立PG/Redis通过（1项跳过），见[本轮验收](runtime-capacity-16c32g.md)。

## 手动启动与正式异步回调补充

当前节点默认 async，新增手动启动与事件推送；现有本地库无损同步、四角色更新，473项unit/contract、241项隔离PG/Redis通过（1项跳过）。Admin试跑继续纯内存直连，不参与业务调度。下方同步默认及旧镜像记录属于此前验收，最新行为和真实环境权限边界见[本轮验收](document-async-events.md)。

## 按节点调用与 ECS 简化配置（2026-11-15）

当前 CPU ECS 直接走既有 API，不要求镜像或完整提取 JSON。删除全局四项 document 设置和重复开关，调用参数归各节点 config JSON；默认 /extract 同步调用且不发送 config，提取器沿用服务端默认模型/设备。节点分配快照覆盖调用参数，已知 job 恢复只 GET，安全文件重试仍用原分配参数。CPU 页面默认仅核心字段，其他选项折叠，GPU ECI 镜像配置对 CPU 隐藏；试用仍在解析与模型 Modal，关闭原因区分部署开关与无在线节点。

本轮仅验证本地后端及 Admin，不请求 ECS/ECI 控制面、内网解析或付费模型。真实依赖测试使用独立临时 PostgreSQL/Redis，提取服务由 loopback/fetch 替身提供；不能作为 CPU 实机解析验收。未修改识别核心、App、Schema 或唯一基线。最终检查与主环境同步证据见 `.local/node-api/`。

436项unit/contract、223项真实隔离PG/Redis集成通过（1项Milvus跳过），typecheck/lint/build、Compose展开及UI检测通过。与镜像构建并行的一轮集成出现PG连接中断和既有5秒用例超时；构建结束后原样重跑通过，未放宽时限。新增覆盖CPU省略config、显式GPU覆盖、两节点不同同步/异步参数、已知job在节点编辑后仍只GET、文件重试保留原调用参数，以及业务FILE_UPLOAD/试用共用客户端。

现有开发库先回滚演练再单事务调整：移除四项旧全局键，CPU节点增加server-defaults调用配置，保留实例/地址/16并发/文档音频能力/不在线状态；运行配置revision2→3，节点3→4。Chrome用原账号完成两次原值保存验证后节点revision6，仍只有一条记录。用户/管理员/工作区各1条，笔记/资源/入库表0，原132条维护任务与结果保留，物理外键0；Schema和基线checksum未改，无凭据或ENV变动。

主Compose四角色使用同一完整镜像huahuo-server:node-api-20261115（2f171262…2e798e），healthy/readiness200；HTML/JS200，匿名管理401，App同路径404。Chrome确认默认六项核心字段、CPU无镜像项、高级配置可折叠、空提取覆盖直接保存及成功反馈、试用入口与新关闭原因；1512px/390px无横向溢出。云开机和节点在线开关保持关闭，不发出云控制面、内网解析或付费请求，真实PDF/Office待用户部署内网后验证。

证据：.local/node-api/ 的 db-rehearsal.json、db-result.json、runtime-result.json、测试/构建日志与node-config.jpg / node-config-390.jpg。App两份只读参照哈希一致，不改App、不推进Pxx，当前代码未提交/推送。


## ENV清理与RAG参数后台管理（2026-11-15）

按用户要求新增“RAG 与检索”：12项候选数量/RRF/客户端并发/索引批次与并发/Embedding时限和索引重试/重排时限与等待预算/原生文本上限由现有runtime_configuration的同一个values JSON管理，Note索引开关放在“功能开关”。没有新增表、版本表或ENV兼容读取。地址、凭据、库/集合绑定、固定模型规格、tokenizer部署路径和源文件域名白名单仍属于服务部署配置。

查询与Worker执行各持有一致参数；检索客户端缓存按参数替换，旧请求完成后才释放旧客户端，避免调参不生效或关闭在用连接。Rerank使用后续请求的配置；索引构建继续冻结批次/并发/时限/重试，Embedding适配器使用已保存构建时限。未新增模型、检索模式或自动重建索引。

主.env、旧.env.compose.local及6份示例共清理133条声明（含同名键在多份文件中的重复），删除与主模板重复的.env.document-parser.example。除已迁DB参数，还删除无人读取的TOOL_TOKEN_SECRET/INTERNAL_API_BASE_URL/TOOLS_PUBLIC_BASE_URL及旧分块/分析器项，Compose与新环境初始化脚本同步。保留仍有用途的本地/云端/宿主调试模板、独立GPU配置及Xberg远端运行模板；grpc_proxy属于SDK传输环境。其余保留键逐项解析值一致，真实ENV权限仍0600，没有重置现用凭据或新增凭据副本。

当前值先准备映射、完成真实开发库回滚演练，再将13项写入原配置行并记录deployment-import审计，revision1→2；原后台值及节点逐项不变，业务/索引表行数未改，schema/checksum未改，物理外键0。12项已有ENV值原样保留，未显式配置的Rerank时限保持原默认30000毫秒，Note开关保持原true，然后删除主ENV旧项。不开云机，不调用内网解析或付费模型。

typecheck/lint/build通过；435项unit/contract、222项真实隔离PG/Redis集成通过（1项Milvus跳过）。新增验证覆盖RAG分类/权限/范围、执行中快照隔离、缓存换参且不关闭在用实例、旧构建Embedding时限，以及六份模板无重复键/无退役项。新增用例中Milvus与模型为替身，不冒称真实供应商验收。主Compose与本地/云端示例静态展开通过，退役项不再注入，Admin仍回环绑定。

当前主环境四角色同一完整镜像healthy/readiness200；HTML/JS200、匿名配置401、App同路径404，实际进程环境不再含退役项。Chrome确认12个RAG字段、现有值、编辑后保存按钮启用/刷新恢复且未提交改值，1512px与390px均无横向溢出，浏览器error/warn为空。角色运行核对与DB参数对照保存在runtime-result.json；后台改动留在原配置revision2，未作真实检索调用。

证据：`.local/env-cleanup/`中的三份ENV审计、rag-import-plan.json、db-import-rehearsal.json、db-import-result.json、测试/构建日志及截图。App两份参照哈希一致，不写App、不推进Pxx，未提交/推送。

## 节点配置收拢为 JSON（2026-11-15）

按用户要求，节点仍原地更新同一行，版本号仅是递增字段，不建立配置历史版本表。`processing_nodes` 仅保留 `id`、`config jsonb`、`revision`、`created_at`、`updated_at`；16项节点配置合并到 `config`。页面/API继续使用相同类型化字段，服务继续做权限、完整校验、revision防覆盖、排空检查和同事务审计。物理实例及常驻地址唯一索引改用JSON表达式；筛选使用JSON GIN索引。保留任务已绑定节点快照以便恢复，不是节点历史版本功能；没有旧列读取或双写兼容路径。

唯一0001同步新结构，新空库真实集成通过。现有开发RDS先完成DDL回滚演练，再于暂停四个本地角色期间单事务转换：逐项对照所有节点值、ID/revision/时间、运行配置、任务归属及业务表计数，全部一致才CAS更新基线校验并提交。原CPU节点仍只有1条，版本3、文档/音频能力和并发16保留；未覆盖成基线默认值。物理外键0，没有清库、删除卷、重置账号或重跑整份初始化。

本轮434项unit/contract、220项真实隔离PG/Redis集成通过（1项Milvus跳过），typecheck/lint/build与Compose静态校验通过；新增用例证明多次编辑只保留同一行/JSON、版本递增、过期版本409、非法并发拒绝。运行证据位于 `.local/runtime-config/node-json-modal/`，包含schema-plan.sql、schema-rehearsal.json、schema-result.json及测试日志。后台试用入口改为解析与模型页的Modal，见[试用验收](admin-document-trial.md)。

## 现有本地环境已启动（2026-11-15）

用户随后明确要求不用隔离环境，启动当前项目。已核对原RDS基线与HEAD一致、新基线仅追加3张配置表，在事务内新增表/索引/授权并导入5项原非秘密业务配置，最后CAS更新基线校验；没有重跑整份0001、清库、修改原账号或重置凭据。用户、会话、工作区、笔记、资源及任务行数前后一致，物理外键仍为0。

现有主Compose的api-server/admin/worker/scheduler已使用同一完整构建镜像更新，四者healthy/readiness200；未建立新数据库/隔离栈或改动已有卷。Admin在 http://127.0.0.1:3001/admin#configuration ，沿用原账号。HTML/JS 200，匿名配置接口401，API-server同路径404。CPU节点及PROCESSING_NODES_ENABLED保持关闭，未开停云机器或调用解析。运行证据：.local/runtime-config/start-existing/runtime-result.json、database-sync.jsonl；镜像完整构建日志image-build-full.log。首次窄范围打包发现缺少API依赖，已改为锁文件完整构建并通过四角色模块导入/启动验证。


本轮按用户要求完成：数据库管理处理节点及业务配置，按类型提供 Admin 页面。页面只参考 `http://localhost:4111/studio-login` 的黑白灰配色、字体、间距和表单质感；管理员账号/Session、CSRF 和实际配置流程不改成该页面的手机号登录。最初 ECS 详情参考只用于分类/详情信息组织。

## 交付

- 复用独立 Admin，新增「运行配置」入口 `/admin#configuration`：处理节点、解析与模型、任务策略、上传与容量、计费策略、功能开关、只读部署配置。保存/读取错误、加载、权限只读、空节点、新增/编辑、版本冲突有对应状态。
- PostgreSQL `processing_nodes`、`processing_node_assignments`、`runtime_configuration` 加入唯一初始化基线。普通 ID/索引，物理外键为 0；没有新增独立增量迁移、ORM 外键、触发器或旧认证兼容分支。
- 基线登记北京 CPU 文档 ECS `i-2zejbbo2svjieb44tqy8` / `172.18.102.103:8000`，停用；部署总开关与文档模式也关闭。未虚构 CPU 服务参数或把 CUDA 参数发送给 CPU。
- 同一 ECS 唯一登记，多节点按未结算分配/并发比选址；文档/音频共用整机占用；不可变绑定用于后续查询/取消/领取。音频仅节点登记与通用占用接口，具体服务协议尚未接入。
- 继续使用原 ECS/Redis 状态机，按机器 DB+Redis 占用判断停机。bound 提交前恢复、job 只查询、模糊提交阻断；Redis 丢失保留 DB 远端占用，不自动当作空闲。仍需人工核实的占用保留，不能删锁掩盖，可能继续计费。
- 保留显式 A10 ECS 缺货回退 NoSpot ECI，作为 GPU 文档节点可选完整配置；CPU/音频节点拒绝回退。没有调用云端申请/启停/解析。
- 配置白名单、类型/范围、完整解析 JSON、密钥拒收、分类边界与 revision CAS。superadmin 写入事务内复核有效 Session/角色，Origin/CSRF 校验；修改与 before/after 审计原子提交。operator 只读，App JWT 不能访问管理 API，API-server 不装载管理路由。
- 每请求/执行批次读一致 DB 快照；完整文档提取参数在受理时冻结。新任务次数持久化，队列并发约5秒同步。计费只选已有不可变策略，切换不会重复发同月额度或改写历史账本。
- `.env`/Compose 清理旧业务/目标项，保留连接、凭据、部署开关与硬上限；本机非秘密旧值私有备份，未自动写入业务库。标准节点鉴权只保存 ENV 变量名；RAM 仍用唯一 AK 命名。

## 证据

| 检查 | 结果与范围 |
| --- | --- |
| `pnpm typecheck` | 通过，严格后端 TypeScript 与 Admin TypeScript |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过，含 Admin 静态产物；Vite 提示单 JS chunk 约808KB，未作打包优化 |
| `pnpm test` | 435 项 unit/contract 通过，均不是云端验收 |
| `pnpm test:integration` | 215 项通过，1 项 Milvus 跳过；真实隔离 PG17/Redis7、临时本地存储、loopback 模拟解析器/云替身 |
| `pnpm compose:validate` | 通过，仅静态展开/校验，没有启动或重建容器 |
| DB 关系与授权 | 真实 public Schema 外键数量0、普通关系索引/CRUD、Worker 无配置写权限通过 |
| 异步/调度 | 节点亲和、停用恢复、跨类型共享容量、排空更新、Redis占用丢失阻断、提交前崩溃只提交一次、未知提交不重发通过 |
| 配置/安全 | Session/JWT 隔离、CSRF、operator 禁写、参数/秘密字段拒绝、CAS/同事务审计、执行快照隔离、真实 API 上传上限、计费切换不重复发放通过 |
| 页面参考 | 只读 HTTP 读取4111页面源样式，未操作该服务登录或其他项目；设计静态检测无发现 |
| 浏览器 | 用户后来允许 Chrome；重连及重置后工具仍报告 browser host unavailable、浏览器列表空。未完成渲染截图/交互验收，不宣称浏览器通过 |

测试日志在本机 `.local/runtime-config/{unit-contract-final,integration-final,build-final}.log`，设计检测为 `design-detect.json`；这些不含实际业务凭据。测试容器仅本轮随机命名/tmpfs/回环端口，执行器核对 owner 后全部清理，没有删除已有数据卷。集成用例遇到隔离 DB 时钟短暂回拨，领取帮助函数改为等待真实可执行时间，未改业务调度规则。

## 部署与边界

本轮代码改动留在工作区；没有执行实际 RDS/开发库结构变更、改迁移 checksum、重建主 Compose、启动云资源或调用生产付费服务。已有库不能直接重跑变更后的0001；应单独备份并审阅无损结构/配置同步，不能清库或在启动时自动重置。尚未完成真实 CPU 文档服务或音频协议验收；本轮不推进新的 Pxx，不代表 P14 全部交付。操作说明见 [运行配置手册](../runbooks/runtime-configuration.md)。

只读核对实际 App `../huahuo-ai/lib/core/network/api_endpoints.dart` SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`lib/features/auth/data/http_auth_repository.dart` SHA256 `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`；与本轮开始参照一致。App 未写入、未运行 Flutter，无移动端端到端验收声明。
