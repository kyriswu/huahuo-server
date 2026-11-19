# huahuo 数据库精简修复

> 历史审计记录，不是当前部署/重置指令。现行资产表映射见 [资产与搜索术语](../content-assets.md)，知识库表与集合见 [知识库手册](milvus.md)，本阶段实际结果见 [验收记录](../acceptance/knowledge-base.md)。
2026-11-05，针对[数据库用途审计](database-audit.md)中已经确认的冗余项完成代码、唯一初始化基线和真实阿里云开发 RDS `huahuo` 的同步。只修改 Server；没有修改 App、凭据、JWT 契约、解析器或切分算法，没有调用真实模型或短信服务。

## 已实施

| 对象 | 最终实现 |
|---|---|
| `upload_parts` | 删除表及写入。上传完整字节数、SHA-256 和状态保留在 `upload_sessions`，资源核验继续走原 Worker。 |
| `resource_delete_requests` | 删除表及写入/完成回填。`storage_jobs`、`tasks` 和 `resources` 承担删除任务及终态；并发删除只创建一个任务，额度释放仍在原事务中。 |
| `task_requests` | 删除表及 `requestOnce`。请求幂等统一调用 `src/lib/idempotency.ts`，使用 `api_idempotency`、事务锁、请求 hash、AES-GCM 加密响应；默认有效期 24 小时，登录继续显式使用 5 分钟。过期 key 明确返回 409，不声称已实现自动物理回收。 |
| 重复索引 | 删除 `content_events_scope`、`rag_child_chunks_version`；保留各自相同前导列的唯一约束索引。 |
| 无消费字段 | 删除 `admin_sessions.csrf_hash`；CSRF 继续由会话 Cookie 与现有服务端密钥派生并常量时间比较。删除 `task_schedules` 的两个短事务租约字段；保留行锁、窗口唯一约束和 `last_window` 防重。任务和 Outbox 的有效租约未删除。 |
| 图片诊断 | 整篇 `missingRefs/orphanAssets/duplicatePaths/unresolvedOcr` 单份保存在 `asset_manifest_uri` 指向的内容寻址 JSON `{assets, diagnostics}`；每张图片只保存自身 metadata。全部未绑定 OCR 保留。 |
| 图片恢复 | 资产数据库事务成功后才发布 canonical checkpoint，避免重试跳过缺失的资产行。 |
| 图片唯一性 | 删除 `UNIQUE(version_id, sha256, object_key)`；保留 `(version_id, source_asset_key)` 唯一索引。不同来源图片路径可共享同一图片文件和 OSS 对象，分别保留 OCR、说明与位置。 |

统一幂等依赖方向：业务 Service → `lib/idempotency.ts` → 通用 `lib/crypto.ts` / `lib/domain-error.ts`。Identity Store 重导出同一个错误类以供现有业务错误处理使用，没有第二套实现。用户任务使用既有 `APP_TOKEN_SECRET`，管理员任务使用既有 `ADMIN_SESSION_SECRET`；Admin 仅增加幂等表的 SELECT、INSERT 授权，没有新增配置或密钥。

## 正文结构一致性

同步了工作区已实现、尚未发布的 TOC 字段和正文约束：

- `document_ingestion_versions` 增加 `toc`、`toc_status` 和一致性 CHECK。
- 文件 TOC 默认状态统一为 `pending`，检查目录值与 `ready` 状态一致。
- Note 已有切分参数为 300 个 Unicode 码点目标、500 个码点硬上限；文件为 2,000 个码点硬上限。数据库约束与当前源码一致。本轮没有调整切分算法。

初始化仍然只有 `migrations/0001_initial_schema.sql`，没有新增历史兼容迁移或启动自动修库逻辑。真实环境使用私有一次性维护操作同步已确认的结构差异；不能对其他已有数据库直接覆盖迁移账本。

## 真实 RDS 执行与验证

