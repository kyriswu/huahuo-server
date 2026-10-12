# 独立容器与单 Compose 部署规范 · v3

## 0. 这是用户已经明确的交付结构

本机 **huahuo-server 独立后端目录**中的一个根目录 `compose.yaml` 管理下面所有服务。前端参考仓库固定为 https://github.com/kyriswu/huahuo-app ，仅供编码期只读核对，不进入Compose构建上下文或容器挂载。

| 服务名（固定） | 默认长期运行 | 职责 | 网络边界 |
|---|---|---|---|
| `api-server` | 是 | App HTTP API、鉴权、上传下载、SSE、受控Dify工具、已启用的供应商回调 | 例：宿主127.0.0.1:3000→容器3000；发布用可信HTTPS入口 |
| `admin` | 是 | 独立管理员登录、管理API、最小运营网页 | 例：宿主127.0.0.1:3001→容器3000；不默认公网 |
| `worker` | 是 | 消费BullMQ任务：ASR、解析、模型/Dify、支付核验与补偿、通知、清理等 | 无公开业务端口，只容器内健康/就绪 |
| `scheduler` | 是 | 定时计划、Outbox投递、PG失联/过期/待对账任务扫描 | 无公开业务端口；只扫描/投递，耗时调用交worker |
| `postgres` | 本地模式是 | 正式业务、订单、账本、任务及结果 | 无公开端口；`local-db` profile，可用云PG替代 |
| `redis` | 是 | 缓存与队列，明确预算 | 无公开端口；AOF/持久卷/noeviction |
| `migrate` | 否 | 对配置PG执行受锁迁移，成功退出0、失败非0 | 专用DB角色；不接HTTP、不执行开发seed/业务任务 |

**独立容器 ≠ 独立仓库。** 默认一个模块化后端、同一套领域服务，可复用一张镜像并选择不同entrypoint；但三个用户点名的角色必须各有容器。不要用supervisor/PM2/concurrently在一个容器中启动全部角色。`worker`中的受限解析子进程属于任务执行，不是混跑API和管理服务。

## 1. 应用组成

```text
src/apps/api-server.ts     buildApiServer()；没有admin路由
src/apps/admin.ts          buildAdminServer()；不复制App业务路由
src/entrypoints/api-server.ts
src/entrypoints/admin.ts
src/entrypoints/worker.ts
src/entrypoints/scheduler.ts
src/entrypoints/migrate.ts
src/admin-ui/             管理网页模板/静态资源（只admin装载）
src/modules/              业务服务可共用，但路由注册按角色分开
```

可以提供多个 Docker build target，但不强制四份重复Dockerfile。P01至少让四个容器分别启动并提供真实连接/健康检查；P02完成管理员身份，P03完成任务投递消费，P14完成运营台。不能为赶P01进度把后三个容器都执行同一个api-server命令。

构建输出路径、Compose command和pnpm start脚本必须一致，并以实际构建验证。禁止容器启动时在线安装依赖、克隆App或下载工作流源码。

## 2. 路由、鉴权与后台动作

- `api-server`：App `/api/v1`契约、白名单工具/供应商回调、health。`/admin`和`/admin/api/v1`应404（不是把admin藏在需要特殊header的同一公共实例）。
- `admin`：`/admin`网页、`/admin/login`、`/admin/api/v1`、health。App用户token不作管理员身份；管理Session/CSRF/RBAC独立。
- `worker/scheduler`：只服务健康与内部指标；不增加可公网调用的“执行任意任务”HTTP接口。
- 管理动作复用领域服务，写intent/task/outbox并返回taskId；由worker消费。不以admin直接UPDATE订单为paid、直接增加余额的方式绕过账本。
- 接收供应商回调在api-server验签并记录Inbox，再ACK；后续耗时核验/权益变化由worker受控处理，不让回调绕到不公开的admin。
- 独立admin不依赖api-server容器存活才能查询PG或建立任务，也不复制会员/计费逻辑。必要文件预览通过相同权限策略下的StoragePort或授权结果，不直接给客服原始bucket读权限。

## 3. 同一Compose的本地／云PG两种模式

只维护一份服务拓扑，不建立两份逐渐漂移的compose-local/compose-cloud。配置样本使用不同 `.env.compose.*`；debug覆盖文件仅可作为明确选配，不能变成日常需要拼四个Compose启动的前置。

本地配置设置 `COMPOSE_PROFILES=local-db`，URL主机为 `postgres`。云配置不设置该profile，URL使用真实云endpoint与TLS。四个常驻角色和migrate都**不直接depends_on postgres**，这样cloud模式不会引用关闭的profile。migrate对实际DATABASE_URL连接做有限重试并检查迁移版本；常驻角色 `depends_on: migrate: condition: service_completed_successfully`。

redis始终本地容器；示例使用 `depends_on redis: service_healthy` 完成首次启动排序。此顺序只解决启动，不保证运行期间永不掉线；所有客户端仍需配置重连、超时和故障降级。

明确实施并验证这些命令（先有真实代码，后给用户运行）：

```bash
# 独立后端根目录；凭据与精确镜像已由P01准备
# 本地PG配置内COMPOSE_PROFILES=local-db
docker compose --env-file .env.compose.local config --quiet
docker compose --env-file .env.compose.local up -d --build
docker compose --env-file .env.compose.local ps -a

# cloud配置不启用local-db；请勿对生产库擅自运行
COMPOSE_PROFILES='' docker compose --env-file .env.compose.cloud config --quiet
COMPOSE_PROFILES='' docker compose --env-file .env.compose.cloud up -d --build
```

