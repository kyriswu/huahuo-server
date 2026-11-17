# 用户资源、不可变文件与当前笔记验收

2026-11-17，测试发布候选，尚未部署。并行窗口已完成，本轮已固定全仓工作并复核；main 控制 PR #25 待 owner 合并后继续首次维护交接。

## 已实现的边界

- `resources` 只归用户。移除 `workspace_id`、重复的 `upload_id`、业务 `processing_status` 和软删除时间 `deleted_at`，保留 13 个用户/文件基础字段及引用次数，具体字段见资源说明。工作区留在业务对象及 `resource_refs`，头像不需要工作区。
- 文件不可覆盖，没有业务版本。按用户最终决定取消内容去重，删除 MD5 入参、签名要求、字段和内容唯一索引；App 不计算文件摘要。`sha256` 可空备用，新上传不填写。每次独立上传生成新 UUID，即使字节完全一致也不合并；同一资源 ID 可在自己多个工作区的业务对象中引用，跨用户拒绝。
- 申请带 X-Idempotency-Key，同用户同键/同元数据在临时回执存在期间复用该次上传；元数据冲突拒绝。已完成的同次上传重试返回 uploadRequired=false，避免重复 PUT/complete；不同键仍是新上传。这只处理请求重试，内部摘要仅计算元数据，不读取文件。
- 上传阶段仅 Redis，首次申请起 24 小时，不计正式容量、不读取余额，不增加临时数量/总量限制。业务首次使用才在事务内校验正式额度、登记文件、空间及引用；成功提交后尽力清 Redis。失败回滚保留临时回执；清 Redis 失败不会多算容量，清理只查中央资源表，已登记文件不删 OSS。
- `reference_count` 与实际 `resource_refs` 同事务变更，以不同业务对象计数：一篇 Note 重复使用同一资源 ID 仍计一次，跨两个业务对象计两次。重复保存不多算，解除引用减一，回滚恢复；最后一个引用解除时，同一事务标记 deleting 并创建原 storage.delete 任务，无额外保留期，也不要求客户端再调删除。Worker 删除 OSS 后，同事务硬删资源行、释放占用、记录原任务的完成回执；失败按现有任务规则重试。事务回滚撤销任务，执行重放不重复调用 OSS 或扣减空间。
- Note 每个部分只保留一行 `note_parts` 当前正文。当前修订字段和 ETag 保留作并发/异步防旧写标记，不保留正文历史和历史图片 pin。GET part 不接受历史修订 query，PUT 不接收 `basePartRevisionId`，仍必须 If-Match；其他当前业务引用和软删除/恢复语义保留。

每次上传沿用 `uploadId=resourceId=Object Key UUID`，不复制或移动对象。OSS versionId/ETag 仅作为精确读删定位，不构成业务版本或文件历史 API。上传、业务认领、引用维护和物理删除各有现成职责，不引入新组件、事件总线、跨库事务、分区或缓存平台；已有按资源/业务对象索引及新增用户文件索引支持查询，未做千万行压测。

实现见 [上传](../../src/modules/storage/service.ts)、[临时记录](../../src/modules/storage/temporary-uploads.ts)、[认领](../../src/modules/storage/resource-claims.ts)、[引用维护](../../src/modules/storage/references.ts)、[当前 Note](../../src/modules/assets/service.ts)；客户端协议见[资源说明](../runbooks/user-storage-layout.md)。

## 数据变更与交接

冻结的 0001–0003 不改 checksum。新增 0009 删除两个退役下载配置键；0010 保留每个 Note/part 的最新正文，移除历史图片 pin，改为当前内容主键；0011 移除资源业务归属/软删除字段，从真实引用初始化计数并建立用户明细索引。原 storage_jobs 增加 completed_at 作为硬删除完成回执，只给 Worker 资源 DELETE 和回执列 UPDATE 权限；仅 storage.delete 允许用户级任务不带工作区，其他业务任务仍强制工作区。资源生命周期只允许 ready/deleting；引用缺少资源、跨用户或有其他生命周期遗留时，迁移在改结构前失败。没有物理外键、数据库级联或触发器关系维护。

