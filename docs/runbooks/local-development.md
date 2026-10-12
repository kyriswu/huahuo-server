# 本地开发

所有命令在 Server 根目录执行。App `../huahuo-app` 只读；不在父目录创建 workspace，不运行 Flutter build/pub get/test。本机已有 Node 26，执行宿主工具脚本；编译/测试/运行统一使用 Docker 的 Node 24.14.0、pnpm 10.15.1。

## 初始化与启动

1. `node scripts/preflight-local.mjs` 检查目录与本地 daemon；`bash scripts/ensure-docker-local.sh` 默认不启动、不切 context。Desktop 未运行时可显式 `--start`；现有 Colima 不可达时脚本拒绝启动另一运行时。
2. `docker build --target tooling -t huahuo-server-tooling:p01 .` 创建工具镜像；仅 Server 挂载的 `bash scripts/tooling.sh install --frozen-lockfile` 安装依赖（工具标签沿用 P01，不代表业务镜像版本）。
3. 全新无项目资源时 `node scripts/init-local.mjs` 生成 0600 的 `.env.compose.local`；遇已有文件或同名资源拒绝覆盖。需要不同端口时修改本项目 API_HOST_PORT / ADMIN_HOST_PORT 和对应 PUBLIC_BASE_URL，不停止其他服务。示例配置不能用作真实密码。
4. `node scripts/app-reference.mjs`（即 `pnpm app:reference`）建立阶段基线。默认读取 config/app-reference.local.json，不存在时读取 example；相对路径基于 Server。`node scripts/app-reference.mjs --diff` 不更新基线，发现变化返回 1。
5. `docker compose --env-file .env.compose.local config --quiet`；每阶段先显式执行 migrate，再 `BACKEND_IMAGE=huahuo-server:p03 docker compose --env-file .env.compose.local up -d --no-build`；`docker compose --env-file .env.compose.local ps -a`。正常状态是 6 个常驻 healthy、migrate Exited(0)。

## 开发与验证

- `bash scripts/tooling.sh typecheck` / `lint` / `build` / `test`；typecheck 覆盖 src/tests，lint 覆盖 src/tests/宿主 mjs。
- `node scripts/verify.mjs`（`pnpm verify`）：容器内执行 typecheck、lint、build、unit、contract，随后宿主启动真实 PG/Redis 测试，验证 local/cloud Compose。依赖缺失即失败，不跳过集成测试报全绿。
- `node scripts/integration.mjs`（`pnpm test:integration`）：验证本地资源归属；创建随机 huahuo_test_* 库，使用独立角色和 Redis DB14/15 随机 TTL key；finally 仅删除本次临时库和测试 env。不会 truncate 开发库、flush Redis 或删卷。`.local/` 不入镜像或版本控制。
- `node scripts/container-isolation.mjs`（`pnpm test:container-isolation` / `test:e2e`）：逐个停止/恢复四角色及 Redis，检查同伴不中断、退出0、503/200、自动恢复、共享卷和路由/镜像边界。只适用于本项目开发环境；运行期间本项目会短暂不可用，失败也会尝试恢复当前服务。
- Node 24/pnpm 宿主可运行 `dev:api-server` / `dev:admin` / `dev:worker` / `dev:scheduler`（tsx）及对应 `start:*`（编译产物）。必须自行提供角色环境；`.env.host.example` 是可选调试模板，默认 PG/Redis 不发布宿主端口。
- P02 已实现 App 登录/管理员身份；P03 已实现持久任务、Outbox、BullMQ Worker/Scheduler 和 demo.digest 基础设施 fixture。真实 AI/ASR/支付/通知仍不可用，不要把 demo.digest 当供应商成功。

## 迁移与数据

`pnpm db:generate descriptive_name` 生成待审查 SQL 文件；不是未经审核的 schema push。`pnpm db:migrate` 运行新的一次性 migrate。迁移锁有等待上限；每个文件事务执行，已应用文件的 checksum 不可变。

后续阶段明确执行：

```bash
docker compose --env-file .env.compose.local build migrate
docker compose --env-file .env.compose.local run --rm migrate
docker compose --env-file .env.compose.local up -d --no-build
```

确认新迁移成功后才启动新代码。四常驻入口从不自动迁移。P01 `db:seed:dev` 需要 APP_ENV=development + ALLOW_DEV_SEED=true，当前没有业务 fixture，明确输出 seeded=0。

`compose:down` 不带 `-v`，保留卷；`infra:down` 仅停本项目 PG/Redis。禁止 prune、down -v、重置凭据或操作未知旧卷。PG 初始化仅空卷运行；修改 env 不会轮换库密码。

## 云 PG 与地址

`docker compose --env-file .env.compose.cloud.example config --quiet` 只校验拓扑，不连接云。禁用 local-db profile 后没有 postgres 服务/强制依赖。实际云连接需准备角色、库、schema权限、可信 CA 和真实 URL；DATABASE_SSL_MODE=verify-full，拒绝连接串 ssl 参数冲突。迁移账号无需 superuser；云管理员应参照 infra/postgres/init 准备角色权限。切地址不迁移数据。

宿主 API=127.0.0.1:3000，Admin=127.0.0.1:3001；容器内部 PG=postgres:5432、Redis=redis:6379。池预算 API10 + Admin5 + Worker10 + Scheduler3 = 28，迁移1；每扩 Worker 都增加10。Redis AOF/everysec/noeviction/maxmemory256MB，容器512MB；逻辑DB不是安全隔离。

App 的 HUAHUO_API_BASE_URL 应使用不附加 `/api/v1` 的根地址（endpoint 已含此前缀）；Debug 允许 HTTP，非 Debug 要求 HTTPS。本轮未修改参数或启动 Flutter。默认回环不可用于手机真机/云供应商回调；这些联调按 P15 授权后进行，Admin 保持回环。
