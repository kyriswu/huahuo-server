# 阶段进度

| 阶段 | 状态 | 代码与迁移 | 验证 | 下一步 |
|---|---|---|---|---|
| P01 | 本地验证通过 | 工程/四角色/0001_p01.sql | 健康、角色隔离、真实 PG/Redis | 已完成 |
| P02 | 本地验证通过 | identity、workspaces、admin；0002_p02_identity.sql | 类型/lint/build；12 unit、8 contract、25 integration；真实 HTTP 与容器隔离通过 | 已完成 |
| P03 | 本地验证通过 | tasks/outbox/attempts/results/events/schedules；0003_p03_tasks.sql；BullMQ content/ai/commercial/maintenance | 14 unit、8 contract、34 real PG/Redis integration；真实 HTTP Worker/Scheduler、容器故障恢复通过 | 已完成 |
| P04 | 本地验证通过 | billing policy、membership、credit lots/reservations/ledger、provider measurements、run usage、storage reservations；0004/0005 P04 migrations；任务准入/结算 | 23 unit/contract、40 real PG/Redis integration；真实 HTTP 会员/credits/home、demo task 预留与 Worker 结算；四角色 p04 healthy | 已完成 |

P02 交付：手机号 CN 规范化/HMAC、SmsProvider 显式模拟与真实 transport 入口、OTP 用途/过期/次数/频率/原子消费；15 分钟访问令牌、30 天设备会话、refresh 轮转/复用撤销；协议版本确认；默认个人工作区事务创建，昵称/时区、工作区 CRUD/切换/ETag、定位资料、可延期问卷草稿；按 scope 隔离及持久幂等。Admin 独立账号/scrypt、Cookie Session、CSRF/Origin、角色限制、退出/撤销、只追加审计及一次性 CLI bootstrap。

P02 边界：真实短信厂商未选/未配置，只完成明确模拟和 transport 适配入口；无真实发送。云草稿/服务端 logout 是新增契约，App 未接线；头像资源归属等待 P05；AI 定位报告等待 P09，不生成假报告或 completion。管理员运营网页在 P14，当前只有身份 API；开发库未创建默认管理员。

本次继续 P02 未重建基础设施、未改已有密码、未删除数据卷。所有测试业务数据在随机独立测试库；临时 HTTP 容器仅用于 P02 验收并在 finally 清理。App 源码未修改，未运行 Flutter。

P02 完成后进入 P03；其原有 Worker/Scheduler 骨架已由 P03 持久任务消费者、Outbox 投递与调度循环替换。

