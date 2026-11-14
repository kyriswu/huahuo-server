# 文档提取接入验收 · 2026-11-14

按用户提供的完整 config、同步/异步接口及 kb-markdown-v1 响应实现，已接入现有文件和 FILE_UPLOAD 流程，复用 Task/Outbox/Worker、ECS/Redis 运行库与 document-keyword/BM25。没有新增向量流程、Embedding、Rerank 或另一套导入服务。

## 完整325页复测未通过，解析机已停止（2026-11-14）

用户追加提供完整《电子标书.pdf》并要求重测。通过 OSS SDK 的 `huahuo-ai-assets-test.oss-cn-beijing-internal.aliyuncs.com` 下载原对象，81,249,929字节、325页，耗时1,631ms；SHA-256 为 `d9c063dfe3f9b8107e7d78c9e27574ac8b23d9dd21096f84e32d9c31b07ac59f`。随后通过真实上传/API创建独立测试资源和入库任务，不截取页数。

本轮未完成入库或查询。首次任务在 DOWNLOADING 阶段发生 `ENOSPC`，Worker `/tmp` 为128MiB；自动重试进入全文解析后，约5分钟远端异步任务开始返回404。实际 `/jobs/{job_id}` OpenAPI 明确声明任务5分钟过期；原任务ID连续读取均为 not found or expired，后端进入 `DOCUMENT_PARSER_EXECUTION_UNKNOWN` 对账，3次尝试预算耗尽。不能将已上传或远端已生成图片当作全文入库成功，也未获得可供质量抽查的完整正文。

只读云助手诊断确认解析容器空闲（CPU约0.02%）。用户随后要求用不到时先停机，已对指定 ECS 执行节省停机并核验 `Stopped + StopCharging`；未执行原计划的同步接口复测、扩大临时磁盘或修改解析器TTL。确认远端停止后定向清理 Redis 未知请求，active/queued/uncertain均0；本项目后端恢复停止状态。

通过解析批次资源清单收回751个测试图片对象，加上上传的PDF副本共752个OSS对象，定向删除后逐个HEAD404。测试账号、工作区、PG关联行及BullMQ任务已清理，Strong查询无本轮Milvus点；原PDF的ETag和长度保持，现有用户摘要不变。未重置凭据、清库、改Schema或删除卷。

原始证据在 `.local/pdf-full-e2e-20261114-8825986/` 的 `source.json`、`evidence.json`、`parser-openapi.json`、`remote-job.json`、`parser-diagnostic.log` 与 `orphan-resources.json`。用户提供的签名URL未写入文档。后续完整复测需要先解决临时磁盘容量和异步任务保留窗口；可评估服务已有同步接口，但本轮未执行，也未再次开启远端解析机。以下2页通过记录仍仅适用于其对应样本。

## 测试服务器 VPC 真实验收（2026-11-14）

按用户追加要求，在测试服务器以 `8825986` 构建 `huahuo-server:pdf-e2e-8825986`，通过真实 HTTP 上传、受理、任务查询、产物下载和检索接口完成一次文件流程。解析器实际连接 `172.18.102.101:8000`，`/health` 为 healthy，`/version` 为 `1.3.9`；Milvus 使用 `c-850eb68e967e1f3a-internal.milvus.aliyuncs.com:19530`，目标为 `default.huahuo_kb_keyword_chunks`。本节不使用模拟解析或模拟索引。

临时 PDF 共2页、61,403字节：第一页为英文及中文原生文本，第二页为没有文本层的扫描图。原生英文 `granitefable`、中文 `青岚检索`、扫描页 OCR `violetquartz` 均保留并命中。解析输出724字符、9个 ready 分段、1张已上传图片；`ocr_used=true`、第2页为 scanned，错误数0。规范正文与存储正文逐字一致，图片受控读取200且 SHA-256 一致。

