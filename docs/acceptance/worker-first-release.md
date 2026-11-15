# 共享队列与 Worker 优先交接验收（2026-11-15）

结论：采用现有共享持久队列，按 Worker → Scheduler → API 的顺序交接。应用侧回归通过；本轮只补充验证和应用契约，未修改生产业务逻辑、Schema、实际环境或宿主入口，也未执行服务器发布。

## 已确认的范围

API、Worker、Scheduler 同机成组部署，水平扩展时增加部署组，Admin 可独立部署。部署组表示容器的放置方式，任务不绑定 API 实例、宿主机或发布版本。复用已有暂停、有限退出、PG 租约和 Outbox，不增加组内队列、任务搬迁、版本能力路由或新的发布控制器。正常更新以数据库和任务载荷向后兼容为前提。

新 Worker 就绪后，先让共享队列的全部旧 Worker 停止领取，保留其正在执行的本地步骤；随后更新 Scheduler，最后交接 API。多服务器时也先完成全部消费端的这一步，再让任何 API 或 Scheduler 产生新增任务类型。应用契约见 [按角色部署](../runbooks/role-deployment.md#worker-优先的应用交接顺序)。

用户指定由宿主入口配合请求交接；其配置、脚本和操作文档继续由宿主机独立管理，不进入本仓库。Admin 试跑可中断并重新发起，不作为交接完成条件。

## 本轮验证

`tests/integration/release-drain.test.ts` 增加一个回归用例：真实隔离 PG/Redis/BullMQ、分角色数据库权限、两个旧 Worker 和一个新 Worker，以及两个独立 Fastify API 实例。API 经过真实 JWT、运行配置和业务路由，HTTP 使用 Fastify inject；不是外部入口或真实两版镜像测试。

- 旧 API 先受理任务并返回，任务持久保存在 PG，之后由新 Worker 处理。
- 新 Worker 运行后，两个旧 Worker 都进入停止领取状态。
- 实际运行 TaskScheduler 的恢复、时间窗、Outbox 领取、投递及确认流程；新 Worker 处理更新前积压任务。
- 旧 API draining 后 ready 为 503、live 为 200；仍被路由过来的合法业务请求继续返回 200，并由新 Worker 处理任务。
- 新 API 接受请求；三条任务的唯一 attempt 均属于新 Worker，三个结果只各存一份。原 JWT、跨 API 幂等重放和结果读取保持有效。

既有 11 秒工作排空用例同时通过：旧 Worker 排空时持续续租并完成原工作，新 Worker 处理另一任务，两个任务各一次 attempt。

首两次新增用例因 fixture 只手工投递、没有执行 Scheduler 及 Outbox 确认而超时。诊断记录显示：一条 Redis 投递 completed，PG 任务仍 queued/attempt 0，持久意图尚为 pending。这是暂停与预取并发时已有补偿路径所覆盖的窗口，不能用缺少 Scheduler 的 fixture 证明恢复通过或失败。最终用例运行真实 Scheduler 路径后通过；仅 fixture 的补投观察间隔缩为 50 ms，生产仍是默认 30000 ms，不能声称生产所有交接任务都立即开始。本轮没有修改生产暂停或补投算法。两次失败日志和诊断保留在 `.local/worker-first-release/`。

暂停仅作用于指定 Worker，保留正在执行的工作，关闭等待其收尾，与 [BullMQ 暂停说明](https://docs.bullmq.io/guide/workers/pausing-queues)及[关闭说明](https://docs.bullmq.io/guide/workers/graceful-shutdown)一致。

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test:integration` | 18 文件，243 通过，1 项真实 Milvus 跳过，exit 0 |
| 新增交接用例 | 474 ms；全量耗时约 38 秒，含原 11 秒排空用例 |

全量数量包含工作区其他改动，本轮新增一项。未改生产实现或 UI，不重复运行 unit/contract 和构建，也不将上一轮结果计作本轮证据。完整输出和执行记录见 `.local/worker-first-release/integration.log`、`verification.json`。

## 真实 App 与环境边界

只读核对 `../huahuo-ai/lib/core/network/api_endpoints.dart` 与 `lib/features/auth/data/http_auth_repository.dart`，既有 Base URL、鉴权和请求协议保持；SHA-256 分别为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。未写 App 或运行 Flutter，未验证 App 的长连接重连。

测试使用本机 owner 标记的临时 tmpfs PG/Redis，已由执行器清理；未写业务数据库、实际 ENV、凭据、已有卷或云资源。历史镜像初始化校验冲突、跨版本回退和真实跨服务器容量仍沿用 [容器演练](release-rehearsal.md)的未验收边界；本轮未消除该历史校验冲突，也未绕过迁移校验。停止在本专项验收点，不推进 Pxx。
