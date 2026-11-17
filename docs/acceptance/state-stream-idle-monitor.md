# 后台状态 SSE 背压与闲置监控初始化恢复（2026-11-17）

状态：本地已修复，未提交、发布或重启既有服务。只改 Server 的状态流及解析节点监控生命周期，没有新增数据库迁移、ENV、依赖或轮询任务。

后续全仓复核已解除下文记录的两项并行 OSS 阻塞：当前类型检查、1109项单元/契约、397项真实依赖及完整隔离升级均通过，详见[全仓验收](full-check-20261117.md)。下文保留当时的专项结果和失败事实。

## 后台状态 SSE

`src/lib/state-stream.ts` 供 Admin 节点状态、文档试跑状态使用，传递完整状态快照。事件名、JSON 内容与接口不变；本实现不用于 Agent 的增量聊天 token。

- `write()` 返回 false 后等待 `drain`，期间暂停状态读取、JSON 序列化和心跳写入。变更通知只标记有更新，恢复后重新读取最新状态，不缓存历史快照队列。
- 单事件及现有待发送字节合计超过 1 MiB 时断开；连续等待 `drain` 30 秒仍未恢复也断开。1 MiB 是发送队列限制，不是读取对象、JSON 序列化瞬时分配或进程总内存限制；`drain` 不是客户端接收确认。
- 终态在写缓冲允许继续后结束响应。服务主动关闭时，堵塞连接直接销毁；正常连接结束响应。原 API 排空及 Admin 立即关闭策略保留。
- 订阅失败、晚到退订、在途读取后断开，以及读取、序列化、心跳和异步写入错误都会清理订阅、定时器及监听。

实际 Writable 验证：首包堵塞后连续通知 100 次并经过一次心跳周期，读取和序列化各仅 1 次，发送缓冲保持不变；释放缓冲后各增加 1 次，第二个状态为最新版本 100。不是网络压测或公开 API 容量结论。

## 闲置关机监控

`createDocumentParserMachine.startIdleMonitor()` 复用进行中的启动 Promise；首次 connect/subscribe 失败会卸下监听、断开旧订阅连接并清空失败实例。既有 `ProcessingNodes.startMonitors()` 下一轮 30 秒重扫能够重新建立监控，不需要重启容器。成功启动后重复扫描复用原监听，没有增加状态查询频率。

关闭先标记停止，再等候初始化和在途检查完成；关闭过程中初始化不能重新激活监听，等待状态查询的检查不能再发起新的 tick。已开始的云操作仍沿用原有在途处理机制。本轮没有更改云启停条件、租约、闲置阈值或业务扣费。

## 验证

| 验证层次 | 结果与边界 |
| --- | --- |
| 定向单元与生命周期 | 6 文件 105 项通过：SSE 15、monitor 11、runtime monitor 6、machine 45、ECI 14、lifecycle 14。包含真实 Writable、Fastify 回环 HTTP 和退出信号；Redis/云依赖使用明确替身。 |
| 真实隔离 Redis | `tests/integration/document-parser-machine.test.ts` 31 项通过，包含真实 Pub/Sub 唤醒与闲置计时、并发/租约状态。ECS/HTTP 为替身，无真实云调用。首次连接/订阅失败与关闭竞态由上述受控单测验证。 |
| 静态与构建 | 全仓 ESLint、构建及 diff-check 通过。最终全仓类型检查被并行 OSS 测试 `tests/unit/oss-head.test.ts:36` 的可选 header 类型错误阻塞，本次修改文件未报类型错误；不宣称全仓类型检查通过。 |
| 完整集成入口 | 首次尝试停在发布数据库预演，错误 `RELEASE_DB_VERIFICATION_FAILED`，尚未执行测试。并行 OSS 断言直接查询 Scheduler 无权限的 resources 表，且 information_schema 列检查也受权限过滤。未修改、绕过正式发布门禁或扩张角色权限。另用独立 Redis 专项 runner 验证本轮功能，两种结果分别保留。 |

日志及隔离运行脚本位于忽略目录 `.local/state-stream-monitor/`：`unit-final.log`、`redis-integration.log`、`typecheck-final.log`、`lint-final.log`、`build.log`；首次完整入口失败见 `integration.log`。隔离容器限定本地 Unix Docker、回环端口、自有标签，无持久卷；执行后只清理本次资源。未清空或操作共享开发数据库。

App 只读复核：HEAD `bf23c1b14d847de5561c1ba66bd4192dc308b356`，工作区干净。`lib/core/network/api_endpoints.dart` SHA-256 为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`，`lib/features/auth/data/http_auth_repository.dart` 为 `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`；未修改 App，不把后台状态流测试当作移动端或 Agent 聊天验收。
