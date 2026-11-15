# 应用发布基础加固验收（2026-11-15）

状态：代码及本地专项验收通过，停在该专项验收点，不推进 Pxx，也不宣称生产无损发布已经完成。

## 交付范围

1. API/Admin 的 readiness 排空与最终 HTTP 关闭分开；Worker 本地暂停、续租和排空；Scheduler 停止扫描及节点监控。
2. 按角色设置有限退出时间，Compose 留额外宽限期；保留遗留句柄截止退出，并回收活动响应完成后变为空闲的连接。
3. 共享运行配置增加兼容读取、严格写入、内部契约版本门禁和真实配置 readiness 检查。
4. 解析 intent 仅凭认证回调及匹配身份/指纹安全绑定 jobId，保持禁止不确定 POST 重发；取消并发增加受租约约束的交接。
5. 复用既有指标监听提供排空状态、活动 HTTP、本地后台操作计数。信号不暴露为公共控制路由。

实现语义与限制见 [应用排空与退出契约](../runbooks/application-lifecycle.md)。

## 验证与证据等级

- 真实本机子进程、HTTP socket 和操作系统信号：SIGUSR2 后 ready 503 / live 200 / 仍可处理被路由过来的请求；SIGTERM 后 11 秒请求完整返回并正常退出；超过截止时间或遗留句柄退出 1；响应头已发出的流完整结束并释放连接。依赖健康为替身，不冒充 PG/Redis 集成。
- 真实独立 PostgreSQL/Redis/BullMQ：旧 Worker 暂停后 11 秒工作持续续租，新实例接手另一任务，两个任务均一次 attempt 成功。此项是相同代码版本的双实例交接，不是两个历史镜像的兼容或回滚证明。
- 真实独立 PG/Redis + loopback 解析替身：不确定提交回调恢复、回调先于 POST 响应、重复/冲突、Worker 丢失、取消、身份不匹配及无回调仍阻塞；未请求真实解析服务/OSS/付费云。
- 配置未来键/版本模拟：兼容读取、不覆盖未知值、严格输入、CAS、版本不兼容 ready 失败且 live 正常。不能替代真实两版镜像演练。
- Schema 验证沿用真实隔离测试的物理外键为 0、查询索引和 CRUD 检查；本专项无需 Schema 改动，使用工作区当前唯一初始化基线。

最终命令、结果及耗时保存在 `.local/release-hardening/verification.json`，每项命令的完整输出在同目录日志。

| 检查 | 最终结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 全部 exit 0 |
| `pnpm test` | 42 文件，465 项通过 |
| `pnpm test:integration` | 18 文件，237 项通过，1 项真实 Milvus 检索跳过 |
| 本地/云示例 `docker compose ... config --quiet` | 全部 exit 0，仅静态校验 |
| `git diff --check` | exit 0 |

首次集成暴露两项取消竞态失败：取消递增任务 version 后，原步骤不能及时释放租约。补窄取消交接及拒绝错误 owner/attempt、未知 intent、失效租约的负例后，完整重跑通过。首次 HTTP 子进程测试还暴露完成后的 keep-alive socket 导致退出超时，已通过响应关闭标志与完成后空闲回收修复；另补清理后遗留句柄仍按截止时间退出的用例。构建保留现有 Admin bundle 大小提示，不影响退出码，不作为本轮 UI 优化。

## 真实 App 参照

只读核对 `../huahuo-ai/lib/core/network/api_endpoints.dart` 和 `lib/features/auth/data/http_auth_repository.dart`，后者 HTTP 调用具有 15 秒客户端超时，本轮不改变其接口或重试行为。SHA-256 分别为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`；证据在 `.local/release-hardening/app-reference.json`。旧通用参照记录仍报告已有 App 工作树变化，本轮没有覆盖该基线或 App 文件，也未运行 Flutter。

## 环境与剩余边界

只在本机 Unix socket 所属 Docker 上运行随机命名、回环端口、tmpfs 的临时测试依赖；执行器按本次 owner 核验后清理临时容器和凭据，无现有数据卷删除。没有修改实际 `.env`、迁移开发/生产数据库、重建主业务栈、调用云资源或付费服务。

主业务容器是否包含此功能尚未验证。入口切流、跨版本回滚、上传恢复及未生成定时窗口补跑仍是后续工作，不能由本轮测试推导“线上发布零中断”。用户已明确接受 Admin 试跑在发布/重启时中断并重新发起，不要求试跑持久化，也不以此阻塞用户侧发布。

后续已执行真实容器、共享测试PG/Redis的同机分角色交接和回切，详见[容器演练](release-rehearsal.md)。该演练部分通过：当前镜像流程通过，历史镜像基线不兼容被拒绝；实际跨机和跨版本回滚仍未通过验收。
