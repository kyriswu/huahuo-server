# P04 账本运行手册

本地开发的部署总开关保留 `.env` 中的 `BILLING_MODE=development`；策略版本在Admin「计费策略」选择已有不可变版本（默认credit-policy-v1），不再读取BILLING_POLICY_VERSION环境变量。新空环境使用唯一0001初始化基线；已有数据库先核对已部署结构及基线校验，不重跑整份初始化或清库。标准构建与迁移命令为：

```bash
docker compose --env-file .env build
docker compose --env-file .env up -d --no-deps --force-recreate migrate
docker compose --env-file .env wait migrate
docker compose --env-file .env up -d --no-build
```

检查 `schema_migrations` 为1且checksum匹配当前基线、四个角色healthy。API读取 `/api/v1/membership`、`/api/v1/account/credits` 和 `/api/v1/home`；Worker成功完成demo fixture后，monthly `settledCredits` 增加、`reservedCredits` 回到0。未知provider用量必须保持pending/uncovered，先对账再人工处置；文件上传先使用storage reservation，确认实际bytes或失败释放。不要在生产启用development policy、模拟付款或删除数据卷。
