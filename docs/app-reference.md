# App 只读参照基线

- 来源仓库：https://github.com/kyriswu/huahuo-app
- Server 根：本机 `huahuo-server`；App 路径相对为 `../huahuo-app`
- 记录时间：2026-10-09
- 当前 commit：`20f61b78887f9288d1fd3227f326e6374d516f27` (`main`)
- 工作树：clean；未执行 fetch/pull/Flutter 命令；App 未修改。

P01 读取并记录哈希的源码证据：

| 路径 | 符号/内容 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/api/api_client.dart` | `ApiClientConfig`、`buildCommonHeaders`、`resolveAuthHeader`、`buildUrl` | `5916960ae6d0704c440bf01ca96d0730a690aed99cc51630ff754a57ccc160fe` |
| `Flutter/packages/huahuo_api/lib/src/api/api_envelope.dart` | `ApiEnvelopeResult`、`parseApiEnvelope`、`parseApiError` | `fa30b010514105c2ef9b37adc3b5bc37829874ce571537a4bc15badb5d1e4815` |
| `Flutter/packages/huahuo_api/lib/src/api/request_parsing.dart` | JSON object/parser/分页/If-Match 辅助 | `d7bc4c4e662a1de9928577c704d9f27e3c969d014614a30b522c27d78dd83b05` |
| `Flutter/packages/huahuo_api/test/api_foundation_test.dart` | formal envelope 与 Bearer 请求 fixture | `938bcfbed29f1bde7faf76cf751b305c8789c478194d6bc46f02ffa2042ab1fb` |
| `Flutter/src/lib/app/bootstrap/core_provider_module.dart` | `HUAHUO_API_BASE_URL`、Debug HTTP/非 Debug HTTPS 校验 | `d084b55a9ecb2f56d0bf9c3558f530deb088ac9aea4949bda7dec9edf00b62cb` |

本阶段核对结论：App 发送 `Accept`/JSON、`X-Trace-Id`、`X-Request-Id`、客户端/设备/平台/locale/timezone 头；有 token 时发送 `Authorization: Bearer …`；endpoint 路径自身包含 `/api/v1`；严格成功响应为 `{success:true,data,traceId}`，失败为 `{success:false,error,traceId}`。后端 health 和错误 envelope 保留这些关键字段，健康以外未提前声明业务兼容。

`config/app-reference.local.json` 与 `docs/app-reference.local.json` 是被忽略的本机路径/哈希记录；`node scripts/app-reference.mjs --diff` 在阶段末返回无差异。App 后续变化需先更新参照，再核对受影响契约。

## P02 读取证据

阶段开始和结束均确认同一 App commit `20f61b78887f9288d1fd3227f326e6374d516f27`、`main`、工作树 clean；未执行 fetch/pull 或 Flutter 命令。读取入口覆盖 Auth、workspace、onboarding 与 profile：

| App 相对路径 | 符号/契约用途 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/auth/auth_client.dart` | AuthClient：sms/login/refresh/status/timezone 请求 | `1ce22418b975e37fa24799e1f291fa3b98fc466196ac79c6ef6bddd327ce8bc2` |
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | auth/me/workspace/onboarding endpoint 路径与方法 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/packages/huahuo_api/lib/src/contracts/contract_models.dart` | SharedWorkspace* 与定位 DTO 解析 | `5a248f30bd1fa04594072bbd57afe6c70edfa9973fc3627dc03b7edd16aa01a0` |
| `Flutter/packages/huahuo_api/lib/src/workspace/workspace_lifecycle_client.dart` | workspace CRUD、If-Match、幂等键 | `658057db0bb1581f0433866ce53638c86f2a9392f093a0718629ba672f2e5472` |
| `Flutter/src/lib/features/auth/data/auth_api.dart` | 登录字段、token/status 解析 | `0c78f60b36631ded7f5ea5766c2e97064e62e938a8d8f7b01a5ce11e2489e755` |
| `Flutter/src/lib/features/onboarding/data/onboarding_api.dart` | content line/creative positioning 字段别名与 completion 解析 | `1e7ea2e0ba6061a95999b5d2e507ceb4e9bad2814984ed0ca2faeb7088041675` |
| `Flutter/src/lib/features/onboarding/data/onboarding_progress_repository.dart` | 本地 onboarding draft：mode/stepIndex/answers/deferredAt | `2c65b2034fbcea6745b62d48e31c7a7acd1952d7372075dc0986af68822e36ea` |
| `Flutter/src/lib/features/ui_v3/application/user_profile_controller.dart` | profile load/save、displayName/avatar 引用 | `e8f61a54bc42869df76391dc2d877667b860a5cd534ef8b5fa508aa8722a3437` |

契约证据链已记录于 `docs/adr/0002-identity-workspace.md` 和 `docs/contract-compatibility.md`。App 只读；新增云草稿与服务端 logout 是后端先行契约，提案见 `docs/app-change-proposals.md`，未修改客户端。

关键定位行号（对应上述哈希）：`auth_client.dart:16` 请求短信、`:34` 登录、`:51` 刷新；`auth_api.dart:265` 登录、`:529` status 解析、`:740` workspace 解析；`contract_models.dart:117` Summary、`:158` BootstrapResult、`:189` Detail；`onboarding_api.dart:163` 创建、`:291` 包装解析、`:455` ID 别名；`onboarding_progress_repository.dart:11` snapshot、`:166` repository；`user_profile_controller.dart:178` load、`:226` save、`:481` profile 解析。

## P03 读取证据

| App 相对路径 | 符号/用途 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | taskDetail/retry/regenerate/runningTasks、Agent Run events/stream 路径 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/src/lib/features/work_ai/data/work_ai_task_api.dart` | task detail/retry/regenerate 请求和严格字段解析 | `3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e` |
| `Flutter/src/lib/features/work_ai/domain/work_ai_task.dart` | WorkAiTaskInfo 状态/错误/重试模型 | `0539c7714263bbe6e870e5c626f6cd09ad88fbd589160c1a0ac05bd767496db4` |
| `Flutter/packages/huahuo_api/lib/src/api/domain_clients.dart` | AgentRunClient detail/events/Last-Event-ID | `28ac16b834fd4bd4491ef25fab26b53ec66f12428ea7cecc7b04b09e1099853e` |
| `Flutter/src/lib/features/chat/domain/assistant_runtime.dart` | run 状态、事件流和 afterSequence 抽象 | `afe8ac28c7b12bad260daeb1beee9b3a12bdadc1d5370cbec183248753bd311c` |
| `Flutter/src/lib/features/chat/data/remote_project_assistant_runtime.dart` | 远端 run/events 请求 | `9148a9d89005fc1d2176799a8271967cceee80fc9dcd44ac130927a2d7fc87ab` |
| `Flutter/src/lib/features/chat/application/chat_run_tracker.dart` | 断线补读、顺序游标和终态判定 | `dbfccde4b121bcc2a39663fba0d44045191c50e79049e1630b1f190edbb2134b` |
| `Flutter/src/lib/features/onboarding/application/initial_positioning_task_coordinator.dart` | 定位任务 receipt/status 恢复 | `1dbd9537afe3a7501d2b7f18a66ffffafd595c89d876dd1a01f0b58fb9b9a566` |

