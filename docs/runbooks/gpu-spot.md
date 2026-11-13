# ECI GPU 抢占式实例底层模块

本轮为用户指定的基础设施增量，只实现 `src/integrations/gpu-spot/`。默认 `GPU_SPOT_PROVIDER=disabled`；尚未注册 Task kind、Worker 消费者、Scheduler 计划或 HTTP/Admin 路由。导入和构造模块不创建实例，不推进其它 Pxx 阶段。

## 云接口与配置

- `CreateContainerGroup` 必须同时设置 GPU `InstanceType` 和 `Container.N.Gpu`，最多 5 个候选规格。每个规格的卡数与镜像 CUDA/驱动兼容性须在选型时确认，不维护静态库存表。[GPU 规格文档](https://help.aliyun.com/zh/eci/user-guide/create-an-instance-by-specifying-the-gpu-type)
- 用户选择 `SpotAsPriceGo`，跟随市场价，资源紧张时价格可达到按量价格。也支持 `SpotWithPriceLimit`，上限最多 3 位小数；保护期默认 1 小时，可设 0。[抢占式实例文档](https://help.aliyun.com/zh/eci/user-guide/create-a-preemptible-elastic-container-instance)
- 显式提供现有安全组、同地域同 VPC 最多 10 个交换机，由 ECI 在可用区和规格中调度。只使用私网，不自动创建 EIP；镜像拉取和外部访问依赖该 VPC 的网络。[创建 API](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-createcontainergroup)
- 默认 `RestartPolicy=Never`、`ActiveDeadlineSeconds=3600`；每次 `acquire` 最多 6 次创建，整体观察预算 10 分钟。指数退避带抖动，初始上界 2 秒、封顶 60 秒。预算在相邻 RPC 之间检查，RPC 另有连接/读取超时；运行时限不是费用封顶。
- 驱动默认由 ECI 选择，可指定 `tesla=580` 这类大版本，不接受完整小版本。官方文档已有 2026 年 11 月驱动变更，不用历史 535/550 示例保证实际驱动。[驱动说明](https://help.aliyun.com/zh/eci/user-guide/create-an-instance-by-specifying-the-gpu-type)

官方 SDK 锁定 `@alicloud/eci20180808@2.1.2`、`@alicloud/openapi-core@1.0.9`、`@darabonba/typescript@1.0.6`。使用 SDK 签名和 HTTPS，关闭 SDK 自身重试，由模块记录并控制每次申请。[官方 SDK](https://help.aliyun.com/zh/eci/developer-reference/overview-2)

创建请求使用签名 POST 表单体，避免官方生成 SDK 默认将所有工作负载参数放进 URL 而触发 HTTP 414；参数、规格顺序和 ClientToken 不变。真实镜像测试发现此问题后新增大环境参数的 SDK 传输回归，GPU 单测现为 105 项，全量 unit/contract 306 项；HTTP 414 的同 token 诊断与解析试验进度见 [解析验收](../acceptance/gpu-parse-trial.md)。

## 已选择的北京 T4 配置与只读预检

用户已确定北京 `cn-beijing`、单张 NVIDIA T4 16 GB、`SpotAsPriceGo`，并明确以下规格优先级，按顺序传入，不能重排：[官方规格表](https://help.aliyun.com/zh/ecs/user-guide/gpu-accelerated-compute-optimized-and-vgpu-accelerated-instance-families-1)

| 优先级 | 规格 | vCPU | 内存 GiB | GPU |
| --- | --- | --- | --- | --- |
| 1 | `ecs.gn6i-c4g1.xlarge` | 4 | 15 | 1 × T4 16 GB |
| 2 | `ecs.gn6i-c8g1.2xlarge` | 8 | 31 | 1 × T4 16 GB |
| 3 | `ecs.gn6i-c16g1.4xlarge` | 16 | 62 | 1 × T4 16 GB |
| 4 | `ecs.gn6i-c24g1.6xlarge` | 24 | 93 | 1 × T4 16 GB |

复用 ECI 官方多规格机制：一次创建请求的 `InstanceType` 是上述有序列表，云端遇到缺货按配置顺序重试；同一请求包含三个交换机，`ScheduleStrategy=VSwitchRandom` 让阿里云按库存选择可用区。目标始终是一台实例，没有向三个交换机分别发送三份并行创建。本地只有在整组申请明确缺货时才换代重试，受理后持续观察同一个实例；未知结果保持原参数/token。完整候选顺序也进入 `requestHash`，恢复时改序会被拒绝。[多规格](https://help.aliyun.com/zh/eci/user-guide/specify-multiple-specifications-to-create-an-elastic-container-instance)、[多可用区](https://help.aliyun.com/zh/eci/user-guide/specify-multiple-zones-to-create-an-elastic-container-instance)

镜像原样使用 `registry-vpc.cn-beijing.aliyuncs.com/eci_open/nginx:latest`，供实例启动和拉取验证；没有据此宣称 GPU 计算或业务模型已经可用。用户给定的 VPC、三个交换机和安全组已保存到忽略提交的 `.env.gpu-spot`（0600），仍为 disabled；这些网络资源的完整 ID 只保存在本地配置和验收文件。

凭据按用户最新指定统一读取根 `.env` 中的 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`，不复制密钥、不读取 OSS 密钥作为替代、不保留另一套 GPU 凭据别名。可选 STS 使用 `ALIYUN_RAM_SECURITY_TOKEN`；运行角色接入时再按需显式注入这些字段。

`GPU_SPOT_VPC_ID` 是必填的目标归属。创建之前，模块并行只读查询每个交换机和安全组，确认 ID、地域及 VPC 一致；任一读取失败或归属不符即停止，不绕过预检。创建参数仍通过 `VSwitchId` 选择 VPC，不发送创建 API 不支持的 `VpcId` 字段。请求摘要与返回实例身份都绑定预期 VPC，后续查询/释放再次核对。另补官方明确的 `OperationDenied.NoStock` 为可重试缺货错误。[交换机查询](https://help.aliyun.com/zh/vpc/developer-reference/api-vpc-2016-04-28-describevswitchattributes)、[安全组查询](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-describesecuritygroupattribute)、[ECI 错误码](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-createcontainergroup)

独立命令只读预检，允许配置文件保持 disabled，不触发申请：

```bash
pnpm build
pnpm gpu:preflight
```

需要 `vpc:DescribeVSwitchAttributes`、`ecs:DescribeSecurityGroupAttribute` 两项只读权限；后续真正申请/观察/释放还需要 ECI 创建/查询/删除权限及相应服务关联角色要求。CLI 只把根 `.env` 指定的 RAM 字段传入 GPU 配置，错误和输出不含密钥或安全组规则全文。

2026-11-11 已使用真实 RAM 凭据运行上述只读命令，退出 0：三个交换机实际位于 `cn-beijing-h`、`cn-beijing-l`、`cn-beijing-f`，当时可用 IP 分别为 4090、4088、4087；三者与安全组均属于目标 VPC。证据为 `.local/gpu-spot/preflight.json`，没有创建/删除资源。它只验证网络归属和对应读取权限，不代表 GPU 库存、镜像拉取、GPU 计算、ECI 写权限或 Task/Worker 已通过验收。

四规格优先级补齐后，当前本地配置、单实例/三交换机请求参数与原网络验收身份的离线一致性校验通过，计划保存在 `.local/gpu-spot/request-plan.json`；该文件不含凭据，未作为创建请求发送，创建开关仍为 disabled。

## 已完成的真实单实例试验

用户随后明确授权试申请。实际创建 `eci-2ze6q98onn7zdlqs0moj`，分配到北京 H 的第 4 档 `ecs.gn6i-c24g1.6xlarge`，API 返回单 GPU、`Running`、容器 `Ready=true`。验证后立即释放；独立按 ID 和分配标签复查均为 0。试验单独使用 900 秒运行期限、一份创建请求，没有改变日常 disabled 配置或开启长期任务。

初次观察出现初始化元数据校验错误，后续以已保存 ID 恢复并清理，没有再次创建。适配器现在将 `Scheduling/Pending` 的缺字段视为可重试，实际归属错配仍拒绝；完整元数据确认前不授权释放。104 项 GPU 单测及全量 300 项 unit/contract 通过。真实时序、原始失败、同实例恢复、清理和 GPU 计算未验证等边界见 [试申请验收](../acceptance/gpu-spot-trial.md)。

用户再次授权的阶段计时已完成：新一轮只创建一台，实际仍为北京 H / 第 4 档；流程至 ID 1.797 秒，至首次 Ready 31.785 秒，自动释放并独立复查为 0。云端拉镜像开始至容器开始运行约 1 秒，但具体 Pulled 事件采集缺失，不能分别承诺镜像拉取/容器创建耗时。实际时序、采集缺口与清理见 [计时验收](../acceptance/gpu-spot-timing.md)；两次试验分别单次创建，不开启常驻任务。

## 调用方式

| 方法 | 结果与边界 |
| --- | --- |
| `submit(spec, session, signal?)` | 保存意图后申请，返回已受理的 ECI 身份，不承诺实例已运行 |
| `acquire(spec, session, options?)` | 申请并观察到 `Running`，处理同步缺货和异步 `ScheduleFailed + NoStock` |
| `describe(ref)` | 查询精确 ID，校验管理与归属标签，只返回状态、私网 IP、规格、就绪标志和事件原因 |
| `waitForRunning(ref, options?)` | 观察已有实例，不创建替代；`Running`、容器就绪、服务健康和任务成功分别判断 |
| `release(ref)` | 验证归属后提交带稳定 token 的 graceful delete，返回只代表请求已受理 |

`AliyunEciGpuProvider.preflight(spec)` 仅执行上述网络查询，可独立调用；正常 `create` 也会自动执行同一校验。

在拥有该任务的 Worker 内按如下形式调用，`persist` 必须由上层真实实现：

```ts
import {
  createGpuSpotModule, loadGpuSpotConfig,
  type GpuAllocationCheckpoint,
} from './integrations/gpu-spot/index.js';

async function acquireForTask(
  taskId: string,
  checkpoint: GpuAllocationCheckpoint | undefined,
  persist: (next: GpuAllocationCheckpoint) => Promise<void>,
  signal: AbortSignal,
) {
  const module = createGpuSpotModule(loadGpuSpotConfig());
  if (!module) throw new Error('GPU_SPOT_NOT_CONFIGURED');
  return module.allocator.acquire(module.spec, {
    allocationId: `gpu:${taskId}`, checkpoint, persist,
  }, { signal });
}
```

同一申请的 `allocationId` 与配置快照必须持久稳定；不得直接接受用户或 LLM 提供的云配置、实例 ID 或凭据。上层按用户/工作区核权，在既有 Task 租约和版本检查下串行执行、续租并保存检查点。当前没有 PG 检查点 Repository、长期自动抢卡任务或内存存储兜底；示例不代表 Worker 已接通。

## 幂等与恢复

每代请求的 64 位 ASCII `ClientToken` 由申请 ID 和代次确定，`requestHash` 绑定规范化配置。检查点保存身份、请求摘要、代次、阶段和云实例/请求 ID，不保存环境变量或密钥。同一检查点更换配置或申请 ID 会在本地拒绝。

| 检查点 | 恢复行为 |
| --- | --- |
| `prepared` | 已保存发送意图，进程恢复时视为可能已发送，保留原 token |
| `unknown` | 超时、5xx、无有效响应，保留原 token 和全部申请参数 |
| `retryable` | 明确的短期限流拒绝，下次仍使用原 token |
| `capacity_unavailable` | 明确拒绝或已确认不收费的异步缺货，下一次先保存新一代意图 |
| `submitted` | 保存了实例 ID，恢复时查询同一实例 |

只有明确缺货才能推进代次；未知提交后的缺货响应仍保留原 token。检查点写入失败会停止后续动作；若云端已受理而结果保存失败，`GpuAllocationError.checkpoint` 带已知实例 ID，交给所属任务对账，不另起申请 ID。[幂等语义](https://help.aliyun.com/zh/ecs/developer-reference/how-to-ensure-idempotence)

`ScheduleFailed` 不收费，云端会在 24 小时后删除其元信息。仅此状态且有 `NoStock`、无余额/配额等明确阻塞事件时自动重试；保留云端失败元信息用于诊断。`Scheduling` 的缺货事件不会触发第二台实例。[生命周期](https://help.aliyun.com/zh/eci/user-guide/lifecycle-of-an-elastic-container-instance)

`Expired`、运行失败、成功退出和即将回收事件均上报，不自动重做业务任务。`SpotDegraded` 或非抢占策略不会作为成功获取结果，已知实例仍可显式释放。回收通知识别 `SpotToBeReleased`，不承诺固定提前量。[事件说明](https://help.aliyun.com/zh/eci/user-guide/custom-events-of-elastic-container-instance)

查询空列表也可能来自 RAM 权限不足，不当作实例不存在：观察继续至超时，释放拒绝动作。释放不强制清理，仅把删除接口明确的实例不存在错误当作删除竞态。取消和超时只停止本地重试/观察，已知云身份保留；上层须继续观察或显式释放。[查询 API](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-describecontainergroups)、[删除 API](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-deletecontainergroup)

## 下一验收点

配置示例为根目录 `.env.gpu-spot.example`，是底层模块接入参考，不是另一份 Compose 部署环境。当前四角色未注入这些配置。真实凭据按本轮决定保留在根 `.env` 的 `ALIYUN_RAM_*` 字段，不放对话、日志或文档。支持 AK 或 STS；需轮换时通过 `EciConnection.credentials` 提供可刷新的凭据源。

受控真实申请、启动/就绪、观察、同实例恢复和释放已通过。下一步按实际业务确认 CUDA/模型镜像、命令及运行预算，再将检查点接入所属 Task/Repository，给 Worker 注入最小配置，验收租约、并发、取消补偿和重启恢复。当前没有启用长期 GPU 任务或修改业务容器。

## 本轮验证（2026-11-11）

- GPU 单元测试共 104 项：首版 83 项，VPC/优先级等 12 项，初始化元数据等待与归属隔离回归 9 项。Mock Provider/SDK、故障注入及真实 SDK 传输替身与真实云端试验分别记录。
- 全量 `pnpm test` 300 项 unit/contract；`pnpm typecheck`、`pnpm lint`、`pnpm build` 和 `git diff --check` 通过。真实只读预检与一次授权的创建/启动/清理试验记录如上。
- 无 Schema/迁移变更，不运行 PG/Redis 集成或业务库操作，不用历史外键/CRUD 验收替代本轮测试。
- App 任务端点及解析入口只读核对，未运行 Flutter。容器未重建，不据此宣称运行镜像已包含模块。
