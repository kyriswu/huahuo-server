# FunASR 算力适配器

Server 的异步转写可以通过 `src/integrations/funasr-compute/index.ts` 选择算力来源。默认 `disabled`。选择 `acs` 时，每轮默认将北京 H、I、L 区的八个单卡候选分为 3、3、2 三批，批内并行申请。选择 `fixed` 时，调用同一接口检查已有 GPU 服务的就绪状态。

## 调用与重试

用 `createFunAsrCompute(loadFunAsrComputeConfig())` 创建实例。调用方先持久化本轮算力申请的 `allocationId`，将同一批等待的转写任务绑定到这个 ID。每轮使用一个新 ID，同一轮投递或 Worker 重启时沿用原 ID。

1. 首个待转写请求经现有 Task、Outbox 和 BullMQ 入队。Worker 按当前算力申请的持久记录调用一次 `start(allocationId)`，提交第一批候选。同一 ID 防止重复创建，后续转写等待同一轮申请。
2. Scheduler 负责到期投递和补偿。Worker 调用 `status(allocationId)`，返回 `starting` 时由现有异步任务流程安排下一次检查。当前批候选全部终止，或达到当前批启动期限仍未选定胜者时，适配器在确认本批 Job 和 Pod 均已回收后提交下一批。候选须 Pod Ready 且 Worker 通过 Pod 私网 IP 访问 `/readyz` 得到 `cuda:0` 才能获选。胜者写入 Kubernetes 后，适配器确认同批其余候选已回收，再返回 `ready` 和 `baseUrl`。
3. 转写任务持久化各自的 FunASR 远端任务 ID，并等待签名回调。仅在回调等待期限已过且本地没有终态时，才向提交任务的原实例查询兜底。等本轮没有待处理或在途转写，结果均已持久化并确认消费，再调用 `release(allocationId)`。返回 `releasing` 时继续用同一 ID 补偿释放，`released` 表示释放完成。固定 GPU 的释放只结束本轮借用。
4. 全部候选批次用完仍未就绪时，本轮失败。创建应答不明且无法通过同名 Job 找回时，本轮进入失败清理流程。失败或取消后调用 `release(allocationId)` 完成释放，已提交的 Job 另有运行期限和完成后 TTL。需要继续等待算力时，由上层任务按有上限的退避策略使用新 `allocationId` 重试。

Server 默认关闭转写。启用后，创建符合条件的无正文音频资产会在同一事务登记任务与 Outbox。Worker 按需创建共享算力申请，后续任务复用同一轮。算力失效或被抢占时，尚未提交的任务可以换用新算力。已提交任务继续从原实例领取结果，远端任务丢失且本地没有回调结果时标记为失败，保留原始 Resource，当前不自动换 Pod 重转写。

