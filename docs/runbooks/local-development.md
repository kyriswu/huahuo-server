# 本地开发

所有命令在 Server 根目录执行。App `../huahuo-ai` 只读；不在父目录创建 workspace，不运行 Flutter build/pub get/test。项目通过 Volta 固定宿主 Node 26.11.0 和 pnpm 10.15.1；编译、测试和运行的 Docker 工具镜像固定为 `node:26.12.1-bookworm-slim`。

## 初始化与启动

默认在本机使用 `huahuo-server-local` Compose 项目。PostgreSQL、Redis、文件存储和各角色凭据归属此项目。新环境从 `0001` 按编号顺序建立，已有环境只追加待执行迁移，已执行 SQL 与 checksum 冻结。

已有克隆可在保留工作区改动后更新到包含本地初始化的 `test` 提交。已有 `huahuo-server-local` 项目时沿用该项目的 `.env`、各角色账号和数据卷。旧 `.env` 指向共享库或其他 Compose 项目时，先将它移到 Git 忽略的 `.local/` 私密目录中归档，再为新的本机项目生成 `.env`。已有服务占用 3000 或 3001 时，可在新 `.env` 调整 `API_HOST_PORT`、`ADMIN_HOST_PORT` 和对应公开 URL。

启动本地 Docker 后安装依赖并初始化新项目。

```bash
pnpm install --frozen-lockfile
node scripts/init-local.mjs
```

