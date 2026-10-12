# 契约兼容性（P01 历史与 P02 增量）

| 范围 | App 依据 | 后端处理 | 证据 | 状态 |
|---|---|---|---|---|
| Base URL | `core_provider_module.dart` 的 `HUAHUO_API_BASE_URL` | Compose `APP_PUBLIC_BASE_URL` 是根地址；路由自身使用 `/health`，P02 起业务路由保留 `/api/v1` | App 哈希基线；cloud/local 配置校验 | CODE/PROPOSED |
| 鉴权注入 | `api_client.dart` `resolveAuthHeader` | P01 不实现用户身份；健康无认证，未来 App 路由使用 Bearer 并从服务端 user/session 派生 | `tests/contract/api.test.ts` 验证 Admin 不接受 App Bearer | CODE/P01 boundary |
| 成功 envelope | `api_envelope.dart` `parseApiEnvelope` | `success(data, traceId)` | Fastify inject health 7 tests、`tests/unit/envelope.test.ts` | CODE verified |
| 错误 envelope | `parseApiError` | code/message/userMessageKey/retryable/traceId；未知错误脱敏 | 400/404/500 contract tests；不含 secret | CODE verified |
| 请求头/trace | `buildCommonHeaders` | 接受安全 `X-Trace-Id`/`X-Request-Id`，响应 `X-Trace-Id`；日志 base 含 service/instanceId | contract test + container HTTP | CODE verified |
| 管理隔离 | App 无管理身份契约；总规范要求独立 admin | API `/admin*` 404；Admin `/admin*` 在 P02 身份前 403；两个实例独立 | container-isolation + contract tests | USER/PROPOSED verified |
| 参数与敏感错误 | App `request_parsing.dart` | 严格 query schema，错误不回显 secret | contract test | CODE/PROPOSED |

P01 没有业务端点、workspace/session/幂等、SSE、上传或支付契约，因此不标“全 App 兼容”。App 源码未修改，也未运行 Flutter 构建。

## P02：CODE 源码核对与后端验证

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，工作树 clean。下表 CODE 表示已核对客户端源码；验证使用后端 JSON fixture/Fastify inject/真实 HTTP，没有执行 Dart 解析器或真机联调。上表 P01 的身份边界由本阶段实现替代。

| API/范围 | App 请求与解析证据 | 后端与验证 | 状态 |
|---|---|---|---|
| POST `/api/v1/auth/sms-code`、`/auth/login`、`/auth/refresh` | `AuthClient` → `AuthApi`，endpoint catalog；phone/scene、协议版本/deviceId、refreshToken；解析 tokens/user/workspace | identity routes/schemas/service；OTP 过期/次数/重复/并发，refresh 轮转/复用撤销；identity integration + p02-http | CODE，SMS 仅 mock |
| GET `/api/v1/me/status`、PUT `/me/timezone` | `AuthClient.getUserStatus/updateUserTimeZone`；AuthApi 会话恢复 userId/displayName/phoneMasked、workspaceId/status | status serializer；真实登录/恢复/时区校验 | CODE |
| GET/PATCH `/api/v1/me/profile` | `RemoteUserProfilePort.load/save`，`_parseRemoteProfile`：profile.displayName/avatarResourceId | 昵称读写与隔离；非空头像引用暂时 409，P05 才校验资源归属 | CODE，头像后置 |
| `/api/v1/workspaces`、`/:workspaceId`、`/set-default`、`/disable`、`/restore` | `WorkspaceLifecycleClient` → `SharedWorkspaceSummary/Detail/BootstrapResult`：workspaceId/state/etag、receipt/cursor；If-Match + 幂等键 | scope 显式核权、持久幂等、版本冲突 412；真实 PG 测试跨用户拒绝、创建重放及切换 | CODE |
| POST `/api/v1/onboarding/creative-positioning`；GET `/creative-positionings`、`/workspaces/current/profile` | `OnboardingApi.createFirstContentLine/readDefaultContentLine`、定位解析：creativePositioning/contentLine、creativePositioningId/contentLineId | 唯一 workspace profile，两个 ID 别名指同一对象；只保存答案，onboardingCompleted=false、conclusions=[] | CODE；AI 报告 P09 |
| GET/PATCH `/api/v1/workspaces/:workspaceId/onboarding-draft` | `OnboardingProgressRepository` 当前仅本地持久化；mode/stepIndex/answers/deferredAt | 云草稿持久化/版本/跨用户隔离测试 | PROPOSED；App 未接线 |
| POST `/api/v1/auth/logout`、`/auth/logout-all` | App 当前本地退出需补服务端调用，见改动提案 | 当前设备/全部设备撤销及测试 | PROPOSED；App 未接线 |
| `/admin/api/v1/login/me/logout`、session revoke | 独立管理身份来自阶段规范，无 App 管理员契约 | bootstrap、scrypt、Cookie、CSRF/Origin、RBAC、限流、审计；真实 HTTP/Admin PG 权限测试 | USER/PROPOSED |
| 空 JSON POST | `buildCommonHeaders` 对无 body 的 POST 仍发送 JSON Content-Type | 空 body 兼容；必填登录字段仍 400、错误 JSON 仍 400、未认证退出 401；contract 回归 | CODE |

