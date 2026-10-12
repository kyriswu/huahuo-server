# P06 容器状态（原验收基线；当前修订结果见下）

记录时间：2026-10-10；Compose project `huahuo-server-dev`；镜像 `huahuo-server:p06`。

| 服务 | 实际状态 |
|---|---|
| api-server | `huahuo-server:p06`，127.0.0.1:3000，healthy |
| admin | `huahuo-server:p06`，127.0.0.1:3001，healthy |
| worker | `huahuo-server:p06`，无宿主端口，healthy；处理资产标签任务 |
| scheduler | `huahuo-server:p06`，无宿主端口，healthy |
| migrate | `Exited (0)`，本次 applied `[7]`，schema version 7 |
| postgres | PostgreSQL 17.9，既有 `pg_data` 保留，healthy |
| redis | Redis 7.4.8 AOF，既有 `redis_data` 保留，healthy |

API/Admin `/health/ready` 返回 stage `P06`、mode `asset-knowledge`；容器隔离检查通过。未执行 down -v、全局清理或修改 App。

## P06 标签化补充修订

Compose 拓扑未改变，所有角色继续独立容器；数据库 schema 已升级为 8，镜像已构建并启动为 `huahuo-server:p06-tags`。迁移仅追加 0008，不删除既有卷/数据；验证使用随机 `huahuo_test_*` 数据库和 Redis DB14/15，测试结束只删除该随机库。

0008 实际迁移输出：`{"applied":[8],"current":8,"status":"complete"}`。四业务角色 `p06-tags` 已通过 Compose `--wait` 健康检查；PG/Redis 沿用原容器与数据卷，migrate 正常退出 0。

最终隔离验收：四角色逐一 stop/start 均 exit 0，其他角色不重启；本项目 Redis 中断时四角色 readiness=503/liveness=200，恢复后全部 ready；共享文件卷跨 API 重启可读。最终 `compose ps -a`：六常驻容器 healthy，migrate Exited(0)。API readiness HTTP 200、stage=P06。
