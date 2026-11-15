# 手动启动与正式文档异步回调（2026-11-15）

本轮恢复工作前重新核对当前源码，保留同期新增的指标、发布排空和 API 服务地址配置。Admin 文档试跑按最新约定保持直接调用、纯内存、零数据库写入；没有恢复试跑任务、节点分配或持久回调机制。不推进新的 Pxx。

## 行为

- Admin 处理节点增加“手动启动”。superadmin、Session、Origin/CSRF 与部署总开关校验后，将启动任务和节点快照写入既有维护队列，立即返回 202；重复点击复用进行中的任务。不开启节点接收任务的开关，也不新建 ECS。
- Worker 每次只执行一个启动/就绪检查步骤；尚未就绪时释放租约与执行槽，延迟继续。启动状态经共享 PostgreSQL LISTEN 与 SSE 推送，页面不定时查询数据库。原有空闲停机策略继续生效。
- 正式 RAG 文档及 FILE_UPLOAD 使用 `/extract-async`，持久记录提交意图、回调身份和 job_id 后让出 Worker。解析完成回调先通过令牌、上下文、指纹和结果回执验证，事务保存后才返回 2xx；Outbox 唤醒原任务继续保存产物和入库。
- 正常回调路径不轮询上游；未收到回调时约 60 秒执行一次补偿检查，每次仅一次远端查询。启动等待、远端执行阶段不保持每文档等待循环。沿用既有四角色，不新增常驻角色或进程。
- 继续保留原节点亲和、取消交接、lease fencing、模糊 intent 不盲目重发及 Redis 占用保护。经认证的匹配回调可以收敛已提交但未收到 202 的 intent；不覆盖取消标记，不允许旧 Worker 发布结果。阶段接续计数与业务失败重试预算分开。
- 节点 `documentApi.mode` 固定为 async；`parameters=null` 仍表示省略 multipart config，直接使用部署好的解析服务参数。OCR 模型、图片、表格、KB Markdown 和 App 契约未改。

回调使用 `API_SERVICE_BASE_URL`，留空只继承明确的 `APP_PUBLIC_BASE_URL`。内网部署时，该地址必须从解析机可达；解析服务若启用了回调主机白名单，需允许对应主机。Admin 自身地址不是业务回调地址。

## 验证

| 检查 | 结果与范围 |
| --- | --- |
| typecheck / lint / build | 通过，含 Admin 构建 |
| unit / contract | 43 文件、473 项通过 |
| integration | 18 文件、241 项通过，1 项 Milvus 跳过；真实独立 PG/Redis，测试结束只清理本轮依赖 |
| 手动启动新增集成 | 真实 PG/Redis、loopback Admin SSE、云替身；202 不调用云 API，重复请求同一任务，两次让出后就绪，只启动一次，未改节点接收开关 |
| 正式回调回归 | 认证/伪造/重复/冲突、提前回调、intent 收敛、取消、租约变化、补偿查询与未知提交不重发通过；供应商为替身 |
| Compose / 镜像 | 静态校验及完整镜像构建通过；实际本地四角色同镜像 healthy、readiness 200 |
| HTTP 隔离 | Admin HTML/JS 200，匿名配置 401，App API 同管理路径 404 |
| Chrome | 原账号打开实际本地后台；六项核心配置、高级折叠、异步提示、空覆盖及禁用的手动启动入口已核对；1512px 无横向溢出 |

完整测试包含同期指标、排空、服务地址和试跑简化改动，不把全部用例归为本轮新增。手动启动正向流程使用云替身；没有真实开机、解析、OSS 上传或付费模型验收。

## 现有开发环境

先完成回滚演练，再暂停本项目四个本地角色，按已核对差异单事务同步：新增任务接续计数、启动任务约束、仅正式任务使用的回调表及必要授权；当前 CPU 节点调用模式从 sync 改为 async，revision 6→7。没有重跑整份初始化、清空表、删除卷或重置凭据；应用启动也不执行结构重置。

事务核对用户、管理员、工作区、笔记、资源、入库、任务/结果/尝试及分配表行数不变，物理外键为 0。运行配置仍 revision 3；CPU 节点的实例、地址、文档/音频能力、并发 16、不在线状态保留。节点总开关仍 false，回调表和未结算分配均为 0。

唯一基线与实际 Schema checksum 为 `5d77ce9faad63e6e1d04b305562367e4264fa69f3cf041cc2ce4100a436015d5`。本地四角色镜像为 `huahuo-server:async-node-20261115`，ID `sha256:110e91ae14fe1cb09ea8cdf790a0c77a8ce92c22797754d01feef50e22578d48`，`local-dev` 指向同一镜像。

权限证据需区分环境：独立测试角色验证 Admin 无正式回调表读取授权；现有开发 RDS 的 Admin 账号已有 API/Worker/Scheduler 及 pg_rds_superuser 角色成员关系，实际可继承读取权限。本次记录该现状，不更改已有角色或凭据，不能将测试角色最小权限结论套用到此开发库。Admin 试跑源码和测试仍保证不读写正式回调表。

证据在 `.local/async-node-resume/`：静态/单元/集成/构建日志、`db-rehearsal.json`、`db-result.json`、`runtime-result.json`、`node-start.jpg`。真实 PDF/Office 及回调网络可达性仍由用户部署到内网测试机后验收；当前电脑不会因云机开机获得 VPC 路由。

只读 App 两份参照 SHA256 不变：`api_endpoints.dart` 为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`，`http_auth_repository.dart` 为 `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。未写 App，未运行 Flutter，未提交或推送本轮工作区。
