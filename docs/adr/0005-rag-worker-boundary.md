# ADR 0005 知识库、RAG 与任务执行边界

## 现有依赖

| 方向 | 当前调用与所有权 |
| --- | --- |
| API → RAG | API 装配 RAG 写入路由和 `RagQueryService`。RAG 管理文档版本、入库处理、查询和对外响应。 |
| RAG → 任务 | RAG 在保存文档版本的同一事务中写任务和任务输入，再用 `enqueueIntent` 写 Outbox。部分任务操作调用 `TaskService`。 |
| RAG 和笔记入库 → 知识库 | 调用 `KnowledgeIndexJobs.indexSource` 构建索引。RAG 查询还依赖知识库的配置、正文读取及已发布构建和分块表。 |
| 知识库 → RAG | `kb/profile.ts` 直接引用 RAG 的 Embedding 适配器和模型常量。 |
| RAG ↔ 文档入库 | RAG 使用文档提取和回调能力。文档入库引用 RAG 的源校验和解析快照类型。 |
| Scheduler → Worker | Scheduler 从 PostgreSQL Outbox 取任务，通过 BullMQ 发送 `{ taskId }`。Worker 领取 PostgreSQL 任务，按类型执行，管理租约、重试和结果。 |

## 公共入口和依赖方向

- 查询调用方走 `RagQueryService`。文档写入走 RAG 路由及其 `RagIngestionRepository.create`、`action`。版本表和内部状态归 RAG 所有。
- RAG 和笔记入库通过 `KnowledgeIndexJobs.indexSource` 提交索引构建，通过 `kb/profile.ts` 获取索引和模型配置。知识库拥有构建、分块和已发布内容。查询侧现有的跨模块读表，可逐步收敛到由知识库提供的读接口。Embedding 适配器和模型常量适合放到双方都能依赖的共享层。
- 业务调用方通过 `TaskService` 操作任务，通过 `enqueueIntent(tx, taskId)` 在已有事务内登记投递意图。任务状态、租约和投递由任务模块负责，继续使用现有的事务与异步交接契约。
- Worker 执行契约由 `tasks/execution.ts` 提供，包含 `Attempt` 和 `TaskExecutor`。Worker 的应用装配层可以依赖 RAG 和任务实现，并把 RAG 处理器交给 `TaskWorkers`。任务消费和执行代码依赖契约。

## 首次落地

试点前，`tasks/queue.ts` 在任务模块中创建 RAG 处理器，`tasks/engine.ts` 也引用了 RAG 的实现类型。

`apps/worker.ts` 创建一个 RAG 处理器并注入 Worker。RAG 和知识库 handler 直接导入任务执行契约。队列消费者继续负责排空，处理器在关闭时随 Worker 释放。任务引擎仍按既有 RAG 任务类型分发，其他业务处理器沿用当前装配。

现有验收覆盖文档提取与知识库构建、任务投递与恢复、Worker 排空与日志。检查跨模块导入时同时核对类型引用，尤其是 RAG、知识库与任务模块之间的路径。