初始化生成根目录的 `.env`。其中 `PROCESSING_NODES_ENABLED=false`，处理节点调用与云控制停用。在 `.env` 私下填写 `SMS_FEISHU_WEBHOOK_URL`，测试群机器人启用签名时再填写 `SMS_FEISHU_SIGNING_SECRET`。 [首次准备](../../README.md#首次准备) · [短信配置](sms.md)

```bash
docker compose --env-file .env up -d --wait postgres redis
pnpm compose:up
curl --fail --retry 10 --retry-connrefused http://127.0.0.1:3000/health/ready
curl --fail --retry 10 --retry-connrefused http://127.0.0.1:3001/health/ready
```

Compose 经由一次性 `migrate` 执行迁移，再启动四个应用角色。用 `docker compose --env-file .env ps -a` 检查各角色和迁移退出状态。Admin 使用 `http://127.0.0.1:3001/admin`，首次账号可通过现有 CLI 创建。 [Admin bootstrap](p02-identity.md#管理员-cli-和会话)

如需记录 App 参照，使用 `pnpm app:reference` 建立阶段基线，`pnpm app:reference:diff` 只读比较。隔离测试栈专用的旧 `pnpm verify`、容器隔离及 E2E 脚本继续使用该测试栈自己的 `.env.compose.local`。

## 开发与验证

- `bash scripts/tooling.sh typecheck` / `lint` / `build` / `test`；typecheck 覆盖 src/tests，lint 覆盖 src/tests/宿主 mjs。
- `node scripts/verify.mjs`（`pnpm verify`）：仅供独立本地测试栈，容器内执行 typecheck、lint、build、unit、contract，随后宿主启动真实 PG/Redis 测试，验证 local/cloud Compose。检测到当前 API 连接云 PG 会失败关闭，不启动测试或重启业务角色；不要为运行旧测试而把当前业务栈切回本地。依赖缺失即失败，不跳过集成测试报全绿。
- `node scripts/integration.mjs`（`pnpm test:integration`）：使用本机已有 `postgres:17.9-bookworm` / `redis:7.4.8-bookworm` 镜像（`--pull=never`），启动独立 tmpfs PostgreSQL 与不持久化 Redis，端口仅映射到回环随机端口；复用 `infra/postgres/init` 创建角色，测试库 `huahuo_test_*` 与每个角色的 32 字节随机凭据仅本次使用。不读取 `.env`、不继承模型或业务凭据，供应商默认 disabled，测试显式 Mock。finally 根据捕获的容器 ID 和本次归属 label 清理临时容器及 `0600` 凭据文件，不删卷、不连接开发/云库；不需要启用旧 `local-db` profile。
- `pnpm test:integration --milvus` 追加独立 Milvus 验证。先拉取 `milvusdb/milvus:v2.6.26`，测试运行器只使用本机已有镜像。Milvus 的数据放在临时容器的 tmpfs，端口仅绑定回环随机端口，测试使用确定性 Embedding。
- `node scripts/container-isolation.mjs`（`pnpm test:container-isolation`）：逐个停止/恢复四角色及 Redis，检查同伴不中断、退出0、503/200、自动恢复、共享卷和路由/镜像边界。它与 E2E 共用旧本地测试栈检查，不允许操作已连接云 PG 的运行角色；只在独立本地测试环境执行。
- Volta 管理的 Node 26.11.0/pnpm 10.15.1 宿主可运行 `dev:api-server` / `dev:admin` / `dev:worker` / `dev:scheduler`（tsx）及对应 `start:*`（编译产物）。新机器先执行 `volta install node@26.11.0`，首次使用 pnpm 时启用 `VOLTA_FEATURE_PNPM=1` 并安装项目 pin 的 pnpm。必须自行提供角色环境；`.env.host.example` 是可选调试模板，默认 PG/Redis 不发布宿主端口。
- P02 已实现 App 登录/管理员身份；P03 已实现持久任务、Outbox、BullMQ Worker/Scheduler 和 demo.digest 基础设施 fixture。真实 AI/ASR/支付/通知仍不可用，不要把 demo.digest 当供应商成功。

## 宿主 Node 调试

需要热重载或断点时，可以通过宿主 Node 运行一个或多个角色。准备独立的本机 PostgreSQL 和 Redis，从 `.env.host.example` 创建私密的 `.env.host`，填写各角色的数据库账号和回环连接地址。应用配置来自所选文件，处理节点和云控制缺省关闭。启动 API 前在私密文件中填入团队提供的飞书测试群 webhook。机器人开启签名时同时填写签名密钥。需要热重载后继续使用原有登录会话时，配置固定的本地 Ed25519 JWT 密钥。

已有独立的本机数据库和 Redis 可以直接使用。需要另起依赖时，从 `.env.compose.local.example` 准备私密的 `.env.host.deps`，替换数据库连接和密码占位符。在 `.env.host` 使用相同的数据库角色密码和宿主回环端口。下面的命令为宿主调试启动独立项目，默认发布 PG 15432 和 Redis 16379。

```bash
docker compose -p huahuo-host-dev --env-file .env.host.deps \
  -f compose.yaml -f deploy/local/compose.deps.yaml --profile local-db \
  up -d --wait postgres redis
```

从 `.env.host.migrate.example` 新建私密的 `.env.host.migrate`。迁移连接和 API 连接须指定同一个回环主机、端口和数据库，迁移使用 `huahuo_migrator` 账号。`--check` 查看迁移状态，应用时沿用项目的版本和 checksum 校验。

```bash
pnpm db:sync:local --check
pnpm db:sync:local
```

在不同终端启动需要的角色。API 和 Admin 默认监听回环的 3000 和 3001，Worker 和 Scheduler 使用 3100 和 3101。启动 Admin 页面前可运行 `pnpm build:admin-ui`。

```bash
pnpm dev:local api
pnpm dev:local admin
pnpm dev:local worker
pnpm dev:local scheduler
```

命令接受可选的第二个参数指定环境文件，例如 `pnpm dev:local api .env.host.isolated`。与 Compose 同时运行时，可修改对应的 `API_HOST_PORT`、`ADMIN_HOST_PORT` 和公开 URL，并为宿主配置单独的 `METRICS_PORT` 或设置 `METRICS_ENABLED=false`。

需要 IDE 断点时，可以运行 `node --watch --inspect=127.0.0.1:9229 --enable-source-maps --import tsx deploy/local/run.mjs api`，再附加到 9229。

## 迁移与数据

`pnpm db:generate descriptive_name` 生成待审查 SQL 文件；不是未经审核的 schema push。`pnpm db:migrate` 运行新的一次性 migrate。迁移锁有等待上限；每个文件事务执行，已应用文件的 checksum 不可变。

本机项目更新代码后通过 Compose 构建新镜像并执行待应用迁移。

```bash
pnpm compose:up
docker compose --env-file .env ps -a
```

确认新迁移成功后才启动新代码。四常驻入口从不自动迁移。测试数据由隔离测试自身创建和清理，不提供空操作的开发 seed 命令。

`compose:down` 不带 `-v`，保留卷；`infra:up` / `infra:down` 仅启动/停止本项目 Redis。禁止 prune、down -v、重置凭据或操作未知旧卷。PG 初始化仅空卷运行；修改 env 不会轮换库密码。

## 云 PG 与地址

既有云端联调使用独立配置文件，例如 `docker compose --env-file .env.cloud config --quiet`。云端配置应提供各角色的数据库地址、账号与可信 CA，`DATABASE_*_URL` 优先于 `DATABASE_URL`。生产使用 `DATABASE_SSL_MODE=verify-full`，连接串应省去 `ssl` 参数。账号权限可参照 `infra/postgres/init`。使用共享测试库时，由测试发布流程处理迁移。

宿主 API=127.0.0.1:3000，Admin=127.0.0.1:3001；业务 PG 地址来自 `.env`，容器内部 Redis=redis:6379（不能使用宿主 127.0.0.1）。池预算 API10 + Admin5 + Worker10 + Scheduler3 = 28，迁移1；每扩 Worker 都增加10。Redis AOF/everysec/noeviction/maxmemory256MB，容器512MB；逻辑DB不是安全隔离。

App 使用 `HUAHUO_SERVER` 指定服务根地址，例如 `http://127.0.0.1:3000`。App 自己添加 `/api/v1` 前缀，Debug 支持回环 HTTP，其他地址使用 HTTPS。受保护接口仍由现有可信鉴权入口代理。Admin 使用本机回环地址。
