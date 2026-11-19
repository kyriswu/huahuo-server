# P04 账本运行手册

本地开发的部署总开关保留 `.env` 中的 `BILLING_MODE=development`；策略版本在Admin「计费策略」选择已有不可变版本（默认credit-policy-v1），不再读取BILLING_POLICY_VERSION环境变量。新空环境从0001顺序执行全部迁移；已有数据库先核对已执行编号和checksum，只执行后续增量，不重跑初始化或清库。标准构建与迁移命令为：

```bash
docker compose --env-file .env build
docker compose --env-file .env up -d --no-deps --force-recreate migrate
docker compose --env-file .env wait migrate
docker compose --env-file .env up -d --no-build
```

检查 `schema_migrations` 与当前完整迁移清单的编号及checksum一致、四个角色healthy。API读取 `/api/v1/membership`、`/api/v1/account/credits` 和 `/api/v1/home`；Worker成功完成demo fixture后，monthly `settledCredits` 增加、`reservedCredits` 回到0。任务失败/取消的预留处理见[任务恢复规则](p03-tasks.md)。未知provider用量必须保持pending/uncovered，先对账再人工处置。通用上传只登记 Redis 临时文件，不预留或计入用户空间；后续业务认领才在同一事务中登记资源、引用、confirmed 明细及正式占用。空间占用仅由资源认领与正式删除任务维护；旧独立 reserve／confirm／release 与 run 用量写入方法已删除。历史账本仍可按用户授权只读查询，不提供没有业务调用方的第二套写入 API。不要在生产启用development policy、模拟付款或删除数据卷。
