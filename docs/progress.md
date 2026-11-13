# 当前开发进度

## 测试服务器运维（2026-11-07 至 2026-11-14）

- 宿主 Nginx + Certbot 已配置 `test-api.chuda.cc` → 回环 3000、`test-admin.chuda.cc` → 回环 3001，公开地址同步至对应环境变量。真实 HTTPS 和续期演练通过，配置与续期脚本保留于 `infra/nginx/`，维护步骤见 [测试域名 HTTPS](runbooks/test-https.md)。
- Milvus 已确认连接内网 `172.18.102.95:19530`；按授权清除失效的 `grpc_proxy` 并补齐现有路径缺失的 tokenizer 文件，测试数据及临时探针已清理。
- 项目容器于 2026-11-10 按用户要求整体停止；2026-11-14 确认仍停止，宿主 Nginx 和自动续期定时器继续运行。本次仅整理文档、删除首次签发模板和性能报告，未改动运行配置或恢复服务。

## Note 块级增量索引（2026-11-07）

- 云开发库 `huahuo` 已按新基线初始化。旧 `public` 归档到 `initialization_backup_20261107_note_delta`，核对 58 张表、406 行及表 OID 一致。新 `public` 有 59 张表，物理外键为 0，迁移重放为 `applied=[]/current=1`。四个后端角色使用 `huahuo-server:note-delta-init` 且均 healthy，API/Admin 就绪接口均为 HTTP 200。
- 保存 Note 正文后沿用现有任务入口。Worker 对照当前索引正文和旧 UTF-16 切点，先撤下失效点，再逐批写入变化块。从保存事务提交起，检索暂停召回这条 Note，直到最新入库任务完成且当前块全部为 `ready`。召回与重排返回后按现有任务 ID 复核，防止在途查询混入旧结果。
- PostgreSQL 基线维护当前块和重试需要的任务数据，Note 不再整篇发布索引版本。Flutter 的手动 Note 保存仍走既有 Note 接口。
- 验证通过 329 项单元和契约测试及 135 项隔离 PostgreSQL/Redis 集成测试。块内删半、跨块修改、大改回退均检查了模拟 Milvus 写入和删除清单，未变化块没有写入。
- 开发环境已启用 `MANUAL_TEXT_ENABLED=true`。使用真实 Embedding 和 Milvus `default.huahuo_manual_text` 实测临时 Note。首次写入 3 块，编辑其中 2 块后只新增 2 个点并删除 2 个失效点，未改块保留原 ID 且写入次数为 0。该轮测试发生在整条 Note 暂停召回规则实施之前。完工后强一致读取核对了 3 个点，测试 Note 已删除，Milvus 复查无测试点残留。
- Note 的纯英文关键词查询现在并行使用英文与 Jieba 分词，Jieba 查询限定为中文和中英混合块。两路沿用授权范围及 `ready` 块限制，按块 ID 去重并保留最高 BM25 分数。存量索引可直接使用。
- 在开发 Milvus `default.huahuo_manual_text` 用自动入库的临时 Note 复测。仅用英文分词时 `granitefable` 漏召回，修复后的 `keyword` 模式用同一输入命中 `# 第二节 / Search token: granitefable.`。实测关闭重排并断言检索未使用 Embedding。删除测试 Note 后强一致复查无向量残留。类型检查、Lint、330 项单元与契约测试通过。四个本机后端角色已切换到 `huahuo-server:note-bm25`，健康检查通过。


- Note 编辑矩阵覆盖局部编辑、Markdown、差分回退和保存时序。断言 UTF-16 切片、核心区间、逻辑块与物理点、Embedding 调用和实际写删 ID。Worker 保留 Note 锁直到超时写请求结束。Note 行锁内保证入库任务时间顺序，防止时钟回拨选中旧任务。沿用既有字段和表。
- 类型检查、Lint、Build、341 项单元与契约测试及 215 项隔离集成测试通过。五组真实 Milvus 用例覆盖半删、跨块替换、大改回退、清空恢复和 S09。S09 在第一批点已可从 Milvus 读取时确认 Dense、BM25、Hybrid 都返回空，完成后再验证三种检索。真实 Milvus 使用确定性测试向量，并强一致读取物理点核对 PostgreSQL 当前块。重试和迟到写入由故障注入控制。

