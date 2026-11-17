# 观测接入与看板

统一定义见 [契约](contract.md) 和 [指标字典](metrics.md)。本目录提供可导入的 Grafana 看板和经数值测试的 Prometheus 记录规则，没有自动修改中心平台、创建 Trace 服务或部署代码。

## 导入

1. 在 Grafana 导入 [grafana-dashboard.json](grafana-dashboard.json)，选择已有 Prometheus 数据源；按 env/service/role/instance 筛选。看板直接查询原始指标，不依赖先安装记录规则。
2. Prometheus 抓取每个进程的独立指标端口。Server 端口和网络限制见 [Prometheus runbook](../runbooks/prometheus.md)；Agent 默认 Compose 宿主端口 9469，容器内 9464。多副本需独立地址/端口，不抓负载均衡地址。
3. 如需复用聚合结果，将 [prometheus-rules.yml](prometheus-rules.yml) 加入中心 rule_files 并检查/重载；不覆盖现有规则。本目录未制定业务告警阈值。
4. 如已有 OTLP HTTP Trace 接收端，配置 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT。日志仍为标准输出 JSON，可先用 Dozzle；需要历史检索和日志跳转时再接入已有日志平台。Grafana 的日志/Trace 链接需按实际 Loki/Tempo/其他数据源配置，当前看板不虚构这些连接。

看板包含实例身份与抓取状态、分层 HTTP、依赖、Agent/模型/工具、任务队列和 RAG。首次没有业务流量时，Counter/Histogram 面板可能没有序列；显示无数据是预期。up 来自 Prometheus，application_info 来自进程；先检查抓取和版本再判断业务指标。

队列数量与年龄先按实例剔除超过 60 秒未成功更新的快照，再按环境/服务/队列取 max；全部过期时无数据。新鲜度面板显示最旧副本的快照年龄，避免被另一个健康副本掩盖。正常扫描约 10 秒更新一次，60 秒是看板的新鲜度边界，不会改变调度或触发清理；节点需保持时钟同步。

## 本地验证

使用与中心兼容的 promtool：

```sh
promtool check rules docs/observability/prometheus-rules.yml
promtool test rules docs/observability/prometheus-rules.test.yml
```

测试涵盖多副本聚合、没有错误序列但存在请求、零流量、目标完全缺失、主动取消和计数器重启。所有看板表达式也须经 PromQL 解析，变量替换成有效值；这证明查询语法有效，不等于已有线上数据。

## 后续正常发布

本次 Server 候选包含迁移 0012_task_trace_context.sql 和四角色代码，遵循既有发布清单与迁移校验。历史迁移不改，历史任务无需回填。可选 OTLP 环境变量为空即可继续无导出运行。依赖锁和 Compose 等控制文件仍走现有 main 审查流程，不绕过门禁。

Agent 是独立项目，单独审查、测试和发布，不并入 Server 发布。启用 Agent 指标后，新旧候选同机重叠时两个实例的业务端口与指标宿主端口都需独立；没有新增自动端口分配机制。实际应用、平台接入和发布验收分别记录，不能用本地 mock 或隔离数据库结果替代线上证据。