同一机器并列测试两套环境时，使用不同 `COMPOSE_PROJECT_NAME`、宿主端口和卷；不能让测试cloud恢复操作覆盖本地正式数据库。切云不等于自动迁移数据，不自动清除旧PG卷。

## 4. migrate和发布

- 使用一次性`migrate`，只它有迁移凭据，业务角色非superuser。DB角色初始化与迁移分开：本地PG的受控init脚本可生成角色，云PG由有权限的管理员准备。
- 迁移应持有项目级PG锁，遇到并发迁移等待/失败有上限；成功可安全重复执行为no-op，而不是每次都改业务数据。
- 不在API/admin/worker/scheduler入口调用迁移；不自动执行生产seed、drizzle push/drop或破坏性down。
- 初次开发启动可按depends_on串联；后续版本部署必须明确执行目标构建的migrate，再启动应用。不要把昨天`Exited(0)`的旧容器当作本版迁移成功。
- P16应实现受控deploy脚本并记录镜像、schema版本、迁移结果。生产迁移须用户授权；失败不启动与schema不兼容版本。可先扩后收，移除列要确认旧进程已退役。

## 5. 配置、秘密、数据库池与存储卷

.env示例不是线上配置。用显式environment/secret文件把每个角色需要的项传入，不把含商户密钥、PG owner密码的统一env_file灌给所有服务。

- api-server：App身份签名与工具校验、限定供应商回调验签材料、App HTTP配置、业务DB URL和池。
- admin：独立Session secret/管理员身份、管理DB URL、只读或受限配置权限；密钥显示掩码与引用。
- worker：需要的ASR/Dify/支付查询等执行凭据和自己的池、队列范围、并发预算。
- scheduler：任务/outbox/计划所需DB权限与Redis生产者配置；默认不需要Dify/支付私钥或用户文件卷。
- migrate：迁移DB URL与schema资源，其他角色无迁移口令。

本地文件驱动下api-server和worker挂**同一持久命名卷**，且非root UID一致或有明确组权限。admin/scheduler默认不挂用户文件卷。镜像构建时预建存储目录并赋予运行用户权限，不能上线后靠0777解决。跨主机worker不能依赖单机local卷，改用对象存储后再扩到多机。

数据库连接池按四个角色与worker副本数累计评估；默认示例值只是预算起点，不是吞吐保证。Redis容器的逻辑DB和前缀不构成安全隔离；发布时按环境威胁模型加ACL/TLS/网络控制。不能公开队列管理接口或Docker socket。

## 6. 健康、退出、日志与资源

api-server/admin独立HTTP健康；worker/scheduler可在各自容器内部监听3100，彼此端口不会冲突，不做宿主ports映射。worker健康要反映消费循环状态/依赖，scheduler反映最近成功扫描/租约与积压；不要启动一个永远200的“健康小服务器”掩盖主循环已死。

- `/health/live`判断本角色进程是否正常工作，`/health/ready`表达依赖、schema、任务接管等是否就绪。Redis故障可按已明确策略让只读API降级，费用/权限不放开。
- Fastify SIGTERM停止接新请求、收尾有限请求再释放池；SSE通知客户端恢复方式，不无限等连接。
- Worker停止领取并尽量完成/记录当前任务。`worker.close()`本身不替你设置业务超时，应配合任务最大耗时、截止退出和失联恢复；不能无限等待也不能直接丢状态。
- Scheduler停止扫描/投递，写入准确租约状态；事务中断可重领。
- 每容器日志含service/instanceId/traceId与必要task/run/orderId，去掉私人正文和凭据。日志轮换与保留配置，health不回显URL。
- 不设置`container_name`限制横向扩worker；不同role分别resource limit，容器内不使用host网络绕过端口边界。

## 7. 故障验收（本轮规格，须由Codex实际执行）

1. `stop worker`：API/admin继续可用，新合法任务持久queued，不显示完成；恢复worker后只有一个正式结果。
2. `stop api-server`：worker完成已有任务，scheduler继续调度，admin仍可查；App重连取回同一结果。
3. `stop admin`：用户API和处理链不受影响；重启管理Session按政策恢复/重登。
4. `stop scheduler`：worker继续处理旧队列，PG新outbox保留；恢复安全投递。两个scheduler误运行时计划不双发。
5. Redis重启/测试队列丢失：从PG对账，未知外部提交先查询，不盲目再收费。
6. worker两个副本：无重复业务效果，累计池/资源/队列公平性满足测得预算。
7. API上传文件、worker读取、容器重建后下载一致；admin无共享卷仍能执行限权管理。
8. 公共API没有admin路由、App token不进admin、worker/scheduler没有公开任务端口。
9. 无App checkout的干净CI仍可build；App兼容测试基于已登记脱敏fixture，源码读取与实际Flutter解析测试分别记录。

`examples/compose.yaml`为拓扑蓝图。P01须把它落实到后端根目录并完成所有entrypoint/脚本/环境/镜像；本提示词包自身不是已经可运行的服务。

## 8. v3本机开发与资源归属

App位于Server同级../huahuo-app，服务构建仍仅Server `.`，禁止扩大context到Code或挂载App。源码路径不是HTTP地址，APP_LOCAL_PATH不进入container env。

新环境Compose默认 `huahuo-server-dev`；同机已有其他项目不得stop/prune。已有Server数据沿用其project名、卷、口令。需要重建只重建明确属于本项目的容器，不带-v删卷。migrate已退出0是成功状态，不应为让7个服务都显示Up而变成常驻进程。

启动已安装Docker遵循11规范（本机context、权限和有限等待）；源码联调网络遵循12规范（容器HOST=0.0.0.0并不等于宿主必须全网卡发布）。
