# 契约兼容性（P01 历史与 P02 增量）

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

## P05：媒体资源与文件传输

App 参照 commit `20f61b78887f9288d1fd3227f326e6374d516f27`，本地工作树无变化。核对 `upload_client.dart`、`media_resource_client.dart`、`endpoint_catalog.dart`、聊天下载/相册/头像调用。

| API | App 实际契约 | 后端状态 |
|---|---|---|
| `POST /api/v1/media/upload-token` | Bearer + `X-Idempotency-Key`；sourceScene/fileName/mimeType/sizeBytes/durationSeconds/sha256?/workspaceId?；返回 uploadId/resourceId、绝对 uploadUrl、method、headers | CODE；不要求 App 私有 URI；返回短期 `X-Upload-Capability`，对象 PUT 不带 Bearer |
| `PUT /api/v1/media/uploads/{uploadId}/object` | 按 token method/headers 流式上传真实字节 | CODE；大小、哈希、MIME/音频时长服务端核验，临时落盘后不可覆盖发布 |
| `POST /api/v1/media/uploads/{uploadId}/complete` | Bearer + 幂等；body 可含 workspaceId；丢响应可重试 | CODE；初始化即分配稳定 resourceId，重复 complete 不重复资源/计量 |
| `GET /api/v1/media/resources/{resourceId}/playback` | Bearer；返回可直接 GET 的短期 URL 与 mime/fileName/expiresAt | CODE；跨用户 404，URL 为持有者 capability |
| `GET .../object` | App 直接 GET signed URL，图片/音频支持 Range | CODE；206/full/suffix/open range，416 返回 `Content-Range: bytes */size` |
| `DELETE /api/v1/workspaces/{workspaceId}/media/resources/{resourceId}` | Bearer + 幂等；解析 `resourceId/workspaceId/status`，status 接受 `deleted` 或 `delete_pending` | CODE；引用检查后返回 `delete_pending`，Worker 异步删除，不在 API 同步删文件 |

头像现在通过资源引用校验后写入 profile；消息/笔记等引用使用同一 `resource_refs` 约束。上传完成只触发检查任务，不伪称 ASR/文本处理完成。App 未修改、未运行 Flutter。

## P06：个人资产、笔记、文件夹、检索与图谱

App 参照 commit `20f61b78887f9288d1fd3227f326e6374d516f27`，本阶段核对 `domain_clients.dart`、`contract_models.dart`、`api_contract_manifest.dart`、`endpoint_catalog.dart`；App 未修改。

| API | App 解析/行为 | 后端状态 |
|---|---|---|
| `GET/POST/PATCH/DELETE /workspaces/{workspaceId}/folders` | Folder ID、parentFolderId、normalizedName、state、currentRevisionId、etag、contentCursor；If-Match + 幂等 | CODE；同级重名冲突、循环移动拒绝、软删除/恢复、作用域隔离 |
| `GET/POST/PATCH/DELETE /workspaces/{workspaceId}/notes` | HNote 的 raw/outline/germination parts、noteRevisionId、etag、resourceRefs、sourceRef | CODE；原文 revision 不可变，旧 ETag 返回 412，删除保留 tombstone |
| `GET/PUT .../notes/{noteId}/parts/{part}` | `contentMarkdown`、`basePartRevisionId`、partRevisionId、contentSha256 | CODE；每次写入追加 revision，原文不被标签任务覆盖 |
| `POST /workspaces/{workspaceId}/notes/batch-move` | 局部结果逐项返回 | CODE；单项冲突不会覆盖其他项 |
| `POST /workspaces/{workspaceId}/search` | keyword/semantic mode、中文与英文 query、owner/folder/date filters；结果带 ownerRef、part、revisionId、path、matchMode | CODE；Note keyword 使用笔记集合 BM25，semantic/hybrid 使用同集合 Dense/BM25 原生 RRF；返回 `part=raw` 和整篇 Note 修订，保留授权及业务筛选 |
| `GET /workspaces/{workspaceId}/content-navigation/{map}` | 局部节点/标签聚合 | CODE；只返回有据的 Note/Tag 节点与计数，限制 100 节点 |
| `GET/POST/DELETE .../notes/{noteId}/relations` | typed explicit relation、source/target、rationale、version、etag | CODE；引用关系和标签聚合均按 workspace 隔离 |

标签提取由 `asset.tag-extract` 持久任务执行，最多 5 个候选；任务失败或 revision 过期不会删除或覆盖原文，人工标签表与提取来源分开。未接真实 LLM/Dify，确定性提取只作为明确的本地 Worker fixture。

## P06 标签化补充修订

- App 参照确认人工标签规范为每篇最多 20 个、每个 1–24 Unicode 字符；后端按此拒绝超限并返回 tag ETag。新增 tag CRUD/建议/提取路由为后端补充契约，保持 envelope、Bearer、Idempotency-Key 和 If-Match 约定。
- App `contentNavigation` 请求目前只发送 workspace/map 且解析 `items/map/contentCursor`；后端提供真实相对路径、revision/version、ownerRef，并额外返回有界 nodes/edges。App 当前 `MiroFishGraphMapper.fromContentNavigation` 只按路径建层级边，忽略显式后端 edges；因此共同标签边已在 API/契约测试中验证，但 App 端完整可视化接线待 P15，不修改 Flutter。
- 搜索保持 `ownerRef.kind=hnote`、`keywordReadiness=current`、`vectorReadiness/vectorStatus=unavailable`，不返回正文/snippet/evidence，保留关键词/标签/来源/时间过滤。

## 知识库当前契约（2026-11-10）

解析器和图文绑定不变。Note 保存 raw 后异步走笔记混合模式，资料保留文件/导入身份并走纯 BM25。索引使用四张元数据表、两个 Collection；详见 [知识库手册](runbooks/milvus.md)。

- 用户入口仍用 JWT；Agent 的 `/internal/v1/rag/query` 仍同时要求用户 JWT 和方向 Service Key。
- Agent 现有 Tool 只发送 query/mode/topK，不发版本和归属 ID；Server 默认 Note 混合业务。资料业务显式指定 sourceType=file/text 或使用 `/api/v1/kb/documents/query`，实际仅执行 keyword。
- App 搜索请求/响应保持既有路径和 Envelope。桌面端 `_openWorkspaceSearchResult` 要求 part，并将 revisionId 交给整篇 Note 的精确读取；因此搜索返回 `part=raw` 和整篇 Note 修订，不能用 raw part 修订代替。
- RAG 详情另返回 sourceRevision/partRevisionId 及 UTF-16 命中范围。整篇 GET 的 revisionId 与 part GET 的 partRevisionId 分别校验，错误版本不能静默读取当前内容。
- 不新增工作区产品概念；现有技术归属与权限过滤保留。知识图谱继续基于标签关系。

真实客户端源文件、hash 和测试夹具位置见 app-reference.md。本阶段未运行或修改 Flutter；集成通过只证明相应 HTTP/JSON 契约，不能代替真机验收。
