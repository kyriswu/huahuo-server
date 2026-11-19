# 本地开发

所有命令在 Server 根目录执行。App `../huahuo-ai` 只读；不在父目录创建 workspace，不运行 Flutter build/pub get/test。项目通过 Volta 固定宿主 Node 26.11.0 和 pnpm 10.15.1；编译、测试和运行的 Docker 工具镜像固定为 `node:26.12.1-bookworm-slim`。

## 初始化与启动

日常开发与测试服务器当前共用数据库及云资源。应用镜像和队列配置以目标成功记录与现行 `.env` 为准；历史初始化镜像不作为当前启动依据。新环境从 `0001` 按编号顺序建立，已有环境只追加待执行迁移；已执行 SQL 与 checksum 冻结。

1. `node scripts/preflight-local.mjs` 检查目录与本地 daemon；`bash scripts/ensure-docker-local.sh` 默认不启动、不切 context。Desktop 未运行时可显式 `--start`；现有 Colima 不可达时脚本拒绝启动另一运行时。
2. `docker build --target tooling -t huahuo-server-tooling:p01 .` 创建工具镜像；仅 Server 挂载的 `bash scripts/tooling.sh install --frozen-lockfile` 安装依赖（工具标签沿用 P01，不代表业务镜像版本）。
3. 日常运行统一使用根目录 `.env` 中的阿里云 PostgreSQL 配置，`COMPOSE_PROFILES` 不启用 `local-db`。现有凭据保持不变；新环境参考 `.env.example` 填写配置，示例值不能用作真实密码。需要不同端口时修改本项目 API_HOST_PORT / ADMIN_HOST_PORT 和对应 PUBLIC_BASE_URL，不停止其他服务。`init-local.mjs` 仅用于全新隔离本地测试环境，不能用于当前业务栈。
4. `node scripts/app-reference.mjs`（即 `pnpm app:reference`）建立阶段基线。默认读取 config/app-reference.local.json，不存在时读取 example；相对路径基于 Server。`node scripts/app-reference.mjs --diff` 不更新基线，发现变化返回 1。
5. `pnpm compose:validate`；每阶段先构建镜像并显式执行 `pnpm db:migrate`，再 `docker compose --env-file .env up -d --no-build`；`docker compose --env-file .env ps -a`。正常运行是四个业务角色和 Redis healthy；一次性 migrate 成功退出 0。本地 postgres 不参与业务运行，其旧数据卷保留。

## 开发与验证

- `bash scripts/tooling.sh typecheck` / `lint` / `build` / `test`；typecheck 覆盖 src/tests，lint 覆盖 src/tests/宿主 mjs。
- `node scripts/verify.mjs`（`pnpm verify`）：仅供独立本地测试栈，容器内执行 typecheck、lint、build、unit、contract，随后宿主启动真实 PG/Redis 测试，验证 local/cloud Compose。检测到当前 API 连接云 PG 会失败关闭，不启动测试或重启业务角色；不要为运行旧测试而把当前业务栈切回本地。依赖缺失即失败，不跳过集成测试报全绿。
- `node scripts/integration.mjs`（`pnpm test:integration`）：使用本机已有 `postgres:17.9-bookworm` / `redis:7.4.8-bookworm` 镜像（`--pull=never`），启动独立 tmpfs PostgreSQL 与不持久化 Redis，端口仅映射到回环随机端口；复用 `infra/postgres/init` 创建角色，测试库 `huahuo_test_*` 与每个角色的 32 字节随机凭据仅本次使用。不读取 `.env`、不继承模型或业务凭据，供应商默认 disabled，测试显式 Mock。finally 根据捕获的容器 ID 和本次归属 label 清理临时容器及 `0600` 凭据文件，不删卷、不连接开发/云库；不需要启用旧 `local-db` profile。
- `pnpm test:integration --milvus` 追加独立 Milvus 验证。先拉取 `milvusdb/milvus:v2.6.26`，测试运行器只使用本机已有镜像。Milvus 的数据放在临时容器的 tmpfs，端口仅绑定回环随机端口，测试使用确定性 Embedding。
- `node scripts/container-isolation.mjs`（`pnpm test:container-isolation`）：逐个停止/恢复四角色及 Redis，检查同伴不中断、退出0、503/200、自动恢复、共享卷和路由/镜像边界。它与 E2E 共用旧本地测试栈检查，不允许操作已连接云 PG 的运行角色；只在独立本地测试环境执行。
- Volta 管理的 Node 26.11.0/pnpm 10.15.1 宿主可运行 `dev:api-server` / `dev:admin` / `dev:worker` / `dev:scheduler`（tsx）及对应 `start:*`（编译产物）。新机器先执行 `volta install node@26.11.0`，首次使用 pnpm 时启用 `VOLTA_FEATURE_PNPM=1` 并安装项目 pin 的 pnpm。必须自行提供角色环境；`.env.host.example` 是可选调试模板，默认 PG/Redis 不发布宿主端口。
- P02 已实现 App 登录/管理员身份；P03 已实现持久任务、Outbox、BullMQ Worker/Scheduler 和 demo.digest 基础设施 fixture。真实 AI/ASR/支付/通知仍不可用，不要把 demo.digest 当供应商成功。

## 迁移与数据

`pnpm db:generate descriptive_name` 生成待审查 SQL 文件；不是未经审核的 schema push。`pnpm db:migrate` 运行新的一次性 migrate。迁移锁有等待上限；每个文件事务执行，已应用文件的 checksum 不可变。

后续阶段明确执行：

```bash
docker compose --env-file .env build migrate
docker compose --env-file .env run --rm migrate
docker compose --env-file .env up -d --no-build
```

确认新迁移成功后才启动新代码。四常驻入口从不自动迁移。测试数据由隔离测试自身创建和清理，不提供空操作的开发 seed 命令。

`compose:down` 不带 `-v`，保留卷；`infra:up` / `infra:down` 仅启动/停止本项目 Redis。禁止 prune、down -v、重置凭据或操作未知旧卷。PG 初始化仅空卷运行；修改 env 不会轮换库密码。

## 云 PG 与地址

根目录 `.env` 是当前业务运行的唯一默认配置；`pnpm compose:validate` 只校验拓扑，不连接云。禁用 local-db profile 后没有 postgres 服务/强制依赖，但不会自动停止以前启动的本地 PG；完成数据迁移和校验后应显式停止旧容器并保留卷。角色 `DATABASE_*_URL` 优先于 `DATABASE_URL`，不能残留指向 `postgres` 的覆盖值。实际云连接需准备账号、库、schema 权限、可信 CA 和真实 URL；生产使用 DATABASE_SSL_MODE=verify-full，拒绝连接串 ssl 参数冲突。迁移账号无需 superuser；云管理员应参照 infra/postgres/init 准备角色权限。仅切地址不会迁移数据。

宿主 API=127.0.0.1:3000，Admin=127.0.0.1:3001；业务 PG 地址来自 `.env`，容器内部 Redis=redis:6379（不能使用宿主 127.0.0.1）。池预算 API10 + Admin5 + Worker10 + Scheduler3 = 28，迁移1；每扩 Worker 都增加10。Redis AOF/everysec/noeviction/maxmemory256MB，容器512MB；逻辑DB不是安全隔离。

App 的 HUAHUO_API_BASE_URL 应使用不附加 `/api/v1` 的根地址（endpoint 已含此前缀）；Debug 允许 HTTP，非 Debug 要求 HTTPS。本轮未修改参数或启动 Flutter。默认回环不可用于手机真机/云供应商回调；这些联调按 P15 授权后进行，Admin 保持回环。
