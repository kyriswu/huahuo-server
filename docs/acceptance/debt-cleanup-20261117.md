# 历史债务清理（2026-11-17，本地候选）

后续本地候选已在 2026-11-18 追加有界 PG 写入优化与 0016；本文件的 0013–0015 和测试数量是此轮历史证据，当前累计候选以[最新优化验收](pg-row-growth-optimization-20261118.md)为准，仍未部署。

用户明确授权清除历史实现、旧客户端字段和混合版本兼容。本轮仅修改 Server；App 只读，测试环境已发布版本及共享数据库保持原状。正式生产尚未接入，测试环境已执行的 0001–0012 按字节核对未改写。当前候选不兼容旧写入方和旧 API，发布清单各项兼容声明为 false，自动发布保持阻断。

## 已收敛的实现

- 文件夹与单 Note 删除/恢复共用状态转换，更新版本、ETag、内容事件和索引任务。删除来源使用普通 nullable UUID，恢复只恢复本次级联对象。既有 deleted 数据不猜测来源，独立删除不复活；删除父目录下拒绝单独恢复。工作区树结构写入串行化，避免并发移动成环。
- 文件夹/关系写入的幂等身份包含工作区，关系创建还包含源 Note ID；不同 URL 身份不会复用另一个对象的成功响应。
- 搜索功能确定需要，现有实现保留；具体业务细节待定。先前误删的查询Service、公开/内部与工作区搜索、配置/指标及测试已恢复，不把这些技术选择当成已确认的产品需求。后续按明确业务调整，当前不继续扩功能。
- 保留上轮既有正确性修复：File查询覆盖file/text真实来源；来源分页与有界point窗口移除最新200来源硬截断；混合检索先合并全局分支候选，再统一RRF，避免跨窗口比较局部分数。
- 任务仅返回真实 state，移除旧 WorkAiTaskInfo 的 status 映射；详情与执行的重试能力一致，不向其他任务宣称 demo 重试。删除固定 409 的 regenerate、无消费的 keywordAttemptId、未执行的 restore 参数及固定空 profile 字段。认证响应删除 defaultContentLine 别名和固定 onboarding/positioning/runningTaskCount 占位；定位使用唯一 creativePositioningId。
- 节点配置及 assignment 快照删除退役 enabled。运行配置严格使用当前 registry，未知字段直接拒绝，不再投影/保留未知键、读取隐式 schemaVersion 或向旧格式双写。
- Studio 仅发当前作用路径的两条 Cookie/内部响应头，删除清理旧根路径 Cookie 的两条过渡头；入口继续消费现有 Studio Access/Refresh 响应头。标签任务必须含当前 tagSetVersion，缺失或非法值按不可重试输入错误失败，不再作为旧任务成功过期。
- JWT 只接受和发布当前 kid 的公钥，删除 previous key 双密钥兼容；更换密钥将使旧 Access Token 立即失效。当前活动凭据未重置。
- 删除空 JSON body 自定义解析。空正文声明 application/json 将按原生 Fastify 规则返回 400；无正文调用须不声明 JSON，或按接口发送合法对象。当前 App ApiClient 仍无条件声明 JSON，此变化作为断开旧兼容记录，不修改 App。
- 删除无行为消费者的 PROVIDER_MODE、DEV_AUTH_BYPASS、ALLOW_DEV_AUTH、PAYMENT_PROVIDER、ASR_PROVIDER、WORKFLOW_PROVIDER、PUSH_PROVIDER，以及旧 JWT ENV。保留有实际消费者的 RAG_PROVIDER_MODE/RAG_RERANK_PROVIDER/ALLOW_MOCK_PROVIDERS。根目录私密本地 ENV 只移除退役键，不输出或更换其他值。
- 删除 Billing 旧独立空间 reserve/confirm/release、recordRunUsage 和 markMeasurementPending 写入方法；现役 ResourceClaims、删除任务、credit 预留/结算与历史用量只读查询保留，未删除账本或存量数据。
- 所有 RAG/KB 内容哈希复用 lib/crypto.digest，删除只剩 SHA256 的旧 chunkers 文件与薄别名。
- 删除空 seed 命令、无调用 object-storage.deleteMany 封装、未接线 composite 索引后端和 document-processing Tool 薄封装及专属测试；现役算法/服务继续由真实调用方使用。
- Admin 删除示例工作台与 demo 登录绕过，默认真实用户管理，仅保留用户/配置两页。健康、OpenAPI、启动身份统一当前版本；容器隔离脚本按实际 Node 参数定位入口。
- 发布成功镜像记录只接受 roleImages，移除统一 image/imageId 旧记录回退。单 SHA 幂等的单终态是当前协议，继续校验且不伪造阶段进度。

外部解析 unknown 结果恢复、租约、取消、权限/归属校验及短期幂等是现役正确性机制，不是历史格式兼容，继续保留。明确 gated 的测试 provider/demo fixture 继续服务隔离测试，未启用真实付费调用。

## 数据库与发布边界

| 新迁移 | 内容与执行边界 |
| --- | --- |
| 0013_retire_processing_node_enabled | 去退役节点/assignment字段并替换 CHECK；最多 10,000 条受影响记录，超限拒绝。旧 writer 会被新约束拒绝，需先排空。 |
| 0014_folder_deletion_origin | Note/Folder 增加删除来源 UUID 与普通部分索引；不回填、不恢复未知历史对象。 |
| 0015_strict_runtime_configuration | 锁 singleton 配置，仅删除已审 $schemaVersion=1/退役下载键；未知键、未知版本拒绝，保留当前设置与权限。 |

