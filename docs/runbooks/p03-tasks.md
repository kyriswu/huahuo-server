# P03 持久任务运行手册

P03 使用 `tasks`、`task_attempts`、`task_outbox`、`task_results`、`task_events` 和 `task_schedule_windows` 作为 PostgreSQL 权威记录。Redis/BullMQ 只保存投递 job，payload 只有 `taskId`。Scheduler 是唯一 Outbox 投递入口；Worker 只消费队列并以 attempt/version/lease CAS 写结果。

本地完成迁移后启动：

```bash
BACKEND_IMAGE=huahuo-server:p03 docker compose --env-file .env.compose.local up -d --no-deps --force-recreate migrate
docker compose --env-file .env.compose.local wait migrate
BACKEND_IMAGE=huahuo-server:p03 docker compose --env-file .env.compose.local up -d --no-build
```

四个队列固定为 `content`、`ai`、`commercial`、`maintenance`。`WORKER_QUEUES` 可限制 Worker 消费范围；默认并发分别为 2、1、1、1。生产不启用 `ENABLE_DEMO_TASKS`。`POST /api/v1/tasks/demo` 只在开发/测试显式启用，用于验证真实 PG result，不代表 AI/ASR 成功。

用户任务接口：

- `GET /api/v1/tasks/{taskId}`、`GET /api/v1/tasks/running`
- `GET /api/v1/tasks/{taskId}/events?afterSequence=0&limit=100`
- `GET /api/v1/tasks/{taskId}/result`
- `POST /api/v1/tasks/{taskId}/cancel`
- `POST /api/v1/tasks/{taskId}/retry`（仅无外部提交、可重试失败）

所有写操作使用幂等键；用户范围由 Bearer session 派生，不能通过 body 或 header 指定 userId。`regenerate` 在 P09 业务策略接入前明确返回 `REGENERATION_NOT_AVAILABLE`。

恢复规则：Worker 租约过期后 Scheduler 将本地任务重新排队；有 `external_state=unknown/submitted` 的任务只进入 `reconciling`，不自动重新调用外部服务。Redis 重启或 job 丢失由 PG 中 pending/sent 时间窗对账补投。旧 attempt 的完成写入若 version/owner/lease 不匹配会被拒绝。

验收命令：

```bash
node scripts/verify.mjs
node scripts/e2e-p03.mjs
node scripts/container-isolation.mjs
node scripts/app-reference.mjs --diff
```

P03 未接入真实 AI、ASR、支付、通知或 Agent Run SSE；App 的 Agent Run 事件端点留 P08，定位 AI 结果留 P09。未运行 Flutter/Dart 或真机联调。
