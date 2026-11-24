# 花火 Server 测试集群部署

使用仓库现有 Dockerfile 构建一次 Server 镜像。API、Worker、Scheduler、Admin 各自运行一个 Deployment，迁移使用同一镜像的一次性 Job。每个常驻角色初始一副本。日常本地开发直接运行角色源码，Compose 可选提供数据库和 Redis。 [本地开发](../../docs/runbooks/local-development.md#直接运行源码)

测试和正式环境使用各自的 Kubernetes 集群。两个集群都用 `ns-applications` 部署业务服务，后续用 `ns-monitoring` 部署 Prometheus 和 Grafana。Agent 有独立镜像和发布流程，接入 Kubernetes 时在对应的 GitHub Environment 中设置 `AGENT_K8S_NAMESPACE=ns-applications`。

测试发布入口和宿主配置见 [ACK 发布 Workflow](test-workflow.md)。

## 在测试 ECS 上构建并推送

在已取得目标仓库推送权限的测试 ECS 上运行。Docker CLI 使用该 ACR VPC 域名的现有登录和持久 Buildx builder。确认 K8s 节点的 `kubernetes.io/arch` 与构建平台一致。脚本默认使用 builder 的原生平台。如需指定，第三个参数可以传 `linux/amd64` 或 `linux/arm64`。

从 Server Git 工作区用 Bash 执行。使用已通过现有测试 CI 的完整提交 SHA。命令从该提交归档构建，输出供 Kubernetes 使用的 OCI digest 引用。

```bash
set -euo pipefail
TEST_SHA='填入已通过 CI 的完整 test SHA'
ACR_REPOSITORY='填入已授权的 ACR VPC 域名/命名空间/huahuo-server'
IMAGE=$(bash deploy/k8s/build-and-push.sh "$TEST_SHA" "$ACR_REPOSITORY")
```

GitHub Actions 继续从受保护的 `main` 用现有 OIDC 调用固定云助手命令，只把校验后的 SHA 交给测试 ECS。仓库外的宿主执行器需要接入上面的构建步骤并记录 digest，然后按下面的步骤发布。现有五阶段结果、发布计划、配置检查、迁移验收和认证冒烟是接入契约。Server 和 Agent 同机打包时，宿主应为构建与推送共用一把锁，沿用各自的业务发布锁。 [测试发布接口](../../docs/runbooks/test-server-release.md) · [标准发布](../../docs/runbooks/standard-release.md) · [ACR 私网访问](https://help.aliyun.com/zh/acr/user-guide/configure-access-over-vpcs)

合入分支前按现有发布控制流程审查。当前自动入口会把未识别的 `deploy/` 路径视作需要发布计划的变化。若这次仅合入部署配置，应先从受保护的 `main` 审查对应触发规则。实际迁移仍以测试机最近一次成功发布为基准。

## 首次准备集群

以下命令在持有测试集群权限的 Bash 会话执行。测试 ACK 使用托管 ACR 免密组件，将 `watchNamespace` 设为 `ns-applications`，将 `serviceAccount` 设为 `sa-huahuo-server`，并在 `AcrInstanceInfo` 中配置镜像使用的 ACR 实例和 VPC 域名。组件通过只读 RAM 权限获取并轮换拉取凭据。确认 ServiceAccount 出现 `imagePullSecrets` 后再做镜像冒烟。真实应用配置由已授权环境提供，放在仓库外。 [ACK 免密拉取](https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/non-secret-pulling-container-image)

```bash
TEST_CONTEXT='填入测试集群 context'
CONFIG_DIR='填入已审配置文件所在绝对路径'
K=(kubectl --context "$TEST_CONTEXT" --namespace ns-applications)
ROOT=deploy/k8s

"${K[@]}" get nodes -L kubernetes.io/arch
"${K[@]}" apply -f "$ROOT/manifests/namespace.yaml"
"${K[@]}" apply -f "$ROOT/manifests/service-account.yaml"
"${K[@]}" get serviceaccount sa-huahuo-server -o jsonpath='{.imagePullSecrets[*].name}{"\n"}'

"${K[@]}" apply -f "$ROOT/manifests/network-policy.yaml" -f "$ROOT/manifests/api-service.yaml"
"${K[@]}" create configmap huahuo-config --from-env-file="$CONFIG_DIR/common.env" \
  --dry-run=client -o yaml | "${K[@]}" apply --server-side -f -
"${K[@]}" create secret generic huahuo-redis --from-env-file="$CONFIG_DIR/redis.env" \
  --dry-run=client -o yaml | "${K[@]}" apply --server-side -f -
"${K[@]}" create secret generic huahuo-db-runtime --from-env-file="$CONFIG_DIR/db-runtime.env" \
  --dry-run=client -o yaml | "${K[@]}" apply --server-side -f -
for role in api worker scheduler admin migrate; do
  "${K[@]}" create secret generic "huahuo-$role-env" --from-env-file="$CONFIG_DIR/$role.env" \
    --dry-run=client -o yaml | "${K[@]}" apply --server-side -f -
done
```

- 配置键参考 [示例](config)。先使用隔离的 PostgreSQL、Redis 前缀和对象存储路径做验证。接管现有测试环境时，核对实际 PostgreSQL、Redis 队列地址和前缀、JWT 密钥、对象存储 Bucket 与前缀，以及外部依赖。API 与 Worker 共用 API Secret 中的 `APP_TOKEN_SECRET`。API 与 Worker 应使用现有的 OSS 或其他已验证的共享对象存储。若旧环境用 Compose 本地文件卷，先迁移并验证历史对象可读。
- `common.env` 适合放非敏感的通用配置。API、Worker、Scheduler 和 Admin 从 `Secret/huahuo-db-runtime` 读取 `huahuo_normal` 的 `DATABASE_URL`，各角色的业务凭据放各自的 Secret。迁移 Job 在 `migrate.env` 中使用 `huahuo_migrator` 的 `DATABASE_URL`，并独立设置语句、连接和锁超时。
- 使用私有 RDS CA 时，用 `huahuo-db-ca` ConfigMap 在各 Pod 挂载 `/app/certs/ca.pem`，并在相关配置中指定此路径。ENV 更新会在新 Pod 创建时生效。
- API Service 默认 `ClusterIP`。如果宿主需要用节点私网 IP 回源，先限定 NodePort 只接受可信入口来源，并从实际宿主验证访问边界，再启用下面的补丁。多节点或宿主在节点外时，以实际 CNI 与安全组配置验证来源识别。Admin 仅通过获授权的本地 `kubectl port-forward deployment/huahuo-admin 3001:3000` 或既有私用入口使用。

```bash
"${K[@]}" patch service huahuo-api --type=merge --patch-file "$ROOT/api-nodeport.patch.yaml"
```

启用 NodePort 后，后续的业务发布只更新工作负载。已有集群资源、命名空间或 ServiceAccount 时，先核对现有配置再应用一次性准备命令。

## 已部署后的镜像更新

日常发布以通过 CI 的 Git SHA 构建镜像。新镜像推送 ACR 后，使用返回的 `IMAGE` 更新受影响的 Deployment。配置、Service 和迁移分别随实际变更处理。完成既有预检后，若这次仅有兼容的 API 变更，测试实例可直接更新 API 镜像并检查滚动结果。

```bash
"${K[@]}" set image deployment/huahuo-api api="$IMAGE"
"${K[@]}" rollout status deployment/huahuo-api --timeout=65m
```

随后通过现有测试入口验收并记录该角色的 digest。涉及任务格式或多个角色时，执行下方完整交接流程。

## 从镜像到 Pod

先验证 ACR 拉取和镜像的五个 Node 入口。这个短时 Pod 只读取镜像内文件，不加载业务配置。

```bash
"${K[@]}" run "huahuo-image-check-${TEST_SHA:0:12}" --image="$IMAGE" \
  --image-pull-policy=Always --restart=Never --attach --rm --pod-running-timeout=5m \
  --overrides='{"apiVersion":"v1","spec":{"serviceAccountName":"sa-huahuo-server","automountServiceAccountToken":false}}' \
  --command -- node -e 'const fs = require("node:fs"); for (const role of ["api-server","worker","scheduler","admin","migrate"]) fs.accessSync("dist/entrypoints/" + role + ".js")'
```

渲染器要求 `仓库@sha256:…`。在每个角色正式应用前，可先用 `apply --dry-run=server` 验证 Deployment，迁移 Job 用 `create --dry-run=server` 验证。ACK 的迁移 Job 在既有迁移完成后，将迁移 SQL 显式授给应用角色的对象权限合并授给共享运行账号，迁移历史表只授予查询权。

下面是五阶段发布中的 Kubernetes 操作。接管共享测试环境时，写库前先按现有标准，用同一个镜像 digest、同一份待发布配置逐角色执行 `release-gate config`、用迁移角色执行 `db-preflight`，并核对清单的兼容判断与必要外部检查。宿主可以拉取该 digest 后复用原角色门禁。首次建库或有经审查的待执行迁移时运行 Job。迁移完成或确认没有待执行 SQL 后，完成各角色的 `db-verify` 和业务角色的 `runtime` 检查，再启动或更新业务 Pod。 [现有发布门禁](../../docs/runbooks/standard-release.md#固定执行顺序)

```bash
JOB=$(python3 "$ROOT/render.py" migrate --image "$IMAGE" | "${K[@]}" create -f - -o name)
"${K[@]}" wait --for=condition=complete "$JOB" --timeout=16m
"${K[@]}" logs "$JOB"
```

**首次从 Compose 接管共享环境**时，确认旧 Compose Scheduler 已停、旧 Compose Worker 已停止领取并完成排空，再启用对应的 K8s Deployment。旧 API 可以在协议兼容时继续提供服务，直到新 API 就绪并完成检查。待领取的任务由同一 PG Outbox 和 Redis 队列接续。K8s 里的排空检查只覆盖 K8s Pod，首次切换应同时核对原 Compose 容器状态。

**后续 K8s 发布**时，按清单更新受影响角色。完整发布先更新 Worker。API 提前切换前要确认旧 Worker 已停领、新 Scheduler 已成功扫描且新旧 Schema 和任务格式兼容。

```bash
python3 "$ROOT/render.py" worker --image "$IMAGE" | "${K[@]}" apply -f -
"${K[@]}" rollout status deployment/huahuo-worker --timeout=65m
```

单节点可执行下面的停领检查。多节点发布前先记录旧 Worker Pod，更新后确认这些 Pod 均已自然退出，再继续。

```bash
python3 "$ROOT/wait-worker-handoff.py" --context "$TEST_CONTEXT" --image "$IMAGE" --timeout 300
```

Worker 交接通过后依次更新以下角色。

```bash
python3 "$ROOT/render.py" scheduler --image "$IMAGE" | "${K[@]}" apply -f -
"${K[@]}" rollout status deployment/huahuo-scheduler --timeout=65m

python3 "$ROOT/render.py" api --image "$IMAGE" | "${K[@]}" apply -f -
"${K[@]}" rollout status deployment/huahuo-api --timeout=65m

python3 "$ROOT/render.py" admin --image "$IMAGE" | "${K[@]}" apply -f -
"${K[@]}" rollout status deployment/huahuo-admin --timeout=65m
```

Worker 使用滚动更新，Scheduler 使用单副本 `Recreate`。Worker 收到 SIGTERM 后停止领新任务，继续为在途步骤续租。应用按数据库里的排空预算退出，各角色保留 3,630 秒的 Kubernetes 终止保护上限。单节点应预留新旧 Pod 重叠的资源。若资源只够单份，应安排维护窗口，在旧实例自然退出后再启动新版。最后通过现有测试入口检查未授权访问、已授权读取、SSE 和一条有界任务。回退前核对当前数据与任务格式，使用上一次已验证的镜像和配置，并保留已提交的数据库迁移。
