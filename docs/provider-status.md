# Provider 状态（P06）

| 能力 | 当前模式 | 本地证据 | sandbox / live | 限制 |
|---|---|---|---|---|
| PostgreSQL | local Docker 17.9 | 0001/0002、真实隔离库、并发/回滚/角色测试 | 未接云库 | 云模式仅 Compose/TLS 配置校验 |
| Redis | local Docker 7.4.8 AOF/noeviction | TTL/故障恢复，PG 为会话/OTP权威存储 | 未接云 Redis | P02 身份限流存 PG，无 Redis 放宽鉴权降级 |
| SMS | explicit mock | 随机六位 OTP、用途绑定、过期/五次上限、并发消费、发送频率、模拟 provider 失败、真实 HTTP 两用户登录 | 未选厂商/无凭据/未发送 | `SMS_PROVIDER=mock` + `ALLOW_MOCK_PROVIDERS=true`；回显还需 `SHOW_TEST_OTP=true`，生产禁止 |
| SMS live transport | `LiveSmsProvider` 接口入口 | 注入 accepted/rejected transport fixture | 未配置真实 transport | `SMS_PROVIDER=live` 缺具体适配器仍拒绝 SMS_NOT_CONFIGURED，不模拟真实成功 |
| Storage | local shared named volume only | P01 卷检查仍保留 | 未接对象存储 | 业务上传/头像资源授权 P05 |
| Dify / ASR / Push / Payment | disabled | 本阶段未调用 | 未授权 | 无真实付费/生产调用 |
| BullMQ | local Redis queue，四个逻辑队列 | 34 项真实集成、Redis 丢队列 PG 补投、HTTP Worker 结果 | 未接托管队列 | Redis 仅投递机制；PG task/outbox/result 是权威记录 |
| Billing ledger | explicit development policy `credit-policy-v1` | 0004 migration、39 项真实 PG/Redis 集成、HTTP membership/credits/home、task reserve/commit | live policy/payment 未配置 | 月度额度 10,000,000 仅为显式开发兼容 fixture；生产默认 `BILLING_MODE=disabled`，不代表正式商业价格 |
| Provider usage | pending/uncovered ledger path | unknown measurement 集成测试与 admission block | 未接 ASR/AI provider | 未知成本不会记 0；需对账后再结算 |

法律：仅登记 App 当前协议版本标识 2026-08-20 和确认时间/动作；文案未提供，不生成或声称法律审核通过。生产部署需配置 USER_AGREEMENT_VERSION / PRIVACY_POLICY_VERSION。

## P05 存储适配

| 能力 | 当前模式 | 本地证据 | live 状态/限制 |
|---|---|---|---|
| Local storage | `STORAGE_DRIVER=local`，API/Worker 共用 `user_files` 卷 | 真实文件写入、原子发布、重启读取、Range、哈希/大小/MIME/时长核验、失败释放预留 | 单机共享卷模式；生产应按部署拓扑配置持久卷 |
| S3-compatible | `@aws-sdk/client-s3` SigV4，path-style，Put/Get/Delete、版本/ETag 保存 | 代码路径与故障端口契约；未启用真实供应商凭据 | 目标厂商/endpoint 尚未提供，未宣称 live 联调通过 |
| Upload capability | HMAC 短期上传/播放 capability，Bearer 不传给对象传输 | 过期、伪造、跨用户播放/上传测试 | 持有链接者可在有效期内使用；应用不保存永久 URL |
| Processing/cleanup | PG task/outbox；Worker 校验/删除，Scheduler 过期扫描 | inspect/delete/expire 真实任务与幂等 | 上传完成不代表 ASR/文本处理成功；业务解析留后续阶段 |

## P06 资产与检索

| 能力 | 当前模式 | 本地证据 | 限制 |
|---|---|---|---|
| Note/Folder/Revision | PostgreSQL 事务、ETag、tombstone、content cursor | 目录循环/重名、旧 revision、删除恢复、跨 workspace 集成测试 | 文本/Markdown 导入已完成；PDF 及解析失败的 DOCX fail-closed 返回 `needs-processing`，不会伪造正文 |
| Keyword search | PostgreSQL `simple` tsvector + GIN，ILIKE 有界降级 | 中文、人名、英文混合、作用域与返回数量上限 fixture | 不提供 semantic/vector/rerank；不宣称 10 万篇性能 |
| TagExtractor | 默认未配置；显式开发 fixture，最多 5 个 | revision fencing、原文保留、标签计数 | 未接真实 LLM/Dify；失败状态由任务系统记录 |
| Graph | PostgreSQL 有效 note_tags 投影；来源引用独立保留 | typed relation、局部节点上限、空数据 | 无 Neo4j/向量库；后续也不引入语义相似边 |

## P06 标签化补充修订

| 能力 | 当前模式 | 证据 | 限制 |
|---|---|---|---|
| TagExtractor | `disabled` 默认；显式 `deterministic-fixture` 仅开发/测试；接口支持 `llm`/`dify` unavailable | 分段预算、输出校验、provider 失败、版本/人工 fence 的 67 项真实集成与 4 项单元 | P08 才接真实 LLM/Dify；无正文不调用，不从文件名推断 |
| 标签图谱 | PostgreSQL `note_tags` 局部投影，实时计数和共同标签 evidence | A/B/C、移除共同标签、删除、隔离、100k 分页/EXPLAIN | 当前 App overview mapper 未消费显式 edges；待后续 App/联调阶段核对 |