## 独立 TextIngestionJob 实施（2026-11-07）

- 新增 `text_ingestion_jobs` 与 `text_ingestion_chunks`，核心 DTO 使用六种字符串来源与九个已确认字段；没有业务版本号，只有手动输入可以修改原文。独立导入记录不伪造 Note，Chunk `parent_id` 直接指向整篇记录。
- 任务执行复用原 Task/Outbox/Worker，所有新来源在文本产出后共用 LangChain、tokenizer、Embedding、Milvus 核心。文件下载和图文预处理已抽成单份能力，原文件 Worker 同用；未接通的爬虫、独立 OCR、ASR 明确不可用。
- 增加 JWT 用户级创建、详情、列表、编辑和失败重试接口。更新通过任务指针和租约 fencing 防止晚到覆盖；新索引完全成功后才发布并清理旧目标。既有 RAG 查询通过 `sourceType=text` 检索独立记录。
- Typecheck、Lint、Build、317 项单元/契约测试和132项隔离真实 PG/Redis 集成测试通过。真实 RDS 原地添加新表、权限，完整目录比对和原记录摘要通过，当前58张表、0外键；四角色与API/Admin readiness健康。未调用真实付费模型，未修改App、凭据、OSS或Milvus数据。
- 接口示例、来源实际能力、恢复策略、真实/Mock证据和环境边界见 `docs/runbooks/text-ingestion.md`。

当前实现以唯一 `migrations/0001_initial_schema.sql` 为初始化基线；旧迁移链、旧用户表别名及数据回填兼容路径已移除。

## 统一用户与认证

- `public.users` 为App、Web、API共用账号主表，`user_identities`保存身份HMAC及脱敏值。
- 手机号登录采用 `purpose: sign_in`，登录必须提供 `clientType/clientId`；不接受旧参数别名。
- 会话使用精确JWT jti/hash绑定，停用或删除账号拒绝登录、访问和刷新；Refresh原子轮换且不超过会话绝对期限。
- Ed25519/EdDSA、JWKS和方向Service Key契约保持；email/OAuth、其它OTP用途和user_api_keys目前仅数据库基础。
- 关系使用普通ID和索引，物理外键为0；用户和工作区归属由业务层校验。
- Readiness精确匹配当前基线checksum，旧库不能因迁移号更大而误报ready。

## 原huahuo数据库实际启用（2026-11-05）

数据库名称及连接保持`huahuo`，没有新建其他数据库。不可逆清库操作曾被自动审批拒绝且未执行；随后获准执行完整保留数据的同库归档方案。

旧public整体归档至`initialization_backup`，58张表4149行的OID、存储标识及内容摘要保持不变；旧视图内容在封存前核验一致。归档列/表/序列/函数权限先撤、Schema权限最后撤，4个运行角色无归档USAGE/CREATE；管理员保留显式恢复权限的能力，归档不进入任何业务读取或兼容路径。

新public按原样0001建立，用户/会话/业务Chunk为空，物理外键全库0；迁移重放`applied=[]`、current1。控制台账号凭据保留策略未创建默认账号，原表本身为空。DB账号、密码、JWT私钥和服务Key未更改。

实际RDS不存在单独huahuo_migrator，初始化和重放沿用已配置的huahuo_admin。第一次数据保留事务因脚本预设migrator存在而自动回滚，确认原Schema/数据未变并恢复服务后，按实际角色配置完成切换；没有创建角色或篡改授权绕过。

## 验收及运行

Typecheck、Lint、Build、27文件229项unit/contract、10文件115项隔离PG/Redis integration通过。另有6项真实PG归档安全实验，覆盖非superuser DB owner、namespace与行保留、ACL封存、函数搜索路径、正常重放及失败整体回滚。

四个独立运行角色均使用最新huahuo-server:dev并healthy；API容器实际连接huahuo、基线checksum匹配、PostgreSQL/Redis均true，API/Admin readiness200，JWKS为EdDSA/Ed25519 server-current。API/Admin只绑定回环3000/3001。

本轮没有调用真实短信、Embedding或Rerank模型，没有清理共享OSS或Milvus；现有向量样本不等于新业务入库验收。App保持只读，客户端需适配新的认证Payload并重新登录。真实记录位于忽略提交的`.local/huahuo-unified-cutover/`。