## P04 读取证据

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27` (`main`)，工作树 clean；未 fetch/pull、未运行 Flutter 命令、未修改 App。P04 读取文件及 SHA-256：

| 路径 | 符号/用途 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/billing/account_usage_client.dart` | membership、account credits、run usage、home quota 请求 | `74fdaf7e88715720396667b73ea5968e24a1854d9ab0baf6ab843b169b2b6c00` |
| `Flutter/packages/huahuo_api/lib/src/billing/account_usage_models.dart` | SharedAccountMembership/CreditSummary/RunUsage 严格解析 | `846d945b76b2d955ef5f18c038b8a465fa30f67d487765ee5e21f534dad4c2b5` |
| `Flutter/packages/huahuo_api/lib/src/billing/account_quota_balance.dart` | quotaSummary.balances、整数/日期解析 | `2e0a3b4a5e011c48c1c75d64ce72a6df91bb69cc14f7d52a7a38ab69ae5fb1fb` |
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | membership/accountCredits/runUsage/home endpoint 路径 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/src/lib/features/billing/data/account_usage_repository.dart` | App billing result mapping and unavailable behavior | `c8ca48ef42bd8d5569c4ff61634346c1db8cd5e095b9b9152c16b4c0077e7a89` |

P03 仍确认 App 工作树 clean、未修改、未运行 Flutter 命令；`node scripts/app-reference.mjs --diff` 返回无变化。

## P05 参照记录

App commit `20f61b78887f9288d1fd3227f326e6374d516f27`，`node scripts/app-reference.mjs --diff` 返回 `headChanged:false,statusChanged:false,changedFiles:[]`。本阶段读取上传客户端、媒体资源删除客户端、端点目录，以及聊天/相册/头像播放解析；App 只读且未修改。

## P06 参照记录

本阶段追加核对 `domain_clients.dart`、`contract_models.dart`、`api_contract_manifest.dart` 与 `endpoint_catalog.dart` 中的 folders/notes/parts/search/relations/content-navigation 契约。App HEAD 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，只读工作树无变化。

## P06 标签化补充修订（只读）

App HEAD `20f61b78887f9288d1fd3227f326e6374d516f27`，原基线差异为空；新增以下有针对性的参照文件后扩充哈希基线。未运行 Flutter/生成器或修改 App。

| App 路径 | 用途 | SHA-256 |
|---|---|---|
| `Flutter/src/lib/features/ui_v3/data/knowledge_user_metadata_repository.dart` | 20 标签/24 runes 上限与字面去重 | `dd441629534349c44c2dccf104b503aa1408fa0728e6d05e6ffcffe63874bcbe` |
| `Flutter/src/lib/features/ui_v3/application/knowledge_library_controller.dart` | effectiveTags/updateEffectiveTags 当前本地写入 | `b4753a8a25780f8b32e023b5021588e005511bbd721bd7fd39b2746f1fb516ef` |
| `Flutter/src/lib/features/ui_v3/data/mirofish_graph_api.dart` | 请求 content-navigation/overview | `21d60697079edc9c229113d7625f3729ea1ff6022d4da64b2bcf5f4d8459d8ae` |
| `Flutter/src/lib/features/ui_v3/data/mirofish_graph_mapper.dart` | items/path/revision-or-version 解析，当前忽略后端 edges | `4be2d9e6f442976576e814bece6bf206e1f6361207095256bbca51d24ddaeb06` |
| `Flutter/src/lib/features/ui_v3/data/graph_snapshot_mapper.dart` | 通用 nodes/edges 接受 id/source/target/kind | `a0fb56e131ba05024a1b28de06e3e7ec87629cb00e48f53ff47564356356545d` |
| `Flutter/src/lib/features/ui_v3/data/graph_repository.dart` | 当前图谱注入与加载边界 | `f4d2353747641f895c8140123d464974ac3b4b3e2a10296787184846d6077f9d` |

请求和解析器另核对 domain_clients.dart:1372/1387、contract_models.dart 的 Search/ownerRef/relative path/敏感字段白名单，后端真实 Fastify + PG 的 tags CRUD、search、navigation 测试覆盖这些数据形状；没有执行 Dart runtime 或手机联调。
