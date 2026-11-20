# ADR 0005 知识库、RAG 与任务执行边界

## 现有依赖

| 方向 | 当前调用与所有权 |
| --- | --- |
| API → RAG | API 装配 RAG 写入路由和 `RagQueryService`。RAG 管理文档版本、入库处理、查询和对外响应。 |
| RAG → 任务 | RAG 在保存文档版本的同一事务中写任务和任务输入，再用 `enqueueIntent` 写 Outbox。部分任务操作调用 `TaskService`。 |
| RAG 与资产正文入库 → 知识库 | 文件和文本调用 `KnowledgeIndexJobs.indexSource`，资产任务执行已登记的构建。`RagQueryService` 通过知识库读接口取得已发布构建、分块和正文。 |
| 共享 Embedding 与模型配置 | 知识库和 RAG 使用 `integrations/embedding.ts` 的客户端和类型，以及 `lib/search-index/model-profile.ts` 的模型常量。 |
| RAG ↔ 文档入库 | RAG 使用文档提取和回调能力。文档入库引用 RAG 的源校验和解析快照类型。 |
| Scheduler → Worker | Scheduler 从 PostgreSQL Outbox 取任务，通过 BullMQ 发送 `{ taskId }`。Worker 领取 PostgreSQL 任务，按类型执行，管理租约、重试和结果。 |

## 公共入口和依赖方向

- 查询调用方走 `RagQueryService`。文档写入走 RAG 路由及其 `RagIngestionRepository.create`、`action`。版本表和内部状态归 RAG 所有。
- 文件、文本和资产正文通过 `kb/profile.ts` 按来源获取索引和模型配置，由 `KnowledgeIndexJobs` 执行。技术模式使用 `keyword` 和 `hybrid`。知识库通过 `kb/read.ts` 提供 `listPublishedBuilds`、`listPublishedChunks` 和 `readSourceBody`，负责来源权限、分页和已发布修订校验。RAG 负责召回、排序、重排和响应。
- 业务调用方通过 `TaskService` 操作任务，通过 `enqueueIntent(tx, taskId)` 在已有事务内登记投递意图。任务状态、租约和投递由任务模块负责，继续使用现有的事务与异步交接契约。
- Worker 执行契约由 `tasks/execution.ts` 提供，包含 `Attempt` 和 `TaskExecutor`。Worker 的应用装配层可以依赖 RAG 和任务实现，并把 RAG 处理器交给 `TaskWorkers`。任务消费和执行代码依赖契约。

## 首次落地

试点前，`tasks/queue.ts` 在任务模块中创建 RAG 处理器，`tasks/engine.ts` 也引用了 RAG 的实现类型。

`apps/worker.ts` 创建一个 RAG 处理器并注入 Worker。RAG 和知识库 handler 直接导入任务执行契约。队列消费者继续负责排空，处理器在关闭时随 Worker 释放。任务引擎仍按既有 RAG 任务类型分发，其他业务处理器沿用当前装配。

现有验收覆盖文档提取与知识库构建、任务投递与恢复、Worker 排空与日志。检查跨模块导入时同时核对类型引用，尤其是 RAG、知识库与任务模块之间的路径。
