# P04 账本运行手册

本地开发使用 `.env.compose.local` 中显式的 `BILLING_MODE=development`、`BILLING_POLICY_VERSION=credit-policy-v1`。启动或升级时先构建镜像并只运行项目自己的迁移：

```bash
docker compose --env-file .env.compose.local build
docker compose --env-file .env.compose.local up -d --no-deps --force-recreate migrate
docker compose --env-file .env.compose.local wait migrate
docker compose --env-file .env.compose.local up -d --no-build
```

检查 `schema_migrations` 为 5、四个角色 healthy。API 读取 `/api/v1/membership`、`/api/v1/account/credits` 和 `/api/v1/home`；Worker 成功完成 demo fixture 后，monthly `settledCredits` 增加、`reservedCredits` 回到 0。未知 provider 用量必须保持 `pending`/`uncovered`，先对账再人工处置；文件上传先使用 storage reservation，确认实际 bytes 或失败释放。不要在生产启用 development policy、模拟付款或删除 `pg_data`/`redis_data` 卷。
