> 搜索功能确定需要，现有技术实现保留；具体业务细节尚未确定。本文记录当前代码，不作为未来产品需求，后续可按明确业务调整。见[需求边界](search-status.md)。

# Server 与 Agent 的内部 HTTP 协定

当前 Server 提供内部 RAG 查询供 Agent 使用，未实现 Server 主动调用 Agent 的业务。双方以本协定和对应接口的严格 Schema 为准；新增调用时在调用方业务客户端中接入，不预建没有调用方的接口或 SDK。当前只在 Server 仓库实现和验证，不能据此宣称 Agent 已联调。

## 路径与注册

内部服务入口统一 `/internal/v1/<业务>/<动作或资源>`；用户公开业务入口为 `/api/v1/...`。前缀表达用途，访问控制还依赖受限监听、可信调用方和所属业务的权限检查。

Server 只有 `src/http/internal-routes.ts` 一个内部注册入口，`internal-api.ts` 提供 Fastify 封装、中间件与固定鉴别策略。业务实现继续放在各自模块：RAG、gateway、document-parser callback 分文件维护。公开与内部入口调用同一业务时使用同一个 Service；当前 RAG 注入同一个 RagQueryService 实例，并共用 createRagQueryRoute 的 Schema、handler 和 timing。新增内部路由必须声明策略；缺失或错误策略在启动注册时失败。统一禁止缓存并隐藏内部 OpenAPI，路由清单由对应测试核对。

| 内部入口 | 当前用途 | 鉴别策略 |
| --- | --- | --- |
| `POST /internal/v1/rag/query` | Agent 读取当前用户有权访问的知识内容 | 可信用户身份头，业务事务再验证会话、工作区、来源与版本 |
| `GET /internal/v1/gateway/auth` | 可信入口的认证子请求 | GatewaySession 验证原始 Bearer/Cookie；成功返回204和身份头 |
| `POST /internal/v1/gateway/logout` | Studio 注销映射 | GatewaySession 验证来源并处理会话/Cookie |
| `POST /internal/v1/document-parser/callbacks/:id/:token` | 外部解析服务向单次任务回报结果 | 单次提交的能力令牌；令牌在业务授权器校验，普通用户身份不能代替它 |

解析回调迁入内部前缀，删除原 `/api/v1/document-parser/callbacks/...` 路由。它是现有外部解析协议的回调，不是新增的 Server–Agent 业务；Server 生成完整地址交给解析器。RAG 和 gateway 的现有内部地址保持。新旧代码混跑或在途旧回调的交接必须单独评估，本轮未部署。

## 身份与 trace

Agent→Server 使用部署方提供的稳定内部 Base URL；不绑定发布槽位，不由请求参数选择目标。当前可信头协议是：

- `X-Huahuo-User-Id`：用户 UUID。
- `X-Huahuo-Session-Id`：当前会话 UUID。
- `X-Huahuo-Auth-Method`：`bearer` 或 `cookie`，表示入口已完成的认证方式。
- `X-Trace-Id`：请求链路 ID；格式为6—96个 `A-Z/a-z/0-9/._:-` 字符。

入口必须覆盖客户端自报身份头；Agent 只能从已经验证的请求上下文传递身份。业务请求不从正文派生身份，也不把公开 Authorization/Cookie 或旧 ServiceKey 当作另一套内部认证。网关认证和注销端点按上表保留其自身原始凭据边界，详见[gateway契约](gateway-auth.md)。

Server 的业务 Service 继续在事务边界检查真实账号、会话、归属和资源状态。HTTP 中间件提取身份不等于资源授权。trace 默认从上下文传递；缺失或非法入站 trace 生成新值，响应头与 JSON Envelope 使用同一 trace。解析器无法自设头时，只有专用回调 URL 可携带 Server 生成的 traceId query。

## RAG 请求与响应

请求使用 `Content-Type: application/json`，严格 Schema 不接受未知字段。公开和内部 RAG 共用请求、响应 Schema、handler 与运行时配置快照，不维护内部默认值分支。

```json
{"query":"查找相关内容","sourceType":"content_asset","mode":"hybrid","assetMode":"ids","topK":7}
```

`query` 为1—2000字符；可选 `sourceType` 为 `content_asset/file`（file查询现同时覆盖file/text真实来源），`mode` 为 `dense/keyword/hybrid`，`assetMode` 为 `ids/links`，`topK` 为1—50整数，`documentKey` 最多128字符。未传字段由当前业务配置决定。文件与导入文本执行其现有关键词检索策略，不因为协议收敛新增模型行为。只在明确需要图片 URL 时传 `assetMode: links`。

普通业务成功响应为 `{success:true,data,traceId}`；RAG data 为 `{mode,query,results}`。失败使用对应4xx/5xx和 `{success:false,error:{code,message,userMessageKey,retryable},traceId}`。调用方按状态、success 与 error.code 判断，不能解析人类 message 当协议。gateway认证的204与注销的专用响应属于明确例外；不包装成RAG Envelope。

## 出站客户端约定

Server 的手写 HTTP 统一由 `src/integrations/http-client.ts` 的 `ServiceHttpClient` 执行，业务调用方使用已有的 `DocumentExtractionClient`、`BailianEmbeddingClient`、`HttpRerankAdapter` 等业务客户端。云SDK继续使用其原生客户端，不再套第二层 HTTP。当前没有 Server→Agent 的调用，因此没有新增空壳 AgentClient。

通用层复用 Node 原生 fetch 的进程连接池；每个业务客户端复用自己的封装实例，不在每次调用时新建 Agent/Pool。每次业务调用仍然产生必要的 HTTP 请求。共用行为为：

- 从当前上下文传递 trace，保留业务客户端明确提供的目标凭据。
- 合并调用方取消信号与单次超时；期限覆盖等待响应头和读取响应体。
- 禁止重定向，避免请求或凭据被转发到另一个地址。
- 流式限制 JSON 响应字节数，成功、失败、超限与取消时释放响应体。
- 不在通用层重试。Embedding 保留自身有界重试；解析提交失败可能已经发生外部副作用，保持 unknown，通过现有任务恢复协议查证。

各业务客户端仍拥有远端路径、JSON结构、状态接受范围、凭据和错误映射。Embedding响应上限8MiB、rerank为1MiB；解析响应遵守本身配置。健康探针3秒，解析取消/ack仍有10秒信号上限；解析总任务期限和rerank外层预算继续生效。未来新增 Server→Agent 调用时，在 integrations 下新增真实使用的业务客户端，使用同一通用层和明确方法，不在 handler 内拼一次性 fetch。

修改已有协议时同步该接口 Schema、调用方约定、严格契约测试及文档；按用户要求移除旧实现和别名，不留路径探测、第二套凭据或自动降级。只有本轮授权的 Server 文件被修改；跨仓同步和环境交接必须据实记录。
