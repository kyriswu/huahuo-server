# A10 按量 ECS → ECI 缺货回退 · 2026-11-14

本轮按用户要求只修改后端代码。接在现有 `withDocumentParser` / ManagedDocumentExtractor 链路：优先启动已配置 A10 按量 ECS，`StartInstance` 明确拒绝且错误码为 `OperationDenied.NoStock` 时，才创建同地域/VPC 的 A10 按量 ECI。没有新增 ECS 分配器；HTTP 超时、Running 但不健康、余额、配额及权限错误不回退。

## 行为与配置

- 默认 `DOCUMENT_PARSER_ECI_FALLBACK_ENABLED=false`；开启时要求网络、内网镜像、ACR、OSS Bucket 配置完整。
- ECI 固定 NoSpot、1卡，按 8/16/32/48 核的四个单 A10 规格顺序调度。四交换机在一次创建请求内，由 ECI 选择其一。明确 ECI 缺货后15秒重试，未就绪超过原 startup timeout 则请求失败。
- 样本镜像 `xberg@sha256:c8ad143dd5da72b922937afd83554db3c8d79e8a188002b381bce8b3a3783e25`，VPC registry、默认模型入口、8000/TCP、1GiB shm、额外40GiB临时存储、自动匹配镜像缓存。原生文字优先/选择性 OCR/完整 KB Markdown 协议沿用现有配置，不改 Xberg 核心。
- OSS 使用现有 Bucket、`<根前缀>/resources` 和地域内网 Endpoint，SDK 边界注入唯一一套 ALIYUN_RAM 凭据；配置签名与 Redis 不包含凭据。API并发16、上传并发16/待上传128；文档全局并发仍由原配置控制。
- Redis 持久化创建意图、代次、受管标签身份、实例ID和私网地址。模糊创建/进程崩溃只查精确归属，不盲目重提。任务恢复、取消和收集使用同一地址；未知解析任务保留占用，禁止释放。
- 空闲删除只操作精确标签/VPC匹配的本轮实例。已接受删除后观察实例/标签均不可见，并确认 ECS StopCharging 才休眠；模糊删除不报告已释放。删除期间新请求排队，下周期重新优先 ECS。有 ECI 记录时禁止 `configure-idle` 切换。

实现位置：`src/config/document-parser-eci.ts`、`src/lib/document-parser-machine/eci-fallback.ts`；既有运行库、Redis Lua、ECI Provider 与状态 CLI 接线。无新增依赖、业务表或迁移，四常驻角色/一次性 migrate 保留。操作与权限要求见[使用手册](../runbooks/document-parser-machine.md)。

## 验证与边界

新增15项配置/请求单元测试、3项凭据注入/归属查找 mock SDK 测试、24项真实隔离 Redis/Lua 双客户端回退测试。覆盖 ECS 成功不回退、显式缺货、权限/余额/配额拒绝、启动结果不明、健康失败、机型/VPC/计费模式校验、全局并发、ECI明确缺货代次、模糊提交标签收养/空结果保留、prepared重启恢复、NoStockWarning不重建、私网/规格校验、未知任务恢复、空闲删除和删除期间到达竞态。

全量检查结果与本机证据位于 `.local/eci-fallback/`；完整隔离 PG/Redis integration **201通过、1跳过**，跳过项要求未启用的 Milvus；24项回退用例全部通过。PostgreSQL/Redis是本机临时容器，ECS/ECI/HTTP/OSS为替身，不冒称真实申请、拉镜像、GPU识别或OSS上传通过。隔离迁移与关系索引/CRUD沿用基础设施验收，业务外键0；没有对开发库做迁移或清空。

| 检查 | 结果 / 证据 |
| --- | --- |
| 全量 unit/contract | 422通过，`unit-contract.log` |
| 隔离 PG/Redis integration | 201通过、1跳过，`integration.log`；临时依赖已清理 |
| typecheck / lint / build | 退出0，分别记录日志；Vite 保留既有 use-client/体积提示 |
| Compose 静态展开 | 空 env 文件/合成占位值，worker/scheduler 参数一致、回退默认false，API/Admin不接收回退参数；`compose-validation.json` |
| App 与默认配置 | 两文件前后SHA一致、默认disabled；`verification.json` |

未读取真实 `.env` 密钥、未修改实际环境、未申请/启动/删除云资源、未部署业务角色、未修改或删除已有数据卷。仅清理测试脚本本轮登记的临时依赖与凭据。既有工作区的其他改动保留。本轮不推进 Pxx，停在代码验收点。

实际可用性仍取决于申请当时 A10 ECI 库存、RAM/ACR 权限、私网连通和镜像拉取；当前代码测试不证明这些云条件成立。模糊提交/删除的保守阻断可能需要人工云侧核实；不能为了继续申请清空 Redis。ECI 本地 ledger 随实例删除，现有 callback 负责在释放前持久化完整结果与回执。

## App 只读参照

`../huahuo-ai` 为 GIT_UNBORN。读取 `lib/core/network/api_endpoints.dart`（SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）和 `lib/features/auth/data/http_auth_repository.dart`（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`），双BaseURL与认证请求保持。未写入/构建 App；本轮内部云调度不改变 App 合约，不冒充 Flutter 端到端通过。
