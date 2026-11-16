# 百炼 Qwen 3.7、FP16 与内部 RAG 配置验收 · 2026-11-16

代码与本机ENV已完成；旧Milvus稠密集合已按用户明确授权删除并原名重建，不备份。**应用容器未重启、云端test/main未发布**，不把源码/ENV更新描述为运行中的服务已经切换。

## 模型、存储与网络

- 嵌入：`qwen3.7-text-embedding-flash`，使用默认原生1024维；原生DashScope接口，文档/查询分别设置document/query，校验维度、有限数值、完整text_index并按输入恢复顺序。每次HTTP最多20条，旧后台32条批次在新快照中限制为20；没有裁剪、降维或补零。
- Milvus：稠密字段从FloatVector改为Float16Vector；写入、Dense和Hybrid查询均显式编码FP16，每个1024维原始向量2048字节。HNSW/COSINE（M16、efConstruction128）、原生BM25/RRF保留。正常应用遇到旧Schema只失败关闭，不自动删除重建。
- 重排：`qwen3.7-text-rerank`，使用`input.query/documents`与`parameters.top_n`、解析`output.results`；校验唯一索引/分数，保留授权候选及原文最终复核。当前后台原有200ms重排预算保持，真实模型超预算仍回退初排；没有进行真实推理延迟或检索质量验收。
- 旧供应商URL、OpenAI兼容嵌入适配器及旧模型运行时绑定已移除。ENV中的两个Key换为用户提供的百炼Key；没有生成、重置其他凭据。
- 本机`.env`和`.env.compose.local`使用用户提供的业务空间**公网**cn-beijing Host；本机即使APP_ENV=test或分支test/main也用公网。云端test/main使用用户提供的**私网**Host；不按APP_ENV/Git分支推断网络，不做私网失败转公网。两个Host均以`/api/v1`为Base URL。
- 云端真实模型配置片段已放在`.local/qwen37-cloud-model.env`，权限0600、忽略提交，供发布时合入既有云端ENV；本轮未传输或应用到测试宿主。示例只放占位业务空间域名。发布配置校验默认要求北京VPC Host；本机显式以public方式校验。
- 不再用BGE tokenizer检查新模型。UTF-8字节数加16作为保守输入预算，上限128000；持久化token_count是预算估计，不能当作供应商实际usage或计费量。

