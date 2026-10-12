# 本机环境与 P01 证据

- Server：当前目录 `huahuo-server`，初始仅有 `specs/`；所有实现只写本目录。
- App：同级 `../huahuo-app`，Git root 正确、clean、只读参照；未运行 Flutter 命令、未改文件。
- 主机：macOS arm64；Node `v26.11.0`（宿主工具脚本不作为运行时）；pnpm 不在宿主 PATH。
- Docker CLI：29.9.0；Compose 5.6.0；当前 context 为本机 Colima Unix socket，daemon Linux/aarch64 29.5.2 可达。`docker context` 未切换；未停止其他容器。
- 项目资源：只创建 `huahuo-server-dev` 自己的 `backend` 网络、`pg_data`、`redis_data`、`user_files`。初始化脚本在发现同名资源/已有 `.env.compose.local` 时拒绝重置密码。
- 镜像固定：node:24.14.0-bookworm-slim、postgres:17.9-bookworm、redis:7.4.8-bookworm、pnpm 10.15.1；运行镜像构建 context 为 `.`，`.dockerignore` 排除 App/父目录/specs/秘密。
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
