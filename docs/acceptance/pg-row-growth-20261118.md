# PostgreSQL 记录增长只读审查（2026-11-18）

范围：当前 Server 工作区源码与 .env 对应的既有共享开发/测试数据库。仅目录、计数、状态与日期聚合，不读取正文/凭据/个人标识，不调用短信、模型、解析、OSS或云控制面。数据库会话明确 BEGIN READ ONLY，单SQL4秒上限，无迁移、删除、VACUUM、部署或业务配置修改。

## 当前实测

2026-11-18 10:18–10:21 Asia/Shanghai，目标schema_version=12；本地候选0013–0015未应用。public共61表，pg_stat_user_tables活行估计1,936，含索引/TOAST约3.63MiB。统计估计不等于COUNT结果，累计insert/update计数没有可靠stats_reset日期，不能换算为每小时增长。

| 表/组件 | 精确行数 | 补充聚合 |
| --- | ---: | --- |
| task_events | 645 | 603行属于maintenance.check |
| task_outbox | 223 | 全部sent且对应任务succeeded；6个任务有多次outbox，最多5条，共18条超出一任务一投递 |
| task_attempts | 220 | 201行属于maintenance.check |
| tasks | 205 | maintenance.check成功201、processing.node-start成功4，无当前queued积压 |
| task_results | 205 | maintenance.check结果201 |
| task_schedule_windows | 201 | 近多个完整自然日均24次maintenance任务 |
| admin_audit_events | 65 | 管理登录与读取用户列表等追加审计 |
| refresh_tokens | 51 | 40 consumed、0 expired；不能将consumed直接当可删 |
| otp_requests | 16 | 失效不等于物理回收 |
| api_idempotency | 11 | 全为auth.sign-in，11行均已过期，密文合计15,688字节 |
| user_sessions / user_audit_events | 各11 | 当前session最终expires_at/revoked_at条件下尚无失效行 |
| processing_node_assignments | 4 | 完成仅标settled |
| notes / note_parts / resources / resource_refs相关资产、文件、KB build/chunk | 已核对的主要源表和索引表均0 | 尚不足以代表真实用户业务负载 |

任务组（tasks、inputs、attempts、events、outbox、results、windows）当前精确共1,699行。重点是未来操作的放大关系与保留策略，当前没有容量紧迫性。不以现有空表推断功能不会增长，也不把共享库当独立测试库。

## 增长优先级与写入来源

### 1. 任务/投递历史：已有持续增长，故障时会放大

[src/modules/tasks/scheduler.ts:68](../../src/modules/tasks/scheduler.ts) 默认每小时创建maintenance任务；[engine.ts:155](../../src/modules/tasks/engine.ts)只统计failed任务数并保存摘要，不清理任何表。正常一次增加task、attempt、result、outbox、window各1与event3，共8行：约192行/天、70,080行/年。实际201次对应603个event，符合源码模型。

普通有input任务一次成功增加8行：task/input/attempt/result/outbox各1、event3；无input少1行。重试/续跑另计。所有这些PG历史目前无统一物理回收，BullMQ的成功1小时/失败24小时保留只针对Redis（publisher.ts:24）。

[scheduler.ts:59–66](../../src/modules/tasks/scheduler.ts)对已sent超过默认30秒、尚未消费的任务补投；[model.ts:31–38](../../src/modules/tasks/model.ts)仅合并pending/delivering，sent保留。Redis可接受但Worker持续不消费时，单个滞留任务理论约新增2,880条outbox/天，且publisher以outbox的delivery.id为jobId，Redis也可能积压多个待执行job。Redis整体不可用时主要更新同条pending，不是同速增行。当前库无滞留任务，此项是代码路径风险，未做故障压测或主动停止Worker。

建议先评估无实际业务作用的周期检查能否复用现有健康/监控；对持续未消费的补投采用有界退避与积压告警，保留可靠投递和租约防重。终态任务应整体制定历史保留与关联清理，不只删tasks父行。

### 2. 解析等待：把重复检查变成持久化明细

[engine.ts:22–32,71–86](../../src/modules/tasks/engine.ts)每次claim增加attempt+running event，每次defer增加waiting event和outbox，通常每轮4行。入场/启动等待常为3秒，连续等待一小时理论约4,800行；外部提交后的补偿回查默认60秒，约240行/小时。实际受调度/执行耗时影响，属于模型估计；回调可提前唤醒。resume_count抵扣正常尝试预算，不能按maxAttempts=3估算最多3行。

建议在不削弱unknown结果恢复、取消和租约的前提下，优先延长长等待阶段的检查间隔、对同状态事件去重，区分业务失败尝试与轮询续跑的详细留存；保留当前状态及最终结果，不把每次进程接力都永久保存成同等价值历史。

### 3. KB build/chunk：正文改动次数 × 每版分段数

[kb/jobs.ts:51–64](../../src/modules/kb/jobs.ts)为每个构建保存完整chunk元数据，即使Milvus point复用，PG仍新增该build下的一行。旧版本发布为superseded；[cleanupLocked:101–109](../../src/modules/kb/jobs.ts)仅删除不再使用的Milvus点并标cleanup_status=ready，不删PG build/chunk。当前正文只一份，不代表派生索引历史只有一份。

设C为实际分段数、V为构建次数，历史大约V+ΣCᵥ。5万码点Note按现有500码点上限、重叠/段落规则通常会产生百级分段；这不是固定数量。多次修改会重复生成相应元数据。源码当前开启索引后的Note raw变更，同时有标签与索引两个任务，单看任务+content_job+build+chunks正常约18+C行（不含Note/幂等/标签等）；仅标题等有效修改也会产生标签任务。

