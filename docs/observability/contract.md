# 花火观测契约 v1

本契约覆盖 huahuo-server 与 huahuo-agent。目标是让一次请求的指标、JSON 日志与真实调用链可以关联，同时保持不同层的统计含义清楚。代码负责产生数据；Prometheus、日志平台与 Trace 后端分别负责存储，Grafana 负责组合展示。导入看板不会自动接通日志或 Trace 数据源。

## 身份与关联

| 含义 | JSON 日志 | OTel resource | Prometheus |
| --- | --- | --- | --- |
| 环境 | env | deployment.environment.name | env |
| 服务 | service | service.name | service |
| 角色 | role | huahuo.role | role |
| 版本 | version | service.version | application_info 的 version |
| 进程实例 | service_instance_id | service.instance.id | application_info 的 service_instance_id |

APP_ENV 的 development、test、production 分别映射为 development、test、prod。Server 四角色为 api-server、admin、worker、scheduler；Agent 为 agent。版本默认 package.json，可用 OTEL_SERVICE_VERSION 注入构建版本或提交 SHA。Prometheus 自己的 instance 是抓取地址，与进程身份不同。version 和 service_instance_id 不加到每条业务指标，避免每次发布扩张所有 Histogram 序列。

- `traceId` / `X-Trace-Id`：保留已有的不透明请求关联号，可用于错误响应、日志、解析回调与任务关联；它不是标准 Trace ID。
- `trace_id` / `span_id`：实际 OTel span 的标准标识。使用 W3C `traceparent` / `tracestate` 传播真实父子关系；缺失或非法父上下文时创建新根。并行请求通过异步上下文隔离。
- `taskId`、Agent 的 run/tool 标识用于日志与 Trace 关联，不作为 Prometheus 标签。

Server 入站请求、手写依赖客户端、任务执行和 RAG 阶段建立 span；Agent 使用官方 Mastra Observability/OtelBridge，把入站请求、原生运行、模型、工具及 Server 客户端接在同一链上。不是所有 SDK 网络请求都已自动插桩：OSS、计算节点、Milvus 等 SDK 请求不能据此推断物理 HTTP 次数。无法携带 W3C 头的解析回调创建新 Trace，保留原 traceId 做关联，不伪造父 span。

任务把生产者 W3C carrier 持久化到 tasks.trace_context，重试和容器重启继续沿用。历史 NULL 任务创建真实新根；不回填伪造上下文。0012 是新增的可空列迁移，不修改冻结历史迁移。

HTTP、状态流与 Agent 运行日志使用 event、outcome；记录耗时时统一为 durationMs，HTTP 状态字段为 statusCode。route 为模板，dependency/operation 为受控名称。两端入站终止事件为 http.server.completed，连接未完成时 outcome=aborted；出站终止事件为 http.client.completed。未拿到完整 HTTP 响应时不伪造 200。Server 可另记 http.server.started，Agent 原生运行用 agent.run.ended，Server 状态流用 stream.closed；Task 步骤使用 task.step.* 和 step.outcome 表示执行结果，不把执行段返回误当作任务终态。这些事件不混为一个业务成功事件。底层 logger 的时间与级别格式由各自客户端产生，采集平台按其 JSON 字段解析；跨服务关联使用上述身份、事件与 trace 字段。

## 指标、日志与 Trace 各自的职责

指标回答速率、分布、失败比例、排队和用量是否可观测；JSON 日志记录一次操作的上下文与结果；Trace 记录具体父子调用与阶段耗时。指标不依赖 Trace 采样，也不把一条请求的明细做成标签。

HTTP 完整响应、连接中断、Agent 运行终态、原生模型推理、工具调用、任务尝试和任务最终完成分别计数。模型指标按原生 MODEL_INFERENCE span 计数，供应商 SDK 在同一个 span 内重试不单独计数，不声称是底层 HTTP 请求数。一个用户请求可能包含鉴权子请求、多个内部 HTTP 和多次模型推理，不能把这些相加当作用户请求量。HTTP 200 的 SSE 可以携带运行失败；连接关闭也不一定意味着后台运行取消。详细口径见 [指标字典](metrics.md)。

不记录每个 token；只在操作或流生命周期结束时聚合统计。原生模型 usage 缺失、部分缺失与完整报告分别标注，缺失不填零。指标是进程内最佳努力观测，事务提交后恰好退出仍可能漏一次记录；不能作为扣费、余额或资源使用的持久账本。

## 内容与基数边界

Prometheus 只保留受控路由模板与有限枚举：不包含用户、工作区、任务、run、trace、原始 URL、IP、文件名或异常消息。新增依赖、模型或工具时同步维护有限字典，未知项归 other。

OTLP 导出采用允许字段清单，移除 prompts、输入输出、工具参数、事件内容、异常消息、URL、认证头和 vendor tracestate。Agent 框架日志采用结构化元数据，不直接输出框架任意 message；异常只保留安全类型、有限 code 和截断栈位置。Server 延续已有脱敏错误诊断，业务代码仍不能把任意正文或供应商响应拼到 Error.message。两端均不导出请求正文、JWT 或身份头。

## 启用与成本

独立 /metrics 默认启用，仅暴露在回环或管理网络。未设置 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 时不创建网络导出器；仍生成真实上下文供日志和跨进程传播。显式设置时使用完整 HTTP traces 端点，例如 `http://collector:4318/v1/traces`，不接受 URL 凭据、查询参数或 fragment；当前不提供导出认证头配置。

Trace 根默认采集并遵循上游采样位。批量队列、单次导出超时和退出等待均有上限；接收端故障不会让业务等待逐条上报。并不承诺故障期间不丢 Trace。没有增加观测数据库、逐 token 存储或额外业务定时任务。Scheduler 的现有扫描每 10 秒刷新一次队列快照，不按 HTTP 请求查询数据库。

采集所有副本的独立 /metrics 地址，不能抓负载均衡入口来代表全部副本。共享 PostgreSQL 的多 Scheduler 看到的是同一个队列快照，聚合用 max，不能 sum；快照时间指标用于识别数据库读取停滞。Agent 同机多副本或候选实例需各自分配 AGENT_PORT 和 METRICS_HOST_PORT；默认单实例指标宿主端口为 9469，不会自动协调端口。

## 规范依据

- [W3C Trace Context](https://www.w3.org/TR/trace-context/)：跨服务上下文传播。
- [OTel resource conventions](https://opentelemetry.io/docs/specs/semconv/resource/)：服务、环境与实例身份。
- [Prometheus instrumentation practices](https://prometheus.io/docs/practices/instrumentation/)：Counter、Histogram、标签与单位。
- [Mastra observability](https://mastra.ai/docs/observability/overview)：原生运行、模型与工具事件；实现 API 以当前安装版本源码和测试为准。

看板导入、规则验证及部署边界见 [接入说明](README.md)。
