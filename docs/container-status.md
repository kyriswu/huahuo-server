# 当前容器与数据库状态

## RAG参数与ENV清理部署（2026-11-15）

现有开发库只更新原runtime_configuration的values JSON、revision1→2并记录导入审计；无DDL/checksum变化或业务表写入，原节点一条/revision3/并发16保留。当前RAG参数先导入再删除ENV，四角色同一完整rag-settings-20261115镜像且healthy/readiness200，实际环境不再注入退役项。没有启动解析机或调用模型，Admin仍127.0.0.1入口。证据在.local/env-cleanup，见[验收](acceptance/runtime-configuration.md)。

## 节点JSON与试用弹窗更新（2026-11-15）

现有开发RDS只将processing_nodes的16个配置列无损合为config jsonb，保留id/revision/时间、节点和业务数据；先回滚演练、逐项比对再提交及CAS更新基线。未重跑0001或更改卷/账号；仍只有原节点1条、revision3、并发16，物理外键0。四角色同一完整镜像更新且healthy/readiness200，主后台试用改为解析与模型tab内Modal。用户确认本机不在解析机内网，实测等其部署内网测试机；本轮不开云机。证据在.local/runtime-config/node-json-modal，详见[验收](acceptance/runtime-configuration.md)。

## Admin文档试用与旧入口清理（2026-11-15）

现有后台新增文档试用，复用业务解析配置/客户端/节点占用，只展示Markdown/JSON和阶段耗时，不创建笔记、资料、入库任务或索引。节点状态按用户要求显示“在线 / 不在线”。旧ENV加载器、假AK校验、无用参数与未使用旁路已清理；构建清除旧生成产物。434项unit/contract、219项隔离PG/Redis通过（1项Milvus跳过），typecheck/lint/build通过。现有主环境按原账号/数据更新，PDF/Office仍需CPU完整配置及可用节点。见[验收](acceptance/admin-document-trial.md)。


## 现有本地环境已启动（2026-11-15）

用户随后明确要求不用隔离环境，启动当前项目。已核对原RDS基线与HEAD一致、新基线仅追加3张配置表，在事务内新增表/索引/授权并导入5项原非秘密业务配置，最后CAS更新基线校验；没有重跑整份0001、清库、修改原账号或重置凭据。用户、会话、工作区、笔记、资源及任务行数前后一致，物理外键仍为0。

现有主Compose的api-server/admin/worker/scheduler已使用同一完整构建镜像更新，四者healthy/readiness200；未建立新数据库/隔离栈或改动已有卷。Admin在 http://127.0.0.1:3001/admin#configuration ，沿用原账号。HTML/JS 200，匿名配置接口401，API-server同路径404。CPU节点及PROCESSING_NODES_ENABLED保持关闭，未开停云机器或调用解析。运行证据：.local/runtime-config/start-existing/runtime-result.json、database-sync.jsonl；镜像完整构建日志image-build-full.log。首次窄范围打包发现缺少API依赖，已改为锁文件完整构建并通过四角色模块导入/启动验证。


## 分类配置代码验收（2026-11-15）

只运行随机命名、回环端口、tmpfs的本轮隔离PG/Redis测试容器，215项通过（1项Milvus跳过），已由执行器核对owner后清理。主Compose未重建，现有卷/开发库/云资源未操作。四独立角色+一次性migrate拓扑保留，Admin监听边界未扩大。现有RDS尚未应用新增配置表，不能宣称新页面已部署。见[验收](acceptance/runtime-configuration.md)。


## 文档解析CPU ECS目标配置已替换（2026-11-15）

本机与示例目标改为 `i-2zejbbo2svjieb44tqy8` / `172.18.102.103`，仅配置和只读身份核对；实际触发模式仍默认disabled，主业务容器未重建、Redis状态/数据卷/业务数据库未改。首次Describe为Stopped+StopCharging，末次为Running，本轮没有调用Start/Stop。未验证CPU服务HTTP或文件解析。见[验收](acceptance/document-parser-cpu-target.md)。

## prod-callback独立云测试已释放（2026-11-14）

