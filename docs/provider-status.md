## v0.2.0 录音卡（2026-11-27）

首次认领委托设备验证服务，后台纲要使用 Worker 专用服务凭据。隔离验收使用本地替身，真实提供方需联调验证身份和幂等行为。 [接口与验收记录](acceptance/recorder-v020.md)

## 创作页链接导入（2026-11-27）

Worker 使用 JustOneAPI 适配器。供应商字段以替身验证，直播回放需授权样本确认。音频资产已有 FunASR 工作流；链接视频缺少转码服务。 [验收记录](acceptance/link-extraction.md)

## FunASR 算力适配器（2026-11-25，本地候选）

算力可选 ACS 单卡分批申请或固定 GPU HTTP 端点。Node01 使用此前的 `gpu-standard` 发布提交首批三个 ACS Job，由 A10 胜出，验证私网直连、GPU 转写、查询、ACK 和清理。P07 的 Server 队列、签名回调和查询兜底已用隔离 PG、Redis 和 FunASR HTTP 替身验证，真实跨集群业务回调仍待验证。 [Node01 实机验收](runbooks/funasr-compute.md#node01-实机验证2026-11-25)

2026-11-26 调整默认三批候选，首批加入北京 H 区 G28Ti `best-effort`，第二批加入北京 I 区 A10 `best-effort`，L20NE 可在自定义列表中使用。当前批次的实际库存仍待云端验证。 [默认候选配置](runbooks/funasr-compute.md#配置)

## 禁用标签时跳过自动任务（2026-11-18，本地候选）

运行配置明确 disabled 时，保存/编辑不创建自动标签任务；显式请求返回 `TAG_PROVIDER_UNAVAILABLE`。启用后的原任务路径和 Provider 能力保持现状，未接入新模型、Dify 或计费调用；既有任务不批量删除/回填。见[写入优化](acceptance/pg-row-growth-optimization-20261118.md)，实际环境尚未应用。

## 搜索能力保留（2026-11-17，本地候选）

用户明确搜索功能确定需要，现有实现保留；业务范围、交互、接口及具体策略尚未定。查询Service/入口、技术配置、指标及测试保持现有实现；不把当前实现当成既定产品需求，不继续扩展功能或接线App/Agent。此前历史债务清理和正确性修复保留。见[需求边界](runbooks/search-status.md)及[本期验收](acceptance/debt-cleanup-20261117.md)。未修改共享库或部署。

## 原生入口联调边界（2026-11-16）

真实Nginx与Agent构建产物、Server鉴权代码联调通过；短信、签发账户存储是隔离替身，真实JWT/会话另由独立PG/Redis测试验证。模型请求0，没有修改共享数据库、云端服务或证书。宿主候选与实际安装分开记录，见[验收](acceptance/ingress-auth.md)。

# Provider 与业务存储状态

## 搜索底层适配器（2026-11-16）

Milvus已接入关键词、纯向量和原生混合端口；另有应用层组合实现，可分别绑定独立关键词/向量后端再做RRF融合，上层模型Rerank独立。ES为后续KeywordIndex提供器，未安装SDK、未连接服务。关键词class替身通过真实隔离PG任务/发布/查询，48项定向集成中的Milvus为本轮tmpfs真实实例；Embedding/解析为替身。914项unit/contract和类型/Lint/构建通过，不冒充真实模型、ES或线上验收。业务默认目标与Qwen/FP16工作区规格保持，无本次共享集合操作，见[接口约定](runbooks/milvus.md#底层接口与后端替换)。

## 默认冒烟不调用供应商（2026-11-15）

27 项 HTTP 替身与 4 项真实 API 冒烟已通过，真实依赖仅本机独立 PG/Redis。默认六个 GET 不触发短信、模型、解析、上传、计费或云操作；凭据自动提供尚未接入。全量隔离集成 247 通过、真实 Milvus 1 项跳过，不代替云或线上验收，见[验收](acceptance/release-smoke.md)。

## 云端 Milvus 真实依赖验收（2026-11-15）

按用户授权使用已有云端 Milvus；随机测试 database 和两种 collection 与业务目标隔离，三轮运行的临时目标已全部清理。文档 BM25 与笔记关键词/向量/混合检索、权限及恢复路径通过，最终全量 244 项集成零跳过；PG/Redis 为本机真实临时依赖，Embedding/Rerank、解析器和云控制面仍为替身。未验证真实模型、Xberg/OSS 或线上部署，实际 ENV 未修改。见[隔离回归验收](acceptance/cloud-milvus.md)；用户要求真实服务稍后验证，已登记[上线前待办](acceptance/pending-live-verification.md)。

## 轻量发布验证沿用隔离依赖（2026-11-15）

Worker优先交接仅使用随机本机PG/Redis/BullMQ、测试JWT与Fastify业务路由；不调用模型、解析器、云控制面、OSS或短信。复用原持久任务和补偿路径，未增加供应商或组内存储。243项隔离集成通过（1项真实Milvus跳过），不计作云或跨机发布验收；见[验收](acceptance/worker-first-release.md)。

## 正式解析回调与手动启动（2026-11-15）

正式文档任务异步提交、认证回调事务接收后唤醒；约60秒单次查询作补偿，等待不占Worker执行槽。手动启动经既有维护队列分步骤执行并推送状态。云控制面和解析器均使用替身验证，真实PG/Redis独立测试；现有本地主栈已更新，但云开关/节点仍关闭，未实际开机、解析或调用OSS。Admin试跑仍为纯内存直接探测，见[验收](acceptance/document-async-events.md)。

## Admin 直接试用解析API（2026-11-15）

Admin试跑不再参与处理节点开停、任务队列、持久回调或恢复；仅用原提取客户端直接提交并读取结果。PDF端点在测试中为fetch替身，PG/Redis为真实独立依赖，证明试跑不落库及用户业务回调保留，不代表云解析/OSS实测通过。没有调用生产付费服务，节点必须已启动且可访问。见[验收](acceptance/admin-document-trial.md)。

## 服务地址与 Admin 部署边界（2026-11-15）

当前仅优先支持 Admin 分机；API/Worker/Scheduler 仍同组。HTTP 解析节点继续走后台配置地址，回调目标新增 API_SERVICE_BASE_URL，可由域名/IP解析；未发真实 ECS/ECI/OSS 请求。真实 loopback HTTP 和隔离 PG/Redis 验证与云端双机部署区分。见[手册](runbooks/service-addresses.md)。

## 容器发布演练供应商边界（2026-11-15）

本轮使用真实临时PG/Redis/BullMQ、容器HTTP及local文件驱动；测试凭据随机生成，处理节点、短信、计费与外部模型关闭，无真实OSS/解析/云电源请求。双Scheduler仅验证持久扫描/时间窗去重及存活副本，不证明多副本云操作安全；本地共享测试卷不证明跨机对象存储通过。见[演练](acceptance/release-rehearsal.md)。

## 发布恢复验证的供应商边界（2026-11-15）

解析 intent 恢复、早到/重复/冲突回调及取消竞态使用 loopback 解析替身，持久事务/锁/队列使用真实独立 PG/Redis。没有调用真实解析服务、OSS、云电源或模型。237项集成通过，真实Milvus检索1项跳过；不把回调替身结果当作供应商部署验收。见[发布基础验收](acceptance/release-hardening.md)。

## Prometheus 客户端（2026-11-15）

采用 @prometheus-io/client 0.16.1，兼容本地 Node 26.11.0 和 Docker 26.12.1。无指标库外部运行时调用；Prometheus 主动抓取四角色的独立私网 /metrics。中心 test 节点 IP/主机名未提供，手册保留明确占位。专项验证仅真实本机 HTTP/隔离 PG/Redis，无生产付费供应商调用。见[验收](acceptance/prometheus.md)。

## 已部署 ECS 按节点调用与配置简化（2026-11-15）

当前CPU ECS无需镜像名或提取JSON，按需唤醒后直接调用已有Xberg API，默认省略config沿用服务端配置。全局四项解析设置移除，同步/异步与可选覆盖随节点快照；核心页面仅名称/实例ID/地址/并发/空闲停机/在线状态，其余折叠，试用仍位于解析与模型Modal。436项unit/contract、223项真实隔离PG/Redis通过（1跳过），静态检查/构建和Chrome桌面/移动验证通过。现有开发库无损调整，四角色已更新且healthy/readiness200；不开云机，内网PDF/Office仍待部署后实测。见[配置验收](acceptance/runtime-configuration.md)。

## RAG参数后台管理与ENV清理（2026-11-15）

本轮仅配置/接口/界面及真实隔离PG/Redis验证，未执行模型、OSS上传、内网解析或云开停机。新增检索与Embedding测试用显式替身；服务地址、凭据、模型规格、源域名白名单仍在ENV，运行参数由后台DB管理。当前值无损导入原配置行，未改业务数据/索引，见[验收](acceptance/runtime-configuration.md)。

## 试用弹窗与当前CPU检查（2026-11-15）

本轮仅查询既有CPU实例身份/Stopped+StopCharging状态及尝试GET健康/版本/OpenAPI，172.18.102.103:8000不可达；没有云开停机、新申请、解析或OSS上传。节点配置改为单条JSON，试用入口收进解析与模型的Modal。434项unit/contract、220项真实隔离PG/Redis通过（1项Milvus跳过），其中云/解析协议为替身；不能视为真实PDF/Office识别通过。见[验收](acceptance/admin-document-trial.md)。

## Admin文档试用与旧入口清理（2026-11-15）

现有后台新增文档试用，复用业务解析配置/客户端/节点占用，只展示Markdown/JSON和阶段耗时，不创建笔记、资料、入库任务或索引。节点状态按用户要求显示“在线 / 不在线”。旧ENV加载器、假AK校验、无用参数与未使用旁路已清理；构建清除旧生成产物。434项unit/contract、219项隔离PG/Redis通过（1项Milvus跳过），typecheck/lint/build通过。现有主环境按原账号/数据更新，PDF/Office仍需CPU完整配置及可用节点。见[验收](acceptance/admin-document-trial.md)。


## 运行配置与处理节点（2026-11-15）

机器目标和业务策略改由PostgreSQL + Admin管理，连接/凭据/付费总开关仍在ENV。CPU文档基线节点停用，文档提取和节点总开关关闭；A10回退在GPU节点可选保留，没有调用真实供应商。LLM/Dify标签和音频HTTP协议仍未接入，不因出现配置项就宣称能力可用。见[验收](acceptance/runtime-configuration.md)。


## 当前文档解析CPU ECS目标（2026-11-15）

用户将按量目标换为 `i-2zejbbo2svjieb44tqy8`，64核/128GiB、PostPaid/NoSpot，私网 `172.18.102.103`。共享RAM仅Describe校验通过；本机与示例已同步，实际模式disabled、A10回退false。CPU提取配置/HTTP接口未验收，不将此前CUDA配置直接启用；下面GPU结果均是历史基线。见[验收](acceptance/document-parser-cpu-target.md)。

## prod-callback真实A10验证（2026-11-14）

共享RAM凭据下ECS StartInstance真实NoStock；ECI NoSpot取得8核/30GiB A10，北京I。用户新固定digest全文325页成功，OSS751对象核验、异步领取/小TXT回调/ack语义通过。新增ListTagResources只读归属查询，避免DescribeContainerGroups标签筛选返回无关记录而误报。实例/753临时Key已确认清理；生产业务PG/回调接收/Redis云端闭环未部署，模型仍有漏字。详见[验收](acceptance/xberg-a10-prod-callback.md)。

## A10 ECS → ECI 可选回退（2026-11-14）

仅 StartInstance 明确 NoStock 且首选 ECS 符合单A10/按量/VPC/StopCharging 才创建 NoSpot ECI。模型/解析协议与 OSS 图片流沿用；共享 RAM 凭据仅 SDK 边界注入，不进入 Redis。云接口测试为替身，未查询或申请真实机器，默认关闭。见[验收](acceptance/document-parser-eci-fallback.md)和[配置手册](runbooks/document-parser-machine.md)。

## 图片 UUID 与存储方案（2026-11-14）

404 项 unit/contract、178 项独立 PG/Redis/Milvus integration 通过，新增图片节点定位、URL→owned UUID、无变化写入、当前／历史引用与最终查询图片验证。PG/Redis/Milvus 为真实本机临时依赖；模型、解析和 OSS 签名为替身，未访问真实 OSS／内网解析／模型或生产付费服务。普通 Note 预览生成只读资源元数据；links 查询不读原图，FILE_UPLOAD 必要时只读所选源的有界解析清单。

已记录用户套餐／容量而非基础设施扩缩容的[存储方案](runbooks/user-storage-layout.md)，明确当前全局额度、分散产物计量和 OSS 物理回收缺口。未配置生命周期／套餐容量、移动对象或调整真实 Bucket；源码优化待部署。见[验收](acceptance/markdown-images.md)。

## Admin 基础用户页面验证（2026-11-14）

新增用户查询使用本项目 PostgreSQL；没有调用短信、模型、解析、OSS 或其他付费供应商。394 项单元/契约与 167 项隔离真实 PG/Redis 集成通过，另 1 项需要 Milvus 的无关用例跳过；测试中的模型/解析替身不计为供应商通过。浏览器使用隔离真实 PG/Redis 和合成用户。实际开发 RDS 只同步只读授权与基线校验，不修改产品用户资料或凭据。见[验收记录](acceptance/admin-users.md)。

## Xberg 文档 HTTP 适配器已接入（2026-11-14）

按用户给定协议接入 `/extract`、`/extract-async`、`/jobs/{job_id}`、取消及 parse-run 资源清单读取；基址配置为测试示例 `http://172.18.102.101:8000`，完整 config 原样发送。现有文件 Worker/FILE_UPLOAD 使用同一运行库，解析后进入原有关键词索引；支持长期同协议 API 模式。完整 KB 产物、规范 Markdown 和已确认上传的图片元数据保存，未重新引入 MinerU 或图片二次 OCR。

19 项 mock HTTP 单元测试、12 项真实隔离依赖/loopback 解析替身集成通过，含真实 Milvus BM25 检索。全量394/160通过。实际内网提取、模型/镜像版本、OSS 对象和质量按用户要求不探测，本轮没有云写操作；真实环境仍默认 disabled，待测试环境部署。见[本轮验收](acceptance/document-extraction.md)。

## 单 ECS 解析机与长期 API 模式（2026-11-14）

默认 disabled；新增 ECS RPC 适配器和 Redis 运行库，当前目标由环境指定为 `i-2zegwjwejyvpxoluhyx8` / cn-beijing / `172.18.102.101`。真实 DescribeInstances 只读确认 ecs.gn7i-c16g1.4xlarge（A10）、PostPaid/VPC、无报告本地盘/操作锁、`Stopped + StopCharging`。Start/Stop SDK 自动重试关闭，实际云写操作未执行；真实解析端口/健康/协议仍待核对。

`always-on` 模式允许固定 HTTPS API 路径，不需 ECS 凭据，继续使用同一 Redis 去重/并发控制。新增 38 项 mock/虚拟时钟测试、26 项真实 Redis/Lua/PubSub 测试；全量 unit/contract 375、隔离依赖 146 通过。未改业务 PG/Schema/数据卷、现行 Provider 或 App。详见[使用手册](runbooks/document-parser-machine.md)。

## A10 OSS/KBXML同镜像实测（2026-11-13）

48核A10按量真实成功、17.943984元/小时计算参考；镜像r4摘要与T4对照相同。完整HTTP351.727秒、OSS2.368秒，751去重对象178630201字节全部SHA/解码/ledger核验并清理；GPU均值4.43%，质量仍有漏字。未接入业务Provider，长期GPU disabled。详见[记录](acceptance/xberg-a10-kbxml-retest.md)。

## Xberg OSS/KBXML真实T4续测（2026-11-13）

内网ACR锁定c8ad143d…783e25/r4；真实RAM统一变量用于测试OSS。T4/A10抢占实际缺货，按量T4第二档成功。OSS16并发/队列128，751对象178630201字节、4.292秒、重试0；UUID/字节/ledger和本地解码通过，已清理测试对象。既有业务Provider未接入本次KB协议，长期GPU disabled。详见[记录](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg OSS/KBXML核对与申请未完成（2026-11-13）

新镜像digest c8ad143d…783e25/build xberg-kbxml-v1-20261113-r4已静态核对；新增北京I交换机已加入本机GPU配置。T4单区/四区及A10两档实际申请均NoStock，关闭缓存和570驱动也未成功，无325页解析或性能结果。所有自有调度实例和临时输入已清理，新镜像缓存Ready并保留。长期GPU仍disabled，未改业务/App/数据库。详见[本轮记录](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg A10独立镜像验收（2026-11-13）

PP-OCRv5 server/ONNX CUDA/batch6/150DPI/原生优先，无force_ocr_pages，真实A10全文请求342.025秒、零逐页失败，但第19页证书标准漏字。响应登记139页OCR输入，768图落盘与引用全部验证；47条混合OCR拒绝及6条缺字形日志另存，不以响应单条告警代表全部日志。未接业务Provider/Task/Worker，长期GPU disabled。详见[本轮验收](acceptance/xberg-a10-native-first-trial.md)。

## 阿里云短信（2026-11-12）

官方 `@alicloud/dysmsapi20170525@4.6.0` 已接入现有 `SmsProvider`，支持单条模板发送、BizId 回执查询及本机工具。通过共享 RAM AK 查询确认现有签名“触达科技”和花火身份验证码模板 `SMS_508520316` 审核通过；用户授权的一条真实短信已获 delivered 回执并由用户确认收到。该真实证据独立于模拟 SDK 和真实 PG 的 OTP 测试。

337 项 unit/contract 与 120 项隔离真实 PG/Redis/Milvus integration 通过。另用 `127.0.0.1:13000` 的独立开发实例和 Android API 36 完成 Flutter 真实发送、重发与验证登录。该实例使用真实阿里云短信，原 `3000` 仍使用其现有迁移基线。详见[短信手册](runbooks/sms.md#flutter-真实短信联调)。

## Xberg CUDA 新图片策略验收未通过（2026-11-12）

新digest21753d34…cfe080d已在真实单T4完成325页请求806.159秒；22页Conv.2/cuDNN错误仅保留原文，图片0，第21页关键证书正文缺失。GPU8.19%、CPU平均2.47核；全程stdout/stderr已保存，不作为生产可用/等质量提速结论。测试实例与3临时OSS对象已清理，长期GPU仍disabled，无业务Provider/Task/Worker接入。详见[本轮验收](acceptance/xberg-cuda-image-policy-trial.md)。

## MinerU 已移除（2026-11-12）

该适配器已从源码、配置、环境文件、Compose和构建产物中删除，不保留disabled占位或兼容调用。PDF/Office解析停止；UTF-8文本/Markdown/CSV、既有资料授权读取和关键词索引保留。309项unit/contract及118项真实隔离PG/Redis/Milvus集成通过，未调用真实解析/付费模型。业务运行容器未重建，详见[移除验收](acceptance/mineru-removal.md)。以下旧阶段提及仅作为历史证据。

## FunASR 独立 ECI（2026-11-12）

用户提供的 `funasr-eci:gpu-20261112` 在北京H单T4/4核/15GiB真实运行，模型/CUDA/鉴权通过并保留。随后完整7438.608秒音频一次POST：HTTP200/101.157秒，1523字符/218分段/4聚类标签；去标点后97.85%为“嗯”，质量未通过，聚类数不代表真实人数。实例MAX_AUDIO_SECONDS从7200调为10800，未改模型；结果与原OSS导出403/直接ECI恢复分别留证，无重复推理，源文件保留。NoSpot、1小时期限、私网8000、未挂NAS。未接业务ASR Provider或持久任务，未做声纹注册/身份匹配。见[实例与音频记录](acceptance/funasr-eci.md)。

## Xberg CUDA全文接口与降级（2026-11-12）

完整325页请求924.558秒返回325页/197,537字符/97表格，但批次1仍有18页整页GPU OCR/cuDNN错误，17页经内嵌图片恢复、1页保留原生文本，41警告；兼容/等质量验收未通过。平均GPU7.43%，末尾176.6秒为GPU0/CPU密集观测，缺函数trace不直接归因。仅本地临时试验，未接业务Provider或改核心/库；资源清理确认，见[全文CUDA验收](acceptance/xberg-cuda-full-trial.md)。

## Xberg CUDA镜像配置复核（2026-11-12）

cuda-t4默认识别批次6在真实T4上三次Conv.2/cuDNN错误，HTTP200但无正文；官方批次1配置绕行后同源20页完成，热请求均值18.633秒，GPU均值8.33%，慢于历史CPU8核10.477秒。证书邮编漏字保留，默认/等质量验收未通过。仅调用侧配置，无核心/权重/库补丁或业务Provider接线；实例与临时OSS已清理。见[验收](acceptance/xberg-cuda-trial.md)。

## Xberg 325页4核全文实测（2026-11-12）

同一325页PDF完整输入，4vCPU/16GiB/0GPU，北京H、NoSpot、固定Xberg1.3.9镜像。成功请求890.026秒（14分50秒），325页均非空、197,589字符、97个表格对象，顶层OCR页失败记录0。257页请求OCR、68页文本层，结果缓存关闭。 首轮默认600秒内部超时后，用官方3000秒参数在同实例完成；7条质量警告保留，未接业务Provider或修改核心。实例及临时OSS已清理。见[全文验收](acceptance/xberg-full-trial.md)。

## Xberg按页OCR参数实测（2026-11-11）

官方按页OCR与线程预算真实对照通过：同源20页，4核全页热38.804秒→4核选择性18.430秒→8核选择性10.477秒。每组选择性重复2次，正文跨核逐字一致，关键证书/目录与表格内容核对；规则为本地测试启发式，仍有错字/警告，未接入生产Provider或修改核心。实例与临时OSS已清理，见[验收](acceptance/xberg-optimization-trial.md)。

## Xberg CPU中文OCR实测（2026-11-11）

实际版本1.3.9，前20页在4核/16GiB完成Paddle ONNX CPU OCR；缓存路径修正后两次HTTP41.763/41.104秒、正文/表格一致。默认native虽0.148秒但漏图片文字，强制OCR也有目录编号丢失和水印噪声；没有接入业务Provider或宣称替代VLM。临时实例及OSS对象已清理，详细边界和原始失败见[验收记录](acceptance/xberg-trial.md)。

## 新OCR标签镜像HTTP验收（2026-11-11）

新标签前10页HTTP200/complete、0issues，真实单T4/FP16/Transformers与请求后常驻健康通过；批次合计147.383秒，旧149.078秒，单次差-1.137%不作为显著提速。新增light_ocr未接HTTP，未验证其独立性能。临时实例/两个OSS对象精确清理，原文件保留。详见[对照验收](acceptance/gpu-parse-ocr-trial.md)。

## huahuo-parse 单 T4 真实部分解析（2026-11-11）

按用户要求提前停止，已导出《电子标书.pdf》第1—78页/325页，HTTP200/partial；190,663字符Markdown、27图片、原始响应与坐标全部取回并核验。247个未处理页错误为人工终止产生，另有第33页1条跨页表格待复核，不作为完整全文验收。北京H/第三档/单T4实际CUDA、Transformers FP16、batch2通过；当前与此前试验实例均已释放，独立ID/标签复核0，临时OSS对象删除，源文件保留。

性能报告及CSV/JSON已导出：ID1.236秒、拉镜像305.387秒、模型健康观测23.017秒；正常38批/76页P50=19.071秒、P95=226.853秒，密集采样窗口GPU均值约66%、显存峰值3.85GiB。人工暂停及在途收尾不混入基准；原控制脚本恢复后EPIPE失败保留，独立导出成功与清理分别有证据。SDK大参数POST修复后105项GPU单测、全量306项unit/contract及Typecheck/Lint/Build通过；无业务角色/数据库/卷/App变更，长期GPU仍disabled、持久Task/Worker未接入。完整边界见[验收记录](acceptance/gpu-parse-trial.md)。

## 阿里云 AK 配置统一（2026-11-11）

OSS 与 ECI 统一读取 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`，删除旧 OSS 专用 AK 变量且不回退；本地实际值保留，各环境文件只定义一组。六份示例及 Compose 一致，API/Worker 注入共享 AK，其他角色不注入。305 项 unit/contract、Typecheck/Lint/Build 与离线 Compose 校验通过；本轮无真实供应商调用，也未改变 GPU disabled 状态。当前运行容器未重建，新命名将在后续构建重建时生效。

## ECI GPU 增量（2026-11-11）

第二次授权的真实阶段计时已完成：本轮单次创建北京 H / 第 4 档一台，流程到实例 ID 1.797 秒、到首次 Ready 31.785 秒；初始化缺字段自动等待，同一实例核验后释放，独立 ID/标签复查均为 0。镜像与容器启动约 1 秒合计，具体 Pulled 事件未采集完整，不能细拆。长期配置仍 disabled，未接入持久 Worker 或验证模型计算；本轮 104 项 GPU 单测及后端编译通过。见 [第二次计时验收](acceptance/gpu-spot-timing.md)。下段为首轮试验记录。

北京 T4/单卡、四档优先级和同 VPC 三交换机已配置，凭据按授权直接读取根 `.env` 的 `ALIYUN_RAM_ACCESS_KEY_ID/SECRET`。只读预检通过后，用户又明确授权一次真实试申请：北京 H 实际分配第 4 档，单 GPU、Running/Ready；以同一 ID 恢复处理启动期校验问题后已释放，独立 ID/标签复查均为 0。真实创建、查询、删除及 Nginx 启动已验证，GPU 计算与持久 Task/Worker 未验证/未接入。模块配置仍 disabled，未启用长期抢卡。初始化缺字段按 transient 等待，实际错配仍拒绝；GPU 单测 104 项、全量 unit/contract 300 项。详见 [真实试验验收](acceptance/gpu-spot-trial.md)。以下为首版历史边界记录，当前状态以本段为准。

`gpu-spot` 已实现官方 SDK 适配、市场价申请、同步/异步缺货重试、未知提交恢复、状态观察和归属标签核验后的释放，默认 disabled。83 项新增测试使用 Mock Provider/SDK 与传输替身，全量 unit/contract 279 项通过；没有真实 GPU、RAM 权限、库存或计费验证。尚未连接持久 Task/Worker、长期调度和运行角色配置，地域/规格/镜像/VPC/RAM 待确定，不借用 OSS 凭据。详见 [GPU 运行手册](runbooks/gpu-spot.md)。以下记录保持各自原验收时间与范围。

唯一初始化基线`migrations/0001_initial_schema.sql`已应用至原阿里云 `huahuo` 库的新 `public` 并部署统一用户模型。旧 `public` 整体改名封存为 `initialization_backup`，58表4149行及OID/relfilenode/视图内容摘要一致，旧行零删除；四运行角色无归档Schema的USAGE/CREATE，不做兼容查询。没有新建数据库，数据库凭据、环境配置和JWT私钥未变。

## 基础设施与统一认证

| 能力 | 当前实现 | 验证与边界 |
| --- | --- | --- |
| PostgreSQL | 日常业务使用根`.env`的阿里云连接；隔离测试使用独立临时数据库 | 原库同库切换完成；新public版本1重放幂等、全库FK0；旧Schema封存，日常启动不重复初始化 |
| 关联模型 | 普通ID、主键/唯一/NOT NULL/CHECK与查询索引；无物理外键或模拟外键触发器 | 迁移提交前与重放后检查FK；业务事务校验归属，保留软删除语义 |
| 统一用户 | `users`保存资料与`active/suspended/deleted`状态；`user_identities`保存身份摘要与掩码 | 新public产品用户/会话均为0，未复制旧账号；仅active用户可进入业务，真实短信本轮未调用 |
| 客户端认证 | 短信`purpose=sign_in`；登录必填`clientType=app|web`与`clientId` | JWT身份来自`sub`，客户端实例字段不能覆盖用户身份，不保留旧参数别名 |
| JWT与会话 | Ed25519/EdDSA、JWKS、Server/Agent audience；`user_sessions`与`refresh_tokens`管理会话和轮转 | Server校验active用户、会话、撤销及业务权限；Agent本地验签，不持有签发私钥 |
| 协议接受 | `user_agreement_acceptances`记录版本、时间和接受入口 | 生产需配置协议与隐私版本；记录接受不等于法律文案已审核 |
| Service Key | 两个方向独立Key，通过`X-Huahuo-Service-Key`发送 | 内部用户接口要求JWT+Service Key；Service Key不能替代用户身份 |
| Redis / BullMQ | 本地Redis、Outbox、任务、租约和补偿；PG为状态事实来源 | 独立临时PG/Redis测试与业务部署分开记录；认证不因缓存故障降级放行 |
| SMS | 阿里云官方 SDK 的 `AliyunSmsProvider`、模板发送与回执工具 | 单条真实送达已验证；mock 仍需显式配置且生产禁止，live 缺配置拒绝启动，详见上方本轮证据 |
| Billing | 基线包含既有账务结构与开发政策，预留、账本和未知用量状态由业务事务管理 | active用户与任务/Run归属校验；默认disabled，开发政策不代表正式价格或真实支付接通 |
| Dify / ASR / Push / Payment | 未接入相应真实供应商流程 | 不把接口占位、已有上传或文件解析描述成这些能力已完成 |

## 对象存储与笔记业务

| 能力 | 当前实现 | 验证与边界 |
| --- | --- | --- |
| StoragePort | Local、S3-compatible、Aliyun OSS共用端口及全局`STORAGE_*`配置 | Local真实文件/Range/故障测试与各供应商真实网络验证分别记录；本次Schema清理不要求重新上传资产 |
| Aliyun OSS | 全局`AliyunOssStorageAdapter`支持流式上传、读取、删除、批量删除与签名URL | RAG直接复用，不新增解析器专用凭据；短期URL只在授权响应生成 |
| 上传与清理 | 临时上传/播放capability，校验MIME、大小、hash、时长；任务处理inspect/delete/expire | 完成上传不代表ASR、图片LLM或正文解析完成；任务和资源必须属于同一用户/Workspace |
| Note / Folder / Revision | 事务、ETag、tombstone、content cursor、完整raw修订 | 创建与raw编辑可自动触发Note索引；有文本的导入复用同一路径；外链目前只存来源信息，不抓取网页 |
| Note普通搜索 | PostgreSQL普通业务查询与全文/ILIKE能力 | 不属于RAG召回；不与Milvus候选执行本地RRF融合 |
| TagExtractor | 默认disabled；显式deterministic fixture仅用于开发测试；llm/dify transport未接通 | 失败、过期修订及人工标签fence不覆盖原文；没有正文时不调用Provider |
| 标签图谱 | 有效`note_tags`的有界实时投影、计数和共同标签证据 | 不建图谱正文副本、Neo4j或语义相似边；App显式edges消费需单独联调 |

## 知识库处理与检索

当前模式和完整验收见 [知识库手册](runbooks/milvus.md) 与 [本阶段验收](acceptance/knowledge-base.md)。

| 能力 | 当前实现 | 验证边界 |
| --- | --- | --- |
| 解析/图文/OCR | 复用已有自研解析和 OSS 绑定 | 本次未改解析器；集成使用明确的 Mock 解析产物 |
| 资料关键词 | 2000 码点 / 零 overlap / Milvus 原生 BM25 | 真实临时 Milvus；模型和模型 tokenizer 调用为零 |
| 笔记混合 | 500 码点 / 约 50 字 overlap / 原生 Hybrid+RRF | 真实临时 Milvus，确定性 1024 维 Embedding 替身 |
| 输入预算 | UTF-8字节数+16，保守限制128000 | 不是模型实际tokenizer或计费量；不加载旧模型tokenizer |
| Embedding | qwen3.7-text-embedding-flash，原生1024维，Milvus FP16 | 本机业务空间公网模型列表200并包含模型；推理仍为替身，未进行付费推理验证 |
| Rerank | qwen3.7-text-rerank，DashScope原生API | 模型列表200；关键词不调用，保留既有200ms预算及失败回退，真实延迟/效果未验 |
| 业务正文 | Note原文、资料 canonical 对象、独立导入原文 | 四张索引表不保存切片正文或向量 |

## 验收状态

本地Fixture历史证据（2026-11-04）：238资产、235引用、3 orphan、1002条完整OCR记录，91个临时章节范围、0章节Parent和152个Child。它验证本地绑定、offset和真实模型tokenizer，不表示新public已完成真实文件RAG入库。

历史真实Milvus与公开向量验证证明过Dense/BM25/Hybrid、Analyzer、稳定写入和删除；这些证据不替代新public的新用户、新文档、新任务验收。原业务数据完整保留在封存Schema，但不复制到新public、不参与运行兼容查询；Milvus/OSS未清理，旧smoke不被当前业务查询返回。

本次typecheck、lint、build、229项unit/contract、115项独立PG/Redis integration和额外6项隔离Schema归档安全检查通过。原库真实切换、四角色healthy、API数据库目标/基线checksum/Redis/readiness200及EdDSA/Ed25519/server-current JWKS均通过；初始化和重放实际使用既有配置的`huahuo_admin`。管理员保留逻辑确认`retainedAdminAccounts=0`（原管理员表即为空）。本轮模型与短信调用均为0，未做真实文件RAG入库；Mock、真实本地依赖和供应商验证分开记录。