P07 接入时验收录音资产的 [`contentStatus`](../content-assets.md#资产内容状态) 写回。对于尚无正文的录音资产，在创建转写任务的事务中将 `content_assets.processing_status` 写为 `processing`，排队、等待 GPU、转写和自动重试期间保持该值。转写正文和 `ready` 在同一事务保存，转写最终失败且已无自动重试时写 `failed`。GPU 等待与转写进度由任务记录维护，摘要失败不影响已可读的正文。验收时通过资产列表和详情核对状态。

### 异步转写接口与长音频

按 `huahuo-funasr` 提交 `13ea25c` 的契约，Worker 将已认领的音频 Resource 流式提交到 `POST /v1/tasks`，每次都带由 Server 私网入口生成的 `callback_url`。Server 在提交前持久化关联标识，以便处理比 `202` 更早到达的回调。Worker 保存返回的 `task_id` 和所属实例，任务尚无终态时才进入 `waiting_external`，随后继续处理其他任务。旧同步接口保留兼容并已弃用。

FunASR 完成后发送带 HMAC 签名的完整成功或失败事件。Server 验签、核对提交与任务关联，按 `event_id` 幂等保存，事务成功后返回 `2xx` 确认消费。正常回调路径不查询 FunASR。

等待期限已过且本地没有终态时，Scheduler 才投递兜底任务。Worker 直接从原实例的 `/v1/tasks/{task_id}/result` 获取事件。`409` 表示尚未完成，按有上限的退避重试。`410` 时先核对本地是否已通过回调查收。兜底结果复用回调的写入事务，持久化后再用 `event_id` 调用 `/v1/tasks/{task_id}/ack`。任务、结果和提交幂等键保存在接收提交的进程内，保留原始 Resource 供实例重启后按业务策略恢复。

FunASR 的音频硬上限为六小时，`MAX_AUDIO_SECONDS` 可调低，`MAX_UPLOAD_MB` 单文件默认 1024 MiB。Server 通用上传的业务默认上限为 100 MiB，可通过 `storage.maxUploadBytes` 配置，仍受部署硬上限约束。长音频端到端验收需核对实际上传限制、暂存空间，以及 ACS Job 的运行期限能否覆盖启动、上传、推理和结果确认。启用回调配置时，默认使用下文已在 A10 验证异步转写的 `gpu-standard` 发布摘要。

上游验收报告记录 69 项测试通过，并以约 659 MiB 的六小时 WAV 验证上传、完整解码、查询和 ACK。该用例采用推理替身，目标 GPU 的转写耗时及端到端表现待实测。

## 配置

| 变量 | 含义 |
| --- | --- |
| `FUNASR_COMPUTE_PROVIDER` | `disabled`、`acs` 或 `fixed`，默认 `disabled` |
| `FUNASR_CALLBACK_SECRET` | 仅 api-server。签名验证用共享密钥，启用时必填，与 FunASR 的 `CALLBACK_SECRET` 相同 |
| `FUNASR_API_TOKEN` | 仅 Worker。提交、查询及 ACK 使用，与 FunASR 的 `API_TOKEN` 相同 |
| `FUNASR_TASK_CREDITS` | 仅 api-server。每笔任务预计保留的额度，默认 0。设为正数时使用现有计费账本，任务失败或取消后释放 |
| `FUNASR_CALLBACK_WAIT_MS` | 仅 Worker。收到 202 后等回调多久才补查，默认 120000 毫秒 |
| `FUNASR_TASK_TIMEOUT_MS`、`FUNASR_UPLOAD_TIMEOUT_MS` | 仅 Worker。单笔转写和单次上传的等待预算，默认 1800000 和 120000 毫秒 |
| `FUNASR_IDLE_MS` | 仅 Worker。最后一笔在途任务结束后的算力复用窗口，默认 10000 毫秒 |
| `FUNASR_COMPUTE_FIXED_BASE_URL` | 固定 GPU 服务的 HTTP(S) origin |
| `FUNASR_COMPUTE_KUBE_API_URL` | ACS Kubernetes API 的私网 HTTPS origin |
| `FUNASR_COMPUTE_KUBE_CA_FILE` | API Server CA 的只读文件路径 |
| `FUNASR_COMPUTE_KUBE_TOKEN_FILE` | 可轮换的 Kubernetes bearer token 文件路径 |
| `FUNASR_COMPUTE_KUBE_CLIENT_CERTIFICATE_FILE`、`FUNASR_COMPUTE_KUBE_CLIENT_KEY_FILE` | 可替代 bearer token 的客户端证书和密钥文件路径 |
| `FUNASR_COMPUTE_NAMESPACE` | 专用于本适配器的 Kubernetes 命名空间 |
| `FUNASR_COMPUTE_API_SECRET_NAME`、`FUNASR_COMPUTE_IMAGE_PULL_SECRET_NAME` | 目标命名空间内已有的 FunASR API 和镜像拉取 Secret 名称。API Secret 的键为 `API_TOKEN` |
| `FUNASR_COMPUTE_CALLBACK_ORIGIN` | ACS Pod 能访问的 Server 私网 HTTP(S) origin，仅含协议、主机和端口。设置后，每个候选 Pod 通过 `CALLBACK_ALLOWED_ORIGINS` 限定回调目的地，并从现有 API Secret 的 `CALLBACK_SECRET` 键读取独立签名密钥 |
| `FUNASR_COMPUTE_POD_CIDRS` | 允许访问的 ACS Pod 私网 CIDR，多个值用逗号分隔 |
| `FUNASR_COMPUTE_IMAGE` | 可选。必须是固定 SHA-256 摘要的 FunASR 镜像。启用回调后，覆盖镜像须支持签名回调 |
| `FUNASR_COMPUTE_CANDIDATES_JSON` | 可选。整个数组按给定顺序替换默认八项。每项指定 `model`、`zone`、`driver`，可加 `qos`（`default` 或 `best-effort`，省略为 `default`）和 `resources`（`cpu`、`memoryGiB`），每轮最多 8 项 |
| `FUNASR_COMPUTE_BATCH_SIZE` | 每批并行候选数，默认 3，支持 1–8 |
| `FUNASR_COMPUTE_KUBE_REQUEST_TIMEOUT_MS` | 单次 Kubernetes 请求超时，默认 10000 毫秒 |
| `FUNASR_COMPUTE_STARTUP_TIMEOUT_SECONDS` | 每批启动期限，默认 600 秒 |
| `FUNASR_COMPUTE_LIFETIME_SECONDS` | 候选 Job 自启动起的最长运行时间，默认 3600 秒 |

配置回调 origin 后，默认镜像摘要为 `sha256:58492f5445e18d102718de536b110b12fbc03278e94a41bc55e73f75d4349cbf`，原有未配置回调的调用沿用 `sha256:cbdfcf5ec862a4857d9852a22ba7fa805292170a060cbefde6c4a837443f9d2c`。每轮所有候选共用一个固定摘要。每个默认候选使用 `580.95.05-open` 驱动，申请一张卡、4 vCPU 和 15 GiB。自定义候选省略 `resources` 时也使用这组资源。同一卡型、可用区和资源规格可以各列一个 `default` 和 `best-effort` 候选，也可以配置不同的 CPU 与内存组合。默认同一时间最多可能占用三张卡。

| 默认批次 | 按顺序配置的候选 |
| --- | --- |
| 第一批 | I 区 A10 `default`、H 区 G28Ti `best-effort`、L 区 G49E `default` |
| 第二批 | I 区 A10 `best-effort`、I 区 G28Ti `default`、L 区 G59 `default` |
| 第三批 | L 区 L20 `default`、I 区 L20N `default` |

首批覆盖三个可用区并包含已有启动记录的 A10。适配器在 Pod 模板设置 `alibabacloud.com/compute-class: gpu`，用 `alibabacloud.com/compute-qos` 指定算力质量。`best-effort` 使用动态库存，运行中回收前约五分钟会产生 `BestEffortToBeReleased` 事件。整轮等待时间取决于实际尝试的批数、回收确认和轮询间隔。 [ACS 算力质量](https://help.aliyun.com/zh/cs/user-guide/acs-pod-instance-overview) · [BestEffort 回收](https://help.aliyun.com/zh/cs/user-guide/besteeffort-instance-overview)

L 区 L20NE 可通过自定义配置使用，驱动为 `580.126.09-open`。以下示例将默认列表替换为 I 区 A10 的两档算力质量与 L 区 L20NE。

```json
[
  { "model": "A10", "zone": "cn-beijing-i", "driver": "580.95.05-open" },
  { "model": "A10", "zone": "cn-beijing-i", "driver": "580.95.05-open", "qos": "best-effort" },
  { "model": "L20NE", "zone": "cn-beijing-l", "driver": "580.126.09-open", "resources": { "cpu": 8, "memoryGiB": 32 } }
]
```

ACS 模式要求 Kubernetes 1.34 或以上。适配器身份仅需目标命名空间的 ConfigMap 读取、创建、更新、删除，Job 读取、列表、创建、删除，以及 Pod 列表权限。运行时通过只读文件提供并轮换 Kubernetes 凭据。Worker 需要能直连对应 VPC 的 Pod IP 和 8000 端口，并由上层 ASR 客户端从可信配置取得同一 API token。 [ACS GPU 配置](https://help.aliyun.com/zh/cs/user-guide/pod-gpu-model-and-driver-version) · [Kubernetes Job 生命周期](https://kubernetes.io/docs/concepts/workloads/controllers/job/)

启用时为 api-server 和 Worker 设置同一 `FUNASR_COMPUTE_PROVIDER`，并验证 FunASR Pod 能通过私网主动访问 Server 的 `/internal/v1/funasr/callbacks/…`。固定 GPU 在自身部署中设置 `CALLBACK_ALLOWED_ORIGINS` 和 `CALLBACK_SECRET`。两种算力来源共用同一业务流程。切换算力配置前，先让原 Worker 完成在途任务与回收。现有 Kubernetes 凭据路径由 Worker 的只读挂载提供。

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

表中各卡型均可按 ACS 单卡规格和 FunASR 实测为候选选择 CPU 与内存。优先在已有可调度区扩充候选，纳入 D 区前确认虚拟节点覆盖、Pod 地址允许范围和 Worker 私网连通。候选持续 `Pending` 时应查看 Pod 事件，确认库存、配额和调度约束。 [ACS 单卡规格](https://help.aliyun.com/zh/cs/user-guide/gpu-families-supported-by-acs/) · [候选配置](../../src/integrations/funasr-compute/config.ts) · [Job 申请与启动期限](../../src/integrations/funasr-compute/acs.ts) · [ACS GPU 调度事件](https://help.aliyun.com/zh/cs/user-guide/acs-pod-custom-events)

按 `huahuo-funasr` 的 `docs/ask.md` 确认实际 GPU、驱动和 PyTorch CUDA 架构，用代表性公开音频记录转写耗时、显存和主存峰值。运行时按 Pod Ready 和 `/readyz` 返回 `cuda:0` 选定已加载模型的候选。11 GB 的 G28Ti 可先用同一镜像单独验证较小的 `BATCH_SIZE_S`，适配器当前未提供该环境变量的候选级配置。

ACS ImageCache 可选用于缩短镜像拉取。阿里云当前只为 `G59`、`G49E`、`L20`（`GN8IS`）提供 `linux/amd64` GPU 镜像缓存，使用缓存的加速费用覆盖 Pod 的完整计费时长，超出地域免费额度还会产生缓存存储费。先记录分配 GPU、镜像拉取完成和 `/readyz` 三个时间点。评估缓存时，用同一固定镜像摘要做对照，读取 Pod 的 `image.alibabacloud.com/matched-image-caches` 注解确认命中。以省下的算力费和整段缓存费比较是否划算。本轮未启用或创建缓存。 [ACS 镜像缓存支持范围与计费](https://help.aliyun.com/zh/cs/user-guide/accelerate-acs-pod-startup-using-image-caching)

2 GB 的 ASK/ECI A10 1/12 走独立验证路径，使用 `a10-2gb` 镜像。它使用 CUDA 11.8、轻量中文标点模型和默认 `BATCH_SIZE_S=10`。`huahuo-funasr` 的 `deploy/ask-smoke.yaml` 用 `k8s.aliyun.com/eci-use-specs` 申请 `ecs.sgn7i-vws-m2.xlarge`，该规格为 4 vCPU、15.5 GiB 主存、2 GB 显存，默认 GRID 470 驱动。该路径要求独立的调度入口，并验收 CUDA 次版本兼容和实际推理显存峰值。当前 ACS 适配器申请的是 `nvidia.com/gpu: 1`，更换镜像仅改变容器运行时。 [ECI 规格与驱动](https://help.aliyun.com/zh/ack/serverless-kubernetes/user-guide/create-an-eci-pod) · [A10 vGPU 规格](https://help.aliyun.com/en/egs/vgpu-accelerated-instance-families) · [CUDA 次版本兼容](https://docs.nvidia.com/deploy/cuda-compatibility/latest/minor-version-compatibility.html)

## 验收范围

此前单 A10 试跑验证了当时镜像的拉取与模型就绪。最新 `gpu-standard` 的独立云端验证见下文。

下文 Node01 实测使用 2026-11-25 当时的批次和算力质量。当前三批默认候选的云端库存仍待验证，尤其是 H 区 G28Ti 和 I 区 A10 的 `best-effort` 库存。

`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。构建后 `pnpm test` 通过 1,180 项，其中 29 项覆盖本适配器。真实隔离 PostgreSQL 和 Redis 的 `pnpm test:integration` 通过 459 项，跳过 7 项，覆盖现有任务投递、Worker 及 Scheduler 回归。

扩展候选主机规格后，类型检查、Lint、构建和 1,188 项单元与契约测试通过。其中 37 项覆盖算力适配器，包含候选去重、Job 资源和旧申请的恢复与释放。Job 请求使用 Kubernetes 替身验证，新档位的实机分配仍待验收。

初版八候选并行方案以 Kubernetes 替身验证同一轮提交八个单卡 Job，当时的类型检查、变更文件的 Lint 和 1,188 项单元与契约测试通过。

分批方案通过类型检查、变更文件的 Lint、构建和 1,194 项单元与契约测试。其中 43 项覆盖算力适配器，验证默认 3、3、2 批次、上一批回收后推进、首批胜出后停止后续申请，以及写入响应丢失和轮询取消时的恢复。

### Node01 实机验证（2026-11-25）

Node01 使用本仓构建后的适配器连接北京测试 ACS 集群，以 `FUNASR_COMPUTE_IMAGE` 覆盖为 `gpu-standard` 发布摘要 `sha256:58492f5445e18d102718de536b110b12fbc03278e94a41bc55e73f75d4349cbf`，源提交为 `1fde9be`。候选仍按默认分批，测试每批启动上限设为 300 秒，单个 Job 最长运行 900 秒。使用 Node01 已有的 Node 容器，在宿主机网络直接访问 Pod 私网地址。公用样例来自镜像内模型随附的普通话 WAV，并按模型清单验证 SHA-256。 [镜像发布回执](https://github.com/kyriswu/huahuo-funasr/actions/runs/45625249683/job/139244043213)

| 环节 | 实测结果 |
| --- | --- |
| 申请与选胜 | 首批提交 A10、G28Ti、G49E 三个 Job，北京 I 区 A10 获胜。其余两项持续 `Pending`，胜出后回收，第二、三批未提交。 |
| 镜像与模型 | A10 的 `Pulling` 到 `Pulled` 事件间隔约 1 秒，`Started` 到首次观察到 `Ready` 约 34 秒。首次观察到 `Ready` 距申请约 52 秒，其他候选回收确认后约 55 秒交付地址。 |
| 真实转写 | Node01 直连 `/readyz` 得到 `cuda:0`。4.523 秒公开样例提交返回 `202`，约 3 秒的轮询间隔后取得 15 字、1 段转写结果。ACK 返回 `200`，再次取结果返回 `410`。 |
| 回收 | 主动释放约 22 秒后，本轮 Job、Pod、ConfigMap 均为 0。临时 API 和镜像拉取 Secret 已删除，云助手退出码为 0。整次运行约 80 秒。 |

本地脱敏记录为 `.local/funasr-acs-gpu-standard-smoke/smoke-events.jsonl`。本次走主动查询和 ACK，验收范围为 Node01 执行适配器和真实 GPU 推理。Server 转写链路另用隔离 PostgreSQL、Redis 和 FunASR HTTP 替身验证。真实跨集群回调、长录音与镜像缓存命中仍待独立验收。本次未开启 ACS ImageCache，拉取事件仅代表这一轮的观测。

### 新版 gpu-standard 的 A10 mmap 对照（2026-11-25）

Node01 在北京 I 区顺序申请两个新 Pod。同一物理 A10、4 vCPU、15 GiB、驱动 `580.95.05`、同一镜像摘要 `sha256:79b67dbe71f5f733fd75aa125bde89c27c9e35118ac2032c7e13e7cef41afc9f`，只切换 `MODEL_CHECKPOINT_MMAP`。每轮都处理同一段 4.523 秒公开模型样例，使用 150 毫秒间隔查询完成结果并 ACK。 [镜像发布](https://github.com/kyriswu/huahuo-funasr/actions/runs/45644740642)

| 测量项（秒） | `mmap=0` | `mmap=1` |
| --- | ---: | ---: |
| Job 提交到首次观察到 Pod Ready | 51.415 | 51.407 |
| FunASR 内部启动 | 30.595 | 29.855 |
| 导入 PyTorch／FunASR | 1.819／4.444 | 1.645／4.431 |
| CUDA 初始化／模型校验 | 0.217／2.845 | 0.216／2.871 |
| 加载 ASR／VAD | 2.388／0.021 | 2.232／0.021 |
| 加载标点／说话人模型 | 17.986／0.219 | 17.569／0.220 |
| 提交音频到首次读到结果 | 1.154 | 1.166 |
| FunASR 报告的 `processing_seconds` | 0.921 | 0.921 |

ASR 和标点检查点实际使用 mmap，VAD 和说话人检查点继续走标准读取。正文、分段、时间戳和说话人字段的完整 SHA-256 相同。内部启动短了 0.740 秒，Job 到就绪与首条结果时间近似持平。每个配置各测一次，第二轮可能受底层页缓存影响。两轮的 Job、Pod 和临时 Secret 均已确认回收。完整分段与回收记录位于 `.local/funasr-mmap-ab-20261125233333/comparison.json`。
