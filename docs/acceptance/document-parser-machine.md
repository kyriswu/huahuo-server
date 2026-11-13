# 文档解析机运行库验收 · 2026-11-14

后续操作：同日 02:16 用户明确授权手动开机，已通过相同 ECS 适配器发送一次 StartInstance 并确认 Running，私网仍为 `172.18.102.101`，记录见 `.local/ecs-power/manual-start-result.json`。这不代表 Redis 协调/自动停机/真实解析已完成云端闭环；以下库验收的云只读结果为先前 01:34 快照。真实配置仍 disabled。

本轮实现可复用后端库，不推进 Pxx。目标是一台按需运行的文档解析 ECS，后续可以配置长期可用的 API，继续复用 Redis 去重和并发。真实解析客户端通过 callback 注入；本轮未新增或假设 App 解析合约，也未恢复 MinerU。

## 交付

- `src/lib/document-parser-machine/`：请求去重、FIFO 等待、全局 semaphore、owner 续期、未知结果保留、开停机串行及事件监视器。
- `src/integrations/ecs-power.ts`：官方 OpenAPI RPC 签名，固定 HTTPS、禁用自动重试，精确核对实例/地域/IP；优雅 StopCharging 与无本地盘初始化的启动。
- `src/config/document-parser-machine.ts`、`.env.document-parser.example`：disabled / ecs / always-on；地址、token、健康路径和并发独立配置，当前并发 1、空闲 60 秒。
- 既有 scheduler 接入 Redis Pub/Sub 唤醒和一次性空闲定时器，无每 5 秒解析机扫描。仅未完成状态每分钟兜底；确认节省停机后持久写入标记并取消所有兜底，重启也不继续轮询，下一次请求事件唤醒。
- `pnpm document-parser:machine status|configure-idle`：云侧只读状态工具，以及排空后原子切换 Redis 配置签名；不清除未知任务或去重回执。

调用方式与配置切换步骤见[手册](../runbooks/document-parser-machine.md)。库复用现有 ioredis/OpenAPI 依赖，无新增包或 Schema。

## 测试与实际边界

| 检查 | 实际结果 |
| --- | --- |
| Node / pnpm | 26.11.0 / 10.15.1 |
| typecheck / lint / build | 退出 0；Vite 保留既有 use-client/体积提示 |
| unit/contract | 375 通过；新增 29 个配置/RPC mock、9 个事件监视器虚拟时钟测试 |
| 隔离 PG/Redis/Milvus integration | 146 通过；新增 26 个真实 Redis/Lua/PubSub/本地 HTTP 测试，云接口均为替身 |
| Compose 静态展开 | worker/scheduler 共用模式/容量/空闲配置，四角色与一次性 migrate 保留，API/admin 无解析配置 |
| CLI disabled | 返回 `{"mode":"disabled"}`，不连接云/Redis |
| 真实 ECS | 仅 DescribeInstances 成功，未执行 StartInstance/StopInstance |

真实 Redis 覆盖两个客户端重复投递、fingerprint 冲突、并发 1/2 与 FIFO、在线复用/启动只发一次、就绪前不执行、空闲按完成时间计、到达与停机竞态、未知请求保留、失联 heartbeat 中断、Redis 断连/部分索引丢失、控制 owner 被替换、SDK 拒绝与超时对账、KeepCharging 不误报成功、配置切换保留回执、长期 API 不调用云，以及真实 Pub/Sub 再唤醒。

虚拟时钟测试覆盖 60 秒到期、期间无 5 秒扫描、1 分钟临时兜底、StopCharging 确认后连续 10 分钟/重启无定时器、新事件唤醒、遗漏完成通知、连接中断、异常退避、未知/阻断状态休眠和关闭清理。虚拟时间不是一次真实云停机试验。

测试中曾出现一次既有 `tasks.test.ts` 立即 claim 返回 null；未修改 TaskEngine，隔离复跑最终 146 项、无未处理异常通过。本轮测试库随机且独立，使用自有临时容器/tmpfs，结束后只清理本次资源。业务库、已有卷未清空，也未执行真实环境迁移；隔离迁移验收仍确认物理外键为 0。

证据在 Server `.local/ecs-power/`：`integration-events-verified.log`、`unit-events.log`、`typecheck-events-final.log`、`lint-events.log`、`build-events.log`、`compose-validation.json`、`target-inspection.json`。后续聚焦监视器复测与全量 typecheck/build 也为退出 0。

## 当前 ECS 只读结果

2026-11-14 01:34（北京时间）通过共享 RAM 凭据读取用户指定实例：`i-2zegwjwejyvpxoluhyx8`、cn-beijing、私网 `172.18.102.101`、VPC `vpc-2zervqxqgm7a38ryqkzm9`。规格 `ecs.gn7i-c16g1.4xlarge`（A10），PostPaid、VPC、报告本地盘数量/容量均 0、操作锁为空，状态 **Stopped + StopCharging**。此结果仅证明查询当时的状态与已知资格条件，不证明库已经完成过真实开停机闭环。8000 与 `/health` 为样本默认，未对停止实例进行 HTTP/解析验证。

真实 `.env` 未改、默认 disabled，业务容器未重启，App 只读。长期 API 地址未实际调用。云开停机及真实文档任务接线不属于本轮通过项。

## App 参照

`../huahuo-ai`，GIT_UNBORN、尚无 commit/remote。读取 `lib/core/network/api_endpoints.dart` 的 HUAHUO_SERVER/HUAHUO_AGENT（SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）与 `lib/features/auth/data/http_auth_repository.dart` 的 auth 请求及幂等 header（SHA256 `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`）。没有改动、格式化、构建 App；参照记录只写 Server。

官方依据：[ECS 节省停机](https://help.aliyun.com/zh/ecs/user-guide/economical-mode)、[StopInstance](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-stopinstance)、[StartInstance](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-startinstance)。
