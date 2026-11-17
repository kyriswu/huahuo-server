## 当前节点调用方式（2026-11-17，本地实现）

已删除部署级解析调用开关；配置好节点直接执行，网络失败按节点不可达处理。云启停仍由独立云控制权限约束。下面的开关/停用记录仅为当时环境状态，不代表当前代码仍保留该开关；本轮没有启动节点、调用云服务或发布。

# 本机环境与 P01 证据

## ENV与RAG配置整理（2026-11-15）

日常仍使用主.env；已清理迁入DB的RAG参数和失效项，主.env现75项、旧.env.compose.local现84项，均保持0600与其余原值。主模板与部署示例同步，重复解析机模板删除；仍需的服务连接/凭据/模型规格/路径/集合与部署总开关保留。RAG参数在当前Admin管理，现有值先无损导入原JSON行再删ENV。当前本机不在解析机内网，不开云机；见[验收](acceptance/runtime-configuration.md)。

## 当前本地后台（2026-11-15）

按用户后续授权，现有RDS已无损新增3张配置表，保留原数据/账号/凭据；主Compose四角色更新且全部healthy，地址为 http://127.0.0.1:3001/admin#configuration ，使用原管理员账号。当时解析调用关闭，CPU节点停用。先前“未写RDS/未部署”记录是当时的代码验收状态，已由本次实际启动替代。见[验收](acceptance/runtime-configuration.md)。


## ENV 与数据库运行配置边界（2026-11-15）

本机旧DOCUMENT_PARSER/DOCUMENT_EXTRACTION目标与业务项已整理移除，非秘密旧值私有备份在 .local/runtime-config/previous-nonsecret-settings.json。业务参数改为Admin/DB，RAM等密钥未重置；当时保留解析调用关闭、部署连接/提供器开关、HTTP硬上限和协调租约。Compose/模板同步，未操作实际RDS或主容器。新空库使用唯一0001基线；已有库部署前须单独审阅无损结构和配置映射，禁止清库或自动改checksum。详见[手册](runbooks/runtime-configuration.md)。


## 当前 App 与短信配置（2026-11-12）

App 只读根目录已改为 `../huahuo-ai`，源码在 `lib/`；`pnpm app:reference`、`pnpm app:reference:diff` 及本机路径预检通过，当前 Git 为没有 commit/origin 的新仓库。实际源码和工作树哈希纳入本轮基线，未向 App 写入。

`.env` 和 `.env.compose.local` 仅追加六个已验证的阿里云短信非秘密参数，既有内容/凭据/模式保留。签名“触达科技”、模板 `SMS_508520316`、code 变量和 3000ms 连接/读取超时可用于新适配器；API 在所有环境直接采用真实短信适配器，新构建启动前必须备齐签名、模板和 RAM 凭据。Skill 仍装在用户目录，业务服务独立读取项目环境中的共享 RAM AK。

宿主使用 Node 26.11.0 / pnpm 10.15.1。337 项 unit/contract、120 项隔离真实依赖测试与一次真实短信送达分别留证，见[短信手册](runbooks/sms.md)。业务容器和数据库未变更。

## MinerU 环境清理（2026-11-12）

根 `.env` 和 `.env.compose.local` 已各删除5个专属变量，六份环境示例及Compose同步。清理前后对其他解析值做哈希比较，确认原值与文件权限保持（本机文件0600），未重置已有凭据。校验脚本首次断言异常曾回显敏感配置，已改为仅输出字段名/哈希校验结果。业务容器未重建；新配置在后续重建时采用。详见[移除验收](acceptance/mineru-removal.md)。

2026-11-11 阿里云 AK 配置修复：根 `.env` 与历史 `.env.compose.local` 均只保留 `ALIYUN_RAM_ACCESS_KEY_ID/SECRET` 一组，删除旧 OSS 专用项，实际密钥值及其他设置保持不变，文件权限 0600。六份示例已同步并去重；本轮没有重建/重启业务容器或操作数据卷，运行状态仍按原部署记录。

> 当前（2026-11-10）使用 `.env` 的云RDS `huahuo` 与现有云Milvus `default` database；开发库已按唯一基线重置为58表/0外键，两个新空集合已验证，四角色已切换到 `huahuo-server:kb-search-dev` 且healthy。以 [知识库验收](acceptance/knowledge-base.md) 和 [当前进度](progress.md) 为准。下文是历史环境证据，不是重新启用旧本地PG或旧迁移链的操作指令。