建议回收已退役、cleanup_status=ready、无在途任务/目录读取/恢复引用的PG派生元数据，保留当前published构建及必要在途构建。不能直接按“非published”全部删，因为pending构建和共享point复用仍依赖它们。现有业务细节尤其搜索仍待定，此处只治理已存在索引生命周期，不扩展搜索能力。

### 4. api_idempotency：行数追加，且响应可能很大

[lib/idempotency.ts:10–24](../../src/lib/idempotency.ts)每个新(scope,operation,key)新增一行；默认24小时、登录5分钟只是重放有效期。过期仍存在并返回409，不会自动删除。新key即使业务无变化仍可能新增幂等结果。

[assets/service.ts:41,183–196,224–236](../../src/modules/assets/service.ts)缓存完整noteDto，包含raw/outline/germination正文与refs；改标题也保存完整响应密文。这是正文当前值之外的隐藏历史载荷。当前库仅有登录回执，尚未出现Note密文积累，不能说已发生大量正文历史。

建议先回收过期大响应、保留轻量失效凭据；若要限制行数，必须明确旧key保留/复用规则。直接DELETE会使原本应409的旧key重新执行，不是透明存储优化。

### 5. 身份、限流与审计：每次使用追加且无TTL删除

- 验证码：每新请求otp1，5分钟后失效但留行。
- 普通登录：session1+refresh1+agreement1+audit1；带key再加idem1；首登另增user/identity/workspace。
- 每次refresh：新refresh1，旧token标consumed，session只UPDATE。若1,000个活跃会话每天活跃8小时、每15分钟刷新一次，场景估算为32,000条refresh/天，不是当前实测速率。
- consumed refresh在活跃会话期仍用于重用检测，不应提早删除；按会话最终过期/撤销和恢复窗口设计清理。
- Admin每次登录/失败登录、每页用户列表读取追加audit。用户内容变更追加content_events，文件夹级联按受影响对象放大；目前没有内容事件增量读取接口或历史回收。
- 限流表按key UPSERT，重复同key不加行，但不同IP/手机号/用户名会形成高基数；需对过期窗口回收。

建议OTP/会话/限流分别确定安全窗口；审计和内容事件分别确定用途/保留要求，不套统一7天或30天。账本和协议接受事实另行定义，不按短期日志处理。

### 6. 资源、正文及其他状态表：区分存量与历史

note_parts当前最多3个part/Note，按(note_id,part)覆盖；note_tags/resource_refs等维护当前关系，不能当作每次编辑都永久追加。Note/Folder软删除保留正文与引用用于恢复，没有最终purge。未确定回收站业务前不删除它们。

新资源认领增加resources1+storage_reservations1及引用；最后引用移除已通过storage.delete删除resources，但reservation只标released保留。expires_at来自临时上传回执，不等于永久资源的删除期限。临时上传本身只在Redis/OSS，PG0行。

processing_node_assignments按新requestId增加，重复request续跑复用；document_parse_callbacks按submission增加，consume主要置consumed并清结果；它们的去重/重试身份仍需留到恢复窗口结束。callbacks还需评估已消费后晚到终态回调重新写入大result的路径。

runtime_configuration、processing_nodes、workspace_content_state等主要覆盖更新；provider_usage_measurements/run_usage当前无生产写入方，不能按未来付费调用量估算现有增长。Fastify日志、进程Prometheus指标、可选OTLP Trace不写这些PG表。

## 优化落地顺序

1. 优先减少无意义写入：维护检查fixture的必要性、禁用标签provider时仍建必败任务、未消费补投放大、重复删除又建cleanup任务。
2. 优先回收有明确生命周期的派生数据：安全窗口外的凭据、已确认清理完的退役KB元数据、已完成任务的明细。先定义不变量和保留时间，再按索引分批短事务清理。
3. 减小幂等大载荷，保留拒绝旧key重做的语义；行数和字节数分别治理。
4. 审计/内容事件/回收站/账本单独制定保留规则，不自行猜用户业务期限。
5. 当前规模暂不需要分区或分库；先补准确行数/每日净增/占用与滞留告警，再依实际规模评估。现有运行角色大多没有历史表DELETE权限；若实施，新增编号迁移授予所属清理角色所需的最小权限，不新增物理外键或依赖级联。

上述是具体推荐，没有执行数据清理或擅自确定保留期限。未修改应用、Schema、ENV或运行服务，也没有运行集成测试来冒充目标业务验证。本次证据为真实库有界只读聚合+源码模型。

## 统计与空间的边界

记录数、写入次数和死行应分别看。例：user_sessions真实11行，但统计累计UPDATE为2,533次；不是增加了2,533个session。更新旧版本由autovacuum治理，业务已过期/已软删的行仍是活行，autovacuum不会按业务日期删除它们。[PG统计](https://www.postgresql.org/docs/17/monitoring-stats.html)、[PG维护](https://www.postgresql.org/docs/17/routine-vacuuming.html)。

未执行VACUUM FULL；它重写表并需要强锁，不适合作为当前行数增长的处理方案。普通VACUUM主要回收死版本供复用，不等于历史记录保留策略。

原始脱敏统计保存在忽略目录 .local/pg-growth-audit-20261118/：initial-stats.json、exact-small-table-counts.json、followup-aggregates.json。首次refresh统计误用了used_at，在只读事务SAVEPOINT回滚后按当前consumed_at复查，最终51/40/0如上；未写数据库。没有读取归档schema或其他实例。
