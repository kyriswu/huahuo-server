# 云端 Milvus 与隔离回归验收 · 2026-11-15

本次按用户要求使用已有云端 Milvus 完成验收。最终 **481 项 unit/contract、244 项 integration 全部通过，零失败、零跳过**；集成测试共 18 个文件、230.20 秒。typecheck、lint、build 均退出 0，构建保留现有 Vite 体积提示。停在专项验收点，不推进 Pxx。

结论仅限本次隔离回归，**不代表真实解析器、模型或完整上线链路验收通过**。用户已要求将真实服务验证留到稍后执行，见[上线前待办](pending-live-verification.md)。

## 实际依赖与验证范围

- PostgreSQL 17.9、Redis 7.4.8、BullMQ 为真实依赖：runner 创建随机库、分角色凭据及本轮所属 tmpfs 容器，未使用业务 SQL 数据库或已有数据卷。
- Milvus 为真实云服务，使用已有 `@zilliz/milvus2-sdk-node@2.6.17`，没有新增依赖。服务返回版本字符串 `unknown-20261016-595ae27287`，不据此推断上游版本。文档 BM25、笔记 Keyword/Dense/Hybrid、HNSW/1024 维、混合语言、授权过滤、幂等写入、部分失败重试、失效租约、删除恢复均在云端测试目标运行。
- 单独的文档/知识库专项 **44 项通过**；随后完成上述全量回归。Embedding/Rerank、解析供应商及 ECS/ECI 控制面仍是明确的测试替身；BGE tokenizer 使用真实本地文件。缓存生命周期用例有意使用确定性索引。不能将这些结果称为真实模型、Xberg 或 OSS 解析验收。
- HTTP 指标专项覆盖真实 loopback Fastify 请求的成功、4xx、5xx、路由模板与 Histogram；业务指标验证真实数据库提交及两个 Worker 实例的全部消费者。全量同时覆盖 Admin/API 地址分离、认证回调、业务 Schema 外键数量为 0、关联查询索引和正常 CRUD。
- Worker 11 秒工作排空时持续续租，新 Worker 接手新任务；共享队列交接覆盖积压、旧 API draining 后的迟到请求、新 API 请求、唯一 attempt、跨 API 幂等及结果读取。交接用例运行真实 Scheduler/Outbox 补偿，生产补投间隔未调整，细节见[交接验收](worker-first-release.md)。本次未修改 Worker 排空实现。

## 改动与发现的问题

`scripts/integration.mjs` 新增显式 `--milvus-cloud`，`scripts/integration-milvus.mjs` 管理临时云端目标。只从已加载 ENV 取 Milvus 地址、用户名、密码、TLS 及显式测试代理；不传递业务 SQL、OSS、模型配置，忽略业务 database/collection。两个集成套件通过 `tests/support/milvus.ts` 统一连接、构建快照及 Schema 检查目标，移除硬编码的本地 Milvus 账号和 default database。云端单用例上限 30 秒，业务 SQL/SDK 超时未放宽。

本机 `.env` 的 gRPC 代理指向容器专用 `host.docker.internal:1082`，宿主调用卡在该代理；本次仅为测试进程指定 `127.0.0.1:1082` 后连接成功。没有改环境文件或系统代理。

全量首次发现 `AssetService.task` 在共享 `task_inputs` 上直接做 JSON cast，查询计划可先解析无关的纯文本任务，导致笔记创建失败。现通过 MATERIALIZED CTE 先限定所属用户/工作区、标签任务种类、Note 修订和状态，再读取 JSON 版本，不放宽权限或去重规则。新增真实 PG 回归强制使用 Hash Join，并同时保留纯文本任务；全量中该用例 143 ms 通过。未修改 Schema。

新增 8 项工具单元测试验证连接参数白名单、已有库拒绝接管、创建失败不删除、服务端身份变化拒绝删除、意外集合拒绝删除、局部清理失败保留测试库、云目标隔离以及正常清理。这些是 Mock 工具测试，与云端集成证据分开。

## 云端隔离与清理

每次创建 `huahuo_test_<随机32位十六进制>` database，里面只允许同批次的 Note/Document 两个专用 collection。创建前拒绝已有同名库；清理前复核服务端 database ID、创建时间及集合白名单。测试参数缺失时失败，不回退业务集合。

三轮云端运行（包括初次失败）创建的库均已清理；最终再以只读调用核对：只剩原来的 1 个 database、default 中 2 个业务 collection，本轮所有测试库均不存在，default 中也没有本轮测试 collection。未向业务集合发起写操作。PG/Redis 只移除本轮有 owner 标记的容器和临时凭据，没有删除数据卷。

## 复现与证据

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
TEST_MILVUS_GRPC_PROXY=http://127.0.0.1:1082 \
  node --env-file=.env scripts/integration.mjs --milvus-cloud
git diff --check
```

代理参数仅在本机确实需要时使用；云上可直连的测试机省略它。详情见[Milvus 手册](../runbooks/milvus.md#使用云端-milvus-验收)。

原始记录保存在忽略提交的 `.local/final-acceptance/`：`cloud-focused.log`、`integration-cloud-final.log`、`unit-cloud-final.log`、`typecheck-cloud-final.log`、`lint-cloud-final.log`、`build-cloud-final.log`、`cloud-cleanup.json`、`verification.json`。本地 Milvus 的失败尝试和首轮云端失败保留，没有改写为通过。此前服务地址验收中未通过的完整回归由本次最终结果补充闭环。

Compose 的 development/test 合成配置均验证四角色地址注入、各自指标端口、Admin loopback 及独立一次性 migrate。此验收未执行实际应用部署、宿主入口调整或跨机容量验证，也未验证中心 Prometheus 实际抓取。

实际 `.env` 哈希与开始时一致，本地 APP_ENV 保持 development，测试子进程明确使用 test。只读参照 App 的 `api_endpoints.dart`、`http_auth_repository.dart`，SHA256 仍分别为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`；未写 App 或运行 Flutter。没有因测试操作现有业务容器或开发 RDS/OSS。
