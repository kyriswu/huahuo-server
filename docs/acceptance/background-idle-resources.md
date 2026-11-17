# Worker / Scheduler 空闲资源优化（2026-11-17）

用户授权尝试代价可接受的优化。本轮只降低后台探针开销和拆分发布/执行依赖，不调整并发、任务扫描、租约、业务查询、内存额度或计费逻辑。

## 改动与代价

- `QueuePublisher` 从 `tasks/queue.ts` 移到 `tasks/publisher.ts`，Scheduler直接导入新模块。移除原导出，不留兼容重导出；Redis参数、队列名、任务载荷、jobId、重试和保留规则不变。Worker依旧预加载现有执行器，避免引入首任务延迟和异步初始化状态。
- Compose仅将Worker/Scheduler稳态健康检查从5秒改为30秒，启动宽限期10秒内显式每5秒检查。完整readiness内容、8秒超时、连续4次失败规则不变。API/Admin保留5秒。
- 健康状态发现更慢：持续故障通常约90—120秒再加探针耗时标记unhealthy，恢复最多等待一次30秒检查。Docker健康标记不负责任务租约恢复；Scheduler仍按原1秒间隔扫描。容器退出仍由原restart策略处理。
- `start_interval`要求[Compose ≥2.20.2](https://docs.docker.com/reference/compose-file/services/#healthcheck)、[Docker Engine ≥25](https://docs.docker.com/reference/dockerfile/#healthcheck)。本机为Compose5.6.0、Engine29.5.2；本轮未连接服务器验证版本。

## 验证

类型检查、Lint、构建、Compose解析通过。25项现有单元/契约测试通过；28项真实独立PG/Redis集成测试通过，覆盖任务投递、续租排空交接、指标和基础readiness。集成运行器按当前累计候选完成3→5迁移演练及重复执行；这两项资源优化本身没有新增或修改SQL，不把其他窗口迁移的兼容性归到本轮。

证据在`.local/resource-review/`的`typecheck.log`、`lint.log`、`build.log`、`unit-contract.log`、`integration.log`。构建保留既有Admin bundle大小提示。没有新增与实现逐行对应的测试，复用真实行为回归。

## 容器对比方法

使用同一现存本机镜像和依赖，只读挂载本轮优化前/后的编译产物，运行实际Worker/Scheduler入口。临时PG/Redis使用随机测试凭据、tmpfs和独立internal网络；不读取业务ENV，不调用模型或云服务。两组依次预热20秒，各采样90秒，指标开启、日志silent、无业务任务；记录主进程RSS、cgroup CPU和扣除inactive_file的内存。结果不能直接与长期运行、配置不同的开发容器相减，也不能代表忙时峰值或长期泄漏测试。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| Worker容器CPU（单核占比） | 1.079% | 0.364% |
| Scheduler容器CPU（单核占比） | 1.213% | 0.479% |
| Worker主进程RSS中位数 | 143.41 MiB | 143.99 MiB |
| Scheduler主进程RSS中位数 | 130.96 MiB | 106.00 MiB |
| Scheduler容器内存中位数（扣除inactive_file） | 87.18 MiB | 60.39 MiB |

两组首次Docker健康均约5秒；候选后续探针间隔实测约30秒。Worker/Scheduler空闲CPU分别减少约66%/60%；Scheduler主进程RSS减少约25 MiB（19%）。RSS与容器内存口径不同，不相加。Worker主进程内存没有明显下降，不把容器短时工作集变化算作加载优化收益。

采样后仅停止本次临时Redis：两角色均在约100.9秒、连续4次失败时标记unhealthy；恢复Redis后约30.3秒重新healthy。验证结束退出码0，所有本次临时容器、网络及凭据均已清理，按run标签回查无残留。

原始数据为`benchmark-results.json`，脚本为`benchmark.mjs`，方法与局限见`benchmark-method.md`。两组编译产物仅Scheduler入口、queue和新增publisher及其source map不同，见`build-comparison.json`。基线预热执行一次初始化maintenance.check，候选未重复，因此不使用Worker内存差异作收益结论；空闲采样窗口均无业务任务。测试容器通过CLI使用相同CMD-SHELL探针，实际Compose为CMD，两组都包含相同的少量shell开销；本机其他容器仍运行，存在VM噪声。

只读进一步检查Worker：Milvus连接和文档处理器远程连接已按需创建，没有发现空闲时提前建立整套外部连接的情况。较大常驻成本仍来自静态SDK代码。音频元数据库可在首次音频校验时加载，但本轮未改；大范围延迟存储/索引加载涉及现有同步工厂和关闭流程，暂不展开。

## 生效与边界

当前为本地代码/Compose候选，未提交、部署或重启既有服务。发布清单只补入Compose审查路径，保留原迁移及兼容声明。Compose来自受保护main，后续发布需按原审查流程同步，不能只发业务代码就声称探针频率已经生效。

只读核对本地留存发布执行器：新容器等待健康预算90秒，可使用快速启动探测。未更新角色已有状态检查预算15秒，若容器刚恢复但Docker尚未再次探测，发布可能保守拒绝；本轮不修改宿主流程，也不声称完成云端发布验证。

App只读核对，工作树干净；`api_endpoints.dart`及`http_auth_repository.dart`的SHA256仍分别为`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。本轮不改公开HTTP契约或运行App。