主要 fixture：`tests/integration/identity.test.ts`、`tests/e2e/p02-http.mjs`。基础契约：`tests/contract/api.test.ts`（8 项）。完整本地校验共 12 unit + 8 contract + 25 integration 通过；HTTP 与四容器隔离另行通过。没有声明未实现的 storage usage、内容同步或 AI run 已兼容。

## P03：任务与 Run 读取证据

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，工作树 clean；只读核对以下客户端实际路径：

| App 证据 | 客户端行为 | P03 后端处理/状态 |
|---|---|---|
| `endpoint_catalog.dart:805-819`、`work_ai_task_api.dart:16-96` | GET `/api/v1/tasks/{taskId}`，POST retry/regenerate；任务字段 taskId/taskType/status/error/retryable | task detail、有限 retry、regenerate 明确 409 `REGENERATION_NOT_AVAILABLE`（业务重新生成留 P09）；`demo.digest` 仅内部 fixture |
| `endpoint_catalog.dart:535-542` | GET `/api/v1/tasks/running` | scope 隔离返回未终态任务 |
| `assistant_runtime.dart:220-246`、`domain_clients.dart:2140-2185` | Agent Run detail/events，`afterSequence`/`Last-Event-ID` 和 SSE | P03 提供通用 task events JSON 游标 `/tasks/{taskId}/events`；Agent Run/SSE 领域端点留 P08，未伪称兼容 |
| `chat_run_tracker.dart`、`remote_project_assistant_runtime.dart` | 断线后按序号补读事件，终态区分 succeeded/failed/cancelled/orphaned | task_events 持久化 sequence、结果先写 PG 再 succeeded；外部 unknown 转 reconciling，不自动重投 |
| `initial_positioning_task_coordinator.dart` | 定位流程保存 taskId 并轮询终态 | P03 提供稳定 taskId/状态/事件；P09 才接真实定位 AI 结果 |

P03 后端新增契约 fixture：`POST /api/v1/tasks/demo`（开发/测试显式启用）、GET task/running/events/result、POST cancel/retry；scope 来自 App session，body/userId 不可越权。真实验证为 14 unit、8 contract、34 PG/Redis integration、`node scripts/e2e-p03.mjs` 和容器隔离；未运行 Flutter/Dart 或真机。

## P04：会员、额度与运行用量

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，工作树 clean；只读核对 billing client、模型、home quota parser 和 repository。`AccountUsageClient` 请求 `GET /api/v1/membership`、`GET /api/v1/account/credits`、`GET /api/v1/runs/{runId}/usage`，`quotaBalances()` 复用 endpoint id `home` 并要求 `data.quotaSummary.balances`。后端保留 `{success,data,traceId}` envelope，credits/tokens/media/provider cost 分开字段，所有额度以 PostgreSQL bigint 结算并在安全范围内序列化。

| API | App 解析证据 | 后端验证 | 状态 |
|---|---|---|---|
| GET `/api/v1/membership` | `account_usage_client.dart`、`SharedAccountMembershipResponse`：`credit-policy-v1`、10,000,000 monthly quota、membership 枚举与 expiresAt 规则 | Fastify contract + 真实 HTTP；development policy 返回 membership/monthly/permanent/account | CODE |
| GET `/api/v1/account/credits` | `SharedAccountCreditSummary`：monthlyCredit、permanentCredit lots、account admission | 真实 PG lot/reservation/ledger 集成与 HTTP smoke | CODE |
| GET `/api/v1/home` | `account_usage_client.dart` endpoint id `home`、`parseAccountQuotaBalances`：`quotaSummary.balances` | credits quotaSummary 真实读取 | CODE |
| GET `/api/v1/runs/{runId}/usage` | `SharedRunUsage`：measurement status、tokens、media quantities、providerCost 字符串 | unknown provider -> uncovered/pending integration path；scope 隔离 | CODE/PROPOSED |

开发政策明确写入 `BILLING_MODE=development`，不接真实支付，也不把 10,000,000 视为正式商业套餐。生产默认 billing disabled，未配置 live policy 时稳定返回 `BILLING_NOT_CONFIGURED`/`BILLING_POLICY_UNAVAILABLE`。

## P05：媒体资源与文件传输

App 参照 commit `20f61b78887f9288d1fd3227f326e6374d516f27`，本地工作树无变化。核对 `upload_client.dart`、`media_resource_client.dart`、`endpoint_catalog.dart`、聊天下载/相册/头像调用。

