# 指标字典

所有应用指标带 env、service、role。表中省略这些默认标签。Counter 用 rate/increase；耗时单位均为秒。直方图先合并各副本 bucket，再算分位数，不能平均 P95。无样本、零流量和 usage 未知不得显示成 100% 成功或零成本。

## HTTP 与依赖

| 指标 | 标签 | 口径 |
| --- | --- | --- |
| application_info | version, service_instance_id；Agent 另有 ttft=first_text | 值 1；确认身份与能力，不代表依赖健康 |
| http_requests_total | method, route, status, outcome, traffic | 完整响应一次；流式响应在完整结束后记录；排除健康与 metrics |
| http_request_duration_seconds | 同上 | 从入口开始至完整响应结束，包含 SSE 生命周期 |
| http_aborted_requests_total | method, route, traffic, reason | 未完整响应的连接；与完成数互斥 |
| http_aborted_request_duration_seconds | 同上 | 开始至异常关闭 |
| http_requests_in_flight | 无 | 当前活跃 HTTP/流连接，完整结束或中断后归还，排除健康与 metrics |
| http_client_requests_total | dependency, operation, method, status, outcome | 每次客户端请求尝试各一次，包含响应消费与协议/业务校验；独立重试各算一次；可能在发出前取消 |
| http_client_request_duration_seconds | 同上 | 包含完整响应消费、截止时间和取消 |

route 是匹配模板，未匹配/未知路径使用固定占位；不采集原始 URL。traffic 为 public/internal/admin/other，只表示该物理 HTTP 路由的性质。HTTP outcome 为 success(2xx 等)、redirect(3xx)、client_error(4xx)、server_error(5xx)，不能替代业务成功率。reason 为 client_abort、connection_error、response_incomplete。

出站 outcome 为 success、http_error、business_error、network_error、timeout、cancelled、response_error。拿到 2xx 后业务信封失败仍算 business_error；响应超限/非法等算 response_error；尚无响应头时 status=none。依赖故障比例排除主动 cancelled，不排除 timeout。Server 依赖枚举为 document_parser、embedding、rerank、processing_node、other；Agent 的 Server 客户端使用 huahuo-server 和受控 operation。非手写 SDK 调用不混入该指标。

HTTP 5xx 比例分母为已完成 HTTP；断流独立看。Agent 的 /agent 前缀在路由模板中规范化；按 service/role/traffic 区分入口与内部调用，避免全链路重复累计。

## Agent、模型与工具

| 指标 | 标签 | 口径 |
| --- | --- | --- |
| agent_runs_total | agent, outcome | 原生 AGENT_RUN 的终态；success/error/abort/limit/blocked；进程内有界去重 |
| agent_run_duration_seconds | agent, outcome | 进入终态的执行段耗时，恢复前的暂停时间不在内，不冒充跨恢复总墙钟耗时 |
| agent_run_segments_total | agent, outcome | 所有已结束原生执行段，包括终态；suspend/interrupted/unknown 不当作成功完成 |
| agent_run_segment_duration_seconds | agent, outcome | 对应执行段耗时，不含暂停等待 |
| agent_time_to_first_text_seconds | agent | 初始运行开始至首个非空 text-delta；包含工具/RAG等待，不是首个任意 SSE chunk，也不是客户端收到文本的时间 |
| model_requests_total | provider, model, outcome | 每个原生 MODEL_INFERENCE 各一次，不重复累计外层 generation/step；同 span 内 SDK HTTP 重试不额外计数 |
| model_request_duration_seconds | provider, model, outcome | 原生推理耗时，不混入工具或整段对话耗时 |
| model_tokens_total | provider, model, direction | 原生提供商已知 input/output usage，缺哪个方向就不补哪个方向 |
| model_usage_reports_total | provider, model, availability | 每次推理的 complete/partial/unknown；中断后合成零 usage 按 unknown |
| tool_calls_total | tool, outcome | 原生 TOOL_CALL/MCP_TOOL_CALL，分别统计成功、错误、中断等结果 |
| tool_call_duration_seconds | tool, outcome | 原生工具执行耗时 |

agent/provider/model/tool 均按启动时的已知定义归一，未知项 other。原生 outcome 为 success/error/abort/interrupted/suspend/limit/blocked/unknown；只有前述终态进入 agent_runs_total，不能将 runs 与 segments 相加。首文本只观测初始流式运行一次；非流式、无文本、恢复执行段不伪造样本。模型耗时与 token 数不等于账单，usage 完整率要与 token 面板一起看。Agent HTTP 完成与运行终态不互相推导。

## Server Task、RAG 与状态流

| 指标 | 标签 | 口径 |
| --- | --- | --- |
| task_processing_attempts_total | kind, result | finish/fail 事务成功提交后本次处理尝试的 success/failure；不等于唯一任务完成数 |
| task_recovery_failures_total | 无 | 恢复路径观察到的不变量失败次数，可能重复观察同一任务 |
| task_terminal_total | kind, state | 已提交的 succeeded/failed/cancelled 终态变更，各终态一次 |
| task_terminal_duration_seconds | kind, state | 数据库时钟计算任务创建至终态耗时，包含排队与重试 |
| task_pending | queue | 到期可调度的 queued/retry_scheduled 数；不含运行中、外部等待、未来重试 |
| task_oldest_waiting_seconds | queue | 上述任务中最早 available_at 至今的等待；重试从本次可执行时间算起；空队列为零 |
| task_backlog_observed_timestamp_seconds | queue | 最近一次成功数据库快照的 Unix 时间；没有成功快照时无序列 |
| rag_stage_duration_seconds | stage | auth/pg_scope/index_ready/embedding/index_search/pg_hydrate/rerank/pg_recheck 各实际阶段 |
| rag_operations_total | operation, outcome | note_query/file_query/text_query 既有技术路由查询及 embedding_attempt；success/failure |
| rag_operation_duration_seconds | operation, outcome | 对应查询/嵌入尝试耗时；不能把查询和内部嵌入次数相加当作用户检索次数 |
| rag_fallbacks_total | reason | 每次查询发生 rerank 降级记一次；timeout/error/invalid_response |
| stream_sessions_total | kind, outcome | 状态流关闭一次；completed/client_abort/error/timeout/shutdown/backpressure/cancelled |
| stream_duration_seconds | kind, outcome | 状态流连接生命周期 |
| stream_first_event_seconds | kind | 第一条状态数据被传输层接收的等待；非客户端 ACK，不含心跳 |
| stream_events_total | kind | 流结束时汇总传输层已接收的数据事件数；不含心跳 |

Task 延后继续、回滚、未知外部结果不伪造处理完成；重试尝试可以先失败、最终成功。终态分布的时间窗不是同一批创建任务的成功率。kind/queue 为代码中的受控枚举。队列 Gauge 为共享 PG 快照，多 Scheduler 用 max；Counter 才按副本 sum(rate(...))。快照最多每 10 秒刷新，结合抓取周期存在正常延迟。

stream kind 为 node_status/document_trial/state；HTTP 200 下的 document_trial failed/cancelled 仍按 error/cancelled 结束。状态流与 Agent 原生模型输出流是不同指标族，不拿状态首事件当 LLM 首文本。

既有 draining、in-flight 等生命周期 Gauge 保持原语义，未重新定义为用户数或任务积压。新增看板只引用实际产生的指标；后续新增业务指标需先定义事件边界、标签字典、失败分母和无数据含义。
