# Server 统一观测测试发布

本次用户授权只发布 huahuo-server 仓库全部待提交改动到测试环境；不提交、发布或重启 Agent，不操作 App，不修改中心监控平台或宿主入口。当前记录为发布准备状态，尚未上线。

## 实际基准与候选

2026-11-17 18:36（Asia/Shanghai）通过固定测试实例的只读成功记录及容器检查，成功业务 SHA 仍为 8b27e01c9ab78188e45573ff1fde98a04d699274。API/Worker 使用该镜像，Admin/Scheduler 使用上一成功 5af896d 镜像，四角色均 healthy。本次清单基于真实成功 SHA，而不是 main 或文档提交。

候选统一四角色的日志身份、W3C 追踪、HTTP/依赖/任务/RAG/状态流指标，附带观测契约、指标字典、Prometheus 规则和可导入 Grafana JSON。公开 API 路径、请求/响应、JWT 和可信身份头契约不变；只读核对真实 App 的 lib/core/network/api_client.dart，原有 traceId 仍是不透明关联号，标准 trace_id/span_id 独立添加，不要求 App 升级。

## 上线清单

- 数据库：仅新增 0012_task_trace_context.sql，可空 JSONB 与结构 CHECK；无回填、物理外键、历史 SQL/checksum 改写。既有任务保持 NULL，候选消费者从新根开始；新任务上下文随原 enqueue 事务持久化，重试不覆盖。
- 角色：api-server、admin、worker、scheduler 全部更新；一次性 migrate 由既有发布器按清单执行。旧镜像不执行迁移；应用恢复不撤销已提交 SQL。
- 依赖：Server 锁定官方 OTel SDK/HTTP exporter，业务镜像使用候选 package.json 与 pnpm-lock.yaml。默认无 OTLP 网络导出，不新增外部服务、观测表或资源。
- OTEL_SERVICE_VERSION：新增，四角色，非必填，默认 package.json.version；本次复用成功配置，不要求手动设置。应用解析及 Compose 注入校验；如以后需显示提交 SHA，再通过正常候选配置指定。
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT：新增，四角色，非必填，默认空/不联网；本次不配置 Trace 接收端。应用校验协议与禁止 URL 凭据/查询，发布复用同一成功快照。
- main 控制同步：仅同步本次两个可选 ENV 的 Compose 注入及审查记录。宿主要求 main/test Compose 字节一致；main 调用器使用自己的锁文件，业务镜像在 test 源码构建，不机械覆盖 main 旧业务依赖。
- 人工项：main 控制 PR 按仓库规定由 owner 审核合并；其余无需手动调整。没有首次迁移脚本、宿主安装、入口变更或监控平台安装。
- 冲突：准备时无；后续如有真实合并冲突另记。

## 验证与边界

Server 类型检查、Lint、构建通过；1199 项单元/契约、461 项真实隔离 PostgreSQL/Redis 集成通过，4 项跳过。小范围日志字段最终统一另跑 Task/Telemetry/状态流定向用例通过。隔离升级演练 schema 11→12，仅应用 0012，再次迁移为空；历史 checksum、角色查询/写入与零物理外键通过。具体证据见 [开发验收](observability-20261117.md)。

Prometheus 6 条规则、6 组数值测试及看板 26 条表达式通过，但没有导入中心平台。Agent 开发结果不作为本次 Server 发布门禁或发布范围。真实付费模型、短信、解析与 OSS 不在本次冒烟中。候选提交后执行 release:check；准确 test push CI 与远端五阶段结果应在实际完成后补录，不以本地健康或计划代替发布成功。