独立ECI `eci-2zeg0m8zdkp9vfuhmk8s`（8核/30GiB/A10）已删除，ID与专属allocation标签双查为空；原首选ECS启动被NoStock拒绝，最终仍Stopped+StopCharging。753临时OSS对象逐项404、原PDF保留，共享镜像缓存未删除。只更新本地源码/构建和无密钥模板，主业务角色、真实.env、业务PG/已有卷不变；本机隔离PG/Redis测试容器已清理。见[验收](acceptance/xberg-a10-prod-callback.md)。

## ECS 缺货回退代码验证，未部署（2026-11-14）

同一 Compose 仅 worker/scheduler 增加默认关闭的 ECI 回退配置及一致的 OSS Bucket/前缀；没有新增服务或端口。隔离 PG/Redis integration 201通过、1个 Milvus用例跳过，脚本只清理本轮临时容器/凭据。实际 `.env`、主业务栈、RDS/OSS/云GPU及已有数据卷未操作。见[验收](acceptance/document-parser-eci-fallback.md)。

## 图片规范化源码验证，主栈未更新（2026-11-14）

本轮只更新后端源码／构建和文档，未重建主 Compose 业务角色，未变更 `.env`、RDS、Bucket、凭据、卷或现有 OSS 对象。先前 Admin 覆盖镜像和未部署的文档提取代码边界保持；当前运行容器不能当作图片优化已部署。

使用本机 Colima Unix socket，`node scripts/integration.mjs --milvus` 创建本轮专属 tmpfs PG17.9/Redis7.4.8/Milvus2.6.26 和随机独立测试库；178 项通过后仅删除该轮容器／临时凭据，无开发库写入或数据卷删除。404 项 unit/contract、typecheck/lint/build 通过。唯一迁移哈希未改，隔离库业务外键为 0。见[验收](acceptance/markdown-images.md)。

## Admin 基础用户页面已更新至本机（2026-11-14）

当前运行镜像的窄范围覆盖仅包含 Admin 模块、管理网页产物和唯一基线，其他业务模块保留原运行代码。为统一新增列级授权后的基线 SHA256，主 Compose 的 api-server/admin/worker/scheduler 均使用覆盖镜像 `sha256:3cf371700533eb23dac7f33f6dbcfbe576de3c226f335f1e0ccabe8ce3a1fa6b`；四角色 healthy/readiness 200，迁移重放 applied=[]/current=1。API/Admin 仍只绑定回环 3000/3001，Worker/Scheduler 无宿主业务端口。Redis、现有文件卷及凭据未变。

最终空结果文字对比度修正只重建 Admin，最终 Admin 镜像为 `sha256:5a32d2dc19e42a2bd50bc3d783d6842f56767f11be050be56827674ff8c2a79d`；其他三角色保留上述镜像，业务代码和基线一致。最终页面及 JS/CSS 均 200、逐字节等于当前构建，四角色再次 healthy/readiness 200。隔离浏览器测试服务和本轮 PG/Redis 容器已清理，不影响业务栈。

开发 RDS 本轮仅两条列级 GRANT 与迁移记录校验同步，用户/身份/会话/管理员行数保持 1/1/2/1，业务外键为 0。公开 API 的用户管理路径 404；Admin 未登录 401、页面 200。认证后完整浏览器验证来自隔离测试库，不代登录真实管理员。见[验收记录](acceptance/admin-users.md)。

## 测试服务器及远端解析机已停止（2026-11-14）

本项目 API、Admin、Worker、Scheduler、Redis 均已停止。远端解析 ECS `i-2zegwjwejyvpxoluhyx8` 在全文测试结束后手动节省停机，云端确认 `Stopped + StopCharging`；Redis 未知请求及临时测试数据已清理，原 PDF 保留。

本次使用从 `8825986` 构建的 `huahuo-server:pdf-e2e-8825986` 和临时部署配置：2页 PDF 流程通过，325页全文未完成入库及查询，详见[文档提取验收](acceptance/document-extraction.md)。原 `.env`、数据库结构及现有卷未改。以下为历史部署证据，不表示服务当前运行。
## 文档提取链路代码完成，待测试环境部署（2026-11-14）

