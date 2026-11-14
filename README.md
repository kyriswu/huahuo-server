# 花火后端 · Server 侧 RAG 文档入库

Fastify 5 / Node 26.11.0 / PostgreSQL / Redis，严格 TypeScript + ESM。Node 和 pnpm 由项目根目录的 Volta pin 统一管理；容器也使用同一 Node 基线。已完成 P02 身份/工作区和 P03 持久任务、Outbox、BullMQ Worker/Scheduler、事件游标与取消恢复。短信支持阿里云官方 SDK，已完成一次真实发送与送达回执验证；真实 AI/ASR/支付任务、AI 报告 P09 尚未实施。P14 已有 Admin 示例工作台，业务页面待定。

## App 源码与短信工具

当前只读 App 根目录是 `../huahuo-ai`，源文件在其 `lib/`，参照配置和各阶段启动规范已更新。当前 App 尚无 Git commit 或远端地址；旧 `huahuo-app` 文档记录只作历史证据。

`pnpm sms preview < request.json` 验证单条模板短信，`SMS_PROVIDER=live pnpm sms send < request.json` 显式发送，`pnpm sms query < query.json` 查询送达。输入、环境配置和登录验证码接入见[短信手册](docs/runbooks/sms.md)。当前开发环境保留原模拟模式，运行中的业务容器尚未更新。

当前同一 `compose.yaml` 运行独立 api-server、admin、worker、scheduler、redis 和一次性 migrate；业务 PostgreSQL 使用根目录 `.env` 中的阿里云连接。本地 postgres 仅保留为显式隔离测试 profile，不参与日常启动。API `http://127.0.0.1:3000/health/ready`，Admin `http://127.0.0.1:3001/health/ready`；管理身份独立于 App，无默认账号。

项目负责应用服务、监听端口、公开 URL 和可信代理配置。域名入口、TLS 证书与自动续期由宿主机独立管理，其配置、脚本和运维文档存放在仓库之外。

## Admin 工作台

安装依赖后运行 `pnpm dev:admin-ui`，打开 `http://127.0.0.1:4173/admin/`。本地预览使用四条示例记录，无需数据库或管理员账号。

`pnpm build` 和 Docker 构建会生成 Admin 页面。启动 Admin 服务后，在浏览器打开 `/admin`，使用已有管理员账号登录。页面和 `/admin/api/v1` 同源，`ADMIN_PUBLIC_BASE_URL` 要匹配浏览器实际访问的地址。登录和初始化方式见 [P02 运行手册](docs/runbooks/p02-identity.md)。

如果本机还运行着旧的 Admin 镜像，执行 `docker compose --env-file .env up -d --no-deps --build admin` 后再打开默认地址 `http://127.0.0.1:3001/admin`。

## 后端运行

已部署的统一认证支持 APP 和 Web 共用用户登录与 JWT：短信请求使用 `purpose:"sign_in"`，登录必须提供 `clientType:"app"|"web"` 和稳定的 `clientId`。用户主表为 `users`，手机号身份和响应掩码来自 `user_identities`，协议记录为 `user_agreement_acceptances`；仅 active 用户可以访问用户业务接口。Access Token 继续使用 Ed25519/EdDSA，Server 发布 JWKS，Agent 按既定契约验签。请求示例和会话生命周期见[认证手册](docs/runbooks/p02-identity.md)。

继续使用原阿里云 `huahuo` 数据库，未新建数据库或清库。旧 `public` 已原样改名封存为 `initialization_backup`，58表4149行及对象身份、存储文件和视图内容摘要核验一致；新 `public` 已按唯一 `migrations/0001_initial_schema.sql` 初始化，版本1重放幂等，全库物理外键为0。产品用户和会话未复制，新 `users/user_sessions` 均为0；四角色已部署统一用户代码且healthy，readiness和JWKS真实验证通过。DB账号密码、环境配置与JWT私钥未变。详情见[RDS基线验收](docs/runbooks/rds-relations.md)。

