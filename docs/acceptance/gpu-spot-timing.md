# 北京 T4 第二次真实申请：阶段计时（2026-11-11）

用户在首轮试验后明确要求再次实际测试申请、取得资源和镜像启动各阶段。本轮单独创建 **1 台**，从本地申请流程开始到首次观测 `Running/Ready` 为 **31.785 秒**，核验后释放，独立 ID/分配标签两路查询均为 0。没有人工恢复、重复创建或启用长期抢卡。

## 配置与实际结果

- 沿用北京 `cn-beijing`、用户配置的同 VPC 三交换机和安全组、一张 T4 16 GB、四档规格优先级、`SpotAsPriceGo`；一份请求供云端选择规格/可用区。
- 镜像仍为 `registry-vpc.cn-beijing.aliyuncs.com/eci_open/nginx:latest`，`IfNotPresent`，未创建镜像缓存或 EIP。
- 实际实例 `eci-2zed5m58u9c04n1qumjw`，北京 H，第 4 档 `ecs.gn6i-c24g1.6xlarge`，24 vCPU / 93 GiB，API 返回 GPU 数 1、容器 Ready、重启次数 0。
- 创建次数限制 1，观察预算 300 秒、轮询间隔 1000 毫秒、实例运行期限 900 秒；就绪核验后立即删除。
- 根 `.env` 的专用 RAM 凭据仅用于签名，没有复制、回显或变更；长期 `.env.gpu-spot` 仍为 `disabled`。

## 时间线

本机时区为 Asia/Shanghai，以下均为 2026-11-11。客户端时刻记录到毫秒；`Pulling` 和 `currentState.startTime` 是云端返回值，本次只有秒，不能把格式补零当成毫秒精度。

| 阶段 | 本地时间或换算后的云端时间 | 距本地流程开始 | 依据 |
| --- | --- | --- | --- |
| 开始申请流程 | 03:31:25.208 | 0 秒 | 持久化状态 `submitting`，包含网络预检 |
| 调用 ECI 创建 SDK | 03:31:25.637 | 0.429 秒 | SDK 调用前的本地计时点；不是抓包的 HTTP 发包时刻 |
| 收到实例 ID | 03:31:27.005 | 1.797 秒 | 创建响应 |
| 首次读取到完整 VPC / 私网 IP | 03:31:37.105 | 11.897 秒 | 此时状态仍为 Scheduling，不能当作 GPU 已可用 |
| 开始拉取 Nginx 镜像 | 03:31:53 | 约 27.8 秒 | 云端 `Pulling.FirstTimestamp` |
| 容器开始运行 | 03:31:54 | 约 28.8 秒 | 云端 `containers[0].currentState.startTime` |
| 首次确认 Running / Ready | 03:31:56.993 | 31.785 秒 | 查询响应；归属、VPC、容器 Ready 均满足 |
| 规格、单 GPU 数核验完成 | 03:31:57.106 | 31.898 秒 | 再次精确 ID 查询 |
| 删除请求受理 | 03:31:57.584 | 32.376 秒 | Delete 响应 |
| 删除后首次查询为空 | 03:31:57.670 | 32.462 秒 | 已受理删除后的查询 |
| 独立清理复核 | 03:32:47.747 | 82.539 秒 | 实例 ID、唯一分配标签分别查询，均 0 |

ECI 创建 SDK 调用至返回 ID 的单调时钟耗时为 **1.367 秒**；从该调用至首次确认 Ready 为 **31.356 秒**。它们与包含本地准备/网络预检的全流程口径分别记录。

## 阶段耗时与解释