依据：[嵌入API](https://docs.bailian.console.aliyun.com/zh/model-studio/text-embedding-synchronous-api)、[重排API](https://docs.bailian.console.aliyun.com/zh/model-studio/text-rerank-api)、[Milvus Float16Vector](https://milvus.io/api-reference/node/v2.6.x/Collections/DataType.md)。

## 实际 Milvus 操作

先枚举当前实例的database/collection，确认只有default中的两个本项目集合，其中只有Note集合含稠密向量。删除前强一致逻辑count为0；共享PostgreSQL的Note构建、切片和未完成索引任务均为0，故无需清理PG元数据或重新调用模型回填。业务Schema物理外键只读核查为0。

显式维护脚本`scripts/rebuild-note-vectors.mjs`默认只输出计划；真正执行绑定核对过的旧集合ID，经执行审批后使用`--discard-without-backup --expected-id …`。只删除`huahuo_kb_note_hybrid_chunks`，重建同名FP16/1024集合及HNSW/BM25索引并load；服务端collection ID已改变，重建后逻辑count仍为0。纯BM25集合`huahuo_kb_keyword_chunks`的服务端ID保持；没有DROP database、删除卷、改PG业务数据或导出正文/向量备份。

脚本拒绝production、目标与关键词集合别名、非稠密集合、集合身份变化、已有PG构建/切片/未完成索引任务。非空安装必须另行评估停止写入、元数据状态及从原文重建的计划；不能将本次空索引操作直接套用到历史非空环境。此脚本不接应用启动、Worker、Scheduler、迁移或自动发布。

连接最初从宿主/项目容器、直连/现有代理均超时；用户要求重试后，以宿主正确的HTTP CONNECT代理恢复。失败探测只读，未发生删除；真正删除只执行了一次。原始计划、执行结果及最终Schema检查保存在忽略目录，不在公开文档贴内部设施标识。

## 内部 RAG 运行配置

`src/apps/api-server.ts`将`/internal/v1/rag/query`纳入RuntimeSettings.enter，与公开RAG路由使用同一请求快照机制。真实隔离PG通过Admin API保存BM25候选7，公开通用/Note/Document及内部四个入口均读取7；一个保持执行中的内部请求继续读取7，同时将后台改为11，后续公开与内部请求都读取11。入口/配置/事务是真实Fastify与PG，检索用例在这项测试中是明确的spy，不能冒充真实模型召回。

本轮只修复此项架构审计问题；File/text查询边界、来源200条截断、账单与任务预留等其他已登记问题未在此项中处理。

## 测试与失败记录

- **903项unit/contract，61文件全部通过**：原生请求/响应、20条批次、查询/文档语义、异常响应、FP16字节与精度、旧FP32集合拒绝、重排回退、维护脚本边界与网络位置校验。模型、删除工具中的云调用为替身。
- **288项integration，21文件全部通过**：真实独立PostgreSQL17.9、Redis7.4.8、Milvus2.6.26，tmpfs容器与随机测试库；覆盖FP16实际入库与Dense/BM25/Hybrid检索、权限/修订、普通CRUD/索引和外键0。模型、解析器与云电源为替身；没有把业务集合用于集成测试。临时容器及凭据已清理，未删除数据卷。
- SQL升级演练基准3→候选3，首次/重复应用均为空清单；没有新增或改写已执行SQL。
- Typecheck、Lint、Build、实际本机Compose及环境样例解析通过；构建保留既有Ant Design use-client和Vite chunk体积提示。
- 本机和四角色+一次性migrate的实际Compose ENV已解析验证，两个模型地址均为公网。云端私网ENV片段只做本地值校验；未声称已在云端容器生效或网络实测通过。
- 真实业务空间公网`GET /compatible-mode/v1/models`返回200，列表同时包含两个指定模型；只读授权检查，**模型推理次数0**。随后真实云Milvus只读验证FP16/1024与两个索引Finished。

首次定向命令未排除`.local`，误执行3份历史候选测试并出现18个旧模型断言失败；加项目既有排除条件后本仓库专项通过。首次全量unit尚有一个旧FloatVector断言，按新规格更新后通过。首次集成因新增测试恢复完整默认值而留下额外键，改为恢复原始存储对象后通过运行配置用例；第二次集成暴露已有标签任务测试立即claim偶发为空的准入时机问题，夹具改为有界等待真实available_at准入，未修改生产TaskEngine。最终上述903/288全部通过，先前失败日志保留。

原始日志：`.local/qwen37-unit-complete.log`、`qwen37-integration-complete.log`、`qwen37-typecheck-complete.log`、`qwen37-lint-complete.log`、`qwen37-build.log`、`qwen37-model-list.json`、`qwen37-local-config.json`、`qwen37-rebuild-plan.json`、`qwen37-rebuild-result.json`、`qwen37-live-schema.log`。不包含真实密钥或原文。

## 发布交接与当前限制

`scripts/release/plan.json`保留原在途网关/统一身份改动，基准沿用已记录测试服成功SHA b65e7ee…；实际发布前仍需复核宿主最新成功记录。清单追加模型ENV替换、旧tokenizer键移除、只读Milvus依赖验收。原有API/配置不兼容标记保留，并将旧模型任务快照标为不兼容，避免未解决调用方和旧写入方交接就自动发布。

| 人工交接项 | 当前状态 |
| --- | --- |
| 本机模型ENV、共享Milvus空集合重建且不备份 | 已完成 |
| 云端test/main模型ENV换为本期私网片段及新Key | 片段已准备，未应用 |
| 网关/Agent统一鉴权交接、旧模型任务/写入方退役 | 沿用在途候选门禁，未声称已完成 |
| 真实嵌入→FP16召回→Rerank效果与延迟，云端私网连通 | 未验；未调用付费推理 |
| 提交、PR、远端CI和应用发布 | 本轮未执行，工作区原有未提交改动保留 |

只读核对真实App的`api_endpoints.dart`与`http_auth_repository.dart`，Git HEAD为bf23c1b…、工作树干净，SHA256仍分别为17bfcbf…和d41d211a…；没有当前RAG消费者。未写App、运行Flutter、操作其他项目或增加其他云资源，停在本专项验收点。

## 同期目录重构后的复核

收尾期间工作区同时将Milvus适配器移到`src/integrations/search-index/`、关键词批量工具移到`src/lib/search-index/`，本次FP16编码/Schema校验保留在新位置。维护脚本和发布只读验收同步使用新路径与hybrid工厂；没有恢复旧路径或增加兼容转发。补齐受影响集成夹具的参数类型。重构过程一轮Typecheck报告该夹具implicit-any、一轮Lint报告新增composite工具未用变量，修正后的Typecheck、Lint、Build、**903项unit/contract和288项真实PG/Redis/Milvus集成**再次通过；这不代表额外新引擎能力全部验收。

追加日志为`.local/qwen37-current-unit.log`、`qwen37-latest-integration.log`、`qwen37-latest-typecheck.log`、`qwen37-verified-lint.log`、`qwen37-latest-build.log`。第一次最终只读脚本仍引用旧dist路径而未能启动，随后换新路径成功；没有再次删除集合。最新重建脚本以默认dry-run验证，只读输出当前FP16集合身份与0条逻辑行；发布只读Schema脚本再次通过。最终实例仍只有1个database、2个本项目集合，唯一稠密字段为Float16Vector，关键词集合ID保持、共享PG索引元数据0、外键0，见`.local/qwen37-final-inventory.json`、`qwen37-current-dry-run.json`及`qwen37-current-live-schema.log`。

## 与可替换检索端口的兼容复核（2026-11-16）

按用户要求只做小范围检查：新Keyword/Vector/Hybrid端口不绑定模型，当前接线继续使用本期Qwen原生1024维与FP16；Milvus写入、Dense与原生Hybrid查询仍编码FP16，应用组合召回也复用同一Vector端口。文档批次限制20、查询/文档text_type、独立重排与200ms预算保留；内部RAG请求快照接线仍在。没有发现需要追加业务逻辑的冲突，只纠正contract-compatibility中一处仍写BGE的说明。

本轮新增执行6文件62项专项单测全部通过，覆盖Qwen请求/索引顺序、FP16、关键词独立能力、组合召回/失败、重排预算与发布网络配置校验；SDK/模型为替身，没有重跑上文288项集成或新增真实推理。只读检查`.env`、`.env.compose.local`为北京公网及/api/v1，私密云端片段为北京VPC及/api/v1；模型/维度/profile和密钥存在性匹配，私密片段权限0600。仅输出脱敏布尔校验结果，没有打印密钥或完整Host。证据`.local/qwen-search-compatibility/unit.log`、`config-check.json`；diff检查通过。本轮未改真实ENV、预算、集合、业务代码，未重启或部署。
