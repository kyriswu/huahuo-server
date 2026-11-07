# 本机环境与 P01 证据

- Server：当前目录 `huahuo-server`，初始仅有 `specs/`；所有实现只写本目录。
- App：同级 `../huahuo-app`，Git root 正确、clean、只读参照；未运行 Flutter 命令、未改文件。
- 主机：macOS arm64；Node `v26.11.0`，由 Volta 项目 pin 管理；pnpm `10.15.1` 由同一 pin 管理。
- Docker CLI：29.9.0；Compose 5.6.0；当前 context 为本机 Colima Unix socket，daemon Linux/aarch64 29.5.2 可达。`docker context` 未切换；未停止其他容器。
- 项目资源：只创建 `huahuo-server-dev` 自己的 `backend` 网络、`pg_data`、`redis_data`、`user_files`。初始化脚本在发现同名资源/已有 `.env.compose.local` 时拒绝重置密码。
- 镜像固定：node:26.12.1-bookworm-slim、postgres:17.9-bookworm、redis:7.4.8-bookworm、pnpm 10.15.1；运行镜像构建 context 为 `.`，`.dockerignore` 排除 App/父目录/specs/秘密。宿主由 Volta 精确 pin v26.11.0；官方 Docker registry 没有 v26.11.0 的对应 bookworm slim 标签，因此容器采用已验证的下一个 Node 26 补丁版本。
- 端口：宿主 3000/3001 空闲，绑定 127.0.0.1；后台角色和 PG/Redis 不发布宿主端口。
- 本地 daemon 可达，不需要启动 Docker Desktop；`ensure-docker-local.sh` 对现有 Colima 只检查，不会启动另一套 runtime。

验证命令和结果：

| 命令 | 结果 |
|---|---|
| `docker compose --env-file .env.compose.local config --quiet` | 通过 |
| cloud env `config --quiet` + JSON 检查 | 通过；无 postgres 服务/依赖 |
| tooling `pnpm typecheck` | 通过 |
| tooling `pnpm lint` | 通过 |
| tooling `pnpm build` | 通过 |
| unit/contract | 7 + 7 tests 通过 |
| 真实 PG/Redis 隔离 integration | 9 tests 通过，随机临时库 finally 清理 |
| container isolation/e2e | 四角色停启、Redis 故障、volume、路由/镜像边界通过 |
| App reference diff | `changedFiles=[]`、commit/status 未变 |

本地真实秘密仅在 `.env.compose.local`（0600、gitignored）；文档不包含密码、CA 或 token。

P05 使用既有本地 Docker/Colima context，镜像 `huahuo-server:p05`。只对本 Compose project 执行 migrate/up，未删除卷；本次迁移版本 6。`.env.compose.local` 仅更新镜像标签与 schema 下限，未输出或重置凭据。

## 2026-10-27 文档入库补充

本轮只改 Server。新增 migration `0009_document_ingestion.sql` 后，`.env.compose.local` 和 Compose 默认最低 schema 调整为 9；本机 Colima 已恢复并执行该迁移；0009 applied、schema 9。已有凭据、数据卷和同级 App 均未重置或修改。

后续 Server-only RAG 入库又增加 `0010_rag_url_ingestion.sql`、`0011_rag_assets.sql` 和 `0012_rag_enriched_assets_and_char_chunks.sql`，当前 Compose 最低 schema 为 12；上面的 P06 记录保留为当时的阶段证据。

## 2026-10-29 Volta / Node 26 验证

- 宿主通过 Volta 使用 Node `v26.11.0`，项目 `package.json` pin Node `26.11.0`、pnpm `10.15.1`；pnpm shim 使用前需设置 `VOLTA_FEATURE_PNPM=1`。
- Docker/Compose 使用存在且已构建验证的 `node:26.12.1-bookworm-slim`。Docker Hub 没有 `node:26.11.0-bookworm-slim` 标签，因此容器采用同一 Node 26 主版本的下一个补丁版本。
- `bash scripts/tooling.sh typecheck`、`lint`、`build`、`test` 通过；`node scripts/verify.mjs` 通过 typecheck、lint、build、39 unit、9 contract、74 real PG/Redis integration，以及 local/cloud Compose 配置校验。
- Compose 四个业务角色已重建并运行在 Node `v26.12.1`，api-server/admin 健康检查通过；PostgreSQL、Redis 数据卷未删除或重置。
