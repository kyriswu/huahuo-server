# Server 统一观测测试发布

本次用户授权只发布 huahuo-server 仓库全部待提交改动到测试环境；本次操作未提交、发布或重启 Agent，未操作 App，未修改中心监控平台或宿主入口配置。测试发布已于 2026-11-17 18:57:33（Asia/Shanghai）完成，终态 TEST_RELEASE_OK，五阶段 5/5 通过，未发生排空强退。

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

Prometheus 6 条规则、6 组数值测试及看板 26 条表达式通过，但没有导入中心平台。Agent 开发结果不作为本次 Server 发布门禁或发布范围。真实付费模型、短信、解析与 OSS 不在本次冒烟中。候选提交及准确合并提交的干净 release:check 均通过。

## 实际发布结果

Owner 已合并 [main 控制 PR #30](https://github.com/kyriswu/huahuo-server/pull/30)，控制 SHA 为 d53d9f947dd266ab46fd50d6d961b8c0c14631a5，其 [push CI](https://github.com/kyriswu/huahuo-server/actions/runs/44067961517) 通过。main 与业务候选 Compose 字节一致。

[Server 业务 PR #31](https://github.com/kyriswu/huahuo-server/pull/31) 合入 test，准确业务 SHA 为 7ef993ee03808db7fab3d09b56d390a6df1fa16f；[同 SHA push CI](https://github.com/kyriswu/huahuo-server/actions/runs/44068292810) 通过后，自动启动 [Test server release](https://github.com/kyriswu/huahuo-server/actions/runs/44068774774)。尝试原生 Auto-merge 时 GitHub 返回 clean status（所有门禁已满足），随后按准确 head SHA 的普通 squash merge 合入，未绕过分支规则。没有手动重复触发或独立维护发布。

| 远端阶段 | 实际结果 |
| --- | --- |
| 1 预检与构建 | 固定业务/控制 SHA、成功基准与配置快照，候选构建及配置门禁通过 |
| 2 数据库迁移 | 只执行新增 0012；schema 11→12，保留已执行历史与 checksum |
| 3 迁移后验收 | 角色数据库/配置验收通过，新增字段可用 |
| 4 容器切换与旧服务退出 | 四角色交接通过，forcedRetirements=[] |
| 5 冒烟与清理 | 健康冒烟、成功记录和清理通过；保留当前与上一成功镜像 |

云调用 exitCode=0、dropped=0；公开 Actions 记录与独立目标成功记录一致。发布器报告五阶段而非仅终态；成功记录、四角色镜像及其不可变镜像 ID 均核对匹配 7ef993ee。没有删除数据卷、改历史 SQL、重置凭据或增加发布兼容路径。

## 发布后独立只读复核

2026-11-17 18:58（Asia/Shanghai）完成有界只读复核，四角色均 healthy，/health/live、/health/ready 和独立 /metrics 均返回 200。application_info 的 env=test、service=huahuo-server、role 各自正确，version=0.3.0，每个进程有独立 service_instance_id；代码来源由镜像 SHA 确认，未把 package 版本误当提交 SHA。

HTTP、依赖、Task、RAG、状态流的指标定义在四角色均已加载。Scheduler 的四队列数量/年龄/观测时间样本齐全且新鲜。专用健康探测携带 W3C 父上下文与不透明 X-Trace-Id，四角色日志均观察到对应 trace_id、独立 span_id 和统一身份字段；只提取该探测的白名单字段，没有采集用户正文或任意业务日志。

另行只读查询确认 schema_version=12、tasks.trace_context 为可空 JSONB、public 物理外键数量为 0。公网 HTTPS 就绪检查 200，匿名业务路径 401；这不等于有效账号的认证业务或端到端 Agent 调用验收。

本轮没有导入 Grafana 看板、修改 Prometheus targets 或配置外部 Trace 接收端；只证明当前角色的观测定义、队列快照和健康请求日志生效，不声明真实业务、付费依赖、SSE 业务终态、跨服务 Trace 后端或 CPU 开销已实测。下一次业务发布以实际成功 7ef993ee 为新基准准备清单；后续仅文档证据提交不再次发布应用。
