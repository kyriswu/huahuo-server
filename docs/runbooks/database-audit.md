# huahuo 数据库用途与精简审计

> 历史审计记录，不是当前部署/重置指令。现行资产表映射见 [资产与搜索术语](../content-assets.md)，知识库表与集合见 [知识库手册](milvus.md)，本阶段实际结果见 [验收记录](../acceptance/knowledge-base.md)。
后续已实施的修复和最新目录见[数据库精简修复](database-cleanup.md)。本文件保留审计时点的事实和候选项，不代表修复后的现状。

只读审计时间：`2026-11-05T14:30:42.103Z`。目标为现有阿里云RDS `huahuo`；本轮没有修改业务代码、Schema、数据、权限或服务配置，没有调用模型或短信。

## 实际目录

- `public`：59张实体表、1个View，50张实体表为空；当前非空对象以配置、迁移账本及周期维护任务为主。空表不等于未使用。
- `initialization_backup`：58张旧表、1个旧View，属于上次初始化保留的归档，不参与运行；上次归档核验4149行。本次仅读取目录和大小，不恢复权限、不读取归档正文。
- 当前所有表均能在唯一初始基线中找到，没有额外临时测试/probe表；物理外键为0。
- 当前目录大小（含索引/TOAST，非业务正文大小）：public约2.11MiB，归档约5.55MiB。本轮精简重点是职责和维护成本，而非明显容量压力。

## 先处理源码与真实库一致性

