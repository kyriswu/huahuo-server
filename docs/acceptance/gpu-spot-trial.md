# 北京 T4 单实例真实试申请（2026-11-11）

用户当轮明确要求“可以申请一个试试看吗”。本次仅授权的开发试验已完成：真实创建一台，验证后释放；不启用长期抢卡任务或生产部署。

## 请求与结果

| 项目 | 本次实际配置/结果 |
| --- | --- |
| 地域 | `cn-beijing` |
| 目标 | 一台实例，单张 T4 16 GB 规格 |
| 候选顺序 | `ecs.gn6i-c4g1.xlarge` → `ecs.gn6i-c8g1.2xlarge` → `ecs.gn6i-c16g1.4xlarge` → `ecs.gn6i-c24g1.6xlarge` |
| 网络 | 用户指定同 VPC 的 H/L/F 三交换机和安全组，一份创建请求，库存最优调度 |
| 镜像 | `registry-vpc.cn-beijing.aliyuncs.com/eci_open/nginx:latest` |
| 策略 | `SpotAsPriceGo`，保护期 1 小时；没有切换按量策略 |
| 试验限额 | 一份创建请求；实例运行期限单独设为 900 秒，观察预算 300 秒；就绪后立即释放，无 EIP |
| 实例 ID | `eci-2ze6q98onn7zdlqs0moj` |
| 实际规格 | `ecs.gn6i-c24g1.6xlarge`，24 vCPU、93 GiB 系统内存，规格对应 T4 16 GB；API 返回容器 GPU 数为 1 |
| 实际可用区 | `cn-beijing-h` |
| 启动 | 云端状态 `Running`、容器 `Ready=true`；事件含 `Pulled/Created/Started` |
| 清理 | Delete 请求已受理；随后按实例 ID、独立分配标签两路查询均为 0 |

实际选中了第 4 档。没有保存云端内部逐规格尝试轨迹，不能据此给出前 3 档在各可用区的具体库存结论。[规格依据](https://help.aliyun.com/zh/ecs/user-guide/gpu-accelerated-compute-optimized-and-vgpu-accelerated-instance-families-1)

本机观测时刻（Asia/Shanghai，2026-11-11）：03:05:32 受理，03:06:49 确认就绪并受理删除，03:10:19 独立清理复核。它们是客户端观测时间，本轮没有读取账单金额。

## 补充：时延和价格比较

根据落盘历史，从本地开始申请流程计算：

| 本机观测点（Asia/Shanghai，2026-11-11） | 时间 | 距流程开始 |
| --- | --- | --- |
| 开始申请（含网络预检） | 03:05:30.388 | 0 秒 |
| 收到实例 ID | 03:05:32.542 | 2.154 秒 |
| 日志确认 Running/Ready | 03:06:49.154 | 78.766 秒 |
| 删除请求受理 | 03:06:49.546 | 79.158 秒 |

78.766 秒包含启动期校验错误、排查和同实例恢复；其间只读查看时实例已经 Running，因此这是确认就绪的观测上界，不是精确的纯资源分配耗时。没有保存首次分配资源/进入 Pending/容器启动的准确云端时刻；删除后补查该实例事件返回 0，无法追溯补齐。

03:18—03:20 对北京 H 的只读查询结果如下，单位元/小时。抢占列取自 ECS `DescribeSpotPriceHistory` 在试验时段有效的 03:00 市场记录；按量列来自当前 ECI `DescribeContainerGroupPrice`。第四档 ECI 当前抢占返回值按秒换算为 6.017004 元/小时，与历史市场价 6.017 一致；按量值也与 ECS 历史原价相符。

| 规格 | 抢占市场参考价 | 当前按量参考价 |
| --- | --- | --- |
| 第一档 `ecs.gn6i-c4g1.xlarge` | 4.071 | 11.63 |
| 第四档 `ecs.gn6i-c24g1.6xlarge` | 6.017 | 17.19 |

第四档抢占参考价比第一档多 1.946 元/小时，约 47.8%。第一档 ECI 在 H/L 返回空抢占报价，在 F/未指定可用区时返回 `Spot.NotMatched`；因此 4.071 是历史市场参考，不代表现在能按此价买到。[ECI 查询接口](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-describecontainergroupprice)、[历史价格接口](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-describespotpricehistory)

若把全流程约 79 秒按上述静态市场价估算，第四档约 0.13 元，第一档约 0.09 元，差约 0.04 元。这不是实际账单：ECI 从 Pending 开始计费，早期 Scheduling 不收费，本地全流程时长不能直接等同计费时长；本轮未查询实际结算金额。[ECI 计费说明](https://help.aliyun.com/zh/eci/product-overview/elastic-container-instances)

原始查询和计算口径保存于同一本地目录的 `pricing-and-timing.json`、`spot-history-comparison.json` 和 `price-comparison-summary.json`；没有创建新实例或改变已确认的规格配置。

## 初始化校验问题与恢复

刚受理后，原适配器先报 `InstanceVpcMismatch`，自动释放也被同一校验拦住；未重新发起创建。随后只读查看同一实例，确认实际 VPC、安全组、交换机和归属标签都匹配，且已经 Running。使用已保存的实例 ID 恢复观察和清理，创建分支没有再次执行。

早期失败的原始响应未保存，因此不对当时 VPC 字段的具体值作追溯断言。代码审查确认原逻辑会把缺字段和真实错配统一作为 fatal，现已修复：

- `Scheduling/Pending` 缺少 VPC 或归属标签时，返回可重试的 `InstanceMetadataPending`，继续观察同一实例。
- 已返回的 VPC/标签实际不匹配仍立即拒绝，完整归属确认前不能删除。
- `Running` 等非初始化阶段缺少必要归属元数据仍拒绝，不放宽授权条件。
- 本地试验观察循环同样处理 transient，不因元数据传播延迟重复申请。

原始失败和清理重试保留在状态文件历史中；最终的成功和清理证据不覆盖原始失败。

## 证据与验证边界

忽略提交的本地目录：

`.local/gpu-spot/trials/trial-1794337501794-9921dcf6-b074-40e9-b87b-ebaa5fe70242/`

- `plan.json`：实际试验参数和请求摘要，无凭据。
- `state.json`：落盘检查点、失败、同实例恢复、就绪和删除历史。
- `cleanup-verification.json`：独立 ID/分配标签查询计数均为 0，保留查询 Request ID。
- `result.json`：最终成功/释放汇总，原始失败保留并标注同实例恢复；本地创建意图计数为 1。

真实操作直接使用根 `.env` 的 `ALIYUN_RAM_ACCESS_KEY_ID/SECRET`，没有复制、回显或重置密钥。长期配置仍为 disabled，没有启动 Task/Worker 抢卡循环，没有重建业务容器、迁移数据库或修改 App。

回归通过：104 项 GPU 单元测试、全量 300 项 unit/contract、Typecheck、Lint、Build、diff 检查。一次性试验脚本另有 5 个传输替身场景，覆盖成功释放、启动失败释放、未知提交查证清理、明确拒绝和初始化元数据等待；这些模拟证据不计作真实云端试验。

本次真实验收覆盖 ECI 受理、所选规格与单卡元数据、镜像启动/就绪、归属校验、恢复与释放。Nginx 启动不代表 CUDA、`nvidia-smi`、模型推理或性能验收；持久 Task/Worker 接入仍未实施。修复后的初始化缺字段路径已用替身回归，没有为验证修复再创建第二台实例。
