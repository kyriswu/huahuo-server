# PostgreSQL 写入与记录增长优化（2026-11-18，本地候选）

承接[只读增长审查](pg-row-growth-20261118.md)，按用户要求只做有界底层优化，不增加分区、归档服务、缓存或业务保留期限。已有搜索技术实现保留，不据此确定或扩展搜索产品行为。此轮未连接共享数据库写入，未删除已有记录、修改私密 ENV、运行服务或部署。

## 本轮范围

| 位置 | 调整 | 边界 |
| --- | --- | --- |
| 默认 maintenance-check-v1 | 新增 0016，仅禁用每小时统计 failed 数量并写摘要的占位 schedule | 保留 schedule、历史 task/window 和通用调度；Worker 临时上传清理独立运行，不受影响 |
| Scheduler / BullMQ | 周期补投复用同任务最近的 sent outbox 及 jobId；队列终态 job 可重新入队 | 正常业务 retry、defer、callback、过期租约恢复仍使用原 enqueueIntent；保留 PG 租约与防重复结果，不依赖 Redis 判断任务成功 |
| Note 标签任务 | tagProvider 明确 disabled 时保存/编辑不建自动标签任务；显式提取在归属校验后返回现有 503 TAG_PROVIDER_UNAVAILABLE | 内容保存、手动标签、内容事件和索引照常；原成功幂等请求仍可重放，重新启用后新操作恢复调度，不自动批量回填 |
| KB chunk 规划 | 每批最多 256 条，批量查询可复用 point、批量插入元数据；ordinal→draft 使用 Map | pointId、重复 occurrence、权限、lease、事务、发布和清理语义不变；不合并不同 build 的历史记录 |

默认占位检查原来一次正常完成约新增 8 行，禁用后不再由它产生约 192 行/天的固定增长。未消费任务原来每 30 秒可能增加一条 sent outbox 和一个 Redis job；复用后，同一次业务投递的周期修复不再新增 outbox 行，也不向 waiting/active 队列重复加 job。任务真实重试和外部续跑仍会产生原有必要记录。重复更新仍产生 PostgreSQL MVCC 版本，不能把活行数稳定说成零写入。

513 个 Note chunk 的 mock 查询计数中，规划阶段复用查询和 INSERT 从 1,026 次降为 6 次；document-keyword INSERT 从 513 次降为 3 次。该计数不含事务、权限、发布等固定查询，不是线上耗时或吞吐压测。

## 数据库与发布

0016 是单个主键定位的配置 UPDATE；不删除历史、不新增权限、不新增表/索引或物理外键。已执行的 0001–0012 保持冻结，当前累计候选为 0013–0016。已更新 `scripts/release/plan.json`，沿用实际上次成功业务 SHA 为基准；先前清理候选兼容项仍为 false，不因本项优化放开自动发布。

共享库当前数据和已运行配置未应用本项修改，不能把本地完成声称为测试环境已生效。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 类型、ESLint、Server/Admin 构建、diff 空白检查 | 通过 |
| 单元/契约 | 87 文件、1,194 项通过 |
| 真实隔离 PostgreSQL/Redis/Milvus | 37 文件、483 项通过，无跳过 |
| 升级/权限/普通索引/零外键验收 | schema 12→16，只应用 0013–0016；重复执行 applied=[]；迁移及四角色验收通过 |
| 发布清单 | 解析通过，包含 0013–0016；自动发布仍按既有 false 声明返回 RELEASE_PLAN_INCOMPATIBLE；工作区尚未提交，不声称完成候选提交审查 |

新增用例实际覆盖：513 条跨三批的 point 身份与复用、keyword 无模型、部分批失败回滚、lease 和续跑；禁用/启用标签及成功 key 重放；默认维护迁移只停指定 schedule 并保留历史/自定义 schedule。真实 PG/Redis 的投递测试验证双 Scheduler 连续五轮仅一行 Outbox/一个 Redis job，completed/failed（attempts=1）重新入队后真实取出并产生唯一 PG 结果，active/delayed 保留、丢失 job 重建、显式/自动 retry 与 external continuation 仍建立新意图。原发送后未确认崩溃、Worker drain 与租约恢复回归也通过。

日志位于忽略目录 `.local/pg-growth-optimization-20261118/`：`typecheck.log`、`lint.log`、`build.log`、`unit.log`、`integration.log`。真实的是本机临时 PG/Redis/Milvus，模型/解析/OSS/云控制仍使用隔离替身；不是实际测试服务器、真实付费供应商或线上并发压测。临时容器与凭据已由运行器按所有权清理，没有删除数据卷。

## 保留的边界

任务历史、退役 KB 元数据、幂等响应、OTP/refresh/session、审计和内容事件仍需分别定义恢复/安全/业务保留窗口，本轮不自行删除。解析轮询的持久化记录也维持原恢复机制。后续可在用途和期限明确后，使用已有角色、索引和短事务分批回收，避免提前设计新组件。

只读核对实际 App 的 `lib/core/network/api_endpoints.dart`、`lib/features/home/presentation/home_asset_cards.dart`：当前本地素材展示不能作为自动标签、搜索或保留期产品需求。App 未修改、未运行生成/构建命令。