| API | App 实际契约 | 后端状态 |
|---|---|---|
| `POST /api/v1/media/upload-token` | Bearer + `X-Idempotency-Key`；sourceScene/fileName/mimeType/sizeBytes/durationSeconds/sha256?/workspaceId?；返回 uploadId/resourceId、绝对 uploadUrl、method、headers | CODE；不要求 App 私有 URI；返回短期 `X-Upload-Capability`，对象 PUT 不带 Bearer |
| `PUT /api/v1/media/uploads/{uploadId}/object` | 按 token method/headers 流式上传真实字节 | CODE；大小、哈希、MIME/音频时长服务端核验，临时落盘后不可覆盖发布 |
| `POST /api/v1/media/uploads/{uploadId}/complete` | Bearer + 幂等；body 可含 workspaceId；丢响应可重试 | CODE；初始化即分配稳定 resourceId，重复 complete 不重复资源/计量 |
| `GET /api/v1/media/resources/{resourceId}/playback` | Bearer；返回可直接 GET 的短期 URL 与 mime/fileName/expiresAt | CODE；跨用户 404，URL 为持有者 capability |
| `GET .../object` | App 直接 GET signed URL，图片/音频支持 Range | CODE；206/full/suffix/open range，416 返回 `Content-Range: bytes */size` |
| `DELETE /api/v1/workspaces/{workspaceId}/media/resources/{resourceId}` | Bearer + 幂等；解析 `resourceId/workspaceId/status`，status 接受 `deleted` 或 `delete_pending` | CODE；引用检查后返回 `delete_pending`，Worker 异步删除，不在 API 同步删文件 |

头像现在通过资源引用校验后写入 profile；消息/笔记等引用使用同一 `resource_refs` 约束。上传完成只触发检查任务，不伪称 ASR/文本处理完成。App 未修改、未运行 Flutter。

## P06：个人资产、笔记、文件夹、检索与图谱

App 参照 commit `20f61b78887f9288d1fd3227f326e6374d516f27`，本阶段核对 `domain_clients.dart`、`contract_models.dart`、`api_contract_manifest.dart`、`endpoint_catalog.dart`；App 未修改。

| API | App 解析/行为 | 后端状态 |
|---|---|---|
| `GET/POST/PATCH/DELETE /workspaces/{workspaceId}/folders` | Folder ID、parentFolderId、normalizedName、state、currentRevisionId、etag、contentCursor；If-Match + 幂等 | CODE；同级重名冲突、循环移动拒绝、软删除/恢复、作用域隔离 |
| `GET/POST/PATCH/DELETE /workspaces/{workspaceId}/notes` | HNote 的 raw/outline/germination parts、noteRevisionId、etag、resourceRefs、sourceRef | CODE；原文 revision 不可变，旧 ETag 返回 412，删除保留 tombstone |
| `GET/PUT .../notes/{noteId}/parts/{part}` | `contentMarkdown`、`basePartRevisionId`、partRevisionId、contentSha256 | CODE；每次写入追加 revision，原文不被标签任务覆盖 |
| `POST /workspaces/{workspaceId}/notes/batch-move` | 局部结果逐项返回 | CODE；单项冲突不会覆盖其他项 |
| `POST /workspaces/{workspaceId}/search` | keyword/semantic mode、中文与英文 query、owner/folder/date filters；结果带 ownerRef、revisionId、path、matchMode | CODE；首期仅 keyword，使用 PostgreSQL simple tsvector/GIN + 有界 ILIKE 降级；semantic 明确返回不可用，不伪造向量 |
| `GET /workspaces/{workspaceId}/content-navigation/{map}` | 局部节点/标签聚合 | CODE；只返回有据的 Note/Tag 节点与计数，限制 100 节点 |
| `GET/POST/DELETE .../notes/{noteId}/relations` | typed explicit relation、source/target、rationale、version、etag | CODE；引用关系和标签聚合均按 workspace 隔离 |

标签提取由 `asset.tag-extract` 持久任务执行，最多 5 个候选；任务失败或 revision 过期不会删除或覆盖原文，人工标签表与提取来源分开。未接真实 LLM/Dify，确定性提取只作为明确的本地 Worker fixture。

## P06 标签化补充修订

- App 参照确认人工标签规范为每篇最多 20 个、每个 1–24 Unicode 字符；后端按此拒绝超限并返回 tag ETag。新增 tag CRUD/建议/提取路由为后端补充契约，保持 envelope、Bearer、Idempotency-Key 和 If-Match 约定。
- App `contentNavigation` 请求目前只发送 workspace/map 且解析 `items/map/contentCursor`；后端提供真实相对路径、revision/version、ownerRef，并额外返回有界 nodes/edges。App 当前 `MiroFishGraphMapper.fromContentNavigation` 只按路径建层级边，忽略显式后端 edges；因此共同标签边已在 API/契约测试中验证，但 App 端完整可视化接线待 P15，不修改 Flutter。
- 搜索保持 `ownerRef.kind=hnote`、`keywordReadiness=current`、`vectorReadiness/vectorStatus=unavailable`，不返回正文/snippet/evidence，保留关键词/标签/来源/时间过滤。