同一 Compose 四角色/一次性 migrate 保持。API/worker 共用提取模式与完整配置文件，worker/scheduler 另用受控 ECS/Redis 运行配置；资源 JSON 已纳入现有 Docker resources 打包。未改业务 Schema/迁移、未执行 RDS 迁移、未重建运行容器或修改真实 `.env`，也没有请求当前内网 ECS。

本轮394项unit/contract、160项隔离PG/Redis/Milvus集成通过；数据库和图片存储为本轮测试隔离资源，提取器是本机loopback替身。仅清理测试自有容器/tmpfs，已有卷未删除。部署配置见[文档提取手册](runbooks/document-extraction.md)。

## 用户指定 ECS 已手动开机（2026-11-14 02:16）

用户明确要求启动 `i-2zegwjwejyvpxoluhyx8`。先只读核对 cn-beijing、私网 `172.18.102.101`、A10 规格与 Stopped 状态，再调用一次 StartInstance（InitLocalDisk=false），观察 Starting 后于北京时间 02:16:13 确认 Running。没有替换实例或更改网络、磁盘、凭据及 Server 部署配置。

这次是独立的手动启动，解析运行库仍默认 disabled，未开启 60 秒空闲停机，解析 API 健康与实际文件任务未验证。过程记录在 Server `.local/ecs-power/manual-start-result.json`。

## 解析机事件监听代码已验证，未部署启用（2026-11-14）

保留同一 Compose 四个独立常驻角色及一次性 migrate。仅给 worker/scheduler 加入可选解析配置，scheduler 使用 Redis 事件和一次性 60 秒空闲定时器；过渡/忙碌状态每分钟临时兜底，确认节省停机后取消全部定时器。没有新增常驻服务、数据库表或迁移。

Compose 展开配置只在进程内检查，未输出实际秘密：默认 disabled、并发 1、空闲 60 秒，API/admin 不接收解析配置。构建/typecheck/lint 通过，146 项隔离 PG/Redis/Milvus 测试通过并清理本轮临时容器；业务容器、数据库、现有卷未操作。指定 ECS 仅查询，已为 `Stopped + StopCharging`，未改变其状态。详见[验收](acceptance/document-parser-machine.md)。

## A10同镜像复测实例已释放（2026-11-13）

eci-2ze43u66fcaz7scrs7nt，北京I、48核310GiB/单A10，驱动580.178.04；缓存启动到健康49.822秒，私网8000、shm1GiB。全文351.727秒，连续58954字节服务日志与全部结果已取回，实例ID/归属双查0；Ready缓存保留。未改业务角色/Compose。详见[记录](acceptance/xberg-a10-kbxml-retest.md)。

## Xberg T4 OSS/KBXML容器已释放（2026-11-13）