目标只读预检记录为 2 用户、184 个已完成任务、零资源/上传会话/容量记录/资源引用/Note 正文，无未完成任务或锁等待。这个规模支持有预算的迁移内处理；不是对未来大表随迁移回填的承诺。没有执行共享库迁移、清库或 OSS 删除。应用四角色必须先排空旧写入再执行不兼容 DDL，不能用旧镜像混跑；发布清单的兼容项保持 false，没有增加临时自动放行路径。

## 本地验证与证据区分

- Node 26.11.0 / pnpm 10.15.1；全仓 typecheck、Lint、Server/Admin 构建通过。
- 1163 项单元/契约通过（81 文件）。此处使用必要替身，不作为真实 OSS 或模型服务证明。
- 定向 111 项集成通过（8 文件）：真实隔离 PostgreSQL/Redis，OSS 为本地替身；覆盖同 ID 跨工作区引用、跨用户拒绝、相同内容独立上传、并发/重复关联、计数/任务回滚、零引用自动删除、云删除失败重试、硬删除后进程中断重放、同 ID 空间只计一次、一天有效期及临时清理。
- 同轮隔离升级从目标 schema 3 顺序应用 0004–0011；重复迁移为空，四角色只读断言通过，业务 Schema 物理外键为 0。迁移用例额外验证当前正文保留、历史 pin 移除、计数初始化、Worker 硬删除权限、用户级删除任务/其他任务归属边界与跨用户损坏拒绝。
- 最终规则下全量 462 项集成通过（32 文件、无跳过）：真实隔离 PostgreSQL/Redis/Milvus，OSS/解析/模型仍是本地替身。此为本轮工作区测试快照，加入大写 UUID 头像校验/计数回归；新修改仍需重新验证。

日志保留在 `.local/release-all-20261117/`：`typecheck-resource-final.log`、`lint-resource-final.log`、`build-resource-final.log`、`unit-resource-final.log`、`integration-no-dedup.log`、`integration-resource-final.log`；隔离脚本仅清理自身带标记临时容器，不删除已有数据卷。

取消内容去重前的 MD5 草案曾通过 1168 项单元/461 项集成，仅作历史记录，不代表最终规则。首次接入用户级自动删除时发现 tasks_check 仍强制工作区，已在 0011 限定仅放开 storage.delete，定向 111 项复测通过，失败日志 integration-zero-reference.log 保留。

首次扩大测试时曾误扫 `.local` 的历史候选，触发旧表/旧依赖失败；当前源码当轮 110 项已通过，修正筛选后完整定向复验通过。早期全仓测试还遇到并行窗口的半成品 HTTP 代码、旧上传 fixture 和缺失 MD5，失败记录 `integration-resource*.log`、`unit-resource.log` 及 `typecheck-resource.log` 保留，不覆盖成成功。

## 未验范围

真实 OSS 上传、Bucket CORS/分片生命周期配置、移动端上传/进度/断网恢复未联调；未调用付费模型、短信或真实解析服务。App 仅只读核对，未修改、运行或构建；其当前 `lib` 无上传 HTTP、uploadRequired/contentMd5 或 Note 历史正文消费者。Redis 持久化/noeviction 的灾难性丢失仍可能留下 OSS 孤儿文件，不凭 Redis 缺失自动删云对象，未新增全桶对账平台。

未调整扣费政策、检索业务或其他仓库。当前测试通过不等于已部署；用户已确认并行窗口结束；继续准备测试发布，main 控制 PR #25 仍由 owner 合并。不兼容维护前不得变更旧服务或执行共享库迁移。

发布前复核补充：资源引用 ID 统一转小写，避免大写 UUID 绕过头像 MIME 校验或重复关联误判。全量复验首次 461/462，失败为任务 fixture 默认 available_at 在时间边界下尚不可执行；将该立即执行 fixture 的 available_at 显式设为数据库过去时间，不改业务调度逻辑和断言，最终 462/462 通过。证据 integration-fixed-candidate.log / integration-fixed-candidate-final.log 保留；最终类型、Lint、构建、1163 单元/契约均通过。