本机没有 pnpm 时使用现有工具容器，不需要安装全局依赖：

```bash
bash scripts/tooling.sh install --frozen-lockfile
# 使用已有 .env；新环境按 .env.example 填写配置，不重新生成已有凭据。
node scripts/app-reference.mjs

docker compose --env-file .env config --quiet
docker compose --env-file .env build
docker compose --env-file .env up -d redis
docker compose --env-file .env up -d --no-deps --force-recreate migrate
docker compose --env-file .env wait migrate
# 确认迁移成功退出 0 后才启动应用：
docker compose --env-file .env up -d --no-build
docker compose --env-file .env ps -a
node scripts/app-reference.mjs --diff
```

日常 `compose:*`、`db:migrate`、`infra:*` 命令统一读取 `.env`；`infra:*` 只管理 Redis。本地 PG 原数据卷保留，不能删除或重新初始化。`pnpm test:integration` 使用本机已有镜像启动独立临时 PostgreSQL/Redis（tmpfs、随机库与凭据、回环随机端口），不依赖业务栈、不读取 `.env`，结束后仅清理本次资源。旧 `verify`、E2E 和容器隔离脚本仍保留业务栈保护，检测到当前 API 使用云 PG 时会拒绝执行，不能用旧配置重启当前业务栈。源码仅写本仓库；同级 App 只读、不挂容器、不影响构建。完整操作和后续迁移顺序见 [本地开发](docs/runbooks/local-development.md)，登录/草稿/Admin CLI 见 [P02 运行手册](docs/runbooks/p02-identity.md)，任务恢复和状态接口见 [P03 运行手册](docs/runbooks/p03-tasks.md)，验收结果见 [阶段进度](docs/progress.md)。

配置以根目录 `.env` 的分组和命名为准。`.env.example` 保持同一组公共键；`.env.compose.local.example`、`.env.compose.cloud.example` 以及 `specs/backend-plan/examples/` 下的同名示例只额外增加 Compose 镜像、角色数据库 URL 和端口等部署字段。PostgreSQL 与 Redis 各自只有一个实例，角色 URL 和缓存/队列 URL 只是同一实例上的账号或逻辑库划分；对象存储使用全局 `STORAGE_*`，Milvus 连接使用全局 `MILVUS_*`，RAG 生命周期使用 `RAG_*`，知识库两种业务的集合绑定使用 `KB_*`。

项目脚本使用 Volta 固定的 Node 26.11.0 与 pnpm 10.15.1；新机器首次设置时执行 `volta install node@26.11.0`，再按 Volta 的 pnpm 支持启用 `VOLTA_FEATURE_PNPM=1` 并执行 `volta install pnpm@10.15.1`。纯检查/构建也可 `bash scripts/tooling.sh typecheck`。`app:reference`、`verify`、`test:integration`、Compose 与容器隔离脚本在宿主执行：其 Node 脚本等价入口见操作手册，不能给业务容器挂 Docker socket。


P01—P06 既有服务已复用；数据库使用唯一初始化基线 `migrations/0001_initial_schema.sql`，不保留旧迁移链或旧用户表别名。素材标签默认不配置模型也能人工管理；`TAG_EXTRACTOR_PROVIDER=disabled` 会如实记录未配置，不返回假提取结果。`deterministic` 只供显式开发 fixture（同时 `ALLOW_MOCK_PROVIDERS=true`，生产拒绝）。`llm`/`dify` 接口配置已预留但真实 transport 到 P08 接通。

标签图谱只从有效 `note_tags` 映射派生，返回有界主题/素材节点及共同标签证据。新增的 Server 侧 RAG 文档入库是独立的 OSS URL 任务边界，不依赖 Note/Resource 关联；接口和状态见 [RAG 入库手册](docs/runbooks/rag-url-ingestion.md)。


