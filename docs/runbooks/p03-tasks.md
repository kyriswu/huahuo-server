# P03 持久任务运行手册

P03 使用 `tasks`、`task_attempts`、`task_outbox`、`task_results`、`task_events` 和 `task_schedule_windows` 作为 PostgreSQL 权威记录。Redis/BullMQ 只保存投递 job，payload 只有 `taskId`。Scheduler 是唯一 Outbox 投递入口；Worker 只消费队列并以 attempt/version/lease CAS 写结果。

本地完成迁移后启动：

```bash
BACKEND_IMAGE=huahuo-server:p03 docker compose --env-file .env up -d --no-deps --force-recreate migrate
docker compose --env-file .env wait migrate
BACKEND_IMAGE=huahuo-server:p03 docker compose --env-file .env up -d --no-build
```

四个队列固定为 `content`、`ai`、`commercial`、`maintenance`。`WORKER_QUEUES` 可限制 Worker 消费范围；默认并发分别为 2、1、1、1。生产不启用 `ENABLE_DEMO_TASKS`。`POST /api/v1/tasks/demo` 只在开发/测试显式启用，用于验证真实 PG result，不代表 AI/ASR 成功。

Scheduler 使用独立的 `tasks/publisher.ts` 发布队列任务，不导入 Worker 执行器及解析/检索依赖；Worker 消费、任务载荷与投递保留策略不变。Worker/Scheduler 的 Docker 健康检查在启动宽限期内每5秒运行，稳定后每30秒运行，仍检查完整的 `/health/ready`。连续4次失败才标记不健康，通常需约90—120秒再加探针耗时，恢复最多等待一个30秒探测间隔；这不改变1秒任务扫描、租约续期、补投或退出预算。API/Admin仍每5秒检查。`start_interval` 需要 Docker Engine ≥25、Compose ≥2.20.2；实际资源对比与验证边界见[空闲资源优化验收](../acceptance/background-idle-resources.md)。

每轮Scheduler清理/扫描/派单共用一份运行配置快照，配置变化从下一轮生效；读取失败时停止本轮并按原间隔重试，不退回默认策略继续派单。新任务在INSERT时保存执行次数上限，`enqueueIntent`仅写Outbox，补投不改写旧任务上限。配置语义与开销见[运行配置](runtime-configuration.md)，本轮验证见[Scheduler配置验收](../acceptance/scheduler-runtime-configuration.md)。

用户任务接口：

- `GET /api/v1/tasks/{taskId}`、`GET /api/v1/tasks/running`
- `GET /api/v1/tasks/{taskId}/events?afterSequence=0&limit=100`
- `GET /api/v1/tasks/{taskId}/result`
- `POST /api/v1/tasks/{taskId}/cancel`
- `POST /api/v1/tasks/{taskId}/retry`（仅无外部提交、可重试失败）

所有写操作使用幂等键；用户范围由 Bearer session 派生，不能通过 body 或 header 指定 userId。`regenerate` 在 P09 业务策略接入前明确返回 `REGENERATION_NOT_AVAILABLE`。

任务与其他 API 共用 `src/lib/idempotency.ts` / `api_idempotency`，不再单独保存任务请求幂等表。响应使用既有用户或管理员服务端密钥加密，默认有效期 24 小时；过期 key 返回 `IDEMPOTENCY_KEY_EXPIRED`，请求内容冲突返回 `IDEMPOTENCY_CONFLICT`。认证和资源权限验证仍先于重放；过期记录尚无自动物理回收任务。

恢复规则：Worker 租约过期后 Scheduler 将本地任务重新排队；有 `external_state=unknown/submitted` 的任务只进入 `reconciling`，不自动重新调用外部服务。Redis 重启或 job 丢失由 PG 中 pending/sent 时间窗对账补投。旧 attempt 的完成写入若 version/owner/lease 不匹配会被拒绝。

任务终态统一由`tasks/lifecycle.ts`更新状态、版本、租约与事件；该模块不包含计价或扣费规则。Worker在获得行锁后以数据库实时时钟检查租约，过期续租、迟到结果与外部提交意图均被拒绝。Scheduler每轮最多恢复50条，逐任务短事务提交，使用`SKIP LOCKED`支持多实例；异常任务保留原状态，后续任务继续，Outbox修复/派单继续。扫描游标仅在内存中优化轮转，重启后从数据库重新扫描，不承担持久状态。

恢复时的领域一致性错误会记录任务ID/错误码，并计入`task_recovery_failures_total`；指标通过现有抓取入口暴露，无需新增Prometheus目标。数据库连接等基础设施故障仍使扫描报错，已提交的其他任务不撤销。此前持有整批锁的恢复逻辑已改为逐条提交：增加少量事务往返，缩短单个任务的锁持有时间，不将其宣称为QPS压测结论。

额度预留：本地任务确定失败或取消时，与任务终态同事务释放，重复恢复不重复归还。自动重试保留原预留；手动重试在重新预留成功后才排队。外部结果未知继续保留预留，不能仅按超时释放；解析服务确认取消后才结束预留。Admin保持财务只读，有预留任务的手动重试须经具备计费准入能力的用户API，详情见[验收与权限迁移](../acceptance/task-reservation-recovery.md)。

以下验收命令仅用于独立本地测试栈，当前 API 使用云 PG 时会拒绝执行；不能用旧配置将业务栈切回本地：

```bash
node scripts/verify.mjs
node scripts/e2e-p03.mjs
node scripts/container-isolation.mjs
node scripts/app-reference.mjs --diff
```

P03 未接入真实 AI、ASR、支付、通知或 Agent Run SSE；App 的 Agent Run 事件端点留 P08，定位 AI 结果留 P09。未运行 Flutter/Dart 或真机联调。
