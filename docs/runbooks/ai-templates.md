# AI 模板配置与 App 契约

Server 的 Admin 和 API 按各自的数据库账号使用同一个业务 PostgreSQL。迁移
现有模板覆盖资产纲要、编辑器润色和社会关系转变子项。场景键在增量迁移 `0020` 统一为 `content_asset_outline` 和 `editor_polish`。
Admin 在「AI 模板配置」编辑展示内容、首屏数量、顺序、分组、启停和提示词。
草稿和发布版本有各自的版本号。每次发布或回滚在同一事务写入一个新版本和发布审计。
已开始的请求记录开始时读取的版本。模板项键可长期用于关联资产结果。

提示词支持 `{{templateTitle}}`，资产纲要也可用 `{{sourceTitle}}`。提示词与正文
分别作为模型指令和用户文本传给 Agent。润色正文、修改位置、建议和理由可由后台发布的提示词定义，前端可按约定的分隔符解析同一次生成返回的文本。

## App

App 通过现有鉴权入口访问 Server，所有工作区路径校验登录会话和工作区归属。

| 方法和路径 | 请求与结果 |
| --- | --- |
| `GET /api/v1/ai-template-scenes/:sceneKey/items` | 场景为 `content_asset_outline` 或 `editor_polish`。可传 `parentKey=relation_shift` 读取二级目录。返回 `revision`、`title`、`displayLimit`、`totalCount` 和排序后的 `items`。每项包含 `itemKey`、`kind`、标题、副标题、图标和子项数。 |
| `POST /api/v1/workspaces/:workspaceId/ai-template-runs` | 传 `sceneKey`、`itemKey`、`input` 与 `X-Idempotency-Key`。纲要输入为 `{contentAssetId, sourceRevision}`，其中 `sourceRevision` 是资产 `parts.raw.partRevisionId`。润色输入为 `{text}`。 |
| `GET /api/v1/workspaces/:workspaceId/ai-template-runs/:runId` | 读取同一用户的运行状态或结果。进行中返回 202，成功返回 200，失败使用 Server 错误信封。 |
| `GET /api/v1/workspaces/:workspaceId/content-assets/:contentAssetId/ai-outline-results` | 返回当前原文版本下每个已生成模板的最新成功记录，用于「已整理」。记录含 `itemKey`、`runId`、`templateVersion` 和生成时间。 |

成功的 `data` 包含 `runId`、`sceneKey`、`itemKey`、`templateVersion`、
`state: "succeeded"` 和 `result`。润色结果为 `{text}`，纲要为
`{contentAssetId, sourceRevision, outlineMarkdown}`。用户选择应用纲要时，可调用
现有资产 `PUT /parts/outline` 并携带 `If-Match` 与新的保存幂等键。

同一个生成接口的 OpenAPI 成功响应提供 `application/json` 和 `text/event-stream`。
App 每次调用通过 `Accept` 选择，所有模板都支持以下两种方式。

| App 请求头 | Server 返回 |
| --- | --- |
| 缺省或 `Accept: application/json` | 默认一次性返回 JSON |
| `Accept: text/event-stream` | SSE 流式返回。也可发送 `Accept: text/event-stream, application/json` |

SSE 的 `delta` 携带 `runId`、`text`，`result` 使用与 JSON 一致的成功信封。
进行中返回 202 JSON，开流前的失败使用 HTTP 错误信封，开流后的失败发终态
`error`。断线后可用已有 `runId` 或原幂等键查询。用原幂等键重取已完成的
结果时，可以重新选择返回格式。主动「重新整理」使用新幂等键。
当前 Flutter 通用客户端声明 JSON，期限为 15 秒，响应上限为 64 KiB。生成接口
允许最多 50,000 个输入字符、10,000 个输出字符，Server 执行期限为 90 秒。

## Server 调用 Agent

为 API 角色设置 `HUAHUO_AGENT_BASE_URL`，值为可从该进程访问的 Agent 私网 origin，
如内部 DNS 对应的 `http://agent:4111`。留空时生成接口返回
`503 AI_TEMPLATE_EXECUTOR_UNAVAILABLE`。App 目录和 Admin 配置仍通过业务库提供。

Server 从已发布模板生成 `{prompt, text, stream}`，通过
`POST /internal/v1/ai-template-runs` 及现有受信身份、Trace 头调用 Agent。
Agent 在单次模型调用中使用部署配置的模型，按需返回 JSON 或 NDJSON。
Server 将终态写入业务库，并为 App 转换 SSE 事件。内部接口的访问边界沿用
受信私网 origin。

## 验收

`tests/integration/ai-templates.test.ts` 用真实隔离 PostgreSQL/Redis、API 和
Admin 各自的数据库账号，以及本机 Agent HTTP 替身验证配置发布、并发冲突、
回滚、目录子项、身份和 CSRF、幂等执行、JSON/SSE、工作区归属、纲要应用与原文版本。