知识库使用两种并列模式：真实 Note 正文进入 `huahuo_kb_note_hybrid_chunks`，由 BAAI/bge-m3（1024维）与 BM25 原生混合检索；资料进入 `huahuo_kb_keyword_chunks`，只用 BM25，不依赖 Embedding、模型 tokenizer 或 Rerank。正文保留在所属业务，四张索引表只存状态、修订、位置、哈希和点 ID，切片正文写 Milvus。原解析与图文逻辑复用，业务 Worker 统一编排发布与清理。见[知识库检索手册](docs/runbooks/milvus.md)。

对象存储统一走 `StoragePort`。除 Local/S3 外，`STORAGE_DRIVER=aliyun-oss` 使用 `src/integrations/object-storage/aliyun-oss.ts`，默认华北二（北京）Endpoint 为 `https://oss-cn-beijing.aliyuncs.com`；访问密钥只通过环境变量/Secret 注入。OSS 是全局对象存储配置，RAG 的 `RAG_SOURCE_ALLOWED_HOSTS` 只负责入库源 URL 的安全 allowlist。

所有阿里云 AK 鉴权统一使用 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET`；根 `.env` 只配置一组，OSS 与 ECI 共用。服务各自保留地域、Endpoint、Bucket 等业务配置。旧 OSS 专用 AK 变量已移除，不作回退；Compose 仅向 API/Worker 注入共享变量。修改后须在下次构建并重建业务服务时生效。

Milvus 连接使用全局 `MILVUS_*` 配置。文件资料进入 `document-keyword` / BM25，不调用 Embedding 或 Rerank；UTF-8 文本、Markdown、CSV 本地解析。启用 `DOCUMENT_EXTRACTION_MODE` 及解析运行模式后，现有文件任务也接受 PDF/Office，通过 Xberg 完整 config/稳定 UUID 提取正文与 KB 元数据，再进入同一关键词流水线；关闭时继续返回 `RAG_FILE_TYPE_UNSUPPORTED`。接口、同步/异步恢复与测试环境配置见[文档提取手册](docs/runbooks/document-extraction.md)。

数据库使用普通关联ID和查询索引，禁止物理外键及模拟外键触发器；规则见[AGENTS.md](AGENTS.md)，关联清单、应用层校验和数据库验收见[RDS关联规范](docs/runbooks/rds-relations.md)。

ECI GPU 抢占式实例底层模块位于 `src/integrations/gpu-spot/`，默认关闭，采用市场价策略，支持幂等申请、同步/异步缺货重试、状态观察与归属核验后的释放。配置参考 `.env.gpu-spot.example`；调用与持久化责任见 [GPU 运行手册](docs/runbooks/gpu-spot.md)。一次明确授权的真实单实例试申请已完成启动验证并释放，见 [试申请验收](docs/acceptance/gpu-spot-trial.md)；尚未接入长期 Task/Worker 或部署角色。

文档解析运行库位于 `src/lib/document-parser-machine/`，已连接现有文件 Worker 和 FILE_UPLOAD：可按需启动指定 ECS，Redis 统一去重、排队和并发，空闲 60 秒后由 scheduler 节省停机，确认后停止兜底；也支持长期在线 API。应用默认 disabled，`.env.document-parser.example` 提供 VPC 测试环境配置；`pnpm document-parser:machine status` 查询状态，切换方式见[解析机手册](docs/runbooks/document-parser-machine.md)。本地模拟解析服务与真实 PG/Redis/Milvus 验证通过，本轮未请求真实内网解析服务。

北京 T4 单卡的四档有序候选、指定 Nginx 镜像与三交换机配置已保存在本地 `.env.gpu-spot`；一次申请由 ECI 按规格优先级和多可用区策略调度，目标一台实例。凭据按用户指定读取根 `.env` 的 `ALIYUN_RAM_ACCESS_KEY_ID/SECRET`。构建后 `pnpm gpu:preflight` 只读核对网络归属，配置仍可保持 disabled；真实网络预检通过不代表 GPU 库存、镜像运行或计算已验证。
