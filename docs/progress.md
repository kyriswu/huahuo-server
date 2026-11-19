## ContentAsset 统一命名（2026-11-19，本地验收）

Server 资产主表及关联、接口字段、路由、AI 纲要、索引任务和后台文案统一使用 ContentAsset 与「资产」。增量迁移 0020 原地改名，并退役旧文件夹级联恢复标记。原文件使用 Resource。 [当前契约](contract-compatibility.md)

类型检查、Lint 和构建通过。隔离 PostgreSQL/Redis 从 13 升到 20，重跑无待执行迁移，业务表外键数为零。486 项集成测试通过，4 项真实 Milvus 用例跳过。首轮发现的三处测试样本命名差异已修正，复验通过。App 为只读参照。物理 Milvus 集合沿用现有地址，共享开发和测试环境留在本地演练后的验收点。

## 笔记归属与组织关系（2026-11-19，本地验收）

笔记按账号归属，工作区可见范围与文件夹位置由关系表表达。删除文件夹后，笔记正文、附件、标签和可搜索性按原状态保留。迁移 `0019` 保留既有笔记和历史恢复标记。App 源码作为只读参照。 [兼容契约](contract-compatibility.md) · [App 参照](app-reference.md)

类型检查、Lint 和构建通过。1195 项单元与契约测试和 486 项隔离 PostgreSQL/Redis 集成测试通过，4 项真实 Milvus 测试跳过。迁移演练从 13 升至 19，重跑无待执行迁移，业务表物理外键为零。演练覆盖跨账号隔离、旧笔记和附件引用、文件夹删除后搜索及历史恢复。全量复跑前修正了任务领取时机、审计顺序和管理员测试样本清理。迁移在隔离库执行。

## Redis Bearer 鉴权缓存（2026-11-19，本地验收）

入口支持直读 Redis 中的短期 Bearer 会话。Server 负责验签、首次填充、令牌刷新和状态失效，默认最长 15 秒。0018 提供提交后的账号与会话状态失效通知。1,195 项单元/契约、484 项隔离集成通过，Lua 模块通过真实 Nginx/Redis 和 HTTP 鉴权替身测试。当前停在本地验收点。[验收记录](acceptance/bearer-auth-cache.md)

## PostgreSQL底层写入优化（2026-11-18，本地候选，未发布）

按用户要求控制范围：0016仅禁用每小时写摘要的默认maintenance占位任务，保留历史与调度；周期补投复用同条Outbox/jobId，终态Redis job可重入，避免Worker未消费时反复加行；disabled标签不建自动必败任务，显式提取503；KB每256 chunk批量查复用/插入，ordinal查找改Map，未扩展搜索业务。类型/Lint/构建、1,194单元/契约、483真实隔离PG/Redis/Milvus全部通过；schema12→16、重复迁移为空、四角色及零外键验收通过。没有设置历史保留期、删除现有数据或扩展新组件，既有发布兼容阻断保留；未提交/部署/写共享库。见[优化验收与边界](acceptance/pg-row-growth-optimization-20261118.md)。

## PostgreSQL记录增长审查（2026-11-18，只读）

只读聚合现有共享开发/测试库（schema12）并核对各组件写入：public61表、活行估计1,936、约3.63MiB；当前任务205，其中201为每小时maintenance。确认无统一PG历史回收，重点风险为未消费补投、解析续跑、KB历史chunk及幂等大响应；记录数量与UPDATE死版本分开。具体行数、增长模型和优先顺序见[审查记录](acceptance/pg-row-growth-20261118.md)。没有删除数据、修改配置/应用/迁移或部署；未自行确定保留期限。

## 搜索功能保留，业务细节待定（2026-11-17，本地候选）

用户明确搜索功能确定需要，现有实现保留；业务范围、交互、接口及具体策略尚未定。查询Service/入口、技术配置、指标及测试保持现有实现；不把当前实现当成既定产品需求，不继续扩展功能或接线App/Agent。此前历史债务清理和正确性修复保留。见[需求边界](runbooks/search-status.md)及[本期验收](acceptance/debt-cleanup-20261117.md)。未修改共享库或部署。

## 历史债务清理（2026-11-17，本地候选，未发布）

按用户明确授权移除历史实现、旧字段别名、占位入口及混合版本兼容；修复文件夹恢复、幂等身份、任务重试和全来源检索。新增 0013–0015，既有 0001–0012 未修改；本期各兼容声明 false，自动发布阻断。最终类型/Lint/构建、1,188 单元/契约及 475 真实隔离 PG/Redis/Milvus 测试通过，schema 12→15 与重复迁移、零外键验收通过。首次图片更新锁回归已修并保留失败事实，UI 浏览器预览不可用。完整验证及已知边界见[清理验收](acceptance/debt-cleanup-20261117.md)。以下均为各自时间点的历史记录，以本项及具体最新验收为准。

## 测试发布完成（2026-11-17 14:50）

全仓业务候选经 PR #26 合入 test，实际部署 5af896d，main 控制为 owner 合并 #25 的 64e2a46，两份准确 push CI 均成功。首次不兼容维护在仓库外独立执行，先停全部旧写入方再应用 0004–0011；五阶段 5/5、四角色健康、无强退，schema 11/零物理外键。1163 单元/契约与462隔离集成通过，资源用户归属、无内容去重、引用归零自动硬删及当前 Note 已部署；普通发布入口未增加放行或永久兼容逻辑。

公开 ready、匿名401、无效回调404已复核，实际镜像/快照与成功记录一致。真实 OSS 上传/解析/模型未联调，Bucket CORS/残片生命周期仍待后续运维配置。本机共享库旧四角色已停，不能用旧镜像在新 schema 重启；Redis/独立入口/Agent 未操作。本记录不代表重建本机开发布局。见[实际发布与边界](acceptance/test-release-20261117.md)。

## 配置整理与移除部署级解析调用开关（2026-11-17，本地完成）

实际ENV与七份根级/规格模板统一分组，删除过时tokenizer、双向鉴权空标题、历史验收和重复注释。用户明确要求配置好节点就直接调用，已完整删除PROCESSING_NODES_ENABLED及config.enabled、Admin状态/列表字段和UI分支；按实际配置选择节点，连接不可达显示unreachable，保留调用期限、租约、取消和未知结果恢复。云启停权限仍独立，不为此扩展实际云操作。

纯整理保留所有值；删除旧开关后逐键/Compose脱敏比对其他值不变。1163项unit/contract、458项隔离PG/Redis通过（4项Milvus跳过），类型/Lint/构建/Compose/diff通过。无本项新SQL/依赖/密钥，旧键停用已记录在候选清单，未更新实际环境、启动节点、发布或重启。见[验收及测试边界](acceptance/node-call-configuration.md)。

## 清除双向服务 Secret Key 配置（2026-11-17，本地完成）

生产代码与Compose已不读取服务间Key，本轮从.env、.env.compose.local及两份规格ENV模板删除双向废弃项；同步删除已废弃的agent-jwt接入手册，修正当前文档仍要求JWT+ServiceKey的旧说明。保留外部用户认证与第三方服务自身密钥。内部路由仍通过统一策略区分入口，同一业务共用Service；RAG公开/内部共用同一个RagQueryService实例和query路由工厂。

42项配置/网关/内部策略/生产注册契约测试通过；脱敏检查全部运行ENV及模板无旧键、Compose展开没有角色收到旧键、diff检查通过。无新代码分支/依赖/迁移，未改Agent仓库、重启或发布。

## 用户资源与当前 Note 收敛（2026-11-17，本地完成，待发布）

按用户最终定义，resources 仅归用户，移除工作区、重复上传 ID、解析状态和软删除时间；不做内容去重，删除候选 MD5 字段/索引和客户端哈希要求，sha256 可空备用。每次独立上传生成新 UUID，多个业务显式使用同一 resourceId 可跨自己的工作区，空间只计一次。引用关系与 reference_count 同事务增减；最后一个引用解除时自动提交现有 storage.delete 任务，Worker 删 OSS 后硬删资源并释放空间，失败按原任务重试，完成回执避免重放多扣。请求重试依赖轻量元数据幂等，不读取文件。临时阶段继续仅 Redis、首次起 24 小时、不计空间、不加临时额度限制，业务成功后清 Redis。保留已有查询索引，不新增清理组件或缓存。

Note 改为 note_parts 当前值，每部分一行；修订字段只用于并发/异步防旧写，不留正文历史和历史图片 pin。移除历史 part query/basePartRevisionId，If-Match 仍强制。新增 0009–0011，不改冻结 SQL；孤立/跨用户引用在迁移前拒绝，旧写入须排空，兼容项维持 false。

最终规则的全仓类型/Lint/构建、1163 项单元/契约及 461 项真实隔离 PG/Redis/Milvus 集成通过（无跳过），另有 111 项定向复测；schema 3→11、重复迁移为空、四角色及零物理外键通过，OSS 为本地替身。前一轮 MD5 草案数量仅作历史证据。用户要求等待另一个窗口，本轮不固定候选或提交/触发发布；未执行共享库迁移、服务重启或部署。见[完整证据与边界](acceptance/user-resources-and-current-notes.md)。此前上传解耦记录为历史轮次，当前资源归属/引用/正文契约以上述为准。

## Server 内部 HTTP 协定与通用客户端（2026-11-17，本地完成，未部署）

内部API由单入口注册到/internal/v1，业务继续分模块，统一显式鉴别策略、no-store和公开OpenAPI隐藏；漏配策略启动失败。RAG公开/内部共用Schema/handler/运行配置；gateway会话刷新/注销在请求校验后执行，回调能力在读取大响应前授权。解析回调迁入内部前缀，生成URL与trace识别同步，删除旧公开路径；Agent当前RAG/gateway路径保持。当前无Server主动调用Agent业务，不预建空壳客户端。

手写出站HTTP共用ServiceHttpClient，复用原生连接池，统一trace、deadline/取消、拒绝重定向、受限JSON和响应释放；业务provider保留各自协议、凭据、状态码与重试，解析unknown不自动重发。1168项单元/契约、456项隔离PG/Redis通过（4项Milvus跳过），类型/Lint/构建通过；首次并行上传fixture和2项时序失败已留证后复验。无本项SQL/ENV/依赖变更，不改其他Agent项目或App、不联网调用真实云、未提交/发布/重启。见[轻量协定](runbooks/internal-services.md)及[验收边界](acceptance/internal-services.md)。

## 通用上传、业务认领与用户空间汇总（2026-11-17，本地完成，未部署）

上传阶段仅 Redis 保存 24 小时临时回执、幂等关系和到期索引，不维护用户临时空间计数、不判断剩余额度，也不增加异常上传限流或临时文件数量/总量限制；文件大小保留为校验元数据。Server 控制 OSS 单片上传的初始化/完成/取消，文件不经 Server；上传 ID、resourceId 与 OSS Key 使用同一 UUID。业务 API 首次使用时才在同一事务校验正式额度、登记资源、正式占用和引用，提交成功后清 Redis；清理失败不影响正式用量或空间判定。到期清理只核对统一资源表，不遍历业务表，保留崩溃/重试下的误删保护。移除上传的场景/时长/数字分身入参及旧 PG 上传流程，临时预览不触发业务。

users 增加 used/reserved 两个非负字节计数，正式认领使用用户行条件更新完成额度判断和 used 增量，不再逐次 SUM 明细。既有 PostgreSQL reserved 基础逻辑与临时上传无关，本次保留；认领、既有容量预留及正式删除均事务维护计数，幂等重试不重复增减。明细与普通索引保留用于细分统计和对账，未扩展权益/扣费政策或新增汇总任务。新增 0007/0008，不改冻结迁移；现有占用一次初始化且失败整笔回滚。

最终 typecheck、lint、build、diff 检查通过；1142 项单元/契约、451 项真实隔离 PG/Redis/Milvus 通过且无跳过，schema 3→8、重复迁移为空、四角色及零物理外键验收通过。之前失败的测试替身/fixture 与一次测试凭据公网读取已如实留证，后者已加默认禁止网络的 guard；真实 OSS 联调与千万行压测未完成。App 仅读，不修改共享数据库、运行服务或部署；兼容项保持 false，目标迁移准备另行评估。见[完整证据、迁移边界及 Redis 故障限制](acceptance/generic-uploads.md)。

## 全仓回归完成（2026-11-17，历史轮次；上传已由上项替代）

当前工作区类型、Lint、Server/Admin构建、本机/云模板Compose解析及diff检查通过；1109项单元/契约、397项真实隔离PG/Redis/Milvus全部通过、无跳过。版本3→6应用0004/0005/0006、重复迁移为空、四角色断言与零物理外键验收通过。前次OSS测试类型和Scheduler发布断言权限阻塞已解除。本轮首次构建/测试并行造成4项dist依赖加载失败，调整为先构建后全量复测通过，失败日志保留。没有修改业务代码、提交、重启或部署；候选兼容项仍为false，发布前准备另行按现有流程落实。详见[完整结果与边界](acceptance/full-check-20261117.md)。

只读审查另发现已完成上传在签名到期前物理删除后，旧PUT链接可能重新写入而留下无主对象；开启Bucket版本控制时，未完成上传的不带版本删除也可能只建立删除标记。两项均与测试通过分开记录，未调用真实OSS或扩展回收业务；具体证据、适用条件和下一步见上述验收。

## OSS 客户端直传直读与旧检查清理（2026-11-17，本地实现）

客户端文件上传/下载、图片与播放统一直接访问OSS；上传完成只HEAD元信息确认，删除Server对象代理、播放令牌及storage.inspect后台任务。移除SHA入参、MIME/DOCX/音频时长本地解析和file-type/music-metadata依赖；自产artifact写入边流写边hash，不再二次读取。新资源SHA为空、时长明确为客户端声明。图片UUID按已配置bucket/对象key与归属校验，过期链接保存/OCR往返继续工作；版本化OSS来源URL与下载/删除按真实版本匹配。

本地.env已设OSS驱动，新增可选公网签名endpoint；现有凭据保留。新增0006及配置/数据库只读验收文件，仅在临时库演练：基线0003→0006及四角色验收通过，1109项单元/契约、393项隔离PG/Redis通过（4项Milvus跳过），typecheck/lint/build通过。失败的权限验收SQL、旧local fixture和并行build测试顺序均已修正/重测，不扩大运行角色权限。未提交、推送、发布、重启或修改共享数据库/OSS；目标迁移与真实OSS联调未执行。见[完整证据与边界](acceptance/oss-direct-access.md)。

## 后台状态 SSE 背压与闲置监控恢复（2026-11-17，待发布）

状态 SSE 在缓冲满时暂停读取、序列化及心跳，恢复后只读最新快照；1 MiB 待发送限制、30秒 drain 超时，关闭及错误路径完整清理。闲置监控首连/首订阅失败后释放实例，复用现有30秒扫描重建；并发启动共享结果，关闭不复活。105项定向单元/生命周期、31项真实隔离Redis及Lint/构建通过。最终全仓类型检查与完整集成入口分别被并行OSS测试类型、发布断言权限问题阻塞，未改正式门禁。无本项SQL/ENV/依赖或新增轮询，未发布、重启或调用真实云；见[验收与边界](acceptance/state-stream-idle-monitor.md)。