| 环节 / 查询 | 实测（ms） | 结果 |
| --- | ---: | --- |
| PDF 上传 PUT | 186 | 200，SHA-256 与原文件一致 |
| 入库任务受理 | 83 | 200；重复受理复用原任务 |
| 受理后等待任务成功 | 38,570 | 包含 ECS 冷启动、解析、存储、索引及2秒轮询误差 |
| 解析器报告的内部提取 | 6,114 | 2页，混合原生文本与 OCR |
| `granitefable`，资料接口 / 通用 RAG 接口 | 1,097 / 92 | 各命中1条；首次查询包含客户端初始化 |
| `青岚检索`，资料接口 / 通用 RAG 接口 | 94 / 85 | 各命中1条 |
| `violetquartz`，资料接口 / 通用 RAG 接口 | 84 / 85 | 各命中1条扫描页内容 |
| 无关词，资料接口 / 通用 RAG 接口 | 67 / 61 | 均0条 |
| 图片受控下载 | 39 | 200，122,911字节，哈希一致 |

资料接口为 `POST /api/v1/kb/documents/query`，通用接口为 `POST /api/v1/rag/query`、`sourceType=file`，均 `topK=5`、限定本次 `documentKey`。通用接口即使请求 hybrid 也按资料规则返回 keyword；本轮禁用 Embedding/Rerank，实际查询为 Milvus 原生 BM25。以上是单样本流程验收，不是分位数压测。

另一个临时用户查询0条，读取产物/图片均404；无凭据读取401。通过业务删除接口后立即查询0条、产物404，后台清理成功；显式字符串 Strong 查询确认本文件的 Milvus 点为0。随后仅定向清理本次的临时用户、工作区、PG关联行、BullMQ任务及5个 OSS对象，全部对象 HEAD404，原有用户记录摘要不变，业务外键仍为0。

ECS 从 `Stopped + StopCharging` 被正式 Worker 按需启动，最后由 Scheduler 自动节省停机；复核 `economicallyStopped=true`、active/queued/uncertain 全0。后端恢复测试前的停止状态。标准 migrate 返回 `applied=[]/current=1`，未改基线、清库、重置凭据或操作现有卷。

本次使用 `.local/pdf-e2e-20261114-8825986/deploy.env` 临时配置，原 `.env` 未改。旧环境的 Qwen tokenizer 输入上限最初阻止新角色启动，按现行 BGE-M3/1024/8192配置修正后通过三个角色的配置预检；旧 OSS 凭据仅以当前共享 RAM 变量注入。`../huahuo-ai` 与 `../huahuo-app` 在本机均不存在，App 为 `UNVERIFIED_APP`，未 clone 或修改。

原始证据在忽略提交的 `.local/pdf-e2e-20261114-8825986/`：`fixture.json`、`evidence.json`、`extraction.json`、`canonical.md`、`ecs-before.json`、`ecs-after.json`。本轮仅证明该2页样本，未验收大文件/并发压力、同步提取、FILE_UPLOAD、Flutter、逐字 OCR 准确率或解析器镜像 digest；`KBIMAGE` 的独立图片 OCR 状态为 unavailable，扫描页文字来自整页 OCR。

## 实际链路

`POST /api/v1/rag/ingestions` → 现有 PG Task/Outbox → Worker 原始文件核验/存储重用 → Redis 去重/全局名额/按需启动 → `/extract` 或一次 `/extract-async` + `/jobs/{id}` → 原文、完整 JSON、图片回执/关联落盘 → 原有分段/关键词索引。完成产物在受控 `/api/v1/rag/ingestions/{jobId}/extraction` 读取，图片读取也检查用户/文档/资源归属与 OSS bucket/prefix。

完整请求在 `resources/document-extraction/kbxml-request.json`。覆盖必须传完整配置，不做默认值合并；请求快照、母文件 UUID 和批次 UUID 持久化后才排队，同批次重试复用。已有母资源按用户/工作区/ready 查询并重用对象，建立资源引用；源文档删除解除引用并取消正在解析的任务。

`content` 原样保存，完整 JSON 无损 gzip 保存、读取时解压；图片只保留已确认上传的 UUID/元数据/回执，不二次上传或进行本地图片 OCR。表格/KB 标签、pages、source_nodes 和原始定位信息均保留。转换前字节偏移不用于截取转换后的正文，Server TOC/片段重新基于规范正文生成。

PG 外部意图先于 POST；已接受 job_id 即使碰上取消/lease 变更也关联原意图保存，旧 Worker 仍不能发布结果。已知 job 恢复只 GET，不重提/重下载。没有 job_id 的模糊提交保持待核实。取消先记录发送意图，DELETE 模糊后只 GET，到终态才释放；删除/取消后的晚到结果不入索引。PG 正文/产物引用与完成状态共用既有 Task lease 事务。

