# PostgreSQL 云端切换验收 · 2026-11-03

当前业务 PostgreSQL 已切换到根目录 `.env` 的阿里云配置，不再使用本地 PostgreSQL。

| 项目 | 实际结果 |
| --- | --- |
| Host | `pgm-2ze7o54d25m8kn53no.pg.rds.aliyuncs.com` |
| Port / Database / Schema | `5432` / `huahuo` / `public` |
| PostgreSQL / schema migration | `17.11` / `15` |
| 运行镜像 | `huahuo-server:pg-cloud-20261103` |
| API / Admin / Worker / Scheduler | 全部 `healthy`，实际连接云端 |
| migrate | 成功退出 `0`，没有新增 schema 迁移 |
| 本地 PostgreSQL | `exited`，restart policy=`no` |
| 原本地卷 | `huahuo-server-dev_pg_data` 保留 |

## 数据迁移证据

切换前本地四个角色仍使用 `postgres:5432/huahuo`，云端只有此前复制的一个用户、一个工作区和一份成功 RAG 样本；此前配置修改不等于运行服务已经切换。

本次先核对两边列、主键、外键和 CHECK 约束，再暂停四个写入角色，分别生成完整 custom-format `pg_dump` 备份。目标库事务内锁表，按依赖顺序补齐缺失记录，处理任务与结果/计费预留的循环引用后恢复原始状态；事务提交前以主键和 PostgreSQL `to_jsonb` 对全部源记录逐字段比对。

- 58 张 public 表，源快照合计 **3,770 行**，提交时目标合计 **3,770 行**，新增 **3,566 行**。
- 已有云端样本的正文、ID、哈希和状态无冲突；恢复先前复制丢失精度的原始时间戳，同步 scheduler `last_window` 与任务历史。
- `schema_migrations` 的版本与 checksum 相同，仅保留云端自己的 `applied_at`。
- 不清空任何表、不删除旧数据卷、不重置用户或数据库凭据。
- 保留原 JWT 密钥、会话相关密钥、Redis 前缀和文件卷。未修改解析器、切分、Embedding 或 Milvus 数据。

| 数据 | 迁移后数量 |
| --- | ---: |
| `app_users` / `workspaces` | 各 18 |
| `user_sessions` / `refresh_tokens` | 26 / 22 |
| `tasks` | 411（快照时；恢复后维护任务继续增长） |
| `rag_ingestion_versions` | 3 |
| `rag_parent_segments` | 57 |
| `rag_child_chunks` | 136 |
| active + succeeded + embedding ready + index ready Child | 128 |
| `rag_document_assets` | 75 |
| `content ILIKE '%economic%'` 的 Child | 71 |

迁移目录：`.local/pg-cutover-2026-11-03T08-59-47.500Z-migrate/`，含 `source.dump`、`target-before.dump`、备份 SHA-256、逐表快照和校验统计。目录权限 `0700`，文件 `0600`，不进入 Git。配置回退材料与切换后脱敏检查结果在 `.local/pg-cutover-config/`。云端恢复写入后如需回退，必须先核对新增数据，不能直接回切旧快照。

## 默认运行入口

- `pnpm compose:validate`、`compose:up`、`compose:down`、`db:migrate` 统一读取 `.env`。
- `pnpm infra:up` / `infra:down` 只管理 Redis；取消重复 `compose:cloud:*` 入口。
- `.env` 不配置本地角色 URL 覆盖；api-server/admin/worker/scheduler/migrate 五个角色解析到同一个云端 `DATABASE_URL`。
- `.env` 补齐现有运行凭据和镜像配置，Redis 使用容器服务名 `redis`，保持 `huahuo-dev` 前缀；API/Admin 仍仅绑定 `127.0.0.1`。
- Compose 的本地 PG 保留为显式 `local-db` 测试 profile；默认运行无需填写本地 PG 密码。全新本地卷缺少密码时仍由 PostgreSQL/init 脚本拒绝初始化。
- 旧 integration/E2E/isolation 脚本检查实际 API 的数据库 host，当前云端运行栈会被拒绝，防止误重启角色或清理云开发库；本次未新建测试平台。

主要文件：`package.json`、`compose.yaml`、`.env`（忽略）、`.env.example`、`scripts/docker-project.mjs`、`README.md`、`docs/runbooks/local-development.md`、`p02-identity.md`、`p03-tasks.md`、`p04-billing.md`、`rag-url-ingestion.md`。

## 验证

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | 16 文件 / 58 测试通过（单元与契约） |
| `docker compose --env-file .env config --quiet` | 通过 |
| `docker compose --env-file .env build api-server` | 通过，四个运行角色使用同一镜像 |
| 完整真实数据迁移 | 58 表 / 3,770 源行逐字段校验通过 |
| 停本地 PG 后健康检查 | API `:3000`、Admin `:3001` 均 HTTP 200；四角色 healthy |
| 云端 `pg_stat_activity` | 存在 `huahuo-api-server/admin/worker/scheduler` 四种实际连接 |
| `pnpm test:integration` | 按预期报 `LOCAL_TEST_STACK_REQUIRED`，在测试副作用前停止；未运行集成套件，不能算通过 |
| `git diff --check` | 通过 |

本次未调用付费解析、Embedding、Rerank 服务，未重新执行完整 RAG 搜索。`economic` 数量是云端 PostgreSQL 正文查询证据。

当前按已有 `.env` 的 development 配置运行，共用已有云账号、`DATABASE_SSL_MODE=disable`；这不属于生产最小权限或 TLS 验收。生产部署仍应配置 `verify-full` 与角色权限。未修改阿里云实例配置或账号密码。
