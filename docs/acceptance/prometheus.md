# Prometheus 指标接入验收 · 2026-11-15

后续隔离回归使用云端 Milvus 完成：481 项 unit/contract、244 项集成全部通过、零跳过，包含本指标专项；解析与模型仍为替身，实际指标部署和中心抓取也未验证。证据见[隔离回归验收](cloud-milvus.md)，真实服务与抓取列入[上线前待办](pending-live-verification.md)，下文保留指标接入时的原始验证记录。

本轮为监控增量，停在代码与本地隔离验证点，不推进 Pxx。初始工作区已有解析 callback、节点和运行配置等未提交改动，未把其验收结果冒充本轮结果。

## 实现

使用固定 `@prometheus-io/client@0.16.1`，pnpm 10.15.1 更新 package.json / pnpm-lock.yaml。官方 engines `^22 || ^24 || >=26`；本机 `node --version=26.11.0`，当前 API 容器只读查询 `node --version=26.12.1`，均兼容。仓库原无指标注册表或 /metrics。

`src/plugins/metrics.ts` 提供每角色 Registry、HTTP Counter/Histogram、任务结果 Counter 与独立 /metrics 监听。`apps/base.ts` 注册一次全局计时；`entrypoints/runtime.ts` 管理监听生命周期，`worker.ts` 将同一 Registry 注入全部队列；`tasks/engine.ts` 在数据库提交后计数，`tasks/queue.ts` 传递共享指标对象。

`config/metrics.ts` / `config.ts` 从现有 APP_ENV 取环境，新增监听开关/地址/端口/service 配置。Compose 提供四个独立端口，四份 env 示例同步；cloud 示例 APP_ENV=test，实际本机 .env 仍 development。容器隔离检查允许专用指标端口，继续拒绝后台业务端口。配置与 PromQL、中心 targets 见[手册](../runbooks/prometheus.md)。

本轮文件清单（共享文件中的其他在途修改不归本轮）：

| 用途 | 文件 |
| --- | --- |
| 指标注册、HTTP 钩子与专用监听 | `src/plugins/metrics.ts`、`src/apps/base.ts` |
| 环境与启动 | `src/config/metrics.ts`、`src/config/config.ts`、`src/entrypoints/runtime.ts`、`src/entrypoints/worker.ts` |
| 提交后的任务计数 | `src/modules/tasks/engine.ts`、`src/modules/tasks/queue.ts` |
| 端口与配置示例 | `compose.yaml`、`.env.example`、`.env.compose.local.example`、`.env.compose.cloud.example`、`.env.host.example`、`scripts/container-isolation.mjs` |
| 依赖 | `package.json`、`pnpm-lock.yaml` |
| 专项验证 | `tests/unit/metrics.test.ts`、`tests/integration/metrics.test.ts` |
| 验证阻塞修复 | `migrations/0001_initial_schema.sql` 中 CHECK 显式命名；`tests/unit/storage-relations.test.ts` 的 TaskRow fixture 对齐 |
| 文档 | 本验收、`docs/runbooks/prometheus.md`、`README.md`、`docs/progress.md`、`docs/container-status.md`、`docs/provider-status.md`、`docs/contract-compatibility.md`、`docs/app-reference.md` |

## 运行验证

使用 APP_ENV=test 在本机 loopback 启动真实 Fastify HTTP 与真实指标监听；HTTP 验证不连接业务数据库。`tests/unit/metrics.test.ts` **10 项通过**：

- 10 次完成响应：200×2、201×1、302×1、400×2、401×1、404×2、500×1；Counter 总增量 10，Histogram count 和 +Inf bucket 总增量均 10。
- 两个不同 UUID 的任务路由都归入 `/tasks/:taskId`，该序列增量 2；404 统一 unmatched。指标未出现 UUID、查询字符串或 trace ID。
- 两个延迟请求的 sum 为秒级（至少 0.035s），4xx/5xx 均有 duration；成功 2xx/3xx 合计 4/10，符合约定口径。
- 指标自身、健康检查及其错误查询不增加请求计数；四个角色的独立指标监听都能返回库的 Content-Type、env/role/service，指标端口不提供 Admin/业务/健康路径。
- APP_ENV=development/test/production 分别输出 development/test/prod，验证禁用开关、配置边界及 Registry 隔离。

`tests/integration/metrics.test.ts` 使用随机独立 PostgreSQL 17.9 / Redis 7.4.8（本轮 tmpfs 容器、测试角色与凭据），真实数据库与真实 BullMQ，外部供应商未调用：

- success/failure 各增 1；重复提交、回滚、失效租约及未知外部结果均未误增。验证数据库实际 succeeded/failed/reconciling 状态。
- 两个 Worker 运行实例、四个 BullMQ 队列共享各自实例 Registry，各指标端点分别 success=2，总计 4；其中一个实例另有 failure=1，另一实例为 0。未知 kind 归为 other，不产生随机标签。
- 同轮验证业务 Schema 外键为 0、关系索引及普通 CRUD。临时依赖只清理本轮所属容器/凭据，不删除已有卷或开发数据。

命令/原始记录位于 `.local/prometheus/`：`metrics-unit.log`、`http-before.prom`、`http-after.prom`、`http-verification.json`、四角色 `.prom`、`metrics-integration-final.log`、`compose-validation.json`。专项集成入口复用原 runner 的临时依赖与清理逻辑，仅筛选本轮指标及零外键用例，并排除 .local 快照。

## 检查边界与已发现问题

首次隔离迁移因现有新加 resume_count 的跨列 CHECK 自动取名 tasks_check，与原命名约束冲突。本轮只为其明确命名 `tasks_resume_count_check`，语义不变，仍是唯一 0001 基线、无物理外键；没有对现有开发库执行迁移或修改迁移校验。

本轮已运行全量 unit/contract 和 PG/Redis integration。运行期间工作区的解析/任务改动仍在变化：曾出现同步/异步默认值不一致、回调用例尚未对齐以及 task_outbox 授权不足；原始失败保留于 unit-contract.log / integration-fixed.log / metrics-integration.log。初期全量失败不能当作指标失败或通过的证据。相关工作区改动完成后，最终全量 unit/contract **465 项通过**，隔离 PG/Redis integration **237 项通过、1 项 Milvus 跳过**，分别见 unit-contract-final.log / integration-regression-final.log；这些总数包含工作区其他变更，本轮指标新增为 10 项 HTTP/配置与 2 项业务集成。最终 typecheck、lint、build 均退出 0，记录于 typecheck-final.log / lint-final.log / build-final.log；已有 Vite 体积提示保留。

Compose 使用空 env 与合成占位值离线验证：默认四个指标端口只绑 loopback；APP_ENV=test 与合成私网地址配置能映射至全部角色，migrate 独立，后台不新增业务端口。本机实际 .env 未改，云测试机 IP/主机名及中心 Prometheus 连通性未知，未将本地验证称为云端已部署/已抓取。未重建现有业务栈、写开发 RDS/OSS、开停云机器或改宿主 Nginx。

只读核对 `../huahuo-ai` 的 api_endpoints.dart 与 http_auth_repository.dart，两个 SHA256 与既有基线一致；此次不新增 App 参数或修改 App 文件。
