# 全仓本地验证（2026-11-17）

以当前未提交工作区为候选执行全仓验证。本轮没有修改业务代码、部署、重启现有服务或操作共享数据库；各项累计改动仍保留在工作区。Node 26.11.0、pnpm 10.15.1。

## 结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | Server、测试及 Admin UI 类型检查通过。此前 OSS HEAD 测试 header 类型错误已修复。 |
| `pnpm lint` | 全仓通过。 |
| `pnpm build` | Server 与 Admin UI 构建通过；保留现有 Ant Design `use client` 指令及大于 500 kB bundle 提示，不是构建失败。 |
| `pnpm test` | 76 文件、1109 项单元/契约全部通过。 |
| `node scripts/integration.mjs --milvus` | 28 文件、397 项全部通过，无跳过；真实临时 PostgreSQL 17.9、Redis 7.4.8、Milvus 2.6.26。模型、OSS、短信、解析及云启停使用受控替身/回环服务，没有真实供应商调用。 |
| 隔离升级演练 | 从清单基准数据库版本 3 升至 6，应用 0004/0005/0006；重复迁移应用列表为空。迁移账号及四种真实应用角色的数据库断言通过。 |
| 数据库约束 | 无物理外键；关系查询与普通 CRUD、迁移代表性数据、回滚和权限测试通过。 |
| Compose | 本机 `.env` 与 `.env.compose.cloud.example` 的 `config --quiet` 均通过，只解析配置，没有更新容器。 |
| 工作区 | `git diff --check` 通过；检查前后的已跟踪文件 diff 相同。没有提交、重置或覆盖并行窗口的变更。 |

首次将构建与单测并行执行时，构建清理 `dist` 导致 Qwen 发布门禁的 4 项单测无法解析其导入文件。确认这些测试依赖构建产物后，等待构建结束重新执行完整单元/契约集，1109 项通过；这是本轮执行顺序问题，未为此修改业务实现。失败日志保留，不以首次结果冒充通过。

## 前次阻塞复核

此前 [SSE/闲置监控验收](state-stream-idle-monitor.md) 中记录的两项并行 OSS 阻塞已解除：HEAD 测试的 header 允许缺失字段；发布 SQL 使用 `pg_attribute` / `pg_constraint` 验证 resources 结构，不再直接读取 Scheduler 无权限的 resources 数据，也没有扩大 Scheduler 权限。本轮完整隔离发布预演已实际通过。

发布清单与 0004–0006 一致，0001–0003 历史迁移未改。0006 的代表性存量状态、保留历史记录和异常回滚由真实数据库测试覆盖。旧下载/检查生产调用、OSS 公开签名入口的配置接线做了只读复核，不恢复兼容旁路。

## 代码审查新增发现（尚未修复）

1. **已完成上传提前删除后，原 PUT 签名仍可能重放。** `src/modules/storage/service.ts:20` 创建一小时有效的上传链接；`src/modules/storage/jobs.ts:34` 可在有效期内删除已完成资源的对象，随后释放容量。对象删除后，禁止覆盖条件不能继续依靠原对象阻止写入；`expireUploads` 又不扫描 completed 会话。由此推导原链接可能再次写入同一 Key 并留下无主对象。现有删除测试只断言当时对象已删除，未覆盖旧 URL 重放。此项是源码调用链发现，未使用真实 OSS 或新增替身复现；不能声称线上已发生泄漏。建议先补“上传→完成→有效期内删除→旧 URL 重放”回归，再协调签名寿命与物理清理时点，复用现有任务调度，不新增清理框架。
2. **开启 Bucket 版本控制时，未完成上传的回收需要额外确认。** 未完成会话尚未保存 object_version，过期删除不带 versionId；OSS 会保留实际对象版本并添加删除标记。此行为见 [DeleteObject 官方说明](https://www.alibabacloud.com/help/en/oss/developer-reference/deleteobject)。当前文档提醒版本清理，但没有证明目标 Bucket 已关闭版本控制或已具备对应清理策略；本轮没有访问真实 Bucket，不据此宣称目标已发生残留。作为条件性部署检查保留，没有擅自扩大版本删除范围。

以上发现独立于自动测试的通过结果；本轮全仓检查没有因此直接扩展上传、存储额度或历史回收业务。

## 发布与验收边界

本地验证通过不代表已具备自动发布条件。当前清单 `compatibility.database/api/tasks/configuration` 均为 false；正式提交审查、目标存量检查任务规模、OSS 候选配置与旧 Worker 排空仍须按现行发布流程落实。本轮没有运行要求干净提交的 `release:check`，没有改变兼容声明、跳过部署门禁或取得云发布权限。

本轮没有运行真实付费模型、真实 OSS/云节点、手机或 Agent；现有待定业务项（如检索范围、计费模式）没有在这轮全仓回归中扩展或重构。测试通过不等同于所有历史业务问题均已关闭。

App 仅只读核对：HEAD `bf23c1b14d847de5561c1ba66bd4192dc308b356`、工作区干净；`api_endpoints.dart` 与 `http_auth_repository.dart` SHA-256 分别为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`，与前次基线一致。

完整日志在忽略目录 `.local/full-check-20261117/`：`typecheck.log`、`lint.log`、`build.log`、`unit-contract-final.log`、`integration.log`、两份 `compose-*.log`；首次单测失败见 `unit-contract.log`。隔离 runner 只创建并清理本次标签/ID 对应的本地容器和临时凭据，无持久卷删除、共享库清空或既有服务重启。
