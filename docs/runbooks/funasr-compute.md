# FunASR 算力适配器

Server 的异步转写可以通过 `src/integrations/funasr-compute/index.ts` 选择算力来源。默认 `disabled`。选择 `acs` 时，每轮默认并行提交八个单卡 Job，覆盖北京 H 区 G28Ti、I 区 A10、L20N 和 G28Ti，以及 L 区 G49E、L20、G59 和 L20NE。选择 `fixed` 时，调用同一接口检查已有 GPU 服务的就绪状态。

## 调用与重试

用 `createFunAsrCompute(loadFunAsrComputeConfig())` 创建实例。调用方先持久化本轮算力申请的 `allocationId`，将同一批等待的转写任务绑定到这个 ID。每轮使用一个新 ID，同一轮投递或 Worker 重启时沿用原 ID。

1. 首个待转写请求经现有 Task、Outbox 和 BullMQ 入队。Worker 按当前算力申请的持久记录调用一次 `start(allocationId)`。ACS 按同一 ID 防止重复创建本轮候选。后续转写等待同一轮申请。
2. Scheduler 负责到期投递和补偿。Worker 每次调用一次 `status(allocationId)`，`starting` 时把下一次检查交回现有异步任务流程。ACS 从 Worker 的网络访问候选 Pod 的私网 IP，只有 Pod Ready 且 `/readyz` 返回 `cuda:0` 才会选定胜者。胜者写入 Kubernetes 后，适配器发起败者回收并确认败者已消失，再返回 `ready` 和 `baseUrl`。
3. 转写任务持久化各自的 FunASR 远端任务 ID，并使用同一实例查询和领取结果。等本轮没有待处理或在途转写，结果均已持久化并确认消费，再调用 `release(allocationId)`。返回 `releasing` 时继续用同一 ID 补偿释放，`released` 表示释放完成。固定 GPU 的释放只结束本轮借用。
4. 申请失败时先完成同一轮的 `release`。创建应答不明且无法通过同名 Job 找回时，ACS 将此轮标为失败并清理已观察到的候选。已提交的 Job 有运行期限和完成后 TTL，调用方进程退出时仍可回收。申请记录由调用方补偿释放。

目前交付的是适配器和异步调用协议。首请求分配共享 ID、转写状态投递和空闲释放由接入 P07 时的持久任务流程负责。FunASR 的任务结果保存在获胜实例内，实例失败后需要由业务任务决定如何恢复。