- 工作区基线SHA-256：`9bc86339841c2bfa09b338bc65e05cc29e2f6856a51e9d5aafe84f02096fd96e`。
- RDS账本基线SHA-256：`4834e9389c39ab29566bd9c6db55c6bbaf4d72873b044a74f807929315029828`。
- 最新源码读取 `document_ingestion_versions.toc/toc_status`，真实RDS当前仅文件表 `rag_ingestion_versions` 有TOC字段；笔记索引版本表尚未同步。证据：[src/modules/ingestion/service.ts:106](../../src/modules/ingestion/service.ts#L106)。
- 当前运行镜像打包的基线与RDS一致，readiness200；不能把未发布的工作区字段误判为数据库脏表。直接发布新工作区镜像会被基线checksum校验拒绝，需先统一Schema。

## 优先精简清单

| 对象 | 真实用途及问题 | 建议 |
|---|---|---|
| `upload_parts` | 上传完成仅写一行；Schema固定part_no=1、byte_start=0；没有运行读取，上传状态已有received_bytes/hash | 当前单文件上传可移除表和写入；不将它冒充已实现multipart |
| `resource_delete_requests` | 删除API插入，Worker只回填completed_at，没有读取；相同任务/资源关系已有storage_jobs/tasks | 合入既有删除任务状态或移除重复记录，保留删除幂等 |
| `task_requests` + `api_idempotency` | 两套scope/operation/key+hash+锁+响应幂等；前者明文JSON且无TTL，后者加密和TTL | 优先统一表与Helper，先明确管理员权限、加密配置和有效期，再删除重复实现 |
| `content_events` | 真实追加写入，未找到增量消费/重放接口；不同于在用的workspace_content_state | 决定是否提供增量同步；不做则移除写端和表，保留则增加消费者与保留期限 |
| `rag_chunks` | 无运行源码调用的View，仅投影文件Child，不额外存储正文 | 确认外部SQL工具不依赖后可移除；不会减少一份Chunk正文存储 |
| 2组重复索引 | 普通索引与已有UNIQUE索引的列、排序、方法等一致 | 保留唯一约束，移除重复普通索引 |

证据：

- 上传分片：[src/modules/storage/service.ts:36](../../src/modules/storage/service.ts#L36)；基线 `upload_parts` CHECK约束。
- 删除请求：[src/modules/storage/service.ts:39](../../src/modules/storage/service.ts#L39)、[src/modules/storage/jobs.ts:41](../../src/modules/storage/jobs.ts#L41)。
- 两套幂等：[src/modules/tasks/service.ts:8](../../src/modules/tasks/service.ts#L8)、[src/modules/identity/store.ts:24](../../src/modules/identity/store.ts#L24)。
- 内容事件：[src/modules/assets/service.ts:19](../../src/modules/assets/service.ts#L19)、[src/modules/tasks/engine.ts:89](../../src/modules/tasks/engine.ts#L89)；游标状态被Note、搜索及图谱使用。

| 可删的重复普通索引 | 必须保留的唯一约束索引 |
|---|---|
| `content_events_scope` | `content_events_workspace_id_cursor_key`，列 `(workspace_id,cursor)` |
| `rag_child_chunks_version` | `rag_child_chunks_version_id_ordinal_key`，列 `(version_id,ordinal)` |

## 已明确预留或链路未完整接入

- `user_api_keys`：用户明确要求的认证基础表，当前无签发/管理/鉴权API；应标预留，不当成脏表删除。
- `provider_usage_measurements`、`run_usage`：读路由已存在，但写入方法只在测试中调用，真实模型/RAG用量尚未接入；应补链路或整体延期，不可只删表而保留接口。
- `task_attempts`、`task_schedule_windows`、用户/管理员审计、协议、credit流水是真实记录或唯一键防重，即使没有列表API也不等于无用。
- 当前运行配置：billingMode=development、demoTasks=true、manualTextEnabled=false、tagExtractor=disabled。关闭功能和缺少实现不同。

## 不建议合并的边界

- 文件 `rag_ingestion_versions/rag_child_chunks` 与笔记 `document_ingestion_versions/document_ingestion_chunks` 分属两类业务来源，按现有要求保持分离；可考虑把后者重命名为Note语义以减少命名混淆。
- `users/user_identities`、`user_sessions/refresh_tokens` 分别承担账号/登录方式、会话/轮换历史，不能直接压平。
- `note_part_revisions`、标签映射、资源引用具有历史或多对多关系；`note_resource_refs`保存展示顺序/anchor，`resource_refs`还承担头像等关系与删除保护，直接删任一张都会丢功能。
- Task/outbox/事件/审计分别是执行状态、可靠投递、状态回放、操作责任，不能合成万能日志表。
- 会员、额度lot、预留、分配明细、流水用途独立；模型计量明细与Run汇总也是不同粒度。
- 用户/管理员限流算法已共享；物理表分离保留权限边界，合并收益有限。

## 字段和重复内容值得清理

- `rag_document_assets.metadata`每图片复制整篇missingRefs/orphanAssets/unresolvedOcr，其中未绑定OCR含全文；可按资产数放大数据。应改为文档级单份诊断产物，完整保留OCR，不能删未绑定OCR。证据：[src/modules/rag/jobs.ts:316](../../src/modules/rag/jobs.ts#L316)。
- 资产caption/alt_text/caption_text当前同值；char_start/end恒NULL。表的asset_ref/object_key映射仍用于签名URL，整表不能删。
- 文件id/document_key/source_pk当前同值、Child ordinal_global/ordinal同值、canonical_content_uri/enriched_canonical_markdown_uri同对象，适合收敛字段但需同步向量元数据、查询与诊断。
- `admin_sessions.csrf_hash`仅写；当前CSRF直接由Cookie派生比较，可裁剪列。
- `usage_periods`只部分字段被消费；应保留实际读取的uncovered_credits，评估重复credit_limit/period_end/reserved/settled字段，而非删整表。
- task_schedules租约在同一短事务中设置后清空，实际有FOR UPDATE+last_window+唯一窗口防重；可评估去掉重复租约列。
- 过期OTP、session/refresh、限流、幂等、任务历史和日志未发现统一保留期清理；有效期校验不等于物理回收。

注意：`notes.search_vector`仍被普通Note查询读取，见[src/modules/assets/service.ts:166](../../src/modules/assets/service.ts#L166)及[src/modules/assets/service.ts:176](../../src/modules/assets/service.ts#L176)；其GIN和触发器不是已废弃的RAG关键词召回，不应删除。

## public逐表用途索引

以下为源码定位，需结合上面的调用链判断；动态SQL和ORM已人工复核。

| 表 | 状态 | 源码定位 |
|---|---|---|
| `account_memberships` | 有真实运行读写或消费路径 | [src/modules/billing/service.ts:54](../../src/modules/billing/service.ts#L54)、[src/modules/billing/service.ts:55](../../src/modules/billing/service.ts#L55) |
| `admin_audit_events` | 在用；安全留证 | [src/modules/tasks/service.ts:63](../../src/modules/tasks/service.ts#L63)、[src/modules/admin/service.ts:21](../../src/modules/admin/service.ts#L21) |
| `admin_login_limits` | 有真实运行读写或消费路径 | [src/modules/identity/store.ts:39](../../src/modules/identity/store.ts#L39) |
| `admin_sessions` | 有真实运行读写或消费路径 | [src/modules/admin/service.ts:20](../../src/modules/admin/service.ts#L20)、[src/modules/admin/service.ts:27](../../src/modules/admin/service.ts#L27) |
| `admin_users` | 有真实运行读写或消费路径 | [src/modules/admin/service.ts:14](../../src/modules/admin/service.ts#L14)、[src/modules/admin/service.ts:19](../../src/modules/admin/service.ts#L19) |
| `api_idempotency` | 有真实运行读写或消费路径 | [src/modules/identity/store.ts:28](../../src/modules/identity/store.ts#L28)、[src/modules/identity/store.ts:35](../../src/modules/identity/store.ts#L35) |
| `asset_folders` | 有真实运行读写或消费路径 | [src/modules/assets/service.ts:21](../../src/modules/assets/service.ts#L21)、[src/modules/assets/service.ts:22](../../src/modules/assets/service.ts#L22) |
| `asset_tags` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:81](../../src/modules/tasks/engine.ts#L81)、[src/modules/tasks/engine.ts:82](../../src/modules/tasks/engine.ts#L82) |
| `auth_rate_limits` | 有真实运行读写或消费路径 | [src/modules/identity/store.ts:39](../../src/modules/identity/store.ts#L39) |
| `billing_policies` | 有真实运行读写或消费路径 | [src/modules/billing/service.ts:47](../../src/modules/billing/service.ts#L47) |
| `content_events` | 追加写端；消费接口未接 | [src/modules/tasks/engine.ts:89](../../src/modules/tasks/engine.ts#L89)、[src/modules/assets/service.ts:19](../../src/modules/assets/service.ts#L19) |
| `content_jobs` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:60](../../src/modules/tasks/engine.ts#L60)、[src/modules/tasks/engine.ts:98](../../src/modules/tasks/engine.ts#L98) |
| `credit_ledger_entries` | 在用；不可替代账务流水 | [src/modules/billing/service.ts:87](../../src/modules/billing/service.ts#L87)、[src/modules/billing/service.ts:116](../../src/modules/billing/service.ts#L116) |
| `credit_lots` | 有真实运行读写或消费路径 | [src/modules/billing/service.ts:57](../../src/modules/billing/service.ts#L57)、[src/modules/billing/service.ts:76](../../src/modules/billing/service.ts#L76) |
| `credit_reservation_lots` | 有真实运行读写或消费路径 | [src/modules/billing/service.ts:116](../../src/modules/billing/service.ts#L116)、[src/modules/billing/service.ts:121](../../src/modules/billing/service.ts#L121) |
| `credit_reservations` | 有真实运行读写或消费路径 | [src/modules/billing/service.ts:34](../../src/modules/billing/service.ts#L34)、[src/modules/billing/service.ts:109](../../src/modules/billing/service.ts#L109) |
| `document_ingestion_chunks` | 有真实运行读写或消费路径 | [src/modules/ingestion/jobs.ts:52](../../src/modules/ingestion/jobs.ts#L52)、[src/modules/ingestion/jobs.ts:59](../../src/modules/ingestion/jobs.ts#L59) |
| `document_ingestion_versions` | 有真实运行读写或消费路径 | [src/modules/ingestion/jobs.ts:43](../../src/modules/ingestion/jobs.ts#L43)、[src/modules/ingestion/jobs.ts:60](../../src/modules/ingestion/jobs.ts#L60) |
| `note_part_revisions` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:57](../../src/modules/tasks/engine.ts#L57)、[src/modules/ingestion/jobs.ts:74](../../src/modules/ingestion/jobs.ts#L74) |
| `note_relations` | 有真实运行读写或消费路径 | [src/modules/assets/service.ts:183](../../src/modules/assets/service.ts#L183)、[src/modules/assets/service.ts:184](../../src/modules/assets/service.ts#L184) |
| `note_resource_refs` | 有真实运行读写或消费路径 | [src/modules/assets/service.ts:20](../../src/modules/assets/service.ts#L20)、[src/modules/assets/service.ts:142](../../src/modules/assets/service.ts#L142) |
| `note_tag_suggestions` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:92](../../src/modules/tasks/engine.ts#L92)、[src/modules/assets/service.ts:57](../../src/modules/assets/service.ts#L57) |
| `note_tags` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:78](../../src/modules/tasks/engine.ts#L78)、[src/modules/tasks/engine.ts:84](../../src/modules/tasks/engine.ts#L84) |
| `notes` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:55](../../src/modules/tasks/engine.ts#L55)、[src/modules/tasks/engine.ts:70](../../src/modules/tasks/engine.ts#L70) |
| `onboarding_drafts` | 有真实运行读写或消费路径 | [src/modules/workspaces/service.ts:97](../../src/modules/workspaces/service.ts#L97)、[src/modules/workspaces/service.ts:98](../../src/modules/workspaces/service.ts#L98) |
| `otp_requests` | 有真实运行读写或消费路径 | [src/modules/identity/service.ts:34](../../src/modules/identity/service.ts#L34)、[src/modules/identity/service.ts:44](../../src/modules/identity/service.ts#L44) |
| `provider_usage_measurements` | 读接口在；真实写链路未接 | [src/modules/billing/service.ts:140](../../src/modules/billing/service.ts#L140)、[src/modules/billing/service.ts:145](../../src/modules/billing/service.ts#L145) |
| `rag_child_chunks` | 有真实运行读写或消费路径 | [src/modules/rag/query-service.ts:175](../../src/modules/rag/query-service.ts#L175)、[src/modules/rag/jobs.ts:162](../../src/modules/rag/jobs.ts#L162) |
| `rag_document_assets` | 有真实运行读写或消费路径 | [src/apps/api-server.ts:36](../../src/apps/api-server.ts#L36)、[src/modules/rag/jobs.ts:326](../../src/modules/rag/jobs.ts#L326) |
| `rag_ingestion_versions` | 有真实运行读写或消费路径 | [src/apps/api-server.ts:36](../../src/apps/api-server.ts#L36)、[src/modules/rag/repository.ts:39](../../src/modules/rag/repository.ts#L39) |
| `refresh_tokens` | 有真实运行读写或消费路径 | [src/modules/identity/service.ts:88](../../src/modules/identity/service.ts#L88)、[src/modules/identity/service.ts:114](../../src/modules/identity/service.ts#L114) |
| `resource_delete_requests` | 当前只写/回填；优先精简 | [src/modules/storage/jobs.ts:41](../../src/modules/storage/jobs.ts#L41)、[src/modules/storage/service.ts:39](../../src/modules/storage/service.ts#L39) |
| `resource_refs` | 有真实运行读写或消费路径 | [src/modules/workspaces/service.ts:40](../../src/modules/workspaces/service.ts#L40)、[src/modules/storage/jobs.ts:35](../../src/modules/storage/jobs.ts#L35) |
| `resources` | 有真实运行读写或消费路径 | [src/modules/admin/routes.ts:42](../../src/modules/admin/routes.ts#L42)、[src/modules/admin/service.ts:44](../../src/modules/admin/service.ts#L44) |
| `run_usage` | 读接口在；真实写链路未接 | [src/modules/billing/service.ts:39](../../src/modules/billing/service.ts#L39)、[src/modules/billing/service.ts:42](../../src/modules/billing/service.ts#L42) |
| `schema_migrations` | 在用；ORM/迁移及readiness校验 | [src/db/schema.ts:2](../../src/db/schema.ts#L2)、[src/db/migrate.ts:32](../../src/db/migrate.ts#L32) |
| `storage_jobs` | 有真实运行读写或消费路径 | [src/modules/storage/jobs.ts:13](../../src/modules/storage/jobs.ts#L13)、[src/modules/storage/jobs.ts:16](../../src/modules/storage/jobs.ts#L16) |
| `storage_reservations` | 有真实运行读写或消费路径 | [src/modules/storage/jobs.ts:17](../../src/modules/storage/jobs.ts#L17)、[src/modules/storage/jobs.ts:42](../../src/modules/storage/jobs.ts#L42) |
| `task_attempts` | 在用；执行尝试历史 | [src/modules/tasks/scheduler.ts:14](../../src/modules/tasks/scheduler.ts#L14)、[src/modules/tasks/engine.ts:17](../../src/modules/tasks/engine.ts#L17) |
| `task_events` | 有真实运行读写或消费路径 | [src/modules/tasks/model.ts:18](../../src/modules/tasks/model.ts#L18)、[src/modules/tasks/service.ts:36](../../src/modules/tasks/service.ts#L36) |
| `task_inputs` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:52](../../src/modules/tasks/engine.ts#L52)、[src/modules/tasks/engine.ts:102](../../src/modules/tasks/engine.ts#L102) |
| `task_outbox` | 有真实运行读写或消费路径 | [src/modules/tasks/scheduler.ts:19](../../src/modules/tasks/scheduler.ts#L19)、[src/modules/tasks/scheduler.ts:35](../../src/modules/tasks/scheduler.ts#L35) |
| `task_requests` | 在用；与通用幂等重复 | [src/modules/tasks/service.ts:10](../../src/modules/tasks/service.ts#L10)、[src/modules/tasks/service.ts:12](../../src/modules/tasks/service.ts#L12) |
| `task_results` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:25](../../src/modules/tasks/engine.ts#L25)、[src/modules/tasks/service.ts:37](../../src/modules/tasks/service.ts#L37) |
| `task_schedule_windows` | 在用；窗口唯一约束防重复 | [src/modules/tasks/scheduler.ts:30](../../src/modules/tasks/scheduler.ts#L30) |
| `task_schedules` | 有真实运行读写或消费路径 | [src/modules/tasks/scheduler.ts:25](../../src/modules/tasks/scheduler.ts#L25)、[src/modules/tasks/scheduler.ts:28](../../src/modules/tasks/scheduler.ts#L28) |
| `tasks` | 有真实运行读写或消费路径 | [src/config/config.ts:1](../../src/config/config.ts#L1)、[src/entrypoints/scheduler.ts:4](../../src/entrypoints/scheduler.ts#L4) |
| `upload_parts` | 当前只写；优先精简 | [src/modules/storage/service.ts:36](../../src/modules/storage/service.ts#L36) |
| `upload_sessions` | 有真实运行读写或消费路径 | [src/modules/storage/jobs.ts:8](../../src/modules/storage/jobs.ts#L8)、[src/modules/storage/jobs.ts:16](../../src/modules/storage/jobs.ts#L16) |
| `usage_periods` | 有真实运行读写或消费路径 | [src/modules/billing/service.ts:59](../../src/modules/billing/service.ts#L59)、[src/modules/billing/service.ts:97](../../src/modules/billing/service.ts#L97) |
| `user_agreement_acceptances` | 在用；协议历史留证 | [src/modules/identity/service.ts:89](../../src/modules/identity/service.ts#L89) |
| `user_api_keys` | 明确预留；无运行API | 当前基线及用户明确要求；无运行调用 |
| `user_audit_events` | 在用；安全留证 | [src/modules/identity/store.ts:18](../../src/modules/identity/store.ts#L18) |
| `user_identities` | 有真实运行读写或消费路径 | [src/modules/identity/service.ts:75](../../src/modules/identity/service.ts#L75)、[src/modules/identity/service.ts:79](../../src/modules/identity/service.ts#L79) |
| `user_sessions` | 有真实运行读写或消费路径 | [src/modules/identity/service.ts:87](../../src/modules/identity/service.ts#L87)、[src/modules/identity/service.ts:95](../../src/modules/identity/service.ts#L95) |
| `users` | 有真实运行读写或消费路径 | [src/modules/identity/service.ts:78](../../src/modules/identity/service.ts#L78)、[src/modules/identity/service.ts:82](../../src/modules/identity/service.ts#L82) |
| `workspace_content_state` | 有真实运行读写或消费路径 | [src/modules/tasks/engine.ts:87](../../src/modules/tasks/engine.ts#L87)、[src/modules/tasks/engine.ts:88](../../src/modules/tasks/engine.ts#L88) |
| `workspace_profiles` | 有真实运行读写或消费路径 | [src/modules/identity/service.ts:164](../../src/modules/identity/service.ts#L164)、[src/modules/workspaces/service.ts:78](../../src/modules/workspaces/service.ts#L78) |
| `workspaces` | 有真实运行读写或消费路径 | [src/apps/api-server.ts:6](../../src/apps/api-server.ts#L6)、[src/apps/api-server.ts:36](../../src/apps/api-server.ts#L36) |

## 边界

未检查组织外部手工SQL/报表对View的使用，不能用仓库静态扫描证明完全没有外部消费者。归档只审计目录，不重新开放读权限。源工作区存在未部署修改，本报告把运行库、运行镜像与当前源码分别记录；不将旧测试日志当作当前Schema已同步的证明。

私有证据：`.local/database-audit/inventory.json`、`source-usage.json`、`indexes.json`、`schema-alignment.json`。均不包含真实业务正文、密钥或完整连接串。
