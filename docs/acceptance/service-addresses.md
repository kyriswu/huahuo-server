# Admin 分离服务地址验收 · 2026-11-15

按用户最新范围，API + Worker + Scheduler 继续同组，仅优先准备 Admin 单独部署。不新增 Worker/Scheduler RPC，也不执行数据库、OSS 或缓存共享改造。

## 改动

- `src/config/service-addresses.ts` / `src/config/config.ts`：新增部署地址 API_SERVICE_BASE_URL，域名/IP 均可。为空时继承显式 APP_PUBLIC_BASE_URL；未配置不推断容器名或 localhost。拒绝 URL 内用户名/密码、query、fragment；保留代理路径前缀。
- `src/modules/ingestion/document-callbacks.ts`：认证解析回调使用 API 服务地址，与管理后台自身 Origin、客户端公开地址分离。缺少地址时在写入回调收件箱前拒绝，报 API_SERVICE_ADDRESS_REQUIRED。
- `compose.yaml`、四份 env 示例：向调用角色注入该地址，可通过部署配置指向真实域名或节点 IP。没有改变 API/Worker/Scheduler 的队列协作，也不增开 Admin 或后台业务端口。
- `tests/unit/service-addresses.test.ts`、两份现有文档流程集成测试：验证内部/公开地址独立、错误地址拒绝和真实 HTTP 回调。

没有新增依赖或修改数据库 Schema。App 两个网络/认证文件只读哈希与既有基线一致。实际 .env、业务容器、数据库、缓存、OSS 和宿主入口未修改；没有真实云调用。

## 验证

- 全量 unit/contract **473 项通过**，其中新增服务地址单元用例 8 项。typecheck、lint、build 退出 0。
- Admin 与 API 分别在真实 loopback 端口监听：Admin 独立会话正常，生成的回调目标指向配置的 API 地址而不是 Admin/公开地址；真实 HTTP 回调写入权威收件箱，伪造 token 返回 404。无地址时回调行数不增长。
- 文档流水线中的解析测试服务确认接收的是 api.internal.test，而不是 App 的 api.test；现有文档解析回归通过。
- Compose 使用空 env 与合成私网/域名值展开，四角色地址一致；内部服务地址与 Admin 公开 Origin 可分别设置。没有使用真实私网机器做跨服务器验收。
- Admin/配置及零外键的独立集成复核 **25 项通过**（admin-integration.log），与上述全量失败明确区分。
- PostgreSQL/Redis 为本轮专属随机测试库与临时容器，保持业务外键 0；仅清理本轮容器与凭据，不删除已有卷。

初次完整 PG/Redis 回归记录 `integration-final.log` 为 **237 通过、1 失败、1 跳过**：唯一失败在既有 `release-drain.test.ts` 的 Worker 排空场景（旧任务仍为 running），不是 Admin/服务地址用例；该次完整回归不能记为全绿。API/Worker/Scheduler 源码不因这次地址调整改变处理或退出逻辑。初次测试的旧 URL 断言与 Lint 失败也保留，不覆盖原始记录。

后续隔离回归已通过：使用真实云端 Milvus 与隔离 PG/Redis，最终 **481 项 unit/contract、244 项 integration 全部通过、零跳过**，包含 Worker 排空及共享队列交接；静态检查与构建通过。最终结果与初次失败分开保留，见[云端与隔离回归验收](cloud-milvus.md)。仍未执行云端 Admin 拆分部署，真实解析与模型链路列入[上线前待办](pending-live-verification.md)。

证据目录 `.local/service-addresses/`：unit-contract.log、typecheck.log、lint-final.log、build.log、integration-final.log、admin-integration.log、compose-validation.json。手册见 [Admin 服务地址](../runbooks/service-addresses.md)。本轮为部署地址增量，不推进 Pxx，未宣称云端 Admin 已拆分部署。