eci-2ze04nfu5bbryyie7cqy最终为北京I/ecs.gn6i-c8g1.2xlarge/8核31GiB/单T4；驱动580.178.04、私网8000、shm1GiB、镜像缓存命中。完整325页1411.127秒，连续57520字节日志已导出；实例ID/归属双查0，两个Ready缓存保留，未改四业务角色或Compose。详见[记录](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg OSS/KBXML核对与申请未完成（2026-11-13）

新镜像digest c8ad143d…783e25/build xberg-kbxml-v1-20261113-r4已静态核对；新增北京I交换机已加入本机GPU配置。T4单区/四区及A10两档实际申请均NoStock，关闭缓存和570驱动也未成功，无325页解析或性能结果。所有自有调度实例和临时输入已清理，新镜像缓存Ready并保留。长期GPU仍disabled，未改业务/App/数据库。详见[本轮记录](acceptance/xberg-oss-kbxml-trial.md)。

## 本机开发库与建库 SQL 对齐（2026-11-13）

开发 RDS 在一个事务内移除了五个无值且无依赖的废弃解析列，并登记当前 `migrations/0001_initial_schema.sql` 的校验值。现有业务数据保留，标准迁移重放返回 `applied=[]` 和 `current=1`。本机四个 Server 角色均由主 `compose.yaml` 启动，使用 `huahuo-server:local-dev` 且健康。隔离 PostgreSQL/Redis 集成测试 120 项通过。

`127.0.0.1:3000` 就绪检查返回 HTTP 200，短信使用 `SMS_PROVIDER=live` 和 `SHOW_TEST_OTP=false`。[短信手册](runbooks/sms.md#flutter-真实短信联调)

## A10测试实例已释放、镜像缓存保留（2026-11-13）

北京F、NoSpot ecs.gn7i-c16g1.4xlarge，16vCPU/60GiB/单A10，可见显存23028MiB、驱动580.178.04；内网固定digest8b64425b…5f3779b，fast模式、私网8000、shm1GiB、额外临时盘40GiB。eci-2zeabjvlm78bshhrntu4释放后ID/本轮标签双查0，3临时OSS对象404；自动缓存imc-2zeabjvlm78bshhrntu5为Ready/100%并保留。没有业务容器、数据库、持久卷或网络变更。详见[本轮验收](acceptance/xberg-a10-native-first-trial.md)。

## 短信适配器与本次测试（2026-11-12）

Compose 只给 API 注入新增短信区域、签名、模板、变量名和超时配置，复用既有共享 RAM AK。API live 模式启动时校验配置；其余角色不增加短信参数或凭据要求。没有新增容器角色、端口、公开管理接口或数据库迁移。

Typecheck/Lint/宿主 Build 和离线 Compose 渲染通过。120 项真实隔离 PG/Redis/Milvus 测试使用本轮自有临时容器与 tmpfs，结束已清理，没有删除现有卷或访问开发库。业务四角色未重建，不能将本次源码能力当成当前运行镜像已更新。

真实 SMS 测试由宿主新服务/工具执行，仅发一条；运营商回执及用户确认均通过。测试不连接业务数据库。详见[短信手册](runbooks/sms.md)。

## Xberg 新图片策略临时T4已释放（2026-11-12）

北京H临时NoSpot ecs.gn6i-c8g1.2xlarge，8vCPU/31GiB、单T4/15360MiB、驱动580.178.04，固定新digest21753d34…cfe080d。服务默认参数语义不变，启动层仅增加stdout/stderr落盘；806.159秒全文请求完成但质量/取图未通过。eci-2ze20ou8lwp81hit3vr0已释放、ID/标签双查0，3临时OSS对象404；无业务角色/Compose/网络/持久卷或数据库操作。详见[本轮验收](acceptance/xberg-cuda-image-policy-trial.md)。

## MinerU 配置与构建清理（2026-11-12）

源码/本机构建和Compose已移除该适配器及五个环境变量；脱敏渲染包含admin/api-server/migrate/redis/scheduler/worker，四角色独立、migrate一次性。现有业务容器未重建，不能视为运行时已经采用新代码。唯一基线删除五个供应商列定义，未对现有业务库执行DDL或重置。

本轮在本机Unix Docker上下文创建独立tmpfs PostgreSQL/Redis/Milvus，118项真实依赖测试全部通过，包含0外键、关系索引及CRUD；只清理本轮带归属标签的临时容器/凭据，无持久卷删除。见[移除验收](acceptance/mineru-removal.md)。

## FunASR 单 T4 ECI（2026-11-12）

独立实例 `eci-2ze2499g6uixsafwn1sq`，北京 H、4 vCPU/15 GiB/1 GPU，私网 `172.16.18.96:8000`。13:17已Running/Ready、重启0、Tesla T4/驱动580.178.04、CUDA实际运算通过，保留运行。NoSpot、3600秒期限，预计北京时间14:12左右退出；默认镜像命令/UID10001、data可写，未挂NAS、无EIP。四个Compose角色、现有卷及数据库未操作，长期GPU仍disabled。见[实例记录](acceptance/funasr-eci.md)。

后续为完整7438.608秒音频，在同一实例增量更新MAX_AUDIO_SECONDS=10800并重启加载，原镜像/GPU/token保留。一次转写HTTP200、101.157秒，输出大量重复“嗯”，质量未通过；13:29复核同实例仍Running/Ready。结果归档已取回/校验，原音频保留、临时输出HEAD404；未另建实例或释放本实例。

## Xberg cuda-t4全文实例已释放（2026-11-12）

北京H、NoSpot、16核/62GiB、1×T4的eci-2zebu67bfhzcxb6syrtr，唯一325页请求及18页整页OCR错误及17页图片恢复/1页原生回退已导出核验后释放。独立ID/标签0，2个临时OSS HEAD404，源PDF保持。无EIP/网络规则/卷/业务角色/数据库变更，GPU disabled。详见[全文CUDA验收](acceptance/xberg-cuda-full-trial.md)。

## Xberg cuda-t4临时实例已释放（2026-11-12）

北京H、ecs.gn6i-c16g1.4xlarge、16核/62GiB、1×T4、NoSpot的eci-2ze9suuzrqrcx8armkbq，默认失败及官方批次1复核均已导出；取回SHA/响应核验后释放，独立ID/标签均0，3个临时OSS HEAD404。无EIP/网络规则/卷/业务角色/数据库变更，长期GPU disabled。见[CUDA验收](acceptance/xberg-cuda-trial.md)。

## Xberg全文4核实例已释放（2026-11-12）

北京H、4vCPU/16GiB/0GPU、NoSpot的eci-2ze8erpglt5mejof765w，257页OCR+68页文本层完成并取回325页结果后释放。原实例内600秒失败及3000秒时限重试分开记录；独立ID/标签查空，3个临时OSS对象HEAD404。无EIP/安全组/卷/业务角色或数据库变更，GPU disabled。见[全文验收](acceptance/xberg-full-trial.md)。

## Xberg 4/8核临时对照均已释放（2026-11-11）

北京H的4核/16GiB `eci-2ze6ipokpr8897eybu60`、8核/16GiB `eci-2zeeutbloczjpy8s5z2l` 均为0GPU、NoSpot、TTL1200秒；同一镜像digest、缓存启动修正，8个请求结束且结果核验后释放。最终独立ID/标签四查0，3个临时OSS对象HEAD404，原文件保留；无EIP/安全组/持久卷或业务角色/数据库变更。详见[验收](acceptance/xberg-optimization-trial.md)。

## Xberg临时CPU实例已释放（2026-11-11）

本轮仅一台实际创建成功的北京H CPU ECI `eci-2zeilmbghi0hpychn7kx`，4vCPU/16GiB、0GPU、NoSpot、TTL1800秒。默认8000服务及同容器缓存修正后的localhost:8001服务测试完成，结果/指标取回后整台释放，ID/当前标签/退役标签三查0，7个临时OSS对象HEAD404。无新增EIP/安全组或业务四角色/数据库/卷变更，长期GPU仍disabled。详见[验收记录](acceptance/xberg-trial.md)。

## 新OCR标签临时实例已释放（2026-11-11）

本次默认命令python -m app.main的ECI `eci-2ze6g3pxvbahg0bffi6y`，北京H/第三档/单T4，10页完整返回后HTTP/模型仍健康；结果和指标取回后删除，ID/标签复核0，两个临时OSS对象HEAD404。无EIP/NAT/安全组变更，业务四角色/数据库/卷未操作。详见[对照验收](acceptance/gpu-parse-ocr-trial.md)。

## huahuo-parse 临时容器已释放（2026-11-11）

按用户要求提前停止，已导出《电子标书.pdf》第1—78页/325页，HTTP200/partial；190,663字符Markdown、27图片、原始响应与坐标全部取回并核验。247个未处理页错误为人工终止产生，另有第33页1条跨页表格待复核，不作为完整全文验收。北京H/第三档/单T4实际CUDA、Transformers FP16、batch2通过；当前与此前试验实例均已释放，独立ID/标签复核0，临时OSS对象删除，源文件保留。

性能报告及CSV/JSON已导出：ID1.236秒、拉镜像305.387秒、模型健康观测23.017秒；正常38批/76页P50=19.071秒、P95=226.853秒，密集采样窗口GPU均值约66%、显存峰值3.85GiB。人工暂停及在途收尾不混入基准；原控制脚本恢复后EPIPE失败保留，独立导出成功与清理分别有证据。SDK大参数POST修复后105项GPU单测、全量306项unit/contract及Typecheck/Lint/Build通过；无业务角色/数据库/卷/App变更，长期GPU仍disabled、持久Task/Worker未接入。完整边界见[验收记录](acceptance/gpu-parse-trial.md)。

## 阿里云 AK 命名统一（2026-11-11）

Compose 的 API/Worker 改为注入共享 `ALIYUN_RAM_ACCESS_KEY_ID/SECRET`，删除旧 OSS 专用项，Admin/Scheduler/Migrate 不注入。根 `.env` 和历史本地环境文件已同步并保留原实际凭据；离线渲染逐角色检查通过。源码构建与 305 项 unit/contract 通过；本轮没有重建/重启运行容器或操作数据库，不能据此宣称当前运行镜像已经采用新字段。GPU 长期配置仍 disabled。

## GPU 底层增量（2026-11-11）

用户再次授权的计时试验另创建一台 `eci-2zed5m58u9c04n1qumjw`，首次 Ready 31.785 秒后自动释放，精确 ID/唯一标签复查均为 0。仅操作该次云端测试实例，未重建或重启业务角色/数据库；长期 GPU 配置仍 disabled。详见 [第二次计时验收](acceptance/gpu-spot-timing.md)。以下首轮试验按原时间保留。

业务 Compose、四角色、数据库和卷均未重建或变更。用户另行明确授权的一次性 ECI 试验已创建一台北京 H 的单 GPU 实例，Nginx Running/Ready 后释放；ID/分配标签复查均为 0，不存在本次遗留运行实例。初次启动校验失败通过同实例恢复处理，未二次创建。配置仍 disabled，凭据没有注入四角色；当前宿主 Typecheck/Lint/Build 与 300 项 unit/contract 通过，GPU 测试 104 项。云端一次性验收不代表已运行的业务镜像包含本模块或已启用 GPU Worker，详见 [试申请验收](acceptance/gpu-spot-trial.md)。以下为更早的配置/容器证据。

本轮未重建、重启或迁移业务容器，未操作 PostgreSQL/Redis/卷。独立模块默认 disabled，没有新增常驻角色、公开端口或给四角色注入 GPU 凭据，当前运行镜像不据此宣称包含新模块。本轮验证为宿主 Node 26.11.0 / pnpm 10.15.1 的 Typecheck、Lint、Build 和 279 项 unit/contract；83 项新增测试为 Mock Provider/SDK 及传输替身，不是云端实例测试。后续沿用原 Worker 执行、Scheduler 投递的单 Compose 拓扑，接入持久检查点后另验收。以下为历史容器证据。

2026-11-05 已在现有远程RDS数据库`huahuo`启用统一用户结构；未新建数据库、重置数据库账号或更改连接凭据。当前public基线为唯一`0001_initial_schema.sql`，current1及checksum均验证通过，物理外键0。

旧Schema在同库`initialization_backup`保留58张表4149行，数据/OID/存储标识核验一致且运行角色无访问授权；当前应用只访问新public，没有归档兼容查询。用户和会话为空，需要重新登录。

api-server/admin/worker/scheduler均运行最新`huahuo-server:dev`且healthy。API实际PostgreSQL、基线checksum、Redis cache和queue探针均true；API/Admin readiness200。API/Admin分别只绑定127.0.0.1:3000/3001，Worker/Scheduler无宿主业务端口。JWKS EdDSA/Ed25519 server-current正常。

Redis沿用既有容器；本地PostgreSQL未用作业务库，原数据卷保留。共享OSS和Milvus不随本次Schema初始化删除，不以旧向量测试样本冒充新业务链路验收。没有真实短信或模型调用。

质量检查：typecheck/lint/build、229项unit/contract、115项独立PG/Redis integration、6项真实权限拓扑归档安全实验通过。证据在忽略提交的`.local/huahuo-unified-cutover/`与`.local/schema-archive-safety.log`。