- Server：当前目录 `huahuo-server`，初始仅有 `specs/`；所有实现只写本目录。
- App：同级 `../huahuo-app`，Git root 正确、clean、只读参照；未运行 Flutter 命令、未改文件。
- 主机：macOS arm64；Node `v26.11.0`，由 Volta 项目 pin 管理；pnpm `10.15.1` 由同一 pin 管理。
- Docker CLI：29.9.0；Compose 5.6.0；当前 context 为本机 Colima Unix socket，daemon Linux/aarch64 29.5.2 可达。`docker context` 未切换；未停止其他容器。
- 项目资源：只创建 `huahuo-server-dev` 自己的 `backend` 网络、`pg_data`、`redis_data`、`user_files`。初始化脚本在发现同名资源/已有 `.env.compose.local` 时拒绝重置密码。
- 镜像固定：node:26.12.1-bookworm-slim、postgres:17.9-bookworm、redis:7.4.8-bookworm、pnpm 10.15.1；运行镜像构建 context 为 `.`，`.dockerignore` 排除 App/父目录/specs/秘密。宿主由 Volta 精确 pin v26.11.0；官方 Docker registry 没有 v26.11.0 的对应 bookworm slim 标签，因此容器采用已验证的下一个 Node 26 补丁版本。
- 端口：宿主 3000/3001 空闲，绑定 127.0.0.1；后台角色和 PG/Redis 不发布宿主端口。
- 本地 daemon 可达，不需要启动 Docker Desktop；`ensure-docker-local.sh` 对现有 Colima 只检查，不会启动另一套 runtime。

验证命令和结果：

| 命令 | 结果 |
|---|---|
| `docker compose --env-file .env.compose.local config --quiet` | 通过 |
| cloud env `config --quiet` + JSON 检查 | 通过；无 postgres 服务/依赖 |
| tooling `pnpm typecheck` | 通过 |
| tooling `pnpm lint` | 通过 |
| tooling `pnpm build` | 通过 |
| unit/contract | 7 + 7 tests 通过 |
| 真实 PG/Redis 隔离 integration | 9 tests 通过，随机临时库 finally 清理 |
| container isolation/e2e | 四角色停启、Redis 故障、volume、路由/镜像边界通过 |
| App reference diff | `changedFiles=[]`、commit/status 未变 |

本地真实秘密仅在 `.env.compose.local`（0600、gitignored）；文档不包含密码、CA 或 token。

P05 使用既有本地 Docker/Colima context，镜像 `huahuo-server:p05`。只对本 Compose project 执行 migrate/up，未删除卷；本次迁移版本 6。`.env.compose.local` 仅更新镜像标签与 schema 下限，未输出或重置凭据。

## 2026-10-27 文档入库补充

本轮只改 Server。新增 migration `0009_document_ingestion.sql` 后，`.env.compose.local` 和 Compose 默认最低 schema 调整为 9；本机 Colima 已恢复并执行该迁移；0009 applied、schema 9。已有凭据、数据卷和同级 App 均未重置或修改。

后续 Server-only RAG 入库又增加 `0010_rag_url_ingestion.sql`、`0011_rag_assets.sql` 和 `0012_rag_enriched_assets_and_char_chunks.sql`，当前 Compose 最低 schema 为 12；上面的 P06 记录保留为当时的阶段证据。

## 2026-10-29 Volta / Node 26 验证

- 宿主通过 Volta 使用 Node `v26.11.0`，项目 `package.json` pin Node `26.11.0`、pnpm `10.15.1`；pnpm shim 使用前需设置 `VOLTA_FEATURE_PNPM=1`。
- Docker/Compose 使用存在且已构建验证的 `node:26.12.1-bookworm-slim`。Docker Hub 没有 `node:26.11.0-bookworm-slim` 标签，因此容器采用同一 Node 26 主版本的下一个补丁版本。
- `bash scripts/tooling.sh typecheck`、`lint`、`build`、`test` 通过；`node scripts/verify.mjs` 通过 typecheck、lint、build、39 unit、9 contract、74 real PG/Redis integration，以及 local/cloud Compose 配置校验。
- Compose 四个业务角色已重建并运行在 Node `v26.12.1`，api-server/admin 健康检查通过；PostgreSQL、Redis 数据卷未删除或重置。
