# 当前发布状态

现行规则：test 提供业务与清单，main 提供受保护发布流程；本地开发以 test 为基线。最新只读查询确认测试服 ce1123e 已通过五阶段发布，本期 2026-11-16 的云控制修改仍待发布，正式生产尚未初始化。以下早期条目按历史保留，不作为当前部署指令。

# 当前开发进度

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

现有主Compose的api-server/admin/worker/scheduler已使用同一完整构建镜像更新，四者healthy/readiness200；未建立新数据库/隔离栈或改动已有卷。Admin在 http://127.0.0.1:3001/admin#configuration ，沿用原账号。HTML/JS 200，匿名配置接口401，API-server同路径404。CPU节点及PROCESSING_NODES_ENABLED保持关闭，未开停云机器或调用解析。运行证据：.local/runtime-config/start-existing/runtime-result.json、database-sync.jsonl；镜像完整构建日志image-build-full.log。首次窄范围打包发现缺少API依赖，已改为锁文件完整构建并通过四角色模块导入/启动验证。


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
- 删除旧分路 Chunk 表、视图、Note PG 全文召回、旧 Qwen/集合默认值和被取代的索引实现，不双写、不兼容回读。App `part=raw`、整篇 `revisionId` 与 `partRevisionId` 的精确读取契约已经真实 HTTP 测试；Agent 内部入口继续使用用户 JWT + 方向 Service Key。
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
