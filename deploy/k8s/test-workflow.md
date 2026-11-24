# 花火 Server 测试 ACK 发布

从通过 CI 的 `test` 提交构建，使用 ACR VPC 地址推送。ACK 用同一个 digest 执行验收 Job，再滚动更新现有 Deployment。结果记录 Git SHA 和镜像 digest。新环境的一次性空库部署使用下文的首发模式。

## GitHub Actions

既有 **Server CI** 跑类型检查、Lint、应用编译、单元和契约测试，以及独立的 PostgreSQL、Redis 集成测试。集成任务会从发布清单的基准演练迁移。[Server CI](../../.github/workflows/release-smoke-check.yml) · [集成测试入口](../../scripts/integration.mjs)

[Test server release](../../.github/workflows/test-server-release.yml) 使用受保护的 `main` 上的控制代码，部署通过 CI 的 `test` 提交到测试 ACK。它先检查发布意图和兼容清单，取得 OIDC 临时身份后重新核对提交，再调用一次固定云助手命令并等待部署回执。先完成 Node01 发布权限、固定命令和公网入口验收，再合入工作流。合入后从 `main` 手动运行并核对部署回执，通过后再开启 `test` push CI 后的自动发布。

| 变量 | 对应值 |
| --- | --- |
| `TEST_ACK_BUILDER_INSTANCE_ID` | 北京 Node01 ECS 实例 ID |
| `TEST_ACK_RELEASE_COMMAND_ID` | 该 ECS 的固定发布命令 ID |
| `TEST_ACK_AUTO_RELEASE` | 仓库级变量。手动验收通过后设为 `true`。未设置时只接受手动触发 |

专用 RAM 角色 `huahuo-server-test-release` 使用固定 Node01 和保存命令所需的 `InvokeCommand` 与 `DescribeInvocationResults` 权限。保存命令接收唯一参数 `sha`，从受保护的宿主控制目录执行 `verify-from-ecs.sh "$sha" --rollout`。保存命令上限 85 分钟，Actions 轮询上限 87 分钟，STS 会话上限 90 分钟。构建或预检耗时过长、剩余时间不足时，执行器在更新 Deployment 前停止。提交结果不确定或轮询失败时，先查云助手调用和构建机日志。

工作流固定使用 Node01 云账号 `1472289886746775` 的共享 Provider `github-actions`。Provider 使用签发方 `https://token.actions.githubusercontent.com` 和受众 `sts.aliyuncs.com`。同一云账号的仓库共用 Provider，各自的 RAM 角色按仓库 OIDC subject 授权。

## 内网构建 ECS

构建机使用既有的 Git 读权限、Git、Docker/Buildx、jq、Python 3、kubectl 和 flock。Docker 凭据使用已有的 ACR VPC 仓库推送权限。宿主固定命令从受保护的控制版本执行 [verify-from-ecs.sh](verify-from-ecs.sh)，并使用以下宿主配置。

| 变量 | 对应值 |
| --- | --- |
| `HUAHUO_TEST_SOURCE_CHECKOUT` | Server 的专用 Git checkout，`origin` 指向本仓库 |
| `HUAHUO_TEST_ACR_REPOSITORY` | ACR VPC 域名、命名空间和 Server 仓库 |
| `HUAHUO_TEST_ACK_CONTEXT` | 已核验的目标测试 ACK kubeconfig context |
| `HUAHUO_TEST_BUILD_PLATFORM` | 可选，例如 `linux/amd64`，根据测试节点架构设置 |
| `HUAHUO_TEST_ACK_NODE_IMAGE` | 可选，同一 ACR 实例中按 digest 固定的基础镜像 |
| `HUAHUO_TEST_ACK_STATE_DIR` | 可选，默认 `/var/lib/huahuo-test-ack`，存放私有日志和执行锁 |
| `HUAHUO_TEST_ACK_BOOTSTRAP_EMPTY_DB` | 默认 `false`。只有首次部署明确选定的空库时，才在宿主受控配置中设为 `true` |
| `HUAHUO_TEST_ACK_EXPECTED_DB_HOST` | 部署必填，预期测试 RDS 的主机名 |
| `HUAHUO_TEST_ACK_EXPECTED_DB_PORT` | 可选，预期测试 RDS 的端口，默认 `5432` |
| `HUAHUO_TEST_ACK_EXPECTED_DATABASE` | 部署必填，预期测试库名称 |
| `HUAHUO_TEST_ACK_SMOKE_ENV` | 可选，宿主私有的验收账号配置文件，含现有冒烟需要的有效 JWT、用户和工作区 |

宿主核对 `origin/test` 仍是传入的完整 SHA，用 [build-and-push.sh](build-and-push.sh) 从 Git 归档构建并推送，取得 `仓库@sha256:…`。手动发布演练使用 `bash deploy/k8s/verify-from-ecs.sh "$TEST_SHA" --rollout`。只验收候选镜像时省略 `--rollout`。GitHub 发布只接受包含目标 SHA 和 digest 的 `deployed` 回执。构建及验收详情保存在 ECS 的私有状态目录。

## ACK 验收