## 会话鉴权活跃记录限频（2026-11-17，待发布）

普通鉴权每次实时读取账号与会话有效性；last_seen_at最多每60秒更新，行锁忙时跳过本次活动记录。复用单条SQL，保留业务FOR SHARE和注销/刷新逻辑，无新增缓存、表、配置或后台任务。新增14项专项与身份/用户/资产回归共73项真实PG/Redis、53项单元/契约及全仓类型/Lint/构建通过。撤销提交后的新鉴权拒绝，提交前已开始的快照读取可能通过，明确在途边界；未做线上性能压测。未部署或重启，见[验收](acceptance/session-activity.md)。

## 笔记列表20条分页与摘要（2026-11-17，待发布）

按用户确认固定20条，使用更新时间/ID游标续页，保留PG微秒、严格校验工作区与格式；列表一次批量查询元信息和有界raw前缀，preview最多200字，不返回parts/resourceRefs或签发图片链接，详情全文保持。42项真实隔离PG/Redis及11项接口契约、全仓类型/Lint/构建通过。实时列表的并发编辑通过刷新首屏可见，不新增跨请求快照。App当前本地SQLite首页未接远程笔记列表；API字段改变如实标记compatibility.api=false，无新SQL/配置/组件/回填，未部署或重启。见[验收与边界](acceptance/note-pagination.md)。

## Scheduler运行时配置修复（2026-11-17，待发布）

每轮过期清理/恢复/派单复用一份运行配置快照，后台新执行次数与投递退避从下一轮生效；配置无效时不执行该轮，恢复后无需重启。全部11处任务INSERT直接保存次数上限，Outbox补投不再改写旧任务；Admin手动节点启动补接相同配置机制，人工retry规则不变。990项unit/contract、既有338项真实依赖回归与新增7项专项分轮通过，4项Milvus跳过；最终全仓类型检查、构建和改动文件Lint通过，全仓Lint受并行新增图片测试的两处多余转义错误阻塞。新增测试fixture两处错误已修，期间其他窗口缺文件导致的收集失败及最终源码通过证据均保留。每轮增加1次配置SELECT，新任务省去1次补写UPDATE，无新SQL/配置键/组件/计费改动，未部署或重启既有服务。见[验收](acceptance/scheduler-runtime-configuration.md)。

## KBIMAGE统一与客户端Markdown往返（2026-11-17，待发布）

Note和手动正文在写入时统一KBIMAGE，查询/展示共用轻量扫描器，无图快速跳过，不再为图片识别构建全文AST。客户端Note只收一个contentMarkdown（手动文本raw_content）标准Markdown；图片路径/Object Key查UUID与下载签名有效期分离，过期链接仍可保存，响应重签。URL fragment定位原节点，同UUID多OCR不混淆；幂等后恢复原OCR/属性，再写hash/revision。原key重试不依赖新正文。签名URL的运输长度和canonical业务上限分别控制，无新增表/缓存/SQL或读取旧格式兼容分支。

1049项单元/契约、368项隔离PG/Redis（4项Milvus跳过）、typecheck/lint/build通过。真实过期下载令牌GET401但PATCH成功、无修改无新版本、编辑保留OCR及原key重放均有接口实测。1MiB合成无图扫描中位389.17→0.28ms，有1图392.09→14.17ms；仅组件实验，不是线上压测。未调用真实模型/解析/OSS，未改App/AGENTS或共享数据、未发布/重启；旧正文仍须发布前盘点。见[完整验收与边界](acceptance/kbimage-unification.md)。

## 文件解析统一外部 OSS URL（2026-11-17，待发布）

按用户明确的底层规则，正式文档、FILE_UPLOAD与后台试用统一只传OSS链接，PDF/Office/TXT/MD/CSV不再本地提取，也不下载再转发。移除Server二进制上传、DOCX Base64、失效下载配置、旧tokenizer及无调用依赖；媒体申请改签发OSS PUT，完成校验仍保留真实完整性/归属/配额保护并改流式读取。资源ID与URL绑定，签名过期及取消/回调恢复补齐。进一步删除无人调用解析旁路/客户端方法、旧正文回退/标题范围/处理状态，；相关工作偏好按用户要求仅作为会话指令，不固化到AGENTS。最终990项单元/契约、338项隔离PG/Redis（4项Milvus跳过）、最后22项直传复测及类型/Lint/构建通过；真实解析服务/OSS均未调用，未部署/重启/写共享库，无本项SQL迁移。其他系统审查条目未包含在本次已修复声明中，详见[实现与验收](acceptance/document-parser-url-contract.md)。

## Worker / Scheduler 空闲资源优化（2026-11-17，待发布）

拆出队列发布器，Scheduler不再加载Worker执行依赖；仅后台两角色健康探针改为启动宽限期5秒、稳态30秒。完整入口隔离容器各90秒采样：Worker/Scheduler CPU单核占比1.079%→0.364%、1.213%→0.479%；Scheduler主进程RSS中位131→106 MiB，Worker内存无明显下降。首次健康约5秒；临时Redis故障约101秒连续4次失败后unhealthy、恢复约30秒后healthy，代价是后台健康状态发现延迟增加。28项真实PG/Redis、25项单元/契约及类型/Lint/构建/Compose通过。未新增SQL/依赖/ENV键或扩展扣费，既有服务未重启、未部署；保留其他窗口累计迁移及兼容声明，详见[验收与局限](acceptance/background-idle-resources.md)。

## 全系统技术债与资源审查（2026-11-17，原始记录；文件链路与依赖已修见上）

按用户要求以当前实现为准减少历史兼容与无调用代码。扫描当前152份src TypeScript文件、14个业务模块及四角色入口、发布策略、依赖和资源，追踪鉴权/工作区、资产/标签、存储/导入、检索、任务/解析节点、配置和管理路径。包含已有未提交修复，不把此前任务预留释放问题重复列为待修；未扩展计费功能或解除此前File线路业务调整暂缓。这里只审查Server；App仅只读核对入口和认证契约，不代表全部未来Pxx或Agent实现验收。

| 顺序 | 当前确认的问题 | 轻量处理方向与证据 |
| --- | --- | --- |
| 已修，待发布 | 解析节点首次订阅失败后，闲置监控缓存失败对象 | 首连/首订阅失败卸监听、断开并清空实例；现有30秒扫描重建，覆盖并发启动和关闭竞态。定向与真实Redis证据见[验收](acceptance/state-stream-idle-monitor.md)，未调用真实云。 |
| 优先 | OSS链接被Worker下载并中转上传，且复制源缓冲 | 用户进一步明确：所有文件由客户端直传OSS，Server接收链接，外部解析服务自行读取；应按外部URL契约移除中转，不以Buffer/流优化继续固化该路径。`integrations/document-extraction.ts:131`的32 MiB输入产生约96 MiB ArrayBuffer实验仅证明现有中转成本，不是实测OOM或RSS峰值。现已按URL契约移除中转，业务接口说明见契约文档，验证见上。 |
| 已修 | RAG为了图片回读并同步解析命中来源全文，无图片也构建AST | 原无图片1 MiB合成Markdown单次约366 ms、RSS前后差约193 MiB，不是线上压测或泄漏。现统一KBIMAGE存储、无图快速跳过/有图轻量扫描，保留跨OCR分块语义，无新增表或偏移缓存。来源读取与哈希校验仍保留，详见[当前验收](acceptance/kbimage-unification.md)。 |
| 已修，待发布 | 笔记列表游标无效，逐条读取详情和全文 | 已改20条游标分页、一次批量列表查询与有界摘要，独立详情保留；42项真实依赖与11项契约通过，见[验收](acceptance/note-pagination.md)。 |
| 优先 | 文件夹恢复无差别恢复此前单独删除的笔记 | `assets/service.ts:31`；缺少笔记自身revision/事件/索引状态转换。记录删除来源，只恢复本次级联删除对象，复用单笔记生命周期。 |
| 已修，待发布 | 每次鉴权UPDATE会话，与业务事务FOR SHARE互阻 | 每次实时验证、活动记录60秒限频且锁忙跳过，保留业务会话锁；73项真实依赖和53项单元/契约通过，见[验收](acceptance/session-activity.md)。 |
| 随后 | OSS stat全量装内存；put/complete/inspect重复核验；删除在持锁事务内做远程IO | `object-storage/aliyun-oss.ts:32`、`storage/port.ts:28,29,62`、`storage/jobs.ts:31`；区分元信息与完整校验，流式核验且复用不可变对象的可信结果；远程删除放事务外，前后短事务保留引用/租约检查。 |
| 已修，待发布 | Scheduler漏接运行时配置上下文 | 每轮快照与创建时保存次数已实现，补投保留旧上限；7项专项含真实入口故障恢复通过，见[验收](acceptance/scheduler-runtime-configuration.md)。 |
| 已修，待发布 | 后台SSE忽略write(false)，慢客户端缓冲继续增长 | 现等待drain并暂停读取、序列化及心跳；100次通知在堵塞期间只读1次，恢复后取最新。1 MiB发送限制、30秒超时；见[验收](acceptance/state-stream-idle-monitor.md)，不是公开API容量测试。 |
| 后续 | 检索先加载全部chunk元数据并拼pointId过滤；索引计划逐chunk SQL和平方级find | `rag/query-service.ts:78,94,103`、`kb/jobs.ts:54,59,60,76`；按发布来源身份过滤后只查命中元数据，保留权限/版本复核；批量SQL及Map寻址。不能简单删除200来源上限，否则放大全量读取；原检索完整性和File/text业务问题保留暂缓记录。 |
| 后续 | 任务/已投递outbox/认证及幂等历史缺少正式留存清理 | 小批次维护、保留未知结果及必要幂等墓碑；过期密文不应长期累积。解析回调正文已有consumed清除，不列为泄漏。 |

明确清理候选：无调用的`loadModelTokenizer`、旧`resources/tokenizers/bge-m3`资源及HF依赖；无源码使用的`diff`/`pdf-parse`（本机pdf-parse包目录约34 MiB，只说明磁盘/镜像占用，不等于常驻内存）；只有单测消费的`stableUuid`/`dedupeByChunkKey`；package重复`release:review`键。固定ali-oss版本已经有getStream，可去旧SDK回退。节点配置继续写退役enabled、运行配置隐式v1/未知字段保留、发布记录单镜像转换均是可收敛的历史格式逻辑；先一次性规范化现有测试状态，再删除运行时双路径，历史已执行迁移不重写。

附加noUnused编译检查只报告`assets/service.ts:192`的basePartRevisionId未使用；这属于接收参数却不执行对应版本约束，不能只删参数掩盖契约问题。已存在整篇Note ETag保护。`recordRunUsage`重复欠账/结清回冲问题仍在，但没有正式调用方，保留为未来结算接入前问题，不在本次扩展扣费。当前应用指标只有HTTP/任务等，后续可补进程CPU、RSS/堆、事件循环延迟、PG池等待及队列积压，以相同样本比较优化前后；本轮不凭空调整容器额度。

证据：`.local/system-audit-20261117/search.json`、`runtime.json`、`runtime-probes.mjs`。Node26.11.0，真实本地函数加明确替身及源码审查；没有本轮真实PG/Milvus/云压测，没有业务代码改动、部署、服务重启、共享数据库写入或付费调用。App api_endpoints与http_auth_repository哈希仍为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1、d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。

## 任务基础机制加强与扣费范围收敛（2026-11-17，待发布）

按用户最终要求停止额度/扣费扩展，撤回新增自动成功扣款及账本索引方案；上一轮必要预留释放修复保留。通用终态模块独立于计价规则；Scheduler逐任务短事务、整页异常轮转与故障报告，Worker统一锁后租约检查，等待锁后过期的心跳不再复活任务。27项专项、全量323项隔离PG/Redis（4跳过）、978项单元/契约及类型/Lint/构建通过。此前5种交接记录基于可空trace草案，不作为当前严格Schema的新旧混跑保证。累计迁移3→5包含既有0004和并行trace的0005，无扣费新表/模型/索引。未提交、部署或写共享库；见[当前验收](acceptance/task-reservation-recovery.md)。

## 简单traceId贯通（2026-11-17，待发布）

只用X-Trace-Id，删除旧别名、任务执行时补值和Agent通用路由兼容探测。11处业务创建点直接写trace，0005改为必填且无默认值；只在迁移事务初始化现有小规模测试数据，不留运行时修补路径。Server978项单元/契约、324项隔离PG/Redis（4跳过）、Agent321项测试及两仓类型/构建、Server lint通过。严格Schema不支持旧二进制，已据实关闭database兼容声明，未执行共享库迁移或发布；见[当前验收](acceptance/trace-id.md)，不推进Pxx。

## 发布防倒退、幂等与按角色更新（2026-11-17）

复用发布锁和成功记录，补齐普通发布顺序、写库/切换前状态核对及同SHA实际镜像/ENV校验；services现在控制需要替换的角色，未选角色保留成功镜像、配置与容器，新记录逐角色保存镜像身份。新增SQL暂保持四角色更新，因为旧镜像不能接受未知迁移历史；不添加自动回滚，默认修复代码向前发布。267项发布专项、6项宿主候选替身（含15种角色组合）、类型/Lint/构建通过。测试机执行器已安装：当前085de22同SHA重跑成功、旧b729842在checkout被拒绝，两次四容器ID和成功记录均不变，公网ready200；本次没有业务重启或新业务发布，正式生产未接入。先前长度拒绝、持锁等待和替身边界保留，见[验收](acceptance/release-order-and-services.md)。同期业务修复及其迁移仍由各自任务维护，不归本项成果。

## 任务终态额度预留修复（2026-11-17，待发布）

按用户要求仅修P1/P2复核第4项，检索第3项暂缓。Worker、Scheduler、用户取消、文本替换取消和解析确认取消共用事务内额度释放；自动重试保留、手动重试重新预留，未知外部结果不释放。不改表，仅新增0004授予Scheduler释放所需列权限，不增加补偿服务或发布特例。22项新增真实PG用例、前期49项专项及最终全量318项隔离PG/Redis（4跳过）通过；973项单元/契约、类型/Lint/构建通过。迁移3→4、重复执行0新增、逐角色权限与物理外键0通过。未提交、部署、改共享库或业务数据；见[验收与未验边界](acceptance/task-reservation-recovery.md)。其他窗口的发布控制改动保留，本轮不代为提交。

## Server发布候选提交准备（2026-11-16）

发布控制已从当前main单独准备PR #18，包含review与普通自动部署门禁分离，独立工作区232项发布测试、类型/Lint/构建及干净提交review通过。main由owner审核合并；本期Server业务候选继续保持自身不兼容门禁，Agent不参与本次发布。宿主资源限制已调整，鉴权路由与应用尚未切换。后续先合控制再同步test，避免旧main误触发云命令。