| 阶段 | 本段耗时 | 测量边界 |
| --- | --- | --- |
| 本地准备、检查点落盘与网络预检 | 0.43 秒 | 本地流程开始至 ECI 创建 SDK 调用 |
| 创建请求至拿到实例 ID | 1.37 秒 | 本地单调时钟；仅代表请求受理 |
| 返回 ID 至开始拉镜像 | 约 26 秒 | 包含云端调度/资源准备与运行环境初始化；不能单独归因于缺货或纯 GPU 分配 |
| 拉镜像开始至容器开始运行 | 约 1 秒 | **合并包含镜像拉取、容器创建和启动**，不能拆成各自精确耗时 |
| 容器开始运行至本地看到 Ready | 约 3 秒 | 含控制面状态传播、轮询和查询响应，不能当成 Nginx 自身初始化耗时 |
| 全流程至首次确认 Ready | **31.785 秒** | 本次实际客户端端到端观测 |

主要等待发生在镜像拉取开始之前；本次结果不支持“两三秒机器就可用”的判断，也不构成后续库存、规格或启动耗时保证。

API 只观测到 Scheduling → Running，没有采集到 Pending。`Pulling` 已出现时查询状态仍为 Scheduling，因此状态轮询不能反推出精确的物理 GPU 分配时刻或计费起点。完整 VPC/IP 在较早时刻返回也不等于 GPU 或容器就绪。[实例生命周期](https://help.aliyun.com/zh/eci/user-guide/lifecycle-of-an-elastic-container-instance)

## 事件采集限制

状态查询中的 `Pulling` 事件和容器 `startTime` 已保存。删除前另一次 `DescribeContainerGroupEvents` 返回 `TotalCount=1`，但计时脚本核对返回 ID 时断言失败，未保存该响应中的具体事件。保留请求 ID `01A1C6F2-1B01-549E-BD89-823D878EA7E0` 及原始失败记录；没有根据未知响应臆测字段缺失或实际 ID 错配的原因。删除后补查事件返回 0。

这属于本次计时采集缺口：没有完整的 `Pulled/Created/Started` 事件，无法准确单列“镜像拉取结束”的时刻；上表的约 1 秒必须作为镜像与容器启动合计。一次性采集器已补充在 SDK 转换及字段断言之前先落盘事件响应的白名单投影，本轮没有为验证此补充再创建云资源。[事件查询接口](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-describecontainergroupevents)、[实例查询中的事件及容器字段](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-describecontainergroups)

首轮出现的初始化元数据校验问题，本轮实际经历 9 次 `InstanceMetadataPending` 后自动继续同一实例；没有再报 fatal 或手动恢复。此项真实行为与 104 项 Mock 单测证据分别记录。

## 证据、清理与验证范围

忽略提交的本地目录：

`.local/gpu-spot/trials/trial-1794339062281-07d6e411-16fd-46b2-9efd-7f54c38b76a1/`

- `plan.json`、`state.json`：不可变规格摘要、单次创建检查点及自动观察/释放过程。
- `timing.json`、`timing.ndjson`：请求单调时钟、每次查询的安全字段投影、云端事件及事件采集失败；不保存环境变量或凭据。
- `timing-summary.json`：计算后的时序、阶段耗时、缺失字段和口径限制。
- `cleanup-verification.json`：独立精确 ID/分配标签查询均为 0；请求 ID 分别为 `01A1C6F2-E018-5FF1-978F-CFC87F4FA2C8`、`01A1C6F2-E012-5FF1-AF9B-5EB2DDB24B84`。
- `post-delete-events.json`：事件补查为空的事实记录。

本轮执行后端 `pnpm exec tsc -p tsconfig.build.json` 成功，GPU 单元测试 **104 项通过**；计时脚本以完全截获传输的正常启动、启动失败、提交未知、拒绝、初始化缺字段 5 个场景验证，无真实云调用。最后补充的事件响应先落盘改动仅做语法检查，未另做云端验证；不把模拟结果混作真实时序证据。未重新运行全量 unit/contract 或 PG/Redis 集成测试。

只补本地试验采集和文档，没有改生产模块、App/Task DTO、Schema 或迁移，也未重建或重启四角色/数据库。真实 App HEAD 与两个任务参照文件哈希再次只读核对一致，详见 `../app-reference.md`。未验证 CUDA、模型加载或模型推理；未查询实际账单，本次 Nginx 时序不能直接代表业务模型镜像。