1. 读取运行镜像中的旧基线，核实 RDS 结构、旧账本、待删三表以及受影响的 RAG/Note 表为空。
2. 在独立临时 PostgreSQL 中分别创建全新基线和旧基线，演练清理；按列、约束、索引、视图、函数、触发器及业务角色授权逐项比较，确认修复后与全新初始化一致。
3. 演练向待删表注入测试记录，确认非空保护拒绝执行且 Schema 整体不变。
4. 构建并核对新镜像；仅停止本项目 API、Admin、Worker、Scheduler，在一个受迁移锁保护的事务内修复 RDS。没有使用 CASCADE，没有清空数据库。
5. 比较所有保留业务记录的摘要；对于删除的重复列，比较其余所有列。归档对象身份、存储标识和 ACL 保持不变。完整结构匹配后才更新基线账本并提交。
6. 新镜像 migrate 重放返回 `applied=[]`、`current=1`；重建四个运行角色，全部 healthy，API/Admin readiness 均为 HTTP 200。

结果：`public` **56 张实体表、1 个 View、179 个索引**，物理外键 **0**。旧值分别为 59 张实体表和 186 个索引。

基线 SHA-256：`d361b2086d754a0ea24320728b4bb4950da01f5359874a0c312e6b565eb6a048`。源码、运行镜像与 RDS 账本一致。`initialization_backup` 的 58 张表及归档权限未改动，没有成为运行兼容路径。

## 修改位置

- `migrations/0001_initial_schema.sql`：删除冗余对象、调整唯一性和授权；保留唯一当前基线。
- `src/lib/{idempotency,crypto,domain-error}.ts`：统一幂等核心及通用能力。
- `src/modules/{identity,assets,workspaces,storage,ingestion}/`：复用统一幂等导入；其余业务行为保持原职责。
- `src/modules/tasks/service.ts`、`src/apps/{api-server,admin}.ts`：任务幂等与现有密钥注入。
- `src/modules/storage/{service,jobs}.ts`：删除重复记录维护。
- `src/modules/admin/service.ts`、`src/modules/tasks/scheduler.ts`：移除无消费者字段的维护。
- `src/modules/rag/jobs.ts`：诊断单份保存及资产恢复顺序。
- `tests/unit/idempotency.test.ts`、相关安全单测，`tests/integration/{storage,tasks,rag-ingestion,no-foreign-keys,database-cleanup}.test.ts`：行为、权限、并发、恢复和目录验收。

## 检查证据

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | 29 文件，244 项通过 |
| `pnpm test:integration` | 11 文件，125 项通过；独立临时真实 PostgreSQL/Redis，解析、向量和模型使用 Mock |
| 结构修复演练 | 非空保护、失败不改 Schema、修复等于全新基线、配置种子保留均通过 |
| 真实 RDS | 结构/账本核对、保留记录摘要、归档未变、外键为 0 通过 |
| 新镜像 | 构建成功；四角色 healthy，API/Admin readiness 200 |
| `git diff --check` | 通过 |

首次集成测试暴露了图片三列唯一约束冲突，修正约束后 125 项全通过；没有修改 fixture 绕过同内容图片场景。测试覆盖三份不同来源路径共享一个对象且只上传一次、全部诊断保留、资产事务失败回滚和重试恢复。

只读核对了 App 的 `Flutter/packages/huahuo_api/lib/src/media/upload_client.dart` 和 `media_resource_client.dart`。上传会话和资源删除对外请求/响应保持不变，没有在 App 运行写入命令。

私有执行证据位于忽略提交的 `.local/database-audit/`：`rehearsal.json`、`rds-preflight.json`、`rds-repair.json`、`migrate-replay.log`、`runtime-after.json` 及质量检查日志。一次性修复脚本不进入应用运行路径。

## 保留项和剩余边界

- `content_events` 和 `rag_chunks` View 的完整消费范围尚未确认，暂保留，不为本轮补建新的同步系统。
- `user_api_keys` 是明确预留的基础表；模型计量两表已有读 API，真实生产者尚待接入，均未误删。
- 保留两类业务 Chunk、正文/TOC/状态、普通 Note 全文查询、LIKE/ILIKE、工作区游标及资源关系。
- 归档清理、数据保留期和过期记录物理回收需要单独确定策略；本轮未触碰历史归档或猜测删除期限。
- 其余同值业务字段、计费预留字段尚需独立确认职责，不将候选项当作已确认无用字段删除。
- 本轮没有调用真实 Embedding、Rerank、MinerU、Volcengine 或真实短信；不将 Mock 测试描述为完整外部服务联调。