先在测试集群准备 `ns-applications` 命名空间、镜像拉取凭据、应用 ConfigMap、分角色 Secret 和适用的 CA。ECS 上的 K8s 身份在该命名空间拥有 Job 创建和读取、Pod 查询和读取日志权限。验收数据库应为已初始化的测试库，Redis 队列和外部依赖使用本次选定的测试环境。 [首次准备集群](README.md#首次准备集群)

[verify-candidate.py](verify-candidate.py) 根据现有工作负载清单生成短时 Job，每个 Job 都引用上述同一 digest 和对应角色的环境变量、Secret、CA 与 ServiceAccount。Job 使用专用标签。首轮依次执行以下检查。

1. 五个角色跑 `config`，验证实际注入的配置及清单声明的配置断言。
2. 迁移账号跑 `db-preflight`，验证已执行迁移编号与校验和；API 执行清单声明的只读 `external` 检查。
3. 五个角色跑 `db-verify`，验收目标数据库结构与声明的字段、权限或数据断言。四个运行角色继续执行 `runtime`，验证实际依赖与运行配置。

现有库发布校验上一次成功 SHA 和实际 Deployment digest。发现待执行 SQL、候选不兼容或实际部署偏离记录时停止。待执行迁移按 [测试发布步骤](README.md#从镜像到-pod) 评审并执行，确认完成后再验收镜像。已确认的空库按下文完成首次部署。

字段检查写在本期计划的 `database.verifySql`，由每个角色执行。仓库已有一个简短的例子，检查 `resources.size_bytes` 为 `bigint NOT NULL`。配置值检查写入本期 `configuration.verifyFile`，例如检查实际的搜索索引模式。这两个文件使用本期计划 ID 的目录。日志会分别记录基础数据库断言、附加断言和配置检查的数量。候选清单未声明专项脚本时，附加检查数为零。 [字段例子](../../scripts/release/changes/20261120-worktree-sync/verify-db.sql) · [配置例子](../../scripts/release/changes/20261119-milvus-textless/verify-config.mjs) · [已有门禁实现](../../src/release/gates.ts)

滚动更新前先对所有角色做服务端 dry-run。更新 Worker 后等待新 Pod 就绪、旧 Pod 退出，再依次更新 Scheduler、API 和 Admin。验收 Node01 上的 HTTPS 健康与匿名拒绝，配置了专用账号时继续执行带身份的冒烟。完成后更新 `last-release.json`，Actions Summary 同时记录提交和镜像。中断时先比对实际 Deployment 与成功记录，再处理未完成的发布。

## 首次部署到指定空库

在宿主受控配置中填写首次部署的变量。固定云助手命令仍只接收已通过 CI 的 `sha`。在同一个空测试库配置两个登录账号。`huahuo_migrator` 负责迁移并管理 `public` 的授权，`huahuo_normal` 由四个运行角色共用，提前授予它 `public` 的 `USAGE`。确保现有迁移引用的 `huahuo_api`、`huahuo_admin`、`huahuo_worker`、`huahuo_scheduler` 角色存在。缺失的角色可创建为 `NOLOGIN`。已有高权限账号保持原有登录方式，运行账号无需加入这些角色。目标必须是已确认的测试 ACK context 和 `ns-applications` 命名空间，提前准备 API Service、`ServiceAccount/sa-huahuo-server`、ACR 拉取授权、数据库和应用 Secret、CA、Redis、共享对象存储配置。

首次部署的 Kubernetes 身份还需要在该命名空间查询 API Service 和 ServiceAccount，查询 Pod，创建 Deployment 并观察滚动状态。将初始 API Service 限定为现有 `ClusterIP` 或受控 NodePort，Admin 继续使用私有入口。

1. 使用同一镜像和各角色的真实配置执行只读预检。逐角色确认 DSN 主机名、端口、数据库名、实际数据库账号，拒绝带查询参数或片段的 DSN，以及已有业务对象的数据库。API 与 Worker 使用共享对象存储配置。写库前执行发布清单中的只读外部依赖检查。
2. 迁移 Job 在执行迁移前重新检查目标与空库状态，从 `0001` 开始初始化。完成后合并授予显式的表、列和序列权限，运行账号对 `schema_migrations` 只有查询权限。再按正常预检核对数据库历史和校验和，执行字段、权限和运行时检查。
3. 创建 Worker、Scheduler、API、Admin 四个 Deployment，逐个等待就绪。宿主写入 `first-release.json`，记录实际部署的 SHA 和 digest。Actions Summary 的 SHA 与 digest 同时适用于纯验证模式，部署证据以此记录为准。入口就绪后，用新库的测试用户运行 [现有鉴权冒烟脚本](../../scripts/release/smoke.mjs)，单独记录入口验收结果。

短信验证码保留为独立验收项。本轮 ACK 首发校验短信配置的格式。在新短信服务接入后，另行验证真实下发、验证码校验及失败处理。

首次操作中断时先核对数据库迁移记录、Job、Deployment 和宿主日志。已发生写入或部分部署时，空库检查或已有工作负载检查会停止后续首次执行。普通候选验收仍可按原方式验证已初始化数据库。