## Note 与知识库文档的目录读取（2026-11-05）

- Note 与知识库文档复用 Markdown 结构解析，TOC 按入库版本保存。带用户 JWT 的详情返回嵌套目录，`/sections/{sectionId}` 返回精确原文。文件从对应的 canonical 对象读取字节范围，Note 从 PostgreSQL 正文快照读取。Flutter 现有 Note raw Markdown 写入路径继续驱动自动入库。
- 新索引正文以 300 字为 Note 切分目标，找不到合适断点时允许延长，硬上限为 Note 500、知识库文档 2,000 个 Unicode 码点，包含重叠。共享 splitter 与唯一初始化 SQL 均执行上限，章节坐标保持 UTF-16。既有环境切换到本版前使用更新后的初始化基线。
- Typecheck、Lint、Build、235 项单元/契约测试和 117 项隔离 PostgreSQL/Redis 集成测试通过。集成测试使用 Mock 解析与向量服务，并从本地对象存储验证精确节选。业务库与共享 Milvus、OSS 未参与本次验证。
- Note 调整为 300 字目标、500 字硬上限后，Typecheck、Lint、244 项单元/契约测试及 11 项 Note 入库集成测试通过。全量集成另有 2 项文件图片诊断用例触发已有的图片唯一约束。

## 数据库审计修复与真实 RDS 同步（2026-11-05）

- 清理 `upload_parts`、`resource_delete_requests`、`task_requests` 及运行调用，幂等统一到通用加密实现。删除两个重复普通索引、无消费的 CSRF hash 和调度短事务租约字段。保留普通 Note 搜索、业务游标、文档/笔记分离及有真实职责的关系表。
- 图片诊断改为文档级单份 manifest，完整保留未绑定 OCR；资产事务成功后才发布正文检查点。修正此前导致两项集成失败的图片唯一约束：稳定来源路径独立，允许共用相同图片对象，不修改解析器或切分算法。
- 同步此前工作区 TOC 与长度约束到原阿里云 RDS `huahuo`。隔离 PostgreSQL 演练及真实目录比较均证明修复结构等于唯一新基线；非空表保护、保留记录摘要和封存归档不变核验通过。没有清库、数据回填兼容分支、凭据更新或新迁移历史。
- 当前 `public` 56 张表、1 个 View、179 个索引，外键为 0。迁移重放 applied=[]/current=1；源码、镜像、RDS checksum 一致。四个独立角色 healthy，API/Admin readiness200。
- 最终 Typecheck、Lint、Build、29 文件244项单元/契约测试和11文件125项隔离真实 PG/Redis 集成测试通过；真实模型/解析/向量服务未调用。App上传及资源删除客户端只读核对，未修改。证据与保留边界见 `docs/runbooks/database-cleanup.md`。

## Admin 示例工作台（2026-11-06）

- `admin-ui/` 使用 Tailwind CSS 和 Ant Design，工作台展示四条明确标注的示例记录。`pnpm dev:admin-ui` 仅在本机回环地址运行独立预览。常规构建的页面由 Admin 服务在 `/admin` 提供，同源复用现有会话、登录和退出 API。
- Typecheck、Lint、Build 和 244 项单元/契约测试通过。浏览器核对桌面与窄屏布局，并用模拟存储验证错误密码提示、登录、刷新恢复会话和退出。此次验证使用本地预览与隔离测试服务。
- App 只读参照 `20f61b7` 的 `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart`，其中 `/api/v1/auth/login` 是 App 登录契约。本次页面只使用 `/admin/api/v1`，P14 业务页面与真实业务数据接入待定。
- 本机 `3001` 原容器没有前端产物。Docker 镜像构建并通过离线页面校验后，仅重建 `admin` 容器。就绪检查通过，浏览器打开 `/admin` 显示登录页，HTML、CSS 和 JS 返回 `200`，无会话调用 `/admin/api/v1/me` 返回 `401`。
- 工作台改用浅色主题。侧栏收起为图标栏并记住浏览器偏好，概况和示例记录各自可折叠。Typecheck、Lint、Build 和 244 项单元与契约测试通过。浏览器验证折叠、刷新恢复与 390 像素宽布局，本机 `3001` 已更新并加载新页面。