P01/P02/P03 的历史验收记录保留在本文件及对应 runbook；P04 最终验收命令包含 `docker compose ... build`、migrate、`node scripts/integration.mjs`、容器隔离、23 unit/contract、`node scripts/app-reference.mjs --diff`。P04 历史记录中的 schema version=5 已由 P05 迁移升级；当前六个常驻容器 healthy，migrate Exited(0)，schema version=6。测试/容器机器记录保存在忽略提交的 docs/*.local.json。未运行 Dart 解析或真机联调；源码核对与后端 fixture 通过不等于完整 App 验收。

P03 交付：API 以同一 PostgreSQL 事务写入 task input 引用、task、event 和 outbox，返回稳定 taskId；持久 request 幂等按 scope/body 冲突检测。Scheduler 使用短租约领取 outbox，BullMQ payload 仅 taskId，PG 定期修复 pending/delivering、失联 lease 和 Redis 丢队列；Worker 以 attempt/version/lease CAS 写入 demo.digest 的真实 PG result，旧 Worker 不能覆盖。状态包含 queued/running/retry_scheduled/waiting_external/reconciling/cancel_requested 及终态，事件按 sequence 读取，取消、有限退避、人工重试和双 Scheduler 时间窗去重均有测试。`node scripts/e2e-p03.mjs` 通过，实际 HTTP 从 mock SMS 登录后由独立 Worker 完成 PG 结果；`node scripts/container-isolation.mjs` 通过。P03 不调用真实 AI、ASR、支付或通知 provider，demo.digest 只用于基础设施演示。

P04 交付：使用显式 `BILLING_MODE=development` 和 `credit-policy-v1` 开发政策；会员、月度/永久额度批次、usage period、reservation、ledger、provider measurement、run usage 全部持久化。预留使用 PG 事务、行锁、条件余额更新和唯一 reservation key；同 key 重放幂等、参数冲突 409，commit/release 单次生效，未知供应商进入 uncovered 并阻断后续付费任务。`GET /api/v1/membership`、`/account/credits`、`/home`、`/runs/:runId/usage` 返回 App 严格解析所需字段。demo task 只在显式开发 fixture 开启时扣 1 credit，Worker 成功结算、失败释放；生产默认关闭 billing development policy，未接真实支付、ASR、AI 或通知。

| P05 | 本地验证通过 | 资源/上传会话/分段清单/引用/删除请求/存储任务；0006_p05_resources.sql；LocalStorageAdapter 与真实 S3-compatible SDK 适配；上传授权、服务端核验、Range 播放、引用感知异步清理 | 23 unit/contract、48 real PG/Redis integration；真实文件 roundtrip、Range、MIME spoof/超限/哈希、稳定 complete 重试、隔离/过期/配额/ENOSPC、引用删除、Fastify App 传输契约；schema 6；p05 四角色 healthy | 等待用户确认 P06 |

| P06 | 本地验证通过 | 统一资产/Note/Folder/不可变 part revision/资源引用/标签/关系/内容事件；0007_p06_assets.sql；关键词检索与局部图谱聚合；Worker 标签提取任务 | 23 unit/contract、53 real PG/Redis integration；目录重名/循环/ETag、旧 revision 任务不覆盖新文本、中文/英文/日期检索隔离、tombstone 恢复、关系与图谱节点；schema 7；p06 四角色 healthy；文本/Markdown 导入可用，PDF/DOCX 解析失败时 fail-closed 为 needs-processing | 等待用户确认 P07 |

## P06 标签化补充修订（2026-10-10）

已完成，不进入 P07。知识图谱收敛为 PostgreSQL `note_tags` 的标签驱动投影：按需主题/素材节点、共同标签证据 `co_tagged`、成员边 `tagged_with`，不读取 `note_relations` 作为标签边，不复制正文、不建图谱表或缓存，不引入 Embedding/pgvector/Rerank/GraphRAG/Dify Dataset。迁移 `0008_p06_tag_graph_revision.sql` 保留旧 mapping/revision/history，加入 tag-set 版本与人工覆盖、建议表、Worker workspace 最小读取权限、未读正文状态、生命周期 fence、最新正文检索索引。

人工标签支持查看、篇内增删改/替换、建议显式应用、20 个上限；24 Unicode 字符校验、NFKC/大小写去重限定工作区。异步 TagExtractor 复用既有任务/Outbox/Worker，默认 disabled；确定性 provider 仅显式 fixture。分段协调最多 32×16k 临时文本，合并校验最多 5 个标签；无正文不调用 provider，失败不影响原文。正文 revision、tag-set version、manual override、note state、attempt/lease 在同一事务中检查，迟到任务不会恢复删除标签。不可读导入保留 P05 资源引用并标 `needs-processing`，允许人工分类。

真实验证：`pnpm verify`（Docker Node24）通过：typecheck、lint、build、18 unit、9 contract、67 real PG/Redis integration；高频 100,000 篇标签 fixture 的两页查询、两次聚焦查询及 EXPLAIN 合计 427ms（本机测试库，非生产延迟承诺），`EXPLAIN ANALYZE` 使用 `notes_graph_page`/`note_tags` 索引，返回 `maxNodes=12/maxEdges=8` 的局部页、全量计数和游标失效。App reference diff 无变化；当前 App `MiroFishGraphMapper.fromContentNavigation` 仅从 `items.path` 推导层级边，尚未消费后端显式标签边，已保留兼容 items 并登记为客户端接线待 P15，不修改 App。

Provider 限制：真实 LLM/Dify 标签提取尚未接通，P08 复用接口接入；未配置 provider 不付费、不返回假标签。下一阶段仍为 P07。

最终部署：`huahuo-server:p06-tags` 构建成功；既有开发库迁移 applied `[8]`、schema 8；四业务角色及 PostgreSQL/Redis 均 healthy，migrate Exited(0)。新增原资源保留下载验收已包含在 67 项集成测试中。

容器独立启停、Redis 故障/恢复、共享卷跨重启与 API/Admin 路由隔离均通过。最终 App baseline diff 为 `headChanged:false,statusChanged:false,changedFiles:[]`。