本期 verify-db.sql 验证字段、索引、节点约束、退役键消失、当前配置键白名单、逐角色权限及 public 外键数量为 0。计划基准为已记录实际成功的 7ef993ee。仅准备清单，未提交/创建 PR、未安装宿主策略、未迁移共享库、未重启或发布。后续发布需核对目标最新成功 SHA、控制流程及旧角色排空，采用已审维护安排；不能把本地代码清理当成目标升级完成，也不通过恢复兼容分支获取自动发布资格。

[search-status.md](../runbooks/search-status.md)记录搜索确定需要、现有实现保留、产品细节待定。它不要求未来沿用当前API或排序策略。已有解析、入库、索引和正文/目录链路未被撤销。

## App 证据

只读 App HEAD fe6a02c12794029dba620ab7ffd85b1f464e4de8，工作树干净。核对 ../huahuo-ai/lib/core/network/api_client.dart（SHA256 1d6e8c03d4f1e78774e9c91f2f4282b363fbeae171e121a02bae4dd3881752d7）与 features/auth/data/http_auth_repository.dart（SHA256 d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5）；ApiClient 每次设置 JSON Content-Type，无 body 时不发送正文。当前 lib 未发现 WorkAiTaskInfo、contentLineId、defaultContentLine、旧 task/regenerate 或知识库查询消费。没有据此推定所有外部调用方都已适配；断开兼容已在本期 API/configuration 声明中保持 false。

## 前轮验证记录（需求澄清前）

最终源码验证：

| 检查 | 结果 |
| --- | --- |
| pnpm typecheck / lint / build | 通过；Admin 仍有现有 Ant Design use-client 提示及 844 KiB bundle 提示，未改警告阈值掩盖 |
| pnpm test | 85 文件、1,188 项通过；明确排除 .local 历史副本 |
| pnpm test:integration --milvus | 35 文件、475 项通过，无跳过；真实临时 PostgreSQL/Redis/Milvus，模型/解析/OSS 为替身 |
| 隔离升级演练 | schema 12→15，只应用 0013/0014/0015；重复迁移 applied=[]；逐角色权限/当前字段/普通索引/零外键通过 |
| Compose / git diff --check | 通过；没有启动业务栈或修改现有容器 |
| 执行过的 0001–0012 | 与 7ef993ee 对应 Git blob 逐字节一致 |
| 发布清单 | 当前清单解析通过；validateReleasePlan 按预期以 RELEASE_PLAN_INCOMPATIBLE 阻断；完整 CLI 因未提交工作区返回 RELEASE_PLAN_WORKTREE_DIRTY，未声称已完成提交级 release:check |

真实集成覆盖 205 来源/615 点（含微秒分页）、file/text 共查、跨用户与已撤销来源、全局 RRF 跨窗口排序（专项替身）、独立删除不复活、每 Note ETag/事件与新幂等范围、原图片/标题并发锁顺序、标签输入严格拒绝及新增迁移失败守卫。没有真实模型、短信、解析、OSS 调用。临时依赖/凭据已由归属检查后的清理器移除，没有删除数据卷。

本机原始测试日志保存在忽略目录 .local/debt-cleanup-20261117/，含首次集成失败与最终复验；不将替身通过、隔离依赖通过与测试服务器发布结果混为一谈。

管理 UI 类型与构建通过，Impeccable 静态检测无发现；浏览器 access host 不可用，尝试本机 fixture 预览未成功，不能声明视觉验收完成。临时预览服务已停止。

准备期间保留的失败事实：定向 Vitest 首轮误扫忽略目录 .local 的历史副本，正式命令排除后通过；新增路由测试首次使用裸 Fastify 缺统一错误响应，修复夹具后通过。真实集成首轮发现 Note 图片更新等待与标题更新的锁顺序回归，已改为普通 Note 共享树锁、文件夹结构写独占锁，保留原并发测试并在完整隔离复验中通过；不将首轮结果写成全绿。

## 搜索恢复后的最终验证

现有搜索实现已恢复，保留上轮历史债务清理。此前误删期间的配置清理与“无查询入口”文档已撤回；本地私密ENV中四个查询配置通过同项目原容器快照匹配现有Embedding地址、模型和凭据后恢复原值，未打印或轮换凭据。

恢复复核完成：165份生产源码与上一轮最终构建内嵌源码逐文件一致；原有0001–0012迁移逐字节一致。查询专属新回归用例因无原文备份，按原跨窗口排序/预算语义重建，单项和全量复验通过。

- 类型、Lint、Server/Admin构建、Compose、diff检查通过。
- 单元/契约：85文件、1,188项通过。
- 真实隔离PostgreSQL/Redis/Milvus：35文件、475项通过，无跳过；schema12→15、重复迁移为空。
- 未调用真实模型/短信/OSS/解析服务；临时依赖均清理，不删除数据卷。
- 现有搜索及上一轮正确性修复保留；不继续推定未来产品需求。具体边界已写入AGENTS和search-status文档，管理页面不增加规划性提示。
- 仍未提交、创建PR、操作共享库或发布测试环境。完整提交级release:check留到候选提交后执行；当前不兼容标志保持阻断。

恢复后的原始日志位于 .local/search-scope-reversal/，包含unit/integration/build/lint记录。
