# v0.2.0 录音卡后端联调与验收

同一账号在不同手机登录时共用录音卡绑定。账号可以持有多张卡，每张卡同时只有一个有效所有者。解绑结束本次绑定，换绑生成新的绑定 ID。已归档的资产和原音继续归入库时的账号。[飞书评审稿](https://r1mn4zjib7v.feishu.cn/docx/EZWvdz0X8o1fAnxCR5kc0pEdnGR)

## App 接口

| 请求 | 使用位置 |
| --- | --- |
| [`GET /api/v1/recorder-bindings`](https://app.apifox.com/project/8965877/apis/api-542191962) | 首页的设备列表。传 `deviceId` 可精确查找本人当前绑定的 SN。 |
| [`POST /api/v1/recorder-bindings`](https://app.apifox.com/project/8965877/apis/api-542192095) | 首次认领，或同账号换手机后取回有效绑定。首次认领由 App 显式选择传输模式。 |
| [`GET /api/v1/recorder-bindings/:bindingId`](https://app.apifox.com/project/8965877/apis/api-542192109) | 读取设备详情和设置。 |
| [`PATCH /api/v1/recorder-bindings/:bindingId`](https://app.apifox.com/project/8965877/apis/api-542192117) | 改名、调整自动或手动传输、调整自动或手动生成。当前转写语言支持 `auto`。 |
| [`DELETE /api/v1/recorder-bindings/:bindingId`](https://app.apifox.com/project/8965877/apis/api-542192122) | 解绑所选录音卡，使该绑定的临时回执失效。 |
| [`POST /api/v1/recorder-bindings/:bindingId/recordings/sync-status`](https://app.apifox.com/project/8965877/apis/api-542192136) | 上传前批量核对最多 100 个不同录音键，逐条返回尚未同步、已入库或已删除。 |
| [`POST /api/v1/recorder-bindings/:bindingId/recordings`](https://app.apifox.com/project/8965877/apis/api-542192140) | 用完成回执确认单条原音入库。请求重试和同账号多手机并发共用同一资产。 |
| [`POST /api/v1/content-assets/:contentAssetId/processing-runs`](https://app.apifox.com/project/8965877/apis/api-542192147) | 在资产详情开始生成或按服务端返回的允许动作重试，解绑后也可使用。 |

现有 `POST /api/v1/media/upload-token` 支持同时提交绑定 ID 和录音键，之后继续使用原签名 PUT、上传状态和完成接口。现有 `GET /api/v1/content-assets` 可按 `bindingId` 筛选，录音卡条目返回处理阶段及可用的 `originalResourceId`。详情和播放使用现有资产接口和 `GET /api/v1/media/resources/:resourceId/playback`，处理失败后仍可听原音。普通录音沿用 `recording`；通用创建接口将 `recorder_card` 保留给专用入库流程。录音卡资产的原音引用受保护。

## 数据如何落库

| 动作 | 存储及事务 |
| --- | --- |
| 认领与解绑 | `recorder_bindings` 记录账号、SN、核验型号、显示名、传输和生成模式、转写语言及绑定时间。解绑写入 `unbound_at`。有效 SN 的部分唯一索引约束并发认领。 |
| 上传 | 文件字节写入 OSS；Redis 回执记录账号、本次绑定、录音键及已核对的对象版本。完成 PUT 或完成上传确认后，App 继续请求单条入库。 |
| 入库 | 服务端复核当前账号和有效绑定，在一个事务内认领 `resources`、记录空间占用、创建 `content_assets`、写入 `content_asset_resource_refs` 原音引用，按生成模式登记任务。失败回滚，提交后清理临时回执。 |
| 核对与删除 | 去重键为 `content_assets(user_id, source_id)`，仅适用于 `source_kind='recorder_card'`。软删后保留来源，重扫返回已删除；资产恢复后沿用原 ID。 |
| 生成 | 自动模式随入库登记，手动模式在用户点击后登记。转写使用既有 FunASR 任务并保存正文。纲要任务读取对应正文版本和已发布模板，结果进入 `ai_template_runs`；App 可通过原有纲要结果接口获取。 |

从音频反查录音卡时，先按账号校验 `resources`，再通过 `content_asset_resource_refs.resource_id` 和 `content_asset_id` 找到录音资产。`source_id` 的两段分别是 SN 与硬件录音键的 UTF-8 Base64URL 编码，以点分隔。取 SN 与资产的 `user_id` 查询 `recorder_bindings`，即可找到该用户与这张卡的绑定历史。原音与设备是一对多关系，解绑或转给另一个账号也能识别历史资产的来源。

本次仅新增 `recorder_bindings` 一张业务表。已有资产、Resource、引用和任务表复用原字段。迁移追加来源索引、账号级纲要任务约束、FunASR 的进行中任务唯一索引，以及 Worker 读取模板和保存运行结果的权限。[迁移 SQL](../../migrations/0006_recorder_bindings.sql)

## 联调条件和风险

- **首次认领。** API 通过 `RECORDER_VERIFIER_URL` 和 `RECORDER_VERIFIER_TOKEN` 对接受信设备验证服务。固定地址接收账号、SN 和不透明的 `proof`；成功返回 `verified: true`、核验后的 `deviceId` 和 `modelCode`，无效凭据返回 `verified: false`。缺配置或验证服务异常时，首次认领返回 503。App 与硬件负责生成有效证明，验证方负责校验证明的新鲜度和账号、设备归属。
- **后台生成。** Worker 使用 `RECORDING_OUTLINE_SERVICE_URL` 和 `RECORDING_OUTLINE_SERVICE_TOKEN` 调用专用后台执行端，发送 `prompt`、`text`、`stream: false`，以 `x-idempotency-key` 传递运行 ID，成功响应包含 `text`。下游须按运行 ID 去重并能返回原结果。默认使用已发布的 `smart_outline` 模板。ASR、纲要、OSS 和硬件验证仍需在各自环境联调。
- **原音与费用。** 自动转写因配置或额度不足而无法启动时，入库保留原音，列表与详情返回失败阶段。永久文件空间不足时，入库事务整体回滚，完成回执可在有效期内重用。
- **供应商响应丢失。** 若转写请求可能已被接收且没有终态回执，服务端保留原任务，并要求按原任务核对供应商结果，以免重复计费。纲要恢复沿用同一运行 ID 和原模板版本；正文版本已变更时，旧结果不会写回新版本。
- **解绑时仍在传输。** 已经签出的 OSS URL 可用到自身过期。解绑后服务端拒绝旧绑定继续申请签名、确认或认领文件；App 应停止旧队列。换绑前遗留在卡中的录音，由 App 和硬件确定可导入的范围。
- **数据库升级。** 既有客户端曾可自填资产来源。升级前核对 `recorder_card` 是否已被占用，迁移发现存量同名来源会停止，避免误认作已核验录音。对资产和任务表建索引需要评估目标库规模和写锁窗口；历史环境需按现有账本升级。当前清单沿用上一候选的本地演练基准。

## 验收依据

- 使用 Node 26.11.0、pnpm 10.15.1 执行。类型检查、ESLint、构建、本地与云环境的 Compose 示例配置解析均通过。单元及契约测试通过 1,228 项；隔离 PostgreSQL／Redis 集成测试通过 486 项，7 项依赖 Milvus 的搜索用例跳过。
- App 源码参照为 `3f7b663`。本轮按当前工作树 CodeGraph 核对了 API 装配、同步路由、资产事务、FunASR 的成功回调和 Worker 纲要入口。普通手机录音和录音卡共用既有文件播放接口。
- 数据库使用 PostgreSQL 17.9，临时上传回执使用 Redis 7.4.8。演练从基线 1 升级至 6，再次运行待执行迁移为零；五个数据库角色均执行了迁移验收，包括业务 Schema 的物理外键数为零和角色权限检查。测试运行器把仓库的原始初始化脚本复制进临时容器，适配 macOS Docker Desktop 的宿主机挂载执行权限。
- 并发认领、同账号换手机、跨账号访问和解绑重绑见[绑定测试](../../tests/integration/recorder-bindings.test.ts)。上传、原音播放、软删重扫、空间占用和解绑期间的上传确认见[文件与资产测试](../../tests/integration/storage.test.ts)。
- 生成链路覆盖回调重放、纲要版本、后台执行、失败阶段和重试。原音留在测试存储中；设备核验、OSS、ASR 和 AI 服务使用本地替身。详情见[转写工作流](../../tests/integration/funasr-workflow.test.ts)和[录音处理测试](../../tests/integration/recording-processing.test.ts)。

## Apifox 同步

已在花火 AI 项目（8965877）主分支（8771298）回读确认 7 条原接口。设备范围的上传、解绑和原音访问见[申请上传凭证](https://app.apifox.com/project/8965877/apis/api-539018529)、[完成上传](https://app.apifox.com/project/8965877/apis/api-539018533)和[播放原音](https://app.apifox.com/project/8965877/apis/api-539018520)。保留来源、按卡筛选、处理状态和原音引用约束见[资产创建](https://app.apifox.com/project/8965877/apis/api-539018651)、[列表](https://app.apifox.com/project/8965877/apis/api-539018656)、[详情](https://app.apifox.com/project/8965877/apis/api-539018659)和[更新](https://app.apifox.com/project/8965877/apis/api-539018661)。

主分支已补齐上表 8 条接口，均在「App 通用组件 / 录音卡」。[上传状态查询](https://app.apifox.com/project/8965877/apis/api-542192155) 在「App 通用组件 / 文件上传与访问」，覆盖临时上传、已完成、已取消、已过期和已认领五种状态。已通过官方 CLI 回读全部 9 个条目的请求、响应、鉴权和示例，确认每个方法与路径只有一个条目。

前次更新的 5 条既有条目中的 9 个响应示例已逐项回读，名称、正文、顺序和对应响应与写入前一致，平台重新分配了示例内部 ID。
