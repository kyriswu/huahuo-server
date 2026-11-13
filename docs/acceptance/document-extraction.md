# 文档提取接入验收 · 2026-11-14

按用户提供的完整 config、同步/异步接口及 kb-markdown-v1 响应实现，已接入现有文件和 FILE_UPLOAD 流程，复用 Task/Outbox/Worker、ECS/Redis 运行库与 document-keyword/BM25。没有新增向量流程、Embedding、Rerank 或另一套导入服务。

## 实际链路

`POST /api/v1/rag/ingestions` → 现有 PG Task/Outbox → Worker 原始文件核验/存储重用 → Redis 去重/全局名额/按需启动 → `/extract` 或一次 `/extract-async` + `/jobs/{id}` → 原文、完整 JSON、图片回执/关联落盘 → 原有分段/关键词索引。完成产物在受控 `/api/v1/rag/ingestions/{jobId}/extraction` 读取，图片读取也检查用户/文档/资源归属与 OSS bucket/prefix。

完整请求在 `resources/document-extraction/kbxml-request.json`。覆盖必须传完整配置，不做默认值合并；请求快照、母文件 UUID 和批次 UUID 持久化后才排队，同批次重试复用。已有母资源按用户/工作区/ready 查询并重用对象，建立资源引用；源文档删除解除引用并取消正在解析的任务。

`content` 原样保存，完整 JSON 无损 gzip 保存、读取时解压；图片只保留已确认上传的 UUID/元数据/回执，不二次上传或进行本地图片 OCR。表格/KB 标签、pages、source_nodes 和原始定位信息均保留。转换前字节偏移不用于截取转换后的正文，Server TOC/片段重新基于规范正文生成。

PG 外部意图先于 POST；已接受 job_id 即使碰上取消/lease 变更也关联原意图保存，旧 Worker 仍不能发布结果。已知 job 恢复只 GET，不重提/重下载。没有 job_id 的模糊提交保持待核实。取消先记录发送意图，DELETE 模糊后只 GET，到终态才释放；删除/取消后的晚到结果不入索引。PG 正文/产物引用与完成状态共用既有 Task lease 事务。

排队/启动等待接入 Worker lease 的取消通知；已提交工作继续占用名额，使用 PG 取消意图和远端终态收尾。两个新增协调测试覆盖取消排队不调用解析、提交后的 admission 取消不会误中断远端/释放名额。资料入口已移除对模型提供方启用状态的依赖，功能开关仍保留；真实 BM25 和 FILE_UPLOAD 在全局模型 disabled 下也验证通过。

## 验证

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

## App 与待测试环境验证项

只读 `../huahuo-ai`，Git仍GIT_UNBORN。ApiEndpoints 与 auth HTTP 客户端哈希同本轮 app-reference 记录，未找到文件提取相关调用，未改/运行Flutter。当前接口为Server CODE和用户给定协议，不冒称移动端已消费。

用户要求不从本机访问 `172.18.102.101:8000`，本轮严格未探测。镜像版本/build-id、真实内网路由、模型运行、OSS上传、真实文件质量/性能以及测试环境部署仍需在VPC内验收。实际 `.env` 仍默认关闭，按[手册](../runbooks/document-extraction.md)启用测试配置。先前手动开机是独立授权记录，本轮没有再次操作云实例。
