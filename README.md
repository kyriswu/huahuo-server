# 花火后端 · P06 标签化补充修订

Fastify 5 / Node 24 / PostgreSQL / Redis，严格 TypeScript + ESM。已完成 P02 身份/工作区和 P03 持久任务、Outbox、BullMQ Worker/Scheduler、事件游标与取消恢复。短信仅显式本地模拟；真实 AI/ASR/支付任务、AI 报告 P09、运营网页 P14 尚未实施。

当前同一 `compose.yaml` 有独立 api-server、admin、worker、scheduler，以及 postgres、redis、一次性 migrate。API `http://127.0.0.1:3000/health/ready`，Admin `http://127.0.0.1:3001/health/ready`；管理身份独立于 App，无默认账号。

本机没有 pnpm 时使用现有工具容器，不需要安装全局依赖：

```bash
bash scripts/tooling.sh install --frozen-lockfile
# 仅新环境首次运行；已有环境不重新生成凭据：
node scripts/init-local.mjs
node scripts/app-reference.mjs

docker compose --env-file .env.compose.local config --quiet
docker compose --env-file .env.compose.local build
docker compose --env-file .env.compose.local up -d postgres redis
docker compose --env-file .env.compose.local up -d --no-deps --force-recreate migrate
docker compose --env-file .env.compose.local wait migrate
# 确认迁移成功退出 0 后才启动应用：
docker compose --env-file .env.compose.local up -d --no-build
node scripts/verify.mjs
node scripts/e2e-p02.mjs
node scripts/container-isolation.mjs
node scripts/app-reference.mjs --diff
```

本次环境已初始化，直接使用现有 `.env.compose.local`。源码仅写本仓库；同级 App 只读、不挂容器、不影响构建。完整操作和后续迁移顺序见 [本地开发](docs/runbooks/local-development.md)，登录/草稿/Admin CLI 见 [P02 运行手册](docs/runbooks/p02-identity.md)，任务恢复和状态接口见 [P03 运行手册](docs/runbooks/p03-tasks.md)，验收结果见 [阶段进度](docs/progress.md)。

`pnpm` 脚本可在 Node 24 + pnpm 环境使用；纯检查/构建也可 `bash scripts/tooling.sh typecheck`。`app:reference`、`verify`、`test:integration`、Compose 与容器隔离脚本在宿主执行：其 Node 脚本等价入口见操作手册，不能给业务容器挂 Docker socket。


P01—P06 既有服务已复用，当前 schema 8。素材标签默认不配置模型也能人工管理；`TAG_EXTRACTOR_PROVIDER=disabled` 会如实记录未配置，不返回假提取结果。`deterministic` 只供显式开发 fixture（同时 `ALLOW_MOCK_PROVIDERS=true`，生产拒绝）。`llm`/`dify` 接口配置已预留但真实 transport 到 P08 接通。

标签图谱只从有效 `note_tags` 映射派生，返回有界主题/素材节点及共同标签证据；无向量知识库。接口与限制见 [标签修订手册](docs/runbooks/p06-tags.md)，后续阶段必须遵守 [持续约束](specs/backend-plan/13_知识图谱标签化补充要求.md)。完成本轮后停止，下一阶段 P07。
