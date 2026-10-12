# ADR 0004：P04 会员权益与额度账本

状态：accepted（开发政策；正式价格和支付仍未启用）

P04 使用 PostgreSQL 作为权益和用量权威账本。`billing_policies` 以 policy version 绑定规则；`account_memberships`、`credit_lots`、`usage_periods` 分开保存会员、月度/永久额度和周期用量；`credit_reservations`、`credit_reservation_lots`、`credit_ledger_entries` 记录预留、结算、释放及来源；`storage_reservations` 独立记录上传字节预留、确认和失败释放。所有 credit 使用 bigint，货币成本使用 currency + minor unit。

预留、结算、释放都在事务内锁定账户批次和 reservation 行。月度批次优先于永久批次，过期批次不参与新预留；唯一 `(user_id,reservation_key)` 使重试幂等，参数冲突返回 409。未知 provider measurement 写入 pending/uncovered，阻止新的收费任务，不能把未知成本当作 0。

当前 `credit-policy-v1` 仅是显式开发兼容 fixture（10,000,000 monthly credits），由 `BILLING_MODE=development` 开启。生产默认关闭 billing；在配置版本化 live policy 和支付事实前，不授予真实付费权益。
