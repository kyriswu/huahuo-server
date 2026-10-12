# ADR 0003 — 持久任务、Outbox 与 Worker 租约

状态：P03 实施。App 参照 commit `20f61b78887f9288d1fd3227f326e6374d516f27`；其 task detail/retry 与 Agent Run event cursor 证据见 `docs/app-reference.md`。

任务受理在 PostgreSQL 单事务内写入输入引用、task、首个事件和 outbox。Redis/BullMQ 只保存 taskId 和 delivery job id，不能作为任务账本或结果存储。Scheduler 独占 Outbox 领取、租约、投递与 PG 对账；多个 Scheduler 由 `task_schedule_windows` 和行锁去重。

Worker claim 时递增 attempt/version 并写 lease；结果提交必须匹配 taskId、attempt、version、owner 与未过期 lease，迟到 Worker 返回 false。任务含 `external_state`；unknown/submitted 只可进入 reconciling，禁止自动重新调用不确定的外部副作用。Redis 丢失时 PG pending/sent 时间窗负责安全补投，succeeded 任务无 outbox 重放。

P03 的 `demo.digest` 读取真实 PG 输入并写入唯一 task_results，用来证明恢复和 CAS；它不是 AI/ASR/支付模拟成功。Agent Run/SSE 领域协议保留到 P08，真实 provider 任务留对应阶段。
