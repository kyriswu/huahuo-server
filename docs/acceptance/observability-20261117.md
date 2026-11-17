# 统一观测契约本地验收（2026-11-17）

范围为 huahuo-server 与 huahuo-agent 的代码、测试、配置模板和可导入观测文件。本记录是发布前开发验收：该阶段未提交、未部署，没有修改 Prometheus/Grafana/Dozzle 或服务器配置，没有调用付费模型、短信或真实 OSS，也未操作 App。后续 Server 单仓发布状态另见 [发布记录](observability-release-20261117.md)。

## 实现结果

- 统一 env/service/role/version/service_instance_id；版本和实例只放 application_info，不扩张全部 Histogram 标签。
- 官方 OTel SDK + W3C 上下文；保留已有 traceId 作为不透明关联号，真实 trace_id/span_id 独立记录。Agent 使用官方 Mastra Observability/OtelBridge，未增加第二套模型调用器或观测持久表。
- HTTP 完整响应、中断、依赖结果、状态流终态、原生 Agent/模型/工具、Task 尝试/终态和 RAG 阶段分开观测。未知模型用量不填零；同 inference span 内的 SDK HTTP 重试不冒充单独模型指标。
- 可选 OTLP 默认不联网，配置后有界批量导出；正文、工具参数、认证、URL、异常文本等经过导出允许清单过滤。Agent 日志保留有限元数据与安全异常类型/位置，Server 保留既有脱敏诊断。
- 新增 0012_task_trace_context.sql：可空 JSONB 与 carrier 结构 CHECK，无外键、无回填、无历史迁移改写。生产者 carrier 与原 enqueue SQL 一起保存，后续消费/重试/恢复不覆盖。
- Scheduler 复用观测查询，最多每 10 秒刷新队列快照；多副本共享 PG 用 max。看板按实例剔除超 60 秒旧快照，并显示最旧副本的新鲜度，避免陈旧高值被另一个健康副本掩盖。

## 验证与证据边界

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| Server pnpm test | 84 文件、1199 项通过 | mock/单元/契约；不等于真实提供商联调 |
| Server pnpm test:integration | 文件 32 通过、1 跳过；461 项通过、4 项跳过 | 每次创建自有临时 PostgreSQL/Redis；不加载开发库配置；Milvus 专项未运行 |
| Server 隔离升级演练 | schema 11 → 12，仅应用 0012；再次执行无新增迁移 | 已执行迁移 checksum 校验、可空字段/约束/角色 CRUD/trace 持久化和零物理外键验收通过 |
| Server pnpm typecheck / pnpm build / pnpm lint | 通过 | 最后日志字段收敛另跑定向测试与 Lint |
| Server 官方 SDK 与 loopback OTLP | 10 项通过 | 真实本机 HTTP 接收器、官方序列化；不是云 Trace 平台验收 |
| Agent pnpm test | 29 文件、354 项通过 | 含 10 项观测测试；提供商、Server 和 OTLP 接收端均为本机测试替身 |
| Agent pnpm typecheck / pnpm build | 通过 | 构建跳过 dotenv、平台 telemetry 与真实持久库，不启动线上实例 |
| Prometheus 记录规则 | 6 条规则解析通过 | 本机已有 prometheus:v3.16.0 镜像中的 promtool，无新常驻服务 |
| Prometheus 数值测试 | 6 组通过 | 多副本、缺错误序列、空闲/缺目标、取消、counter reset、陈旧队列与跨环境隔离 |
| Grafana JSON 与 PromQL | 26 条面板表达式解析通过 | 变量替换后用 promtool 解析；未导入实际 Grafana，未声明线上面板已有数据 |

首次全量隔离集成有一项失败：旧 Task 日志替身只有 child，无顶层 structured info，Worker 在执行前抛错。仅修正替身和新日志字段断言后，全量隔离测试重跑通过；没有给生产逻辑增加旧日志兼容分支。

Agent 原生链测试实际运行 mock provider → native tool → Server 客户端 → text-delta，验证官方桥父子关系、一次首文本、原生模型/工具/run 计数及已知用量；没有用手工构造 span 代替此条证据。另测真实 loopback /metrics、端口冲突拒绝启动、SSE reader 完成/取消、响应消费超时、并发上下文与 canary 不泄漏。Server 同样验证真实 socket 中断只计一次，以及状态流失败/取消/背压等终态。

进程终态 Counter 是最佳努力观测，不是业务账本；本轮未进行跨机网络、线上流量、真实模型推理、Trace 后端、Grafana 渲染或资源开销压测。SDK 原生云请求也没有自动变成逐次 HTTP 指标。

## 交付与后续接入

[观测契约](../observability/contract.md)、[指标字典](../observability/metrics.md)、[接入说明](../observability/README.md)、[Grafana 看板](../observability/grafana-dashboard.json)、[Prometheus 规则](../observability/prometheus-rules.yml)。Agent 独立说明位于该仓 docs/runbooks/observability.md。

Server 发布清单已为 0012 与四角色更新准备，仍需正常控制文件审查、固定提交及发布流程；本次没有迁移任何现有环境。Agent 独立发布，不夹带在 Server 发布中。同机候选或多副本必须分别分配业务和指标宿主端口。平台接入时需要配置各副本 targets（含正确 env/service/role），按需配置 OTLP 接收端，再导入看板；这些外部步骤尚未执行。
