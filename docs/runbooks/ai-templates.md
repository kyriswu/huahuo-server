# AI 模板配置与 App 契约

Server 的 Admin 和 API 按各自的数据库账号使用同一个业务 PostgreSQL。
现有模板覆盖 `content_asset_outline`（资产纲要）和 `editor_polish`（编辑器润色）。社会关系转变是编辑器润色的分组。
Admin 在「AI 模板配置」编辑展示内容、首屏数量、顺序、分组、启停和提示词。
草稿和发布版本有各自的版本号。每次发布或回滚在同一事务写入一个新版本和发布审计。
已开始的请求记录开始时读取的版本。模板项键可长期用于关联资产结果。

在提示词里输入或粘贴 `{{变量名}}` 后，Admin 自动标出变量。同一提示词内同名变量使用同色。
展开「变量用法与 API 传参」可查看匹配规则和请求示例。
两个场景均提供系统变量 `{{templateTitle}}`，资产纲要也提供 `{{sourceTitle}}`。
提示词与正文分别作为模型指令和用户文本传给 Agent。润色正文、修改位置、建议和理由可由后台发布的提示词定义，前端可按约定的分隔符解析同一次生成返回的文本。分隔符可能跨多个 SSE 片段。

## App

App 通过现有鉴权入口访问 Server，模板运行按登录账号校验会话、来源资产和结果归属。

| 方法和路径 | 请求与结果 |
| --- | --- |
| `GET /api/v1/ai-template-scenes/:sceneKey/items` | 场景为 `content_asset_outline` 或 `editor_polish`。省略 `parentKey` 读取顶层目录。点击 `kind: "group"` 项时传其 `itemKey` 作为 `parentKey`。返回已发布目录的 `revision`、`title`、首屏建议展示数 `displayLimit`、当前目录项数 `totalCount` 和按配置排序的 `items`。每项包含 `itemKey`、`kind`、`title`、`description`、`icon` 和 `childCount`。 |
| `POST /api/v1/ai-template-runs` | 传 `sceneKey`、`itemKey`、`input` 与 `X-Idempotency-Key`。可选的顶层 `variables` 为提示词提供变量值。纲要输入为 `{contentAssetId, sourceRevision}`，其中 `sourceRevision` 是资产 `parts.raw.partRevisionId`。润色输入为 `{text}`。 |
| `GET /api/v1/ai-template-runs/:runId` | 读取同一用户的运行状态或结果。进行中返回 202，成功返回 200，失败使用 Server 错误信封。 |
| `GET /api/v1/content-assets/:contentAssetId/ai-outline-results` | 返回当前原文版本下每个已生成模板的最新成功记录，用于「已整理」。记录含 `itemKey`、`runId`、`templateVersion` 和生成时间。 |

App 切换纲要模板时，先读 `GET /api/v1/ai-template-scenes/content_asset_outline/items`，按 `data.items` 动态展示后台已发布的模板。选中 `kind: "template"` 的条目后，将它的 `itemKey` 和资产的原文版本传给生成接口，并为这次生成使用新的幂等键。若读取目录后所选模板已停用，生成接口返回 `404 AI_TEMPLATE_UNAVAILABLE`，App 可重新读取目录。

成功的 `data` 包含 `runId`、`sceneKey`、`itemKey`、`templateVersion`、
`state: "succeeded"` 和 `result`。润色结果为 `{text}`，纲要为
`{contentAssetId, sourceRevision, outlineMarkdown}`。用户选择应用纲要时，可调用
现有资产 `PUT /parts/outline` 并携带 `If-Match` 与新的保存幂等键。

例如，提示词 `请用 {{语气}} 为 {{目标.读者}} 润色以下文字。` 可使用以下请求体。

```json
{
  "sceneKey": "editor_polish",
  "itemKey": "improve_opening",
  "input": { "text": "今天讨论了新方案。" },
  "variables": { "语气": "简洁", "目标.读者": "项目组" }
}
```

`variables` 的字段名可以自定义，值为字符串，也可传空字符串。Server 去掉占位符名称两端的空白，再与请求字段名逐字匹配，区分大小写。当前场景的系统变量优先。没有对应值的占位符会移除，模板未引用的字段不参与生成。值里带有双花括号时只插入一次。正文按原样传给 Agent。

变量值最多 10,000 个 UTF-16 码元，生成请求体最多 400,000 字节，展开后的提示词最多 12,000 个 UTF-16 码元。若展开后没有实际指令，返回 `400 AI_TEMPLATE_PROMPT_INVALID`。
使用同一幂等键重试时，提交的变量键和值要一致，键顺序可以变动。省略 `variables` 等同于传空对象。

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
回滚、目录子项、身份和 CSRF、两场景的变量匹配、幂等执行、JSON/SSE、账号归属、纲要应用与原文版本。
只读核对 App 提交 `fe6a02c`，`free_writing_page.dart` 和 `compose_inspiration_page.dart` 的 AI 润色按钮当前显示「AI 润色暂未接入」。本轮验收覆盖 Admin 与 Server HTTP 契约。