排队/启动等待接入 Worker lease 的取消通知；已提交工作继续占用名额，使用 PG 取消意图和远端终态收尾。两个新增协调测试覆盖取消排队不调用解析、提交后的 admission 取消不会误中断远端/释放名额。资料入口已移除对模型提供方启用状态的依赖，功能开关仍保留；真实 BM25 和 FILE_UPLOAD 在全局模型 disabled 下也验证通过。

## 此前本地模拟解析与真实隔离依赖验证

| 验证 | 结果 |
| --- | --- |
| Node / pnpm | 26.11.0 / 10.15.1 |
| 类型、lint、构建 | 通过；Admin Vite 原有体积/use-client 提示保留 |
| 单元/契约 | 394 通过，新增19项协议用例；fetch均为替身 |
| 独立 PG/Redis/Milvus integration | 160 通过，新增12项业务链路用例；解析 HTTP 服务在loopback，图片存储/上游上传回执由替身给出 |
| 真实 BM25 | 模拟解析产出的正文经真实 PG/Redis/Milvus 入关键词索引，可检索 Native；Embedding/Rerank 设为调用即失败，未调用 |
| Schema/迁移 | 本轮无改动；隔离迁移/CRUD/索引验收物理外键0 |
| 真实环境操作 | 无内网解析/健康/版本探测，无 ECS/OSS API 调用，未修改真实env、运行容器或App |

协议用例覆盖完整配置/拒绝部分配置、multipart顺序、nil UUID、同步/异步、GET-only恢复、部分失败索引归属、独立图片null上下文、完整正文/合并HTML/字面KB代码示例、无上传回执或携带字节/Base64/本地路径的图片拒绝、已知job404/500保留unknown、取消只发送一次、资源清单过滤。

12项集成覆盖现有JWT API→真实PG Task→Redis→模拟提取→存储/资产→关键词发布；异步持有名额并先保存job_id；GET失败恢复不重提/不重下载；模糊POST不重发；同批次UUID/配置快照稳定；取消正常与模糊DELETE；FILE_UPLOAD；已上传母资源重用/并发受理去重/引用清理；取消赶上POST接受；删除阻止晚发；真实BM25查询。其他用户/已删除文档产物不可读取，资产前缀不重复添加。

既有 heartbeat 测试改为生产允许的6秒租约并直接验证实际Redis过期时间延长，避免负载下1.2秒人工租约抖动造成假失败；失联过期必须unknown的专门测试保留。测试库、凭据、端口和容器全为独立随机临时资源，结束后仅清理本轮资源，已有卷/开发库未清空。

证据：Server `.local/ecs-power/extraction-release-unit.log`、`extraction-release-integration.log`、`extraction-release-typecheck.log`、`extraction-release-lint.log`、`extraction-release-build.log`。静态配置核对在 `extraction-compose-validation.json`，最终App/凭据扫描在 `extraction-final-audit.json`；新增两项排队取消/已提交任务持有名额验证也包含在160项中。这里的真实依赖测试不是实际Xberg/OCR/OSS上传质量验收。

## App 核对与剩余验收

接入实现阶段曾只读 `../huahuo-ai`，当时 Git 为 GIT_UNBORN；ApiEndpoints 与 auth HTTP 客户端哈希同 app-reference 记录，未找到文件提取相关调用，未改或运行 Flutter。2026-11-14 的测试服务器缺少 App 源码，因此本次 App 验收为 `UNVERIFIED_APP`。当前接口为 Server CODE 和用户给定协议，不冒称移动端已消费。

接入实现阶段按用户当时要求未探测解析私网；后续获准在 VPC 进行真实测试，部署、内网解析及 OSS/关键词索引链路已由上述2页样本验证，325页全文尚未通过。待验收项为完整大文件、并发压力、同步提取、真实 FILE_UPLOAD、Flutter、逐字 OCR 质量及解析器镜像 digest/build-id。实际 `.env` 未改，测试使用临时配置；后续启用方式见[手册](../runbooks/document-extraction.md)。