## 单项目发布流程复核（2026-11-16）

按用户最新边界，Server只发布自身四角色与migrate，不检查或操作Agent；已撤回前文要求两项目绑定发布的表述。通用候选review与本项目自动部署资格分离，宿主自动门禁保留。Server232项发布专项及独立范围提示调整后的23项通过，类型/Lint/构建通过；仓库外8场景控制器mock通过，明确部分失败需按实际状态恢复。Nginx资源限制已在已授权测试机备份、校验并平滑reload，4个新worker实际65536/8192，业务健康前后通过，应用和鉴权路由未换。控制代码尚未提交或推送，入口与新应用仍未发布；详见[复核记录](acceptance/ingress-auth.md#发布流程复核与独立发布边界2026-11-16后续约定)。

## 统一入口发布前复核（2026-11-16）

核对实际测试成功基准仍为Server b65e7ee、Agent b491b5e，两端及宿主入口尚未迁移。修复内部注销事务会话校验遗漏，补两端入口配置门禁，并在仓库外修复200 MiB上传被100 MiB入口限制的问题。30项真实隔离身份集成、Server相关专项、Agent55项专项及静态/构建通过；目标连接限制、首次配套迁移路径、准确提交CI和目标业务验收仍待落实。未提交、部署、重启或放宽兼容门禁，详见[本轮证据](acceptance/ingress-auth.md#测试发布前复核2026-11-16-2145-cst)。

## 内部 IP / 服务名调用约定复核（2026-11-16）

确认现有 Agent Server 客户端和 Server 服务地址配置均支持 IP / 服务名，无需增加第二套调用逻辑。补齐两仓应用契约与 Agent 配置说明：同网服务名、跨机私网地址、逻辑入口与单实例直连的区别；Server 尚无反向 Agent 业务客户端，不增加无调用方的配置。后续 Agent 扩容由部署侧选择实例，当前固定端口单实例发布仍可能短暂中断。

Agent 身份/地址15项、Server正式地址8项定向测试通过；另以实际配置解析函数验证IPv4/IPv6/容器服务名/逻辑服务名共12项断言通过。首次Server命令同时匹配了忽略目录的历史测试，随后显式排除并重跑，计数仅取正式8项。此次只有文档和模板注释变更，未修改业务代码、真实ENV、网络、运行服务或发布状态；不将配置校验称为跨机连通或滚动发布验证。

## 宿主入口与两仓身份契约收敛（2026-11-16）

按用户决定移除应用内代理容器、Dashboard、分支探测、路由卷和切流脚本，API/Admin恢复各自受限端口。Server适配原生认证子请求的401登录提示和独立Cookie头；用户明确授权后同步修改Agent，删除重复注销/匿名跳转，保留Mastra用户隔离。宿主Nginx和切流候选在仓库外准备，未在Mac安装Nginx，未切换现有运行服务。

Server 903项unit/contract、288项真实隔离PG/Redis（4跳过）、类型/Lint/构建通过；Agent 259项测试、类型、Studio构建和构建产物冒烟通过。真实Nginx与两端代码联调、SSE/重载及延迟鉴权退役通过；身份存储/短信为替身，模型调用0。两仓尚未提交或部署，首次配套切换门禁保留，见[验收](acceptance/ingress-auth.md)与[应用鉴权契约](runbooks/gateway-auth.md)。

## Qwen与检索端口兼容复核（2026-11-16）

小范围核对当前Qwen/1024/FP16、原生/组合检索、内部RAG快照和200ms重排预算，未发现需要追加业务逻辑的冲突。6文件62项专项单测通过，本机公网/云端VPC私密片段仅做脱敏值校验；未调用真实模型、未重跑288项集成、未改预算或服务状态。只修正一处旧BGE文档，见[本轮证据](acceptance/qwen37-vector-switch.md#与可替换检索端口的兼容复核2026-11-16)。

## 搜索底层能力与可替换后端（2026-11-16，尚未部署）

按最新用户边界优先封装检索能力：新增独立KeywordIndex、VectorIndex、HybridIndex端口及工厂，Milvus驱动迁至integrations/search-index；底层不绑定Note/File名称或任意查询DSL。关键词可独立换后端；组合Hybrid分别召回后以RRF融合，模型Rerank继续由上层负责。默认业务沿用Milvus原生混合，纯向量/组合能力通过显式工厂接入，不新增自动部署开关。ES仅预留接口与接线边界，未引入ES SDK或声称实测。

真实临时PG/Redis/Milvus定向48项与914项unit/contract通过，Typecheck/Lint/Build通过。覆盖独立关键词/向量/原生混合Schema、应用融合、权限过滤、稳定ID重试/删除、分路失败等待、替代关键词class适配器与真实PG发布流程。与本轮开始时工作区比较，既有两个Milvus Schema、业务快照/configHash输入和ID算法保持；本轮无数据库迁移、共享集合重建、模型付费调用、业务服务重启或部署。另一窗口Qwen/FP16改动沿用，不能把其已授权集合操作归到本轮。证据`.local/search-index-refactor/`；见[接口、接线和ES扩展约定](runbooks/milvus.md#底层接口与后端替换)。

## 百炼Qwen 3.7与FP16专项（2026-11-16）

替换嵌入/重排及本机ENV，原生1024维与Milvus Float16Vector；用户提供的公网用于本机（包括test环境），云端test/main私网配置已私密准备。按明确授权与执行审批删除并重建唯一旧稠密集合，不备份；原集合和PG索引元数据均0，纯BM25集合保留。内部RAG补接请求级运行配置，7→11及在途快照回归通过。903项unit/contract、288项真实独立PG/Redis/Milvus、类型/Lint/构建与本机Compose通过；真实模型仅做列表GET检查、推理0。保留原200ms重排预算、失败记录和在途发布门禁；未重启应用或发布云端，不推进Pxx。详见[验收](acceptance/qwen37-vector-switch.md)。

## 全仓架构与历史逻辑检查（2026-11-16，问题已复现，尚未修复）

本轮按用户请求检查现有工作区，包括在途网关改动；没有大范围重构、提交或部署。用户进一步澄清：底层是 Note / File 两条入库线路，未来业务名称另定；文本导入是获取方式或内容格式。源码本来只有 note-hybrid / document-keyword 两种索引模式，问题在于 `note/file/text` 又把原始记录来源与入库/查询类别混用。前次“文档存在两套模型”的表述过重，本次更正，不以合并物理表为目标。以下为待修项。

| 优先级 | 确认的问题 | 影响与修复方向 |
| --- | --- | --- |
| P1 | File线路内的原始来源file/text被用作查询类别；documents/query仅选file | 两种来源本来共用document-keyword索引，导入文本仍被文档查询漏掉。拆清Note/File线路、获取方式、内容格式与原始记录引用，统一File的查询/回源/图片/清理边界；不预设业务名称或强制合并物理表。详见[线路梳理与AI任务说明](contract-compatibility.md#note--file-入库线路梳理与调整说明2026-11-16)。 |
| P1 | Billing.recordRunUsage 重复累加 uncovered；settled 后未冲回汇总 | 同一 Run 的 5 点欠账重报两次后，单条 Run 为5、周期汇总为10；结算后 Run 为0、汇总仍10，会继续阻止任务准入。应根据旧/新事实差额幂等更新。 |
| P1 | Scheduler.recover 另行实现任务失败终态，未释放预留 | 耗尽次数的失联任务变成failed，额度仍reserved；releaseExpiredReservations 存在但没有生产调用方。任务终态与预留释放应复用同一事务边界，未知外部结果不能盲目释放。 |
| P1 | RagQueryService.eligible 仅纳入最新200个来源 | 第201个已发布来源在全局检索中消失，指定其ID却可查到。不是显式候选数限制；应覆盖全部授权来源，并避免每次把全部Chunk ID加载后拼成Milvus过滤表达式。 |
| P1 | 文件夹删除/恢复直接批量改Note，绕开单Note生命周期 | 恢复文件夹会复活此前独立删除的Note，Note ETag保持原值；也未走单Note的事件/索引安排。统一状态转换并保留删除来源，不能按文件夹位置无差别恢复。 |
| P1，已修复 | `/internal/v1/rag/query` 漏接运行时配置上下文 | 本次已补接请求快照，7→11及在途一致性回归通过，见[验收](acceptance/qwen37-vector-switch.md)。 |
| P2 | Note列表游标无效且逐条读取完整详情 | 51条记录只返回前50条、nextCursor=null，任意cursor仍重复第一页；50条列表实际205条SQL（含BEGIN/COMMIT）。应实现稳定分页、批量装配与列表摘要，保留详情接口。 |
| P2 | 每次JWT鉴权更新同一会话行，业务事务又持共享锁 | 隔离PG证明：一个业务读取事务可阻塞同会话的下一次鉴权。把有效性校验与活跃时间写入分开，活跃时间写入节流；继续保留注销/封禁即时校验。该复现不是线上QPS或延迟压测。 |
| P2 | 存储stat为全对象GET，删除还在数据库事务内做远程IO | 上传完成及后台inspect重复全量核验；OSS stat可先缓冲整个对象。明确区分元信息查询/完整校验，避免重复读取；把远程删除放到事务外，前后短事务校验，保留幂等与完整性保证。此项为源码调用链判断，未调用真实对象存储。 |

次级清理：`putNotePart` 接收但忽略 basePartRevisionId，已复现；通用TaskEngine内仍写标签业务SQL；StoragePort与各驱动同文件、OSS反向动态依赖LocalAdapter，形成层间依赖环（不等于已出现初始化错误）；索引任务另建pg.Client，连接总预算需包含它；api_idempotency过期不清除密文响应，任务/认证历史也没有明确的回收执行器，应先确定留存和过期键拒绝语义；`diff`/`pdf-parse`未找到源码使用，stableUuid只被自身测试使用。63行生产源码超过500字符，主要是事务、权限和状态转换压在一行，增加漏审成本。

验证证据：扫描144个TypeScript源文件（含1份声明），重点追踪四角色、身份、资产、两条导入链、检索、账本、存储与任务恢复。8项定向复现全部通过，意为确认现存问题，并非修复回归通过；使用自有临时PostgreSQL/Redis，Milvus召回及内部路由测试中的检索过程为模拟，其余事务/查询/锁为真实PG。临时容器/凭据已清理，无既有卷删除、业务库修改、付费服务或App写入。一次新增夹具把UUID owner写成字符串导致失败，修正夹具后重跑；失败与成功日志均保留。

忽略目录证据：`.local/architecture-review/reproductions.log`、`reproductions-fixture-failure.log`、`inventory.json`，定向夹具及独立runner为 `.local/architecture-review.test.ts`、`.local/architecture-review-integration.mjs`。附加 noUnused 编译检查仅报告 basePartRevisionId 未使用，不能将它描述为标准Typecheck失败。本轮未跑全量回归或线上性能测试。

## SSE原配置1000并发复核（2026-11-16）

保持2核/1.914GiB和15秒窗口，将500并发增至1000。直连/Traefik各1000条收到SSE；Nginx及双层路径各507条成功、493个HTTP500。日志和进程限制确认Nginx测试容器1024文件描述符软上限；未调参，不据此断言代理容量差异。补齐客户端HTTP状态观测后完整复核，Traefik1000流对应2000条TCP。临时容器/网络已清理，详见[SSE报告](acceptance/sse-proxy-benchmark.md)。

## SSE 代理短时基准（2026-11-16）

本机隔离模拟源对比直连、Nginx、Traefik、双层代理；最终500并发、各15秒，均完成建连且记录错误为0。HTTP/1.1单层代理均1000条TCP，双层各1000条，未发现Traefik减少连接数量。非真实Agent/模型、非线上容量或自动发现验收；环境问题、废弃样本及复测结果见[SSE基准](acceptance/sse-proxy-benchmark.md)。临时容器/网络已清理，未更改应用及入口配置，不推进Pxx。

# 当前发布状态

现行规则：test 提供业务与清单，main 提供受保护发布流程；本地开发以 test 为基线。2026-11-16 03:03测试发布成功，宿主成功记录与四角色镜像均为 b65e7ee；本期解析排队/回执修复已上线。正式生产尚未初始化。以下早期条目按历史保留，不作为当前部署指令。

# 当前开发进度

## 文档解析排队状态与重复图片回执修复（2026-11-16）

真实管理 API 定位 RT-Thread 试用因远端 queued 被误判为未知状态而失败；共用客户端已接受排队状态并继续等待，保留未知状态拒绝及不重复提交。跨页复用图片允许存储及归属一致的重复回执，冲突仍拒绝。最新基准832项unit/contract、277项真实隔离PG/Redis（1项Milvus跳过）、类型/Lint/构建和发布清单通过；PR #16合并为b65e7ee，测试Action第二轮五阶段5/5通过、无强退，四角色健康。首轮历史OOM标记导致阶段4中止、Admin短暂中断，恢复后同候选重跑成功，失败证据保留。原RT-Thread远端任务最终419/419页完成，与325页电子标书结果在已部署镜像中均通过校验，未修改远端调度或评估全文准确率。不推进Pxx，详见[实测、恢复与发布](acceptance/document-trial-api-20261116.md)。

## 节点默认接收任务与试用就绪诊断（2026-11-16）

移除节点级接收新任务开关，所有已登记节点默认可选；0003将退役DB字段固定true供旧容器交接，新接口不再暴露或接收。实际解析机只读确认Stopped，试用提交前增加有界健康检查以区分服务未就绪和提交后结果未知。无真实PDF重发、无改旧迁移；验证及发布边界见[验收](acceptance/node-defaults-and-parser-readiness.md)。

## 测试环境启用解析调用（2026-11-16）

该阶段用户明确要求开启当时的部署级解析调用开关并发布测试服（当前代码已移除该开关）；已准备沿用现有凭据的候选快照，新增本期配置断言。无数据库变化，开发默认不变。见[候选记录](acceptance/parser-api-enabled.md)。

## README 与线上云控制环境规则（2026-11-16）

README 按实际工具/版本、依赖、四角色关系、首次运行、配置、开发检查、发布下线及规范重写。明确本地 development、线上测试 test、线上生产 production；后两者默认允许云控制，保留显式 false 和 RAM 授权要求，不连带开启私网解析调用。测试发布清单按实际成功 ce1123e 更新，写库前逐角色校验 APP_ENV、云控制开关及完整 RAM；隔离 CI 显式禁止云操作。817项unit/contract、275项真实隔离PG/Redis通过（1项Milvus跳过），静态检查、构建与15份Compose角色配置通过。已执行迁移、App、真实ENV和云资源未修改，未发布本期候选，验证和待部署项见[环境验收](acceptance/cloud-control-environments.md)。

## Main 业务更新与测试发布准备（2026-11-15）

将本轮42个业务改动文件移植到实际成功版本0771fd5，保留冻结迁移和排空设置；补齐关闭云控制时遗留ECI checkpoint不得创建实例的遗漏。当时测试机候选暂定直接部署main（该尝试在预检失败，现已恢复test业务/main控制），保留人工Merge和Action。API关停期间已接入普通请求继续完成，四角色真实HTTP回归通过；Typecheck/Lint/Build、771项unit/contract、275项真实隔离PG/Redis通过，1项Milvus跳过；SQL版本2→2、首次与重复应用均为空。该历史候选已合并但未发布成功，后续test更新已通过验收，详见[本期验收](acceptance/main-update.md)。

## 脱敏异常堆栈与 Dozzle 排查（2026-11-15）

公共500/DomainError 5xx写入脱敏err原因、堆栈/原因链，沿用traceId并附角色、实例、路由模板和状态；RAG/短信/上传保留包装原因，客户端提示不变。四角色启动启用source maps，真实Node26.11/容器26.12编译产物验证到TypeScript行号。12项专项、679项unit/contract、274项真实隔离PG/Redis通过（1项Milvus跳过），静态检查/构建通过；无新依赖/组件/SQL。未执行线上部署，随新版本生效，见[验收](acceptance/error-diagnostics.md)和[日志手册](runbooks/application-logs.md)，不推进Pxx。

## 解析节点云控制、内网调用与发布清单（2026-11-15）

主界面只读显示实例状态及独立的解析API连通性，Running即实例在线；私网API不可达不再阻塞手动开机完成。云控制由独立开关授权，完整RAM凭据或已启用节点调用时默认允许，可显式禁止；私网调用开关仍默认关闭。手动开机只用云接口，经维护队列短步骤与SSE更新；即使未参与自动调度，完成后仍按空闲时限节省停机。运行方式胶囊沿用已保存mode，不推断计费。后台删除新增入口，服务仅UPDATE已存在节点；新增须随代码发布。667项unit/contract、274项真实独立PG/Redis通过（1项Milvus跳过），静态检查/构建和本地Chrome通过；云接口为替身。未改Schema/迁移、App或实际ENV，未开停云机；测试服本轮未发布，不推进Pxx，见[验收](acceptance/processing-node-status.md)。

## 人工发布、分支分工与阶段进度（2026-11-15）

测试发布改为人工 Merge 后再从 main 人工启动 Action，main 提供控制代码、test 提供已通过同 SHA push CI 的业务版本；补齐远端五阶段进度与终态复核边界。737 项 unit/contract、Typecheck/Lint/Build、48 项宿主 mock 和 Skill 静态检查通过；本轮真实隔离 PG/Redis 275 项通过、1 项 Milvus 跳过，f80→候选 SQL 2→2、首次与重复应用均为 `[]`。main/test 规则、test/production 环境限制及 owner 审批已保存并 API 回读；owner 的 PR-only 例外不绕过原 main PR/CI 规则，尚未用实际协作者反向实测。RAM 环境 subject 和宿主安装已核对，四角色未重启。

[PR #4](https://github.com/kyriswu/huahuo-server/pull/4) 已由用户合并为 `0771fd5`；main/test 同 SHA push CI 通过后，用户手动运行 [Action 43713175343](https://github.com/kyriswu/huahuo-server/actions/runs/43713175343)，五阶段通过。四角色实际健康，保留当前和上一成功镜像；本次发生到期强退，结果为 `OK_WITH_FORCED_DRAIN`，不是所有旧工作自然完成。该轮业务来源为 test，与 main 同提交；后续曾尝试直接main但预检失败，现已恢复test业务/main控制。生产目标和云角色未接入。见[手动发布验收](acceptance/manual-release.md)及[团队操作](runbooks/team-releases.md)。

## 可复用发布规范、Skill 与迁移验收（2026-11-15）

在已完成的测试机发布基础上，新增仓库 skill、单份发布清单、冻结历史迁移、写库前纯只读检查、迁移后按角色 SQL 断言和配置门禁。每次隔离集成测试先按实际成功 SHA 的 SQL 升级到候选；本期用增量 0002 给已有单行配置补入默认十分钟退出预算，旧版迁移保持不变。数据修正依据规模、锁、时长与恢复条件决定随发布或独立运行，不机械强制双写/独立回填。675 项 unit/contract、275 项真实隔离 PG/Redis（1 项跳过）、Typecheck/Lint/Build 通过；宿主控制流另有 39 项 mock 演练，真实启用状态见[验收](acceptance/standard-release.md)，操作规范见[标准发布](runbooks/standard-release.md)。

后续 [Action 43705816086](https://github.com/kyriswu/huahuo-server/actions/runs/43705816086) 已发布 f80a0c2；实机确认四角色 healthy、DB 版本 2、排空默认值 600000、物理外键 0，并保留当前及前一成功镜像。结果为 `OK_WITH_FORCED_DRAIN`，API 入口排空与旧容器退出有到期强停，不能称全程无中断；仅通过 health 范围。

## GitHub 真实合并演练与测试机发布准备（2026-11-15）

全部工作区改动经 PR #1 合入 main `58da15340d60709065a9522e3b3a1887f08e22f7`，PR 和 main push 的 Server CI 均真实通过，分支保护已启用。新增测试机 workflow 和固定云助手调用器处于下一分支，48 项本地替身测试及全量 561 项 unit/contract、Lint/Typecheck 通过。云助手只读诊断定位旧镜像基线哈希不匹配导致四角色 unhealthy；未更新服务或数据库。用户随后确认云端授权，专用 OIDC 发布身份和固定命令已创建，宿主安装及真实 workflow 部署继续验证，见[接口及状态](runbooks/test-server-release.md)。

## 默认发布冒烟与 Actions 接口（2026-11-15）

新增固定六次 GET 冒烟、AI 编写约束、可复用生产调用接口和 PR/main/手动触发的 Server CI。完整 513 项 unit/contract、247 项真实隔离 PG/Redis（1 项 Milvus 跳过）、类型/Lint/构建通过。用户确认先留凭据接口，并授权全部工作区改动参与下一步真实 GitHub 演练；本机结果不代表线上部署。见[验收](acceptance/release-smoke.md)。

## 上线前真实服务验证待办（2026-11-15）

用户要求真实链路稍后再测，先登记[上线前待办](acceptance/pending-live-verification.md)。真实 PDF → Xberg → 正文/OSS 图片 → 资料 BM25，以及笔记真实 Embedding/Milvus/Rerank、按需开停机/并发/文件限额和实际 Prometheus 抓取均待云上执行。此前 481 项 unit/contract、244 项集成通过属于隔离回归，不能称为完整真实链路验收通过；本轮只读核查连接配置、运行参数与 ECS 状态，没有调用模型、解析器或启停云机，不推进 Pxx。

## 16核32GiB目标的任务与容量策略（2026-11-15）

通过真实Admin保存内容并发8、维护2、AI/商业各1、下载300秒、上传/源文件各200MiB、用户额度10GiB；自动执行3次与重试间隔保留，运行配置revision3→5，节点revision7/名额16/不在线不变。调用端总文件预算改为读现有源文件配置，补齐远端200MiB字段/201MiB请求部署片段；Admin试用保持32MiB有界内存。486项unit/contract、243项真实独立PG/Redis通过（1项Milvus跳过），静态检查/构建通过。现有四角色同镜像healthy/readiness200，Chrome重载及数据库值核对通过；未改Schema、主ENV或凭据，未开云机。真实200MiB解析须内网应用远端限额后验收，见[验收](acceptance/runtime-capacity-16c32g.md)，不推进Pxx。

## 云端 Milvus 与隔离回归通过（2026-11-15）

按用户要求连接已有云端 Milvus，使用随机独立测试 database/collection，PG/Redis 仍为本机隔离 tmpfs 依赖。修复标签任务查询误将无关纯文本 cast 为 JSON；统一测试快照和连接目标，新增清理归属保护。最终 481 项 unit/contract、244 项集成回归全部通过、零跳过，typecheck/lint/build 与 development/test Compose 校验通过；Worker 排空及共享队列交接通过。三轮云端测试库均已清理，实际 ENV 和只读 App 参照哈希未变；模型、解析器仍为替身，未执行应用部署，不推进 Pxx。见[隔离回归验收](acceptance/cloud-milvus.md)。

## 共享队列、Worker 优先的轻量发布（2026-11-15）

用户选择保留共享持久队列，API/Worker/Scheduler 同机成组放置、更新时按 Worker → Scheduler → API 交接；Admin 可独立。复用已有暂停、租约及Outbox，不增加组归属/组内队列/版本路由或发布控制器。新增回归验证两个旧Worker停领后，新Worker完成旧API积压、旧API排空期间仍到达的请求及新API任务，均一次attempt；首次fixture缺少Scheduler补偿导致的失败已留证并修正。243项真实隔离PG/Redis通过（1项Milvus跳过），类型检查/Lint通过；本轮只改测试与文档，未改业务代码、Schema或执行部署，不推进Pxx。见[轻量发布验收](acceptance/worker-first-release.md)。

## 手动启动与正式文档异步回调已本地验证（2026-11-15）

恢复前重新核对同期代码，保留指标、排空、服务地址及纯内存 Admin 试跑边界。手动启动经维护队列短步骤执行并用 SSE 推送；正式解析提交后让出 Worker，认证回调持久保存再唤醒，约60秒单次查询仅作补偿。473项unit/contract、241项真实独立PG/Redis通过（1项Milvus跳过），静态检查和完整构建通过。现有开发库无损同步，节点revision7/async、运行配置revision3、物理外键0；四角色同镜像healthy/readiness200，Chrome核对实际后台。云节点仍关闭，未真实开机或调用解析；实机回调网络待内网验收。见[验收](acceptance/document-async-events.md)，不推进Pxx。

## Admin 试跑只读配置、零业务写入（2026-11-15）

现有单一试用弹窗改为直接调用已可访问的解析API，状态/结果仅内存；移除试跑审计、节点分配、回调入库/恢复、机器调度和sessionStorage。唯一未上线基线删除试跑专用字段/索引及Admin回调表权限，用户正式任务的持久链路保留。473项unit/contract与239项真实隔离PG/Redis通过（1项Milvus跳过），静态检查/构建通过，零写入及中断不恢复已验证；未同步现有库或部署，停在专项验收点。见[试跑简化验收](acceptance/admin-document-trial.md)。

## 用户侧稳定优先，Admin 试跑允许中断（2026-11-15）

用户明确 Admin 仅用于验证功能，试跑可在发布/重启时中断并重新发起；不为试跑新增状态/结果持久化、跨副本接续或强制实例亲和，不作为发布或扩容阻塞项。最高优先级仍是用户侧 API、上传、已受理任务和回调一致性；管理配置校验及必要的共享节点占用核对/资源回收保持。已同步部署契约和验收边界，仅文档调整，无应用/Schema/环境改动，不推进 Pxx。

## Admin 独立部署服务地址（2026-11-15）

按最新范围保留 API/Worker/Scheduler 部署组，优先 Admin 独立。新增 API_SERVICE_BASE_URL，认证解析回调使用可配置的 API 域名/IP；留空继承显式 APP_PUBLIC_BASE_URL，不再猜测当前进程的 localhost。Compose 向调用角色注入地址，后台自身 URL 与业务公开 URL 保持独立。473项unit/contract、25项Admin相关隔离集成通过，类型检查/Lint/构建通过；完整回归另有1项Worker排空用例失败，见[验收](acceptance/service-addresses.md)。数据库/OSS/缓存共享方案不在本轮，见[服务地址手册](runbooks/service-addresses.md)。

## 容器演练与可组合部署边界（2026-11-15）

按用户要求保持统一仓库/镜像，角色可任意组合放在同机，也可跨机独立扩容，不要求一角色独占一台服务器。真实历史镜像→当前镜像因唯一基线校验和不匹配被拒绝，未更改真实数据库。当前镜像分角色切换与回切通过：322个鉴权请求零错误、27秒上传完整、两任务各一次attempt、管理会话及未知可选配置保留、双Scheduler时间窗去重/存活副本继续工作。整套角色同时重叠出现测试OOM，真实多机及跨版本回滚仍未验收；主栈未更新，不推进Pxx。见[演练](acceptance/release-rehearsal.md)与[部署契约](runbooks/role-deployment.md)。

## 应用发布基础加固（2026-11-15）

完成 SIGUSR2 readiness 排空、按角色有限退出、Worker 暂停续租与新实例接手、Scheduler 停扫描及监控、共享配置兼容读取/严格写入/版本门禁、认证回调收敛解析 intent 和取消交接。465 项 unit/contract、237 项真实独立 PG/Redis 集成通过（1 项 Milvus 跳过），typecheck/lint/build、两套 Compose 静态校验通过。未部署主栈、迁移实际数据库或调用付费服务，不推进 Pxx；真实入口切流/跨版本回滚等边界见[验收](acceptance/release-hardening.md)。

## Prometheus 指标接入（2026-11-15）

新增共享 Registry、HTTP 完成计数/耗时、数据库提交后的异步任务结果计数与四角色独立抓取端口。环境标签来自现有 APP_ENV：本地 development、测试 test、生产 prod。真实 loopback HTTP 与隔离 PG/Redis/BullMQ 专项通过；初期工作区解析/任务失败已保留原始日志，最终全量465项unit/contract、237项隔离集成通过（1项Milvus跳过），静态检查/构建通过；总数包含工作区其他改动。现有开发环境及云环境未部署本轮指标。见[监控手册](runbooks/prometheus.md)和[验收](acceptance/prometheus.md)，不推进 Pxx。

## 已部署 ECS 按节点调用与配置简化（2026-11-15）

当前CPU ECS无需镜像名或提取JSON，按需唤醒后直接调用已有Xberg API，默认省略config沿用服务端配置。全局四项解析设置移除，同步/异步与可选覆盖随节点快照；核心页面仅名称/实例ID/地址/并发/空闲停机/在线状态，其余折叠，试用仍位于解析与模型Modal。436项unit/contract、223项真实隔离PG/Redis通过（1跳过），静态检查/构建和Chrome桌面/移动验证通过。现有开发库无损调整，四角色已更新且healthy/readiness200；不开云机，内网PDF/Office仍待部署后实测。见[配置验收](acceptance/runtime-configuration.md)。

## ENV清理与RAG后台参数（2026-11-15）

清理主ENV、旧本地ENV和6份示例的已迁DB/失效项，删除重复解析机模板；现用凭据与其他设置保留。后台新增“RAG 与检索”12项参数，Note开关归功能分类；先将当前值导入原JSON记录再删ENV，配置revision2、节点与业务数据不变。执行快照、构建时限和检索客户端换参已接线，无ENV回退。435项unit/contract、222项真实隔离PG/Redis通过（1项Milvus跳过），静态检查/构建及Compose展开通过。未调用云资源或付费模型，见[验收](acceptance/runtime-configuration.md)。

## 试用弹窗与节点单条JSON配置（2026-11-15）

文档试用入口收进“运行配置 → 解析与模型”的Modal，取消独立菜单/页面；关闭重开保留状态并刷新已保存的配置。节点16项参数收拢为config jsonb，同一行原地更新、revision只递增，不建版本表或旧列兼容路径。现有开发库无损转换保留原CPU节点1条、版本3/并发16/文档音频能力，业务数据不变、物理外键0。434项unit/contract与220项真实隔离PG/Redis通过（1项Milvus跳过），静态检查/构建通过。Chrome已连接验证真实主后台Modal；文件自动上传被扩展文件访问设置阻止，CPU实机仍StopCharging，未开始PDF/Office解析。见[试用验收](acceptance/admin-document-trial.md)和[配置验收](acceptance/runtime-configuration.md)。

## Admin文档试用与旧入口清理（2026-11-15）

现有后台新增文档试用，复用业务解析配置/客户端/节点占用，只展示Markdown/JSON和阶段耗时，不创建笔记、资料、入库任务或索引。节点状态按用户要求显示“在线 / 不在线”。旧ENV加载器、假AK校验、无用参数与未使用旁路已清理；构建清除旧生成产物。434项unit/contract、219项隔离PG/Redis通过（1项Milvus跳过），typecheck/lint/build通过。现有主环境按原账号/数据更新，PDF/Office仍需CPU完整配置及可用节点。见[验收](acceptance/admin-document-trial.md)。


## 现有本地环境已启动（2026-11-15）

用户随后明确要求不用隔离环境，启动当前项目。已核对原RDS基线与HEAD一致、新基线仅追加3张配置表，在事务内新增表/索引/授权并导入5项原非秘密业务配置，最后CAS更新基线校验；没有重跑整份0001、清库、修改原账号或重置凭据。用户、会话、工作区、笔记、资源及任务行数前后一致，物理外键仍为0。

现有主Compose的api-server/admin/worker/scheduler已使用同一完整构建镜像更新，四者healthy/readiness200；未建立新数据库/隔离栈或改动已有卷。Admin在 http://127.0.0.1:3001/admin#configuration ，沿用原账号。HTML/JS 200，匿名配置接口401，API-server同路径404。当时CPU节点及解析调用保持关闭（当前代码已移除部署级调用开关），未开停云机器或调用解析。运行证据：.local/runtime-config/start-existing/runtime-result.json、database-sync.jsonl；镜像完整构建日志image-build-full.log。首次窄范围打包发现缺少API依赖，已改为锁文件完整构建并通过四角色模块导入/启动验证。


## 分类运行配置与 Admin 页面（2026-11-15）

处理节点与解析/任务/上传容量/计费策略/功能开关改由数据库管理，Admin按类型展示，参考4111登录页的黑白灰风格。机器唯一登记、任务节点快照、文档/音频共享占用、排空改配置、未知占用阻断、可选A10 ECI回退及修改审计已接线。CPU节点/提取模式/部署总开关保持关闭，音频协议未接入。

435项unit/contract、215项真实隔离PG/Redis通过（1项Milvus跳过），typecheck/lint/build通过；Chrome工具仍不可连接，未作渲染/交互验收。仅更新代码/唯一初始化基线及本机ENV项整理，未写实际RDS、重建主Compose或调用付费服务。App只读哈希一致，停在本轮代码/API验收点，不推进Pxx。见[验收](acceptance/runtime-configuration.md)与[手册](runbooks/runtime-configuration.md)。


## 通用文档解析CPU ECS目标替换（2026-11-15）

按用户要求改为 `i-2zejbbo2svjieb44tqy8`，cn-beijing、64核/128GiB，私网 `172.18.102.103`。本机目标/示例/手册同步，实际触发开关仍默认disabled；A10回退关闭，CPU完整提取参数待提供，未发送旧CUDA配置。正式适配器真实只读校验与Compose静态展开通过，既有29项mock单元通过；未执行开停机、解析、部署或迁移。新实例末次查询Running，非本轮启动。App只读，不推进Pxx。见[验收](acceptance/document-parser-cpu-target.md)。

## 新prod-callback镜像 / 8核A10全文实测（2026-11-14）

ECS真实启动NoStock后取得最低档8核/30GiB A10 ECI，新digest `152b65be…31a6c7`；325页核心353.849秒，完整请求361.897秒，325页/97表/768图引用，751对象SHA/解码全通过。UUID规范化后与旧48核A10全文一致，已知漏字及表格问题仍在；GPU均值4.16%、CPU1.709核，完整原始日志/时序/报告导出。

调用侧切换新状态/结果分离协议，补202/410与终态ack；真实标签查询误报修为专用ListTagResources并严核归属。430项unit/contract、201项隔离PG/Redis通过（1跳过），静态检查/构建通过。ECI及753临时对象已清理，原PDF/ECS节省停机保留；业务回调路由/主栈未部署，App只读，不推进Pxx。见[验收](acceptance/xberg-a10-prod-callback.md)。

## A10 按量 ECS 缺货回退 ECI（2026-11-14）

既有解析机运行库增加可选回退：指定 A10 ECS 启动明确 NoStock 才创建 A10 NoSpot ECI，原队列/信号量共用；Redis 持久归属与意图，模糊提交/删除不重复申请，未知任务不释放，空闲删除确认后下周期优先 ECS。配置示例包含四交换机、8/16/32/48核单A10优先级与内网 r4 镜像。默认关闭，实际 `.env`、云资源和业务容器未操作，不推进 Pxx。验证和限制见[验收](acceptance/document-parser-eci-fallback.md)。

## 图片 UUID 规范化与按需展示（2026-11-14）

Note 保存先将已验证自有图片地址归一为稳定 UUID，再计算幂等摘要／SHA／差分；签名刷新不产生新 revision 或索引。当前正文引用与历史 part pin 分开，update 附件同步生效。编辑响应以独立 displayMarkdown／imageLinks 展示临时链接，规范正文保持不变。既有查询默认图片 ID，仅 links 模式为最终复核后的 topK 收集并解析图片，不读取原图或批量签全文图片。

404 项 unit/contract、178 项真实隔离 PG/Redis/Milvus integration 和 typecheck/lint/build 通过；模型／解析／OSS 签名使用替身，不冒称真实供应商通过。App 只读且相关哈希一致，唯一迁移未改、外键 0；未部署主 Compose 或写开发 RDS/OSS。用户确认套餐／存储额度含义，已记录目录、计量和缩容方案，尚未实施迁移／套餐联动。不推进 Pxx。见[图片验收](acceptance/markdown-images.md)与[资源方案](runbooks/user-storage-layout.md)。

## Admin 基础只读用户页面（2026-11-14）

既有后台新增“用户管理”，展示昵称、用户 ID、已验证的脱敏手机号、状态和注册时间；支持昵称/完整 UUID 查询、状态筛选、20 条分页、刷新及复制 ID。只读管理 Session 路由与访问审计已接线，JWT、导出和用户写操作均不在本轮。

394 项 unit/contract 与 167 项隔离真实 PG/Redis integration 通过（另 1 项无关 Milvus 用例跳过），typecheck/lint/build 通过。Safari 使用独立测试库验证实际登录、列表、筛选/分页、空结果、复制及桌面/390px 布局。开发 RDS 仅同步列级授权与基线校验，用户数据不变；本机四角色已更新窄范围覆盖镜像并全部 healthy/readiness 200。App 前后哈希一致，未修改。本轮不推进 Pxx，也不宣称整个 P14 完成。见[验收记录](acceptance/admin-users.md)。

## 服务器运维职责移出仓库（2026-11-14）

域名入口、TLS 与证书续期的配置、脚本和运维文档已移出仓库，由宿主机独立管理；项目只维护应用监听、公开 URL 与可信代理设置。应用代码、Compose 和运行参数未改，本项目及远端解析服务保持停止。

## 测试服务器 PDF 真实复测（2026-11-14）

2页原生文本与扫描 PDF 通过真实 Xberg、OSS、PostgreSQL、Redis 和内网 Milvus 完成解析、关键词入库、查询及删除，权限隔离与产物完整性通过。随后325页完整 PDF 复测未通过：先遇 Worker 128MiB 临时磁盘 `ENOSPC`，重试解析后远端异步任务返回404，未完成全文入库及查询。详细结果和证据统一保留在[文档提取验收](acceptance/document-extraction.md)。

两轮临时数据均已清理，原 PDF 保留；远端解析机已确认 `Stopped + StopCharging`，本项目容器恢复停止。原 `.env`、Schema 和凭据未改，未实施同步复测、任务保留时间或临时磁盘调整。测试服务器缺少 App 源码，App 验收为 `UNVERIFIED_APP`。
## Xberg 接入现有文件与关键词流水线（2026-11-14）

现有 `/api/v1/rag/ingestions` PDF/Office 任务和 `FILE_UPLOAD` 已接到同一提取器/ECS-Redis 运行库，后续复用 document-keyword/BM25，不调用 Embedding/Rerank。完整 config 与母文件/解析批次 UUID 在受理时持久化；同步/异步、已知 job 恢复只 GET、模糊提交阻断、取消/删除晚到结果 fencing 已接通。规范正文原样保存，完整 JSON 无损 gzip、图片上传回执/资产关联另存；provider 转换前字节位置不冒充规范正文坐标。

394 项 unit/contract、160 项隔离 PG/Redis/Milvus integration 通过，新增19项协议单元与12项现有流程集成，包括真实 BM25 检索、资源重用/同批次去重、异步恢复、取消竞态、删除防晚发。外部提取服务为 loopback 模拟；按用户要求没有请求 `172.18.102.101`、ECS 控制面、OSS 或生产付费服务。本轮不改真实 `.env`、App、Schema/迁移或业务容器，应用默认关闭，已提供 VPC 测试配置。见[手册](runbooks/document-extraction.md)与[验收](acceptance/document-extraction.md)，不推进其他 Pxx。

## 文档解析机按需运行库（2026-11-14）

完成 `withDocumentParser` 与 ECS 电源适配：地址/策略可配置，当前单实例 ECS，未来可切长期在线 API；Redis 原子去重、FIFO 等待、全局并发默认 1、过渡锁及未知结果阻断。空闲默认 60 秒，Redis 事件驱动一次性定时器，仅未完成状态保留每分钟兜底；确认 `Stopped + StopCharging` 后持久标记并取消全部兜底，重启继续等待请求事件。仍在既有 scheduler 角色内运行。

375 项 unit/contract、146 项隔离 PG/Redis/Milvus integration 通过；其中新增 38 项 mock/虚拟时钟测试与 26 项真实 Redis/Lua/PubSub 测试。typecheck、lint、build、Compose 配置边界通过。只读确认指定北京 ECS 为按量 VPC/A10、`Stopped + StopCharging`，未执行真实开停机或解析。实际 `.env`、App、业务库和运行容器均未修改，默认 disabled；解析协议客户端/业务任务接线尚未实测。见[使用手册](runbooks/document-parser-machine.md)与[验收](acceptance/document-parser-machine.md)。本轮为基础设施增量，不推进 Pxx。

## 同镜像A10全文复测完成（2026-11-13）

按用户要求只申请A10，第一轮取得48核/310GiB/单A10，北京I；325页同镜像同请求351.727秒，对照T4的1411.127秒约快4.012倍（CPU档位也不同）。核心345.976秒、OSS2.368秒，GPU均值4.43%、容器CPU1.50核；图片/表格和OCR工作量核对，19/62页已知漏字未修复。实例及测试对象已清理，完整报告/正文/日志/采样导出。详见[本轮验收](acceptance/xberg-a10-kbxml-retest.md)。

## Xberg OSS/KBXML在T4全文实测完成（2026-11-13）

扩展T4及市场价抢占后，最终北京I的8核/31GiB/单T4按量成功；325页HTTP1411.127秒，核心1401.431秒、OSS4.292秒，97表格、768图片记录/751去重对象全部校验。GPU均值5.26%、容器CPU1.35核；19页ISO9001与62页图中文字仍漏，质量未全部通过。实例及临时对象清理，完整正文/日志/采样已导出；未改业务/App/数据库。详见[验收](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg OSS/KBXML核对与申请未完成（2026-11-13）

新镜像digest c8ad143d…783e25/build xberg-kbxml-v1-20261113-r4已静态核对；新增北京I交换机已加入本机GPU配置。T4单区/四区及A10两档实际申请均NoStock，关闭缓存和570驱动也未成功，无325页解析或性能结果。所有自有调度实例和临时输入已清理，新镜像缓存Ready并保留。长期GPU仍disabled，未改业务/App/数据库。详见[本轮记录](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg A10原生优先全文实测（2026-11-13）

用户允许其他A10配置后，8核档库存为空，使用16核/60GiB/单A10完成同源325页：342.025秒、1.052秒/页、97表格、768图。GPU平均4.54%、CPU平均1.53核，末尾132.86秒GPU0/CPU约1核；第19页9001:2015漏字，质量未全部通过。实例与3临时OSS已清理，自动缓存Ready并保留复用；未改业务/App/数据库/角色，长期GPU disabled。详见[本轮验收](acceptance/xberg-a10-native-first-trial.md)。

## 阿里云短信服务与当前 App 参照（2026-11-12）

已接入官方 SDK 4.6.0 的单条模板发送与回执查询，并接通既有登录 OTP Provider。命令行 `sms preview/send/query` 复用同一服务；双重关闭 SDK 自动重试，未知发送结果保留 pending、同键不重发。现有真实签名/模板只读审核核对后，使用用户授权的号码只发送一条，运营商回执 delivered，用户确认收信。手机号只留脱敏证据，验证码不落盘。

App 当前为 `../huahuo-ai`，原 `huahuo-app` 仅为历史参照。活动规范、默认脚本、参照配置和清单已更新；当前 Git 已初始化但没有 commit/origin，正确登记 GIT_UNBORN。新 App 认证请求与现行契约一致，未改或运行 Flutter。

Typecheck、Lint、Build、337 项 unit/contract、120 项真实隔离 PG/Redis/Milvus integration 通过；其中短信故障/幂等集成使用模拟供应商，单次真实送达单独留证。测试临时容器已清理，Schema/迁移/开发数据未改，业务四角色未重建；实际 env 只补已验证的签名/模板配置，原模式及凭据保留。详见[短信手册](runbooks/sms.md)，本轮不推进其他阶段。

## Xberg cuda-t4 新图片策略全文实测（2026-11-12）

同一325页/257页OCR清单按用户新配置完成首次请求806.159秒，8核/31GiB/单T4；返回325页、97表格，但22页CUDA错误均仅保留原文，第21页证书关键内容丢失，图片导出0。GPU平均8.19%、CPU2.47核，完整179,549字节服务日志已落盘校验。相比旧924.558秒少12.8%不能当等质量提速；实例及3临时OSS对象已清理，业务/App/数据库/角色未改，长期GPU仍disabled。详见[本轮验收](acceptance/xberg-cuda-image-policy-trial.md)。

## 移除 MinerU 文件解析适配器（2026-11-12）

在线/Mock客户端、ZIP/图文OCR绑定、Worker分支、供应商快照/身份、5个专属env、Compose注入、测试脚本与fflate依赖均已删除；本机2份env和6份示例同步，其余配置哈希/权限保持。通用文件入口保留UTF-8文本/Markdown/CSV；PDF/Office在受理前HTTP400且不建任务，原生文本无需模型提供方。旧正文/图文资产和查询权限保留，唯一基线删除5个供应商列定义，未操作业务库或App。

309项unit/contract、118项真实隔离PG/Redis/Milvus integration、Typecheck/Lint/Build/Compose/diff通过，业务Schema外键0与索引/CRUD回归通过。临时测试容器已清理，无卷或开发库删除。业务容器尚未重建，运行时需采用新镜像后生效；完整范围和校验异常记录见[移除验收](acceptance/mineru-removal.md)。不推进其他Pxx阶段。

## FunASR 单 T4 申请（2026-11-12）

已创建并保留 `eci-2ze2499g6uixsafwn1sq`，北京 H、4 核/15 GiB/单 T4，用户指定 FunASR 镜像锁定摘要，默认命令、私网8000；模型/CUDA/鉴权通过。用户随后要求结果，原音频实际7438.608秒，实例音频上限调为10800后完整POST一次：HTTP200/101.157秒、模型85.536秒、1523字符/218分段/4聚类标签，但文字97.85%为“嗯”，质量未通过。原始JSON/文字/分段/指标已导出；OSS导出403后直接ECI恢复，无重复转写，临时输出HEAD404、源文件不变。抢占缺货后NoSpot约11.63元/小时，3600秒期限预计14:12左右退出，未挂NAS；实例仍Ready。无业务、App、数据库或Compose角色改动，长期GPU仍disabled。见[实例与音频记录](acceptance/funasr-eci.md)。

## Xberg cuda-t4全文325页（2026-11-12，已收尾）

同一完整325页PDF、257页OCR清单、批次1，单T4/16核62GiB；请求924.558秒（15分24.6秒），返回325页/197,537字符/97表格。18页整页GPU OCR/cuDNN报错：17页内嵌图片重试恢复、1页保留原生文本，recovered=true不代表原整页路径修复，41条警告保留；不能当全部OCR通过。GPU平均7.43%、显存峰值1.44GiB，末尾176.6秒GPU0而CPU平均13.56核；比历史CPU全文慢3.88%，条件不同仅供参考。

默认服务/核心/权重/推理库未改，无复杂自动判页/区域OCR接线；实例与2个临时OSS已清理，原PDF及全部结果/阶段/采样/失败页导出。报价16.41元/小时，整轮计算费估算5.08元非账单。长期GPU disabled，详见[全文CUDA验收](acceptance/xberg-cuda-full-trial.md)。

## Xberg cuda-t4选择性OCR（2026-11-12，已收尾）

同源20页、原5页OCR清单、单T4/16核62GiB。原默认批次6三次均cuDNN Conv.2错误（HTTP200但summary.errors=1、无正文）；仅以官方rec_batch_num=1复核成功，20页/10,375字符/2表格，热请求18.633/18.634秒，慢于历史8核CPU10.477秒。GPU均值8.33%、显存969MiB，未拉满；原第20页证书邮编漏1个0，不能当默认配置/等质量验收通过。

未改核心、权重、运行库或业务/App/数据库/角色，API16及离线默认保持；未实施复杂自动判页/区域OCR。实例/3个临时OSS已清理，结果与默认失败、全部阶段/资源采样导出，长期GPU disabled。见[CUDA验收](acceptance/xberg-cuda-trial.md)。

## Xberg 4核全文325页（2026-11-12，已完成）

同一325页PDF完整输入，4vCPU/16GiB/0GPU，北京H、NoSpot、固定Xberg1.3.9镜像。成功请求890.026秒（14分50秒），325页均非空、197,589字符、97个表格对象，顶层OCR页失败记录0。257页请求OCR、68页文本层，结果缓存关闭。

首轮触发默认600秒内部超时，无正文；通过官方extraction_timeout_secs=3000在原实例完成重试。成功轮14分50秒，创建到导出28分18秒含失败/诊断/重试；CPU均值89.69%（3.59核）、RSS采样峰值4.159GiB。7条警告含5页缺字形，不能把325页输出当逐字无漏。实例/3个临时OSS对象已清理，源文件保留；原始JSON、MD、表格及两轮逐秒指标导出。无业务/App/数据库/角色变化，GPU disabled。见[全文验收](acceptance/xberg-full-trial.md)。

## Xberg按页OCR与4/8核对照（2026-11-11，已完成）

固定1.3.9镜像、同源20页和Paddle默认参数，使用官方force_ocr_pages与4/8线程预算；判页规则由本地测试侧提前固定为3/4/15/19/20页。结果缓存关闭。4核全页热请求38.804秒，选择性均值18.430秒；8核选择性均值10.477秒，组合减少73.00%。4次选择性Markdown逐字一致，20页/10,399字符/2表格，目录页码及证书关键字保留。

混合响应缺逐页backend，仍有水印/错字与语言检查警告，不宣称全量准确或生产自动分流已实现。两台实例/3个临时OSS对象清理确认，完整阶段与逐秒CPU/RSS已导出；没有Xberg核心/业务/App/数据库/运行角色变更，长期GPU仍disabled。详见[对照验收](acceptance/xberg-optimization-trial.md)。

## Xberg 1.3.9 前20页测试（2026-11-11，已完成）

同源前20页在北京H的4vCPU/16GiB CPU ECI完成中文Paddle OCR；修正镜像预热/运行缓存路径后，首次41.763秒、同进程第二次41.104秒，HTTP200、20页、10,870字符、2表格，正文/表格一致。默认0.148秒只取文本层，漏证书图中文字；强制OCR补出证书编号/公司，却丢目录309/310/315并保留水印噪声，不能作为等质量替换结论。

创建到ID0.754秒、首次健康47.614秒、拉镜像32.964秒；四核折算CPU均值约87%，进程VmHWM1480.4MiB。原始缓存OCR等待195.067秒取消的失败也已保留。结果/逐秒指标已导出；实例及7个临时OSS对象清理确认，源文件保留。仅本地测试材料/docs，未改业务/App/数据库/角色，长期GPU仍disabled。详见[验收记录](acceptance/xberg-trial.md)。

## 新OCR标签镜像前10页对照（2026-11-11，已完成）

用户选同一PDF前10页，逐页144DPI像素与原文件一致。新标签`t4-fp16-ocr-20261111T111715Z`在相同北京H/第三档/单T4默认命令启动，HTTP200/complete、10/10页、0issues，正文7184字符及1图片完整取回。请求后服务/模型仍健康；GPU精确ID/标签双查0，临时样本及归档HEAD404，源文件保留。

镜像拉取305.130秒、容器启动到模型健康25.032秒、HTTP149.143秒；5批合计147.383秒，对照旧149.078秒差-1.137%，未见明显提速。HTTP VLM代码逐字节一致，新增light_ocr未接入该路径；8页Markdown相同，2页仅标题层级不同。逐秒GPU/CPU/完整版本及CSV已导出，详见[验收记录](acceptance/gpu-parse-ocr-trial.md)。业务源码/角色/数据库/App不变，长期GPU仍disabled；本轮未额外跑无关全量测试。

## huahuo-parse 单 T4 解析与性能导出（2026-11-11，已收尾）

按用户要求提前停止，已导出《电子标书.pdf》第1—78页/325页，HTTP200/partial；190,663字符Markdown、27图片、原始响应与坐标全部取回并核验。247个未处理页错误为人工终止产生，另有第33页1条跨页表格待复核，不作为完整全文验收。北京H/第三档/单T4实际CUDA、Transformers FP16、batch2通过；当前与此前试验实例均已释放，独立ID/标签复核0，临时OSS对象删除，源文件保留。

性能报告及CSV/JSON已导出：ID1.236秒、拉镜像305.387秒、模型健康观测23.017秒；正常38批/76页P50=19.071秒、P95=226.853秒，密集采样窗口GPU均值约66%、显存峰值3.85GiB。人工暂停及在途收尾不混入基准；原控制脚本恢复后EPIPE失败保留，独立导出成功与清理分别有证据。SDK大参数POST修复后105项GPU单测、全量306项unit/contract及Typecheck/Lint/Build通过；无业务角色/数据库/卷/App变更，长期GPU仍disabled、持久Task/Worker未接入。完整边界见[验收记录](acceptance/gpu-parse-trial.md)。

## 阿里云 RAM 配置统一（2026-11-11）

- 按用户要求，OSS 与 ECI 的 AK 鉴权只读取 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`。删除旧 OSS 专用变量，缺少共享变量时直接报对应配置错误，不保留别名回退；各服务地域/Endpoint/Bucket 独立保留。
- 根 `.env`、历史本机 `.env.compose.local` 已删除/改名重复的 AK 项，原密钥值与其他设置保持；各保留一组共享 RAM 变量、0600。六份环境示例和 Compose 同步；另删除 `.env.compose.local.example` 重复的 `APP_TOKEN_SECRET`，保留原有效值。独立 GPU 文件不再定义第二组 AK，仍 disabled。
- 新增 5 项配置回归，验证 API/Worker 与 ECI 身份一致、旧别名不能替代缺失字段、不使用阿里云客户端的角色无新增要求。全量 305 项 unit/contract、Typecheck、Lint、Build 和 Compose 离线渲染校验通过；六示例/本地文件无重复赋值，Compose 仅 API/Worker 接收共享 AK。未调用真实云服务、重建运行容器或变更数据库/App；运行服务须下次构建重建后采用新命名。App HEAD/两个任务文件哈希复核一致。

## ECI GPU 抢占式实例底层模块（2026-11-11）

- 用户再次授权实际计时：本轮仅创建 `eci-2zed5m58u9c04n1qumjw` 一台，北京 H / 第 4 档，单 GPU；本地流程至 ID 1.797 秒、至首次 Running/Ready 31.785 秒，自动观察后释放，独立 ID/分配标签复查均为 0。开始拉镜像前约 27.8 秒，拉镜像开始至容器开始约 1 秒；具体 Pulled 事件采集缺失，不能把这 1 秒精确拆分。初始化缺字段已实际自动等待恢复。104 项 GPU 单测和后端编译通过，计时脚本另有 5 个传输替身场景；配置仍 disabled，未改业务模块、运行角色、数据库或 App。详见 [第二次计时验收](acceptance/gpu-spot-timing.md)。以下为首次试验及此前阶段记录。

- 用户明确授权一次真实试申请，唯一实例 `eci-2ze6q98onn7zdlqs0moj` 分配到北京 H、第 4 档 `ecs.gn6i-c24g1.6xlarge`，单 GPU、Running/Ready；验证后已释放，独立 ID/分配标签复查均为 0。试验单独限时 900 秒，仅一份创建请求，恢复只查询和释放已保存实例，没有再次创建。详见 [真实试验验收](acceptance/gpu-spot-trial.md)。
- 启动期原适配器曾将网络元数据问题报为 fatal，阻止初次观察/清理；保留失败记录，以同一实例恢复完成。现已区分初始化缺字段（transient 等待）与真实 VPC/标签错配（拒绝），不放宽授权。104 项 GPU 单测、全量 300 项 unit/contract、Typecheck/Lint/Build/diff 通过；一次性脚本另有 5 个传输替身场景。未测 CUDA/模型计算；Task/Worker 仍未接入，配置仍 disabled，业务容器/数据库/App 未改。以下为试申请前的配置与首版阶段记录。

- 北京 T4 配置细化：用户指定单卡与四档优先级 `gn6i-c4g1.xlarge → gn6i-c8g1.2xlarge → gn6i-c16g1.4xlarge → gn6i-c24g1.6xlarge`。复用 ECI 官方按顺序多规格重试，同一申请携带三个交换机、库存最优调度，目标一台，不发三份并行创建。Nginx 启动验证镜像及私有资源 ID 存在本地 `.env.gpu-spot`。按最新授权直接使用根 `.env` 的 `ALIYUN_RAM_ACCESS_KEY_ID/SECRET`，不复制或回显密钥。新增必填目标 VPC、申请前只读网络归属校验、返回实例 VPC 复核和 `pnpm gpu:preflight`，并补 `OperationDenied.NoStock` 重试分类。
- 真实只读预检退出 0：交换机为北京 H/L/F，可用 IP 当时为 4090/4088/4087，三者与安全组均属于目标 VPC；证据 `.local/gpu-spot/preflight.json`。95 项 GPU 单测、全量 291 项 unit/contract、Typecheck/Lint/Build/diff 通过。开关仍 disabled，没有 GPU 创建/删除、数据库迁移、容器重建或付费任务；GPU 库存/镜像运行/计算/ECI 写权限及 Task/Worker 仍待后续验收。以下首版验证保留其原范围。

- 用户指定的基础设施增量；默认 `SpotAsPriceGo` 跟随市场价，支持多 GPU 规格/交换机、有限退避、幂等检查点、状态/回收事件和归属核验后的释放。同步缺货与异步 `ScheduleFailed + NoStock` 均可重试；未知提交保留 token，运行中任务被回收不自动重做。
- `src/integrations/gpu-spot/` 使用锁定的官方 ECI SDK，独立 `.env.gpu-spot.example` 默认关闭。尚未注册 Task/Worker、长期调度或 HTTP 路由；检查点由后续所属任务持久化接入，不建内存任务账本。
- 83 项新增 Mock/SDK 单测、全量 279 项 unit/contract，以及 Typecheck、Lint、Build、diff 检查通过。无真实阿里云调用、GPU 申请、数据库迁移或容器重建；App 只读核对。语义、证据和下一验收点见 [GPU 运行手册](runbooks/gpu-spot.md)。本轮停在底层模块验收，不推进其它 Pxx 阶段。

## 知识库双模式与 BGE-M3（2026-11-10）

- 当前代码统一为真实 Note 混合检索与资料纯关键词检索。四张 PG 表为 `kb_note_hybrid_builds/chunks`、`kb_document_keyword_builds/chunks`，只保存处理、哈希、坐标及 Milvus 点 ID；完整正文仍由所属业务保存，分段正文写对应 Milvus 集合。
- Note 保存接原 Task/Outbox/Worker，BGE-M3 1024/profile `bge-m3-1024` 与固定 SHA 的官方 tokenizer 已同步到实际 `.env`、示例、Compose、代码及镜像。资料≤2000码点/零重叠，Note≤500码点/同章节约50字重叠；无独立章节 Parent 表。资料及纯 keyword 路径模型/tokenizer/Rerank 调用为零。
- 删除旧分路 Chunk 表、视图、Note PG 全文召回、旧 Qwen/集合默认值和被取代的索引实现，不双写、不兼容回读。App `part=raw`、整篇 `revisionId` 与 `partRevisionId` 的精确读取契约已经真实 HTTP 测试；该阶段曾使用用户 JWT + 方向 Service Key；现已移除，当前内部入口使用可信身份头，见[内部协定](runbooks/internal-services.md)。
- Typecheck、Lint、Build、196项 unit/contract、117项独立 PG/Redis/Milvus integration、Compose 与 diff 检查通过。真实 BGE tokenizer，确定性模型替身，未调用付费模型。全部6份环境变量示例及规范示例统一；新增配置一致性与中文无空格句界测试。镜像 `huahuo-server:kb-search-dev` 构建成功，关键产物哈希一致。
- 现有云 Milvus `default` 内两个新空集合已真实创建/加载/验证：`huahuo_kb_keyword_chunks` 只有BM25稀疏索引，`huahuo_kb_note_hybrid_chunks` 同行BM25+1024维Dense；Strong ready计数均0。已通过实际执行审批定向删除旧 `huahuo_chunks`、`huahuo_manual_text`，保留database和实例。
- 用户明确允许忽略其它开发部署并直接清理后，实际执行审批通过，RDS `huahuo` 按唯一基线重置为58张表、0外键，两个旧归档Schema已删除；1个管理员账号及凭据保留。四角色已切换 `huahuo-server:kb-search-dev` 且healthy，API/Admin readiness200，migrate `applied=[]/current=1`。实际四角色配置BGE/1024一致，API容器新集合连接通过，PG/Milvus一致性计数0/0无残留。详见 [本轮验收](acceptance/knowledge-base.md)；未操作另一部署的运行包。

以下为历史阶段证据；旧模型、集合、表、迁移链及切分参数不再是当前代码的运行契约。

## Note 混合检索 50 并发实测（2026-11-08）

- 使用已生效的 Milvus 闸门/SDK 池上限 50，HTTP 也设为 50 并发；82 字/1 块、5 万字/175 块各预热 100 次后，分别执行 100 次不同查询。200 次正式请求全部 HTTP200、目标命中100%、查询失败0%，两组 Milvus 实际峰值均49，无预热后连接/集合冷初始化。
- 短 API P50/P95=3,214.77/4,723.16ms、吞吐8.75req/s、重排回退32%；长=6,247.22/11,530.69ms、吞吐6.34req/s、回退100%。较历史8并发吞吐增加但尾延迟上升，P95一秒目标仍未达成。
- 闸门等待P95<0.006ms；长Note的Milvus RPC/Embedding首字节P95为6,576.15/5,747.86ms，短Note业务PG池等待P95为1,660.83ms。正式Embedding全部200且无重试，每请求1次逻辑HybridSearch/12次业务SQL；完整分段、历史对照及统计边界见docs/runbooks/milvus.md和.local/note-hybrid-concurrency50-latency/。
- 本轮只调整诊断脚本范围和峰值观测，语法、ESLint、diff检查通过，未改业务配置和算法。3000实际服务两次smoke均200并命中，冷启动单列。后台长Note自动清理仍失败，已按本批待删除ID和完整归属限定补偿；强一致确认PG/向量无测试残留、会话撤销，失败任务与墓碑保留。标签提取的provider不可用也保留独立失败记录，均不伪装为查询故障或已修复。

## Milvus 应用并发上限 50（2026-11-08）

- 按要求将 `.env`、示例、Compose 和配置默认值中的通用/Note Milvus 并发统一设为 50；两项配置均校验为整数 1～50。继续使用原有单 Repository 闸门、32 个等待位置及连接/集合就绪缓存，无第二套限流路径。
- 安装的 SDK 2.6.17 默认 gRPC 客户端池 max=10；显式对齐到对应 Repository 的并发值，min 保持 2（上限为 1 时 min=1），连接按需增长。新增 50 个操作同时执行、第 51 个等待并被释放的 Mock 测试，以及池配置/边界测试。
- Typecheck、Lint、Docker 内 `pnpm build`、358 项 unit/contract、216 项独立临时 PostgreSQL/Redis/Milvus integration 通过。隔离集成不调用真实模型，不使用业务库。`docker compose config --quiet` 与 `git diff --check` 通过。
- 本机四角色已更新为 `huahuo-server:milvus-concurrency-dev`，均 healthy；四角色运行配置确认两项均为 50，API/Admin readiness 均 200。API 容器分别建立文件与 Note 的真实 Milvus 连接，SDK 池均 min=2/max=50；证据在 `.local/milvus-concurrency-50/`。未改数据库、Redis、云端配置或数据，未执行新的 50 并发真实模型压测；该上限为单进程、单 Repository 的应用上限，不是云服务全局上限。

## Note 混合检索 8 并发实测（2026-11-08）

- 入口请求从4翻倍到8，Milvus内部仍4、API池10、重排预算200ms；每组预热后100次不同查询。短P50/P95=1,857.31/2,426.12ms，长=2,283.87/5,555.47ms；均100%目标命中、0%失败，重排回退18%/100%。
- 吞吐为3.97/2.94req/s，较历史4并发提高；但gate P95为645.51/1,678.62ms，原生RPC P95为1,198.19/2,290.94ms，长Note尾延迟恶化。PG业务池P95约2.41/2.60ms、SDK本地P95<0.76ms，Embedding全HTTP200且无重试。P95一秒仍未达成。
- 只运行现有脚本参数，未改业务/部署配置。完整分段及4/8对照见docs/runbooks/milvus.md；数据在.local/note-hybrid-concurrency8-latency/。

## Note 混合检索 4 并发实测（2026-11-08）

- 请求并发由 2 提至 4，Note Milvus 内部上限保持已有的 4；每组并发预热8次，再测100个不同查询，topK=5、模型/召回配置及200ms重排预算不变。82字/1块 API P50/P95=1,574.25/2,473.41ms，5万字/175块=1,924.63/2,842.32ms；均100%命中、0%查询失败，重排回退10%/100%。
- 增补逐环节及子阶段计时：正式 Embedding 全部 HTTP200且无重试；每请求1个逻辑HybridSearch RPC，元信息RPC/冷建连/集合初始化均为0；Milvus gate P95<0.005ms、SDK本地P95<0.8ms、PG事务连接池等待P95<0.41ms。主体耗时在远端RPC、Embedding首字节与12次业务SQL往返，P95一秒目标仍未达到。Dense/BM25/RRF云端内部无法从客户端可靠分拆，计入同一个RPC。
- 只扩展诊断脚本，未改变默认检索模式或永久并发配置；脚本Lint/语法及92项相关单测通过。详细结果见 docs/runbooks/milvus.md 和 .local/note-hybrid-concurrency-latency/。

## Note 纯 BM25 实测（2026-11-08）

- mode=keyword，保持真实英文/mixed 两路 BM25、权限和 ready 校验；82 字/1 块及 50,000 字/175 块分别预热后双并发 100 次不同查询。短 P50/P95=837.14/1,205.82ms，长=1,095.86/1,390.01ms，均 100% 命中目标 Note、0% 查询失败。
- 正式查询和预热的 Embedding/Rerank 调用计数均为 0；每请求 2 次 SDK search，热连接/集合就绪冷初始化均为 0；PG 业务 SQL 为 8 次往返。P95 1 秒目标仍未达成，分段瓶颈为 BM25 RPC 和 PG 往返。
- 只扩展压测脚本，未改默认检索模式或业务检索实现。相关 89 项单测及脚本 Lint/语法检查通过；实际 3000 API 两次关键词 smoke 200。长样本准备的阶段失败由原 Worker 恢复，诊断脚本改为等待最终任务状态。完整统计与原始记录见 docs/runbooks/milvus.md 及 .local/note-bm25-latency/。

## Note 混合检索预算与实测（2026-11-08）

- 核对实际运行镜像已含 Note Milvus Repository/就绪缓存，直接复用；四组预热后均无新建连接或集合校验。
- 新增 `RAG_NOTE_RERANK_BUDGET_MS=200`，Note Dense/Hybrid 的远端重排超时、失败或无效响应按已经验证的 Milvus 顺序回退，取消 HTTP 等待，保留返回前的用户/Note/任务状态复核；记录实例级回退次数、分段及 Embedding 逐次尝试，不记录文本、凭据或向量。
- 同机 API 容器分别用 82 字/1 块与 50,000 字/175 块 Note 做前后对照：每组预热后双并发 100 次不同查询，共 400 次且失败保留。短 P50/P95 从 4.31/17.14 秒降至 2.10/4.25 秒，长从 6.26/32.26 秒降至 2.18/3.90 秒；命中率从 99%/87% 至 100%/100%，失败率从 1%/13% 至 0%/0%，优化后重排回退率为 77%/100%。
- 1 秒 P95 目标未达成；剩余主要是 Milvus RPC、Embedding 首字节长尾及 12 次 PostgreSQL 网络往返。端点、模型、请求和凭据一致，未复现容器固定数秒的 Embedding 中位数；系统代理/虚拟 DNS 仍在链路内，未修改 VPN。
- Typecheck、Lint、Build、354 项 unit/contract 和 216 项隔离真实 PG/Redis/Milvus integration 通过。实际 3000 API 两次 smoke 200；运行 API 使用 note-hybrid-budget-dev，其他角色未重建。详细指标、统计口径、真实/Mock边界及复现命令见 docs/runbooks/milvus.md。

## 测试服务器后端维护（2026-11-07 至 2026-11-14）

- Milvus 已确认连接内网 `172.18.102.95:19530`；按授权清除失效的 `grpc_proxy` 并补齐现有路径缺失的 tokenizer 文件，测试数据及临时探针已清理。
- 项目容器于 2026-11-10 按用户要求整体停止；2026-11-14 确认仍停止。当时仅整理文档、删除首次签发模板和性能报告，未改动运行配置或恢复服务。

## Note 块级增量索引（2026-11-07）

- 云开发库 `huahuo` 已按新基线初始化。旧 `public` 归档到 `initialization_backup_20261107_note_delta`，核对 58 张表、406 行及表 OID 一致。新 `public` 有 59 张表，物理外键为 0，迁移重放为 `applied=[]/current=1`。四个后端角色使用 `huahuo-server:note-delta-init` 且均 healthy，API/Admin 就绪接口均为 HTTP 200。
- 保存 Note 正文后沿用现有任务入口。Worker 对照当前索引正文和旧 UTF-16 切点，先撤下失效点，再逐批写入变化块。从保存事务提交起，检索暂停召回这条 Note，直到最新入库任务完成且当前块全部为 `ready`。召回与重排返回后按现有任务 ID 复核，防止在途查询混入旧结果。
- PostgreSQL 基线维护当前块和重试需要的任务数据，Note 不再整篇发布索引版本。Flutter 的手动 Note 保存仍走既有 Note 接口。
- 验证通过 329 项单元和契约测试及 135 项隔离 PostgreSQL/Redis 集成测试。块内删半、跨块修改、大改回退均检查了模拟 Milvus 写入和删除清单，未变化块没有写入。
- 开发环境已启用 `MANUAL_TEXT_ENABLED=true`。使用真实 Embedding 和 Milvus `default.huahuo_manual_text` 实测临时 Note。首次写入 3 块，编辑其中 2 块后只新增 2 个点并删除 2 个失效点，未改块保留原 ID 且写入次数为 0。该轮测试发生在整条 Note 暂停召回规则实施之前。完工后强一致读取核对了 3 个点，测试 Note 已删除，Milvus 复查无测试点残留。
- Note 的纯英文关键词查询现在并行使用英文与 Jieba 分词，Jieba 查询限定为中文和中英混合块。两路沿用授权范围及 `ready` 块限制，按块 ID 去重并保留最高 BM25 分数。存量索引可直接使用。
- 在开发 Milvus `default.huahuo_manual_text` 用自动入库的临时 Note 复测。仅用英文分词时 `granitefable` 漏召回，修复后的 `keyword` 模式用同一输入命中 `# 第二节 / Search token: granitefable.`。实测关闭重排并断言检索未使用 Embedding。删除测试 Note 后强一致复查无向量残留。类型检查、Lint、330 项单元与契约测试通过。四个本机后端角色已切换到 `huahuo-server:note-bm25`，健康检查通过。


- Note 编辑矩阵覆盖局部编辑、Markdown、差分回退和保存时序。断言 UTF-16 切片、核心区间、逻辑块与物理点、Embedding 调用和实际写删 ID。Worker 保留 Note 锁直到超时写请求结束。Note 行锁内保证入库任务时间顺序，防止时钟回拨选中旧任务。沿用既有字段和表。
- 类型检查、Lint、Build、341 项单元与契约测试及 215 项隔离集成测试通过。五组真实 Milvus 用例覆盖半删、跨块替换、大改回退、清空恢复和 S09。S09 在第一批点已可从 Milvus 读取时确认 Dense、BM25、Hybrid 都返回空，完成后再验证三种检索。真实 Milvus 使用确定性测试向量，并强一致读取物理点核对 PostgreSQL 当前块。重试和迟到写入由故障注入控制。

### 开发环境实测与性能调整（2026-11-07）

- 本机开发容器运行 `huahuo-server:note-perf-dev`，使用云开发库和 `default.huahuo_manual_text`。已通过实际 API 验证 S09。分两批更新三个块中的两个，第一批已写 Milvus 而第二批仍待处理时，Dense、BM25 和 Hybrid 均返回空。完成后召回新正文，未变点沿用原 ID，写入与删除次数均为零。
- PostgreSQL 改为单次批量持久化块计划，保留同一事务内的任务校验和差分逻辑。5 万码点样本在旧镜像中首轮执行超过 15 秒租约，任务在第二次领取后成功。优化后以下三例均一次成功，差分和切块耗时约 98 至 131 毫秒。
  - 首次写入 217 点，保存到就绪从 76.9 秒降到 49.4 秒。
  - 局部编辑保留 216 点，写入一个点并删除一个旧点，保存到就绪从 36.3 秒降到 11.1 秒。
  - 大改触发回退，复用 167 点、写入 26 点、清理 50 点，保存到就绪从 47.7 秒降到 19.2 秒。
  - 基线连续保存出现一次 HTTP 500，日志仅记录通用错误码。优化后同一场景连存三次均成功，前两次索引任务被最后一次覆盖。从首次提交到核对最终 PostgreSQL 和 Milvus 一致约 20.3 秒。
- Note 检索复用配置目标的 Milvus 连接及集合就绪检查。同一笔记在开发环境交替测试旧连接方式与复用方式，查询服务关闭重排。单请求 8 次，中位数从 4.87 秒降到 0.75 秒。四并发各 12 次，P95 从 7.18 秒降到 4.52 秒。
- 实际 API 保留开发重排配置。71 码点样本四并发关键词各测 12 次，P50 从 6.17 秒降到 3.24 秒，P95 从 9.37 秒降到 8.48 秒。双并发混合检索各测 4 次，样本 P95 从 15.94 秒降到 5.58 秒。短笔记局部更新单次实测约 11 至 12 秒。5 万码点样本四并发关键词 12 次，实际 API P95 为 5.63 秒，双并发混合检索 4 次的样本 P95 为 10.82 秒。以上为开发样本，包含网络与远端服务耗时。测试 Note 已删除，Milvus 已核对无残留。

- 最终回归发现应用时钟落后时，Worker 完成任务可能接受已过期的租约。完成操作在持有任务行锁后用 PostgreSQL 的时钟判断租约，并用应用时钟落后 60 秒的用例验证。类型检查、Lint、342 项单元与契约测试及 215 项隔离集成测试通过。

- 核对桌面端和手机端的工作区关键词搜索，两端调用同一个 PostgreSQL 搜索接口。此前 8.48 秒的 P95 来自 Note RAG API，含远端重排。对同一份 71 码点中英混合样本，四并发各 12 次，调整前工作区 API P95 为 0.60 秒，Note RAG API P95 为 2.95 秒。
- 服务层拆分耗时发现 Note 的英文与 Jieba 两路查询共享同一 Milvus 并发限制。四并发对照中，关闭重排时并发上限 2、4、8 的 P95 分别为 3.37、1.81、2.20 秒。Note 默认上限调整为 4，显式关键词模式按 BM25 分数返回。Dense 和 Hybrid 按配置执行重排，多 Note 查询仍在返回前复核当前任务。
- 四个本机开发容器切换到 `huahuo-server:note-keyword-fast-dev` 并通过健康检查。相同条件下实际工作区 API 的 P50/P95 为 0.33/0.62 秒，Note RAG API 为 1.78/2.19 秒。每个请求均命中测试笔记，Note 关键词响应没有重排分数。延迟仅覆盖已入库后的 API 请求，样本为四并发各 12 次。测试笔记已删除且 Milvus 无测试点残留。类型检查、Lint、Build、343 项单元和契约测试、215 项独立 PostgreSQL/Redis/Milvus 集成测试通过，其中 S09 验证三种检索均跳过同步中的 Note。

- 混合搜索分段实测使用 `note-keyword-fast-dev` 的同配置 HTTP API，真实调用开发 Embedding、Milvus 与远端重排。两组均为双并发各 12 次，两个会话使用同一用户，固定搜索已入库的单条 Note，查询 `granitefable`，`topK=5`。71 码点、3 块样本 API P50/P95 为 1.92/3.55 秒，5 万码点、217 块样本为 3.60/5.44 秒。实际运行中的 API 另对短样本双并发 4 次，P50/P95 为 2.27/3.33 秒。所有请求都命中测试词，确认使用了重排。
- 短 Note 与长 Note 的各段 P50（毫秒）依次为鉴权 50/47、PostgreSQL 读取可检索块 184/231、查询 Embedding 154/160、Milvus 混合召回 851/1835、PostgreSQL 取原文 198/228、远端重排 141/399、PostgreSQL 最终复核 197/185。每次搜索的三段 PostgreSQL 事务共 12 条 SQL 往返，另有鉴权更新。远端重排输入为 3/20 个候选块。Milvus 连接已预热，SDK 调用前 P95 为 0.7/1.4 毫秒。短样本最慢请求的远端重排为 1.50 秒，长样本最慢请求的 Milvus 调用为 4.00 秒。Milvus 计时含客户端和网络，缺少对应的云端执行计时。测试 Note 已删除，强一致读取确认无测试点残留。

- 纯语义与混合搜索用同一配置 HTTP API 交替实测，复用 71 码点和 5 万码点两种测试正文、`granitefable` 查询及 `topK=5`。两种模式分别双并发各 12 次，均命中测试词，均调用远端重排。短样本纯语义/混合的 API P50 为 1.97/1.88 秒，P95 为 3.10/3.94 秒，Milvus P50 为 0.64/0.93 秒。长样本的 API P50 为 2.75/3.34 秒，P95 为 6.22/4.60 秒，Milvus P50 为 1.46/1.79 秒。长样本纯语义的最慢请求在 Milvus 客户端调用内耗时 4.96 秒，包含网络与服务端处理。每组 P95 对应组内最慢请求。已删除两条测试 Note 并验证 Milvus 无残留。

- 在开发容器固定同一个查询向量和 217 个已就绪块，双并发每组 12 次直接计时 Milvus。预热后每次只有一次 `Search` RPC，无重试，SDK 本地开销低于 1 毫秒。`GetVersion` P50/P95 为 430/806 毫秒。现有查询和同一过滤条件的模板写法 P50/P95 分别为 1.07/2.08 秒和 1.02/1.55 秒，12 次的前 20 个块 ID 集合均相同。该轮实际一致性均为 `Bounded`。
- SDK 2.6.17 构造搜索请求时用 `||` 处理一致性。`ConsistencyLevelEnum.Strong` 的值为 0，当前 Note 集合默认 `Bounded`，因此现有搜索实际发送 `Bounded`。第二轮核对实际 RPC 参数后，当前写法与显式 `Strong` 的 P50/P95 为 1.20/1.44 秒和 1.48/3.49 秒，各 12 次，前 20 个块 ID 集合相同。结果仅覆盖已就绪的测试 Note，不能验证有界一致下刚写入的数据何时可见。两个测试 Note 均已清理且 Milvus 无残留。计时包含网络和服务端，未能读取对应时段云端监控。

## 独立 TextIngestionJob 实施（2026-11-07）

- 新增 `text_ingestion_jobs` 与 `text_ingestion_chunks`，核心 DTO 使用六种字符串来源与九个已确认字段；没有业务版本号，只有手动输入可以修改原文。独立导入记录不伪造 Note，Chunk `parent_id` 直接指向整篇记录。
- 任务执行复用原 Task/Outbox/Worker，所有新来源在文本产出后共用 LangChain、tokenizer、Embedding、Milvus 核心。文件下载和图文预处理已抽成单份能力，原文件 Worker 同用；未接通的爬虫、独立 OCR、ASR 明确不可用。
- 增加 JWT 用户级创建、详情、列表、编辑和失败重试接口。更新通过任务指针和租约 fencing 防止晚到覆盖；新索引完全成功后才发布并清理旧目标。既有 RAG 查询通过 `sourceType=text` 检索独立记录。
- Typecheck、Lint、Build、317 项单元/契约测试和132项隔离真实 PG/Redis 集成测试通过。真实 RDS 原地添加新表、权限，完整目录比对和原记录摘要通过，当前58张表、0外键；四角色与API/Admin readiness健康。未调用真实付费模型，未修改App、凭据、OSS或Milvus数据。
- 接口示例、来源实际能力、恢复策略、真实/Mock证据和环境边界见 `docs/runbooks/text-ingestion.md`。

当前实现以唯一 `migrations/0001_initial_schema.sql` 为初始化基线；旧迁移链、旧用户表别名及数据回填兼容路径已移除。

## 统一用户与认证

- `public.users` 为App、Web、API共用账号主表，`user_identities`保存身份HMAC及脱敏值。
- 手机号登录采用 `purpose: sign_in`，登录必须提供 `clientType/clientId`；不接受旧参数别名。
- 会话使用精确JWT jti/hash绑定，停用或删除账号拒绝登录、访问和刷新；Refresh原子轮换且不超过会话绝对期限。
- Ed25519/EdDSA、JWKS和方向Service Key契约保持；email/OAuth、其它OTP用途和user_api_keys目前仅数据库基础。
- 关系使用普通ID和索引，物理外键为0；用户和工作区归属由业务层校验。
- Readiness精确匹配当前基线checksum，旧库不能因迁移号更大而误报ready。

## 原huahuo数据库实际启用（2026-11-05）

数据库名称及连接保持`huahuo`，没有新建其他数据库。不可逆清库操作曾被自动审批拒绝且未执行；随后获准执行完整保留数据的同库归档方案。

旧public整体归档至`initialization_backup`，58张表4149行的OID、存储标识及内容摘要保持不变；旧视图内容在封存前核验一致。归档列/表/序列/函数权限先撤、Schema权限最后撤，4个运行角色无归档USAGE/CREATE；管理员保留显式恢复权限的能力，归档不进入任何业务读取或兼容路径。

新public按原样0001建立，用户/会话/业务Chunk为空，物理外键全库0；迁移重放`applied=[]`、current1。控制台账号凭据保留策略未创建默认账号，原表本身为空。DB账号、密码、JWT私钥和服务Key未更改。

实际RDS不存在单独huahuo_migrator，初始化和重放沿用已配置的huahuo_admin。第一次数据保留事务因脚本预设migrator存在而自动回滚，确认原Schema/数据未变并恢复服务后，按实际角色配置完成切换；没有创建角色或篡改授权绕过。

## 验收及运行

Typecheck、Lint、Build、27文件229项unit/contract、10文件115项隔离PG/Redis integration通过。另有6项真实PG归档安全实验，覆盖非superuser DB owner、namespace与行保留、ACL封存、函数搜索路径、正常重放及失败整体回滚。

四个独立运行角色均使用最新huahuo-server:dev并healthy；API容器实际连接huahuo、基线checksum匹配、PostgreSQL/Redis均true，API/Admin readiness200，JWKS为EdDSA/Ed25519 server-current。API/Admin只绑定回环3000/3001。

本轮没有调用真实短信、Embedding或Rerank模型，没有清理共享OSS或Milvus；现有向量样本不等于新业务入库验收。App保持只读，客户端需适配新的认证Payload并重新登录。真实记录位于忽略提交的`.local/huahuo-unified-cutover/`。

## Note 与知识库文档的目录读取（2026-11-05）

- Note 与知识库文档复用 Markdown 结构解析，TOC 按入库版本保存。带用户 JWT 的详情返回嵌套目录，`/sections/{sectionId}` 返回精确原文。文件从对应的 canonical 对象读取字节范围，Note 从 PostgreSQL 正文快照读取。Flutter 现有 Note raw Markdown 写入路径继续驱动自动入库。
- 新索引正文以 300 字为 Note 切分目标，找不到合适断点时允许延长，硬上限为 Note 500、知识库文档 2,000 个 Unicode 码点，包含重叠。共享 splitter 与唯一初始化 SQL 均执行上限，章节坐标保持 UTF-16。既有环境切换到本版前使用更新后的初始化基线。
- Typecheck、Lint、Build、235 项单元/契约测试和 117 项隔离 PostgreSQL/Redis 集成测试通过。集成测试使用 Mock 解析与向量服务，并从本地对象存储验证精确节选。业务库与共享 Milvus、OSS 未参与本次验证。
- Note 调整为 300 字目标、500 字硬上限后，Typecheck、Lint、244 项单元/契约测试及 11 项 Note 入库集成测试通过。全量集成另有 2 项文件图片诊断用例触发已有的图片唯一约束。

## 数据库审计修复与真实 RDS 同步（2026-11-05）

- 清理 `upload_parts`、`resource_delete_requests`、`task_requests` 及运行调用，幂等统一到通用加密实现。删除两个重复普通索引、无消费的 CSRF hash 和调度短事务租约字段。保留普通 Note 搜索、业务游标、文档/笔记分离及有真实职责的关系表。
- 图片诊断改为文档级单份 manifest，完整保留未绑定 OCR；资产事务成功后才发布正文检查点。修正此前导致两项集成失败的图片唯一约束：稳定来源路径独立，允许共用相同图片对象，不修改解析器或切分算法。
- 同步此前工作区 TOC 与长度约束到原阿里云 RDS `huahuo`。隔离 PostgreSQL 演练及真实目录比较均证明修复结构等于唯一新基线；非空表保护、保留记录摘要和封存归档不变核验通过。没有清库、数据回填兼容分支、凭据更新或新迁移历史。
- 当前 `public` 56 张表、1 个 View、179 个索引，外键为 0。迁移重放 applied=[]/current=1；源码、镜像、RDS checksum 一致。四个独立角色 healthy，API/Admin readiness200。
- 最终 Typecheck、Lint、Build、29 文件244项单元/契约测试和11文件125项隔离真实 PG/Redis 集成测试通过；真实模型/解析/向量服务未调用。App上传及资源删除客户端只读核对，未修改。证据与保留边界见 `docs/runbooks/database-cleanup.md`。

## Admin 示例工作台（2026-11-06）

- `admin-ui/` 使用 Tailwind CSS 和 Ant Design，工作台展示四条明确标注的示例记录。`pnpm dev:admin-ui` 仅在本机回环地址运行独立预览。常规构建的页面由 Admin 服务在 `/admin` 提供，同源复用现有会话、登录和退出 API。
- Typecheck、Lint、Build 和 244 项单元/契约测试通过。浏览器核对桌面与窄屏布局，并用模拟存储验证错误密码提示、登录、刷新恢复会话和退出。此次验证使用本地预览与隔离测试服务。
- App 只读参照 `20f61b7` 的 `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart`，其中 `/api/v1/auth/login` 是 App 登录契约。本次页面只使用 `/admin/api/v1`，P14 业务页面与真实业务数据接入待定。
- 本机 `3001` 原容器没有前端产物。Docker 镜像构建并通过离线页面校验后，仅重建 `admin` 容器。就绪检查通过，浏览器打开 `/admin` 显示登录页，HTML、CSS 和 JS 返回 `200`，无会话调用 `/admin/api/v1/me` 返回 `401`。
- 工作台改用浅色主题。侧栏收起为图标栏并记住浏览器偏好，概况和示例记录各自可折叠。Typecheck、Lint、Build 和 244 项单元与契约测试通过。浏览器验证折叠、刷新恢复与 390 像素宽布局，本机 `3001` 已更新并加载新页面。

- 本轮 Note 性能验收的合成数据已清理：PostgreSQL 测试 Chunk=0，Milvus Strong 测试点=0；测试会话撤销，保留合成墓碑及失败任务历史。一次清理任务失败后使用原删除流程和待删除 ID 恢复成功，未改清理业务、清库或调整凭据。完整原始性能失败记录保留于 `.local/note-search-latency/`。

- BM25 本轮合成数据清理遇到后台失败，已按持久的 175 个待删除 ID 和完整归属条件执行定界补偿；强一致确认后清理测试索引状态、撤销会话，失败任务与墓碑保留。后台自动清理异常仍需单独修复，未在性能测试中掩盖。

- 4并发混合测试的真实3000端口补充smoke均200。已知自动清理异常本轮再次出现，保留失败任务并对测试fixture使用完整归属和持久待删除ID补偿；没有修改业务Worker或掩盖失败。最终强一致核验见 .local/note-hybrid-concurrency-latency/final-verification.json。

- 8并发批次实际3000端口的两次单请求smoke均200并命中。既有自动清理异常再次发生，长Note的175个持久待删除ID仅在完整归属范围内补偿，失败历史保留；本轮未修复后台业务。最终数据/会话核验见.local/note-hybrid-concurrency8-latency/final-verification.json。


## 发布清单与 test 来源恢复（已发布）

增加 PR 上线清单与 ENV 值断言，恢复 main 控制/test 业务。main 直接发布尝试在预检被宿主配置检查阻止，未换容器；测试实际基准保留0771fd5，正式生产未初始化。验证与交付见 docs/acceptance/release-config-checklist.md。

真实 test 发布 Action 43725571994 五阶段通过，OK，无到期强退；四角色5b844ba健康、保留上一成功0771fd5与数据卷。正式生产未部署。详见 docs/acceptance/release-config-checklist.md。


## 原生 test 自动发布与 main 准备（候选）

收敛为原生Auto-merge与workflow_run，保留现有五阶段和安全门禁；main自动生成准确候选摘要，生产未接入。移除临时总控脚本，细节与验证见 docs/acceptance/native-release-flow.md。