P07 接入时验收录音资产的 [`contentStatus`](../content-assets.md#资产内容状态) 写回。对于尚无正文的录音资产，在创建转写任务的事务中将 `content_assets.processing_status` 写为 `processing`，排队、等待 GPU、转写和自动重试期间保持该值。转写正文和 `ready` 在同一事务保存，转写最终失败且已无自动重试时写 `failed`。GPU 等待与转写进度由任务记录维护，摘要失败不影响已可读的正文。验收时通过资产列表和详情核对状态。

### 异步转写接口与长音频

按 `huahuo-funasr` 提交 `13ea25c` 的契约，Worker 将已认领的音频 Resource 流式提交到 `POST /v1/tasks`。音频上传并暂存后返回 `202` 和 `task_id`。Worker 持久化任务 ID 及所属实例，结束提交步骤，后续访问同一实例的状态和结果接口。旧同步接口保留兼容并已弃用。

主动领取时从 `/v1/tasks/{task_id}/result` 获取完整事件，结果持久化后用 `event_id` 调用 `/v1/tasks/{task_id}/ack`。如启用 `callback_url`，FunASR 发送签名的完整成功或失败事件。接收方验签，按 `event_id` 去重并持久化后返回 `2xx`，FunASR 据此确认消费。任务、结果和幂等键保存在接收提交的进程内，保留原始 Resource 供实例重启后按业务策略恢复。

FunASR 的音频硬上限为六小时，`MAX_AUDIO_SECONDS` 可调低，`MAX_UPLOAD_MB` 单文件默认 1024 MiB。Server 通用上传的业务默认上限为 100 MiB，可通过 `storage.maxUploadBytes` 配置，仍受部署硬上限约束。长音频端到端验收需核对实际上传限制、暂存空间，以及 ACS Job 的运行期限能否覆盖启动、上传、推理和结果确认。使用包含六小时支持的 `nvidia-modern` 发布摘要。当前默认摘要对应此前试跑的镜像。

上游验收报告记录 69 项测试通过，并以约 659 MiB 的六小时 WAV 验证上传、完整解码、查询和 ACK。该用例采用推理替身，目标 GPU 的转写耗时及端到端表现待实测。

## 配置

| 变量 | 含义 |
| --- | --- |
| `FUNASR_COMPUTE_PROVIDER` | `disabled`、`acs` 或 `fixed`，默认 `disabled` |
| `FUNASR_COMPUTE_FIXED_BASE_URL` | 固定 GPU 服务的 HTTP(S) origin |
| `FUNASR_COMPUTE_KUBE_API_URL` | ACS Kubernetes API 的私网 HTTPS origin |
| `FUNASR_COMPUTE_KUBE_CA_FILE` | API Server CA 的只读文件路径 |
| `FUNASR_COMPUTE_KUBE_TOKEN_FILE` | 可轮换的 Kubernetes bearer token 文件路径 |
| `FUNASR_COMPUTE_KUBE_CLIENT_CERTIFICATE_FILE`、`FUNASR_COMPUTE_KUBE_CLIENT_KEY_FILE` | 可替代 bearer token 的客户端证书和密钥文件路径 |
| `FUNASR_COMPUTE_NAMESPACE` | 专用于本适配器的 Kubernetes 命名空间 |
| `FUNASR_COMPUTE_API_SECRET_NAME`、`FUNASR_COMPUTE_IMAGE_PULL_SECRET_NAME` | 目标命名空间内已有的 FunASR API 和镜像拉取 Secret 名称。API Secret 的键为 `API_TOKEN` |
| `FUNASR_COMPUTE_POD_CIDRS` | 允许访问的 ACS Pod 私网 CIDR，多个值用逗号分隔 |
| `FUNASR_COMPUTE_IMAGE` | 可选。必须是固定 SHA-256 摘要的 FunASR 镜像，默认使用本次 A10 实测镜像 |
| `FUNASR_COMPUTE_CANDIDATES_JSON` | 可选。整个数组替换默认八项。每项指定 `model`、`zone`、`driver`，可加 `resources` 指定 `cpu` 和 `memoryGiB`，每轮最多 8 项 |
| `FUNASR_COMPUTE_KUBE_REQUEST_TIMEOUT_MS` | 单次 Kubernetes 请求超时，默认 10000 毫秒 |
| `FUNASR_COMPUTE_STARTUP_TIMEOUT_SECONDS` | 本轮启动期限，默认 600 秒 |
| `FUNASR_COMPUTE_LIFETIME_SECONDS` | 候选 Job 自启动起的最长运行时间，默认 3600 秒 |

默认镜像摘要为 `sha256:cbdfcf5ec862a4857d9852a22ba7fa805292170a060cbefde6c4a837443f9d2c`，每轮所有候选共用一个固定摘要。默认 L20NE 使用 `580.126.09-open`，其余使用 `580.95.05-open`。每个候选申请一张卡，默认候选与省略 `resources` 的自定义候选均使用 4 vCPU 和 15 GiB。对同一卡型和可用区，可以配置多个不同的 CPU 与内存组合。选定胜者并回收其余候选前，一轮最多可能同时占用八张 GPU。

下面的自定义配置同时尝试 I 区 A10 和 L 区 G49E，并为 G49E 提供两个 CPU 与内存档位。

```json
[
  { "model": "A10", "zone": "cn-beijing-i", "driver": "580.95.05-open" },
  { "model": "G49E", "zone": "cn-beijing-l", "driver": "580.95.05-open" },
  { "model": "G49E", "zone": "cn-beijing-l", "driver": "580.95.05-open", "resources": { "cpu": 8, "memoryGiB": 32 } }
]
```

ACS 模式要求 Kubernetes 1.34 或以上。适配器身份仅需目标命名空间的 ConfigMap 读取、创建、更新、删除，Job 读取、列表、创建、删除，以及 Pod 列表权限。运行时通过只读文件提供并轮换 Kubernetes 凭据。Worker 需要能直连对应 VPC 的 Pod IP 和 8000 端口，并由上层 ASR 客户端从可信配置取得同一 API token。 [ACS GPU 配置](https://help.aliyun.com/zh/cs/user-guide/pod-gpu-model-and-driver-version) · [Kubernetes Job 生命周期](https://kubernetes.io/docs/concepts/workloads/controllers/job/)

## 北京可选 GPU 与镜像

单卡显存大于 2 GB 且通过真实 FunASR 转写的组合可纳入常用候选。优先覆盖不同可用区和卡型，再为有需求的卡型补充合适的 CPU 与内存档位。同一卡型在同一区的不同规格可能共用库存。 [ACS 单卡规格](https://help.aliyun.com/zh/cs/user-guide/gpu-families-supported-by-acs/) · [ACS 虚拟节点与交换机](https://help.aliyun.com/zh/cs/user-guide/create-a-virtual-node-and-update-the-switch-configuration)

先从包含六小时改动的 `huahuo-funasr` 版本构建一个 `nvidia-modern` 的 `linux/amd64` 镜像，供北京 ACS 整卡候选共用。`huahuo-funasr` 提交 `13ea25c` 的 `Dockerfile` 使用 PyTorch 2.8.0、CUDA 12.8 和完整模型集，默认 `BATCH_SIZE_S=120`，发布构建检查包含 Blackwell 的 CUDA 内核。L20 与 GN8IS 是同一卡型，ACS 示例和 ACK 接入 ACS 示例分别使用这两个值。 [NVIDIA CUDA 架构矩阵](https://docs.nvidia.com/datacenter/tesla/drivers/latest/cuda-toolkit-driver-and-architecture-matrix.html) · [ACS L20 示例](https://help.aliyun.com/en/cs/user-guide/accelerate-wan2-1-video-generation-with-deepgpu) · [ACK GN8IS 示例](https://help.aliyun.com/zh/cs/user-guide/access-acs-computing-power-in-an-ack-cluster)

以下是阿里云公开列出的北京 NVIDIA 整卡候选。实际能否分配取决于目标集群的虚拟节点、交换机可用 IP、账号配额和当时库存。T4 的 ACS 可用区公开表未列北京，D 区的 PPU 使用独立设备和驱动体系。 [ACS 可用区](https://help.aliyun.com/zh/cs/user-guide/gpu/) · [ACS 驱动版本](https://help.aliyun.com/zh/cs/user-guide/list-of-gpu-driver-versions-supported-by-acs/)

| 卡型 | 北京可用区 | 单卡显存 | 驱动标签 |
| --- | --- | --- | --- |
| `A10` | `cn-beijing-i` | 24 GB | `580.95.05-open` |
| `G49E`、`L20`（`GN8IS`） | `cn-beijing-l` | 各 48 GB | `580.95.05-open` |
| `L20N` | `cn-beijing-i` | 48 GB | `580.95.05-open` |
| `G59` | `cn-beijing-l` | 32 GB | `580.95.05-open` |
| `L20NE` | `cn-beijing-l` | 72 GB | `580.126.09-open` |
| `G28Ti` | `cn-beijing-h`、`cn-beijing-i` | 11 GB | `580.95.05-open` |
| `GU8TF`、`GU8TEF` | `cn-beijing-d` | 96 GB、141 GB | `580.95.05-open` |

表中各卡型均可按 ACS 单卡规格和 FunASR 实测为候选选择 CPU 与内存。优先在已有可调度区扩充候选，纳入 D 区前确认虚拟节点覆盖、Pod 地址允许范围和 Worker 私网连通。若候选因缺货持续 `Pending`，在本轮启动期限内记录 Pod 事件。到期仍无候选就绪时完成本轮释放，再由上层任务按有上限的退避和新 `allocationId` 重试。 [ACS 单卡规格](https://help.aliyun.com/zh/cs/user-guide/gpu-families-supported-by-acs/) · [候选配置](../../src/integrations/funasr-compute/config.ts) · [Job 申请与启动期限](../../src/integrations/funasr-compute/acs.ts) · [ACS GPU 调度事件](https://help.aliyun.com/zh/cs/user-guide/acs-pod-custom-events)

按 `huahuo-funasr` 的 `docs/ask.md` 确认实际 GPU、驱动和 PyTorch CUDA 架构，用代表性公开音频记录转写耗时、显存和主存峰值。运行时按 Pod Ready 和 `/readyz` 返回 `cuda:0` 选定已加载模型的候选。11 GB 的 G28Ti 可先用同一镜像单独验证较小的 `BATCH_SIZE_S`，适配器当前未提供该环境变量的候选级配置。

2 GB 的 ASK/ECI A10 1/12 走独立验证路径，使用 `a10-2gb` 镜像。它使用 CUDA 11.8、轻量中文标点模型和默认 `BATCH_SIZE_S=10`。`huahuo-funasr` 的 `deploy/ask-smoke.yaml` 用 `k8s.aliyun.com/eci-use-specs` 申请 `ecs.sgn7i-vws-m2.xlarge`，该规格为 4 vCPU、15.5 GiB 主存、2 GB 显存，默认 GRID 470 驱动。该路径要求独立的调度入口，并验收 CUDA 次版本兼容和实际推理显存峰值。当前 ACS 适配器申请的是 `nvidia.com/gpu: 1`，更换镜像仅改变容器运行时。 [ECI 规格与驱动](https://help.aliyun.com/zh/ack/serverless-kubernetes/user-guide/create-an-eci-pod) · [A10 vGPU 规格](https://help.aliyun.com/en/egs/vgpu-accelerated-instance-families) · [CUDA 次版本兼容](https://docs.nvidia.com/deploy/cuda-compatibility/latest/minor-version-compatibility.html)

## 验收范围

现有云端记录证明单 A10 可拉取该镜像并启动 FunASR。本轮验收覆盖本机 HTTPS 传输，以及使用 Kubernetes 替身验证并行创建、并发选胜、重启恢复、取消和回收。八候选 Job 竞速、新增卡型的实际库存与真实转写，以及 Worker 到 ACS Pod 的私网路径仍需部署验收。

`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。构建后 `pnpm test` 通过 1,180 项，其中 29 项覆盖本适配器。真实隔离 PostgreSQL 和 Redis 的 `pnpm test:integration` 通过 459 项，跳过 7 项，覆盖现有任务投递、Worker 及 Scheduler 回归。

扩展候选主机规格后，类型检查、Lint、构建和 1,188 项单元与契约测试通过。其中 37 项覆盖算力适配器，包含候选去重、Job 资源和旧申请的恢复与释放。Job 请求使用 Kubernetes 替身验证，新档位的实机分配仍待验收。

默认候选扩至八项后，类型检查、变更文件的 Lint 和 1,188 项单元与契约测试通过。Kubernetes 替身测试从默认配置验证同一轮的八个单卡 Job 并行提交。
