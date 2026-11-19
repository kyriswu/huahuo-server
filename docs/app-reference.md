## 资产与上传契约核对（2026-11-19）

只读核对 Flutter 提交 `fe6a02c12794029dba620ab7ffd85b1f464e4de8`。自由创作通过 `lib/features/inspiration/data/inspiration_store.dart` 本地保存。`lib/core/uploads/upload_service.dart` 调用 `/api/v1/media/upload-token` 与 `/api/v1/media/uploads/{uploadId}/complete`，使用 `resourceId` 标识原文件。Server 的资产路由和两个独立导入入口尚无对应的 Dart 调用。 [现行资产契约](contract-compatibility.md)

## 历史记录 · 0019 内容归属和文件夹关系（2026-11-19）

只读核对 Flutter 提交 `fe6a02c12794029dba620ab7ffd85b1f464e4de8`。自由创作通过 `lib/features/inspiration/data/inspiration_store.dart` 保存到本地，共享上传走 `lib/core/uploads/`。当前共享 Dart 源码没有笔记工作区或文件夹路由的调用。Server 本期把账号归属和组织关联分开，原路由从关系表读取工作区和文件夹信息，App 接线按后续产品契约确认。

## Bearer 会话缓存参照（2026-11-19）

只读核对 App 提交 `fe6a02c12794029dba620ab7ffd85b1f464e4de8`。App 在 `lib/core/network/api_client.dart` 发出 `Authorization: Bearer <accessToken>`，在 `lib/features/auth/data/http_auth_repository.dart` 调用原 `POST /api/v1/auth/refresh` 并读取轮换后的令牌。共享缓存只改变服务端鉴权路径，App 请求、响应和刷新协议沿用现有契约。[鉴权契约](runbooks/gateway-auth.md)

## 用户资源与当前笔记参照（2026-11-17）

沿用本轮只读核对的 App 提交 `bf23c1b14d847de5561c1ba66bd4192dc308b356`；`lib` 未发现上传 HTTP、contentMd5/uploadRequired 或 Note 历史正文的消费者。当前改动只在 Server：资源只按用户归属、同一资源 ID 多处引用及计数、零引用自动硬删除、Note 只存当前正文；旧 part 修订入参不再接受。按用户最终要求不做内容去重，客户端不计算 MD5/SHA；接线时以幂等键重试同次上传、用 resourceId 复用文件，按 uploadRequired 决定是否直传，并用 If-Match 编辑当前 Note，不将修订 ID 当历史正文查询键。本轮不写 App、不运行 Flutter，不宣称移动端上传已联调。参见[当前协议与验证](acceptance/user-resources-and-current-notes.md)。

## 内部 HTTP 协定参照（2026-11-17）

只读复核真实App提交bf23c1b14d847de5561c1ba66bd4192dc308b356，api_endpoints.dart定义Server/Agent公开Base URL，未发现内部路径或可信身份头消费者；其SHA256仍为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1，http_auth_repository.dart仍为d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。本轮仅修改Server内部注册与出站封装；不写App，不读取/修改其他Agent项目，不宣称双方联调。见[协定](runbooks/internal-services.md)。

## 通用上传解耦参照（2026-11-17）

本轮只读核对真实 App，HEAD 为 `bf23c1b14d847de5561c1ba66bd4192dc308b356`，开始和核对后工作树均干净。当前 `lib` 未发现 `upload-token`、`media/uploads`、`sourceScene`、`durationSeconds` 或 `resourceId` 的上传 HTTP 消费实现。`core/platform/inspiration_files.dart` 仅负责本地选取/分享文件；`features/home/presentation/upload_more_menu.dart` 仅为菜单，不能作为云上传已接线的证据。

后端通用上传不再接收场景、音视频时长或数字分身参数，只负责文件授权、校验和用户归属；工作区属于后续业务上下文。上传后的业务由其他 API 主动引用 `resourceId`。客户端预期通过一个上传组件封装申请、OSS 直传和完成确认；此次未修改 App、未运行 Flutter，也未验证移动端上传进度或断网恢复。现有 `api_endpoints.dart` 仍分别声明 Server/Agent 地址，不代表已经实现统一上传组件。

本轮实际读取文件及 SHA-256：

| App 相对路径 | SHA-256 |
| --- | --- |
| `lib/core/network/api_endpoints.dart` | `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1` |
| `lib/features/auth/data/http_auth_repository.dart` | `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5` |
| `lib/core/platform/inspiration_files.dart` | `4b561ec23ed5fda54f0983fdff5e4b438ee6ffa48c24d07402fbf704fde9b597` |
| `lib/features/home/presentation/upload_more_menu.dart` | `7dc8de27c1bc96b6e98b90c74059c3b5f6e58c8180a92f297ec95e116cbe9e93` |

## OSS 直传直读参照（2026-11-17）

只读检索真实 `../huahuo-ai/lib` 未发现 upload-token、media/uploads、media/resources、extractionUrl/downloadUrl、contentMarkdown/KBIMAGE 的当前 HTTP 消费实现。本轮仅修改后端签名 URL/元信息确认/下载 JSON 契约，未写 App、运行 Flutter 或宣称移动端联调。后端证据见[OSS 验收](acceptance/oss-direct-access.md)。

## KBIMAGE 与可编辑 Markdown 参照（2026-11-17）

只读检索真实 `../huahuo-ai/lib`，未发现 KBIMAGE/contentMarkdown/displayMarkdown/imageLinks 的消费者；`features/inspiration/presentation/inspiration_image_embed.dart:34` 仍为 FileImage，`features/auth/presentation/auth_resources.dart:240` 是法律文本 Markdown，不属于本次 Note 编辑协议。前者 SHA256 为 `3b23860d989bf7f9729e092d25d98ef95281492994c4359d590a61c8f7cd3296`，后者为 `4f52a825e6fb3fd9909420eae173f39fce5662b3f6f3da66386ad652987b8fc2`。本轮只完成后端单正文标准 Markdown、过期图片地址识别及 KBIMAGE 无损往返；未修改/构建 App，不能宣称移动端编辑器联调完成。见[后端验收](acceptance/kbimage-unification.md)。

## 任务基础机制参照（2026-11-17）

本轮仅加强Server内部调度、终态事务与租约保护，公开请求/响应及队列载荷不变，扣费扩展按用户要求暂缓。沿用同轮只读App基准bf23c1b14d847de5561c1ba66bd4192dc308b356，两份认证/地址参照文件哈希未变；未写App或运行Flutter。历史后端模块交接不作为移动端验收，见[边界](acceptance/task-reservation-recovery.md)。

## traceId贯通参照（2026-11-17）

只读核对api_endpoints.dart与http_auth_repository.dart，SHA256仍分别为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1、d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。本轮仅补后台trace上下文与任务持久关联，不改App或运行Flutter；已有响应Envelope保持，见[验收](acceptance/trace-id.md)。

## 发布策略契约（2026-11-17）

本次只增加发布顺序/幂等及services按角色更新约束；App路由与业务响应Schema不变，固定云命令仍只接收SHA、返回原终态协议。私密成功记录新增逐角色镜像身份，不暴露到App。只读复核api_endpoints.dart、http_auth_repository.dart，文件SHA256仍分别为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1和d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5；未写App或运行Flutter。详见[发布保护验收](acceptance/release-order-and-services.md)。

## 任务预留恢复参照（2026-11-17）

只读核对当前App提交bf23c1b14d847de5561c1ba66bd4192dc308b356及干净工作树，lib未找到通用Task接口消费者；两份认证/地址参照文件哈希与上次一致。此轮仅改任务终态与预留事务，不改HTTP请求/响应结构，不写App或运行Flutter；后端测试不作为移动端联调。证据见[任务恢复验收](acceptance/task-reservation-recovery.md)。

## 统一入口与Agent配套修改参照（2026-11-16）

只读复核真实App的api_endpoints.dart、http_auth_repository.dart，SHA256仍为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1和d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。App继续从环境读取两个Base URL；统一域名部署时配置Server origin和Agent的/agent前缀，不修改内部业务路径。本轮没有写App，用户另行明确授权的Agent后端已配套调整；后端代理联调不冒充移动端验收。见[证据](acceptance/ingress-auth.md)。

## Qwen模型切换参照（2026-11-16）

只读真实App的api_endpoints.dart与http_auth_repository.dart，Git HEAD bf23c1b14d847de5561c1ba66bd4192dc308b356、工作树干净；SHA256仍为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1及d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。本次仅替换后端模型/派生向量与修复内部RAG配置入口，当前App未发现RAG消费；没有修改App或运行Flutter，未将后端测试称为移动端联调。见[专项验收](acceptance/qwen37-vector-switch.md)。

# App 只读参照基线

## 搜索底层端口封装（2026-11-16）

本轮只读复核api_endpoints.dart与http_auth_repository.dart，SHA256仍分别为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1、d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。公开/内部RAG请求与正文响应不改，变化是底层索引端口、后端工厂和SDK适配位置；阶段诊断名改为index_ready/index_search。未写App、未运行Flutter或独立Agent；914项unit/contract和48项隔离真实PG/Redis/Milvus不是移动端或真实ES验收，见[底层说明](runbooks/milvus.md#底层接口与后端替换)。

## 全仓架构审计参照（2026-11-16）

本轮只读核对实际 `../huahuo-ai/lib`；当前客户端未找到 rag/ingestions、text-ingestions、kb/documents、kb/notes 或 basePartRevisionId 的消费代码，不能把历史 Server 端点当作已接通当前 App。`lib/core/network/api_endpoints.dart` 仍为双 Base URL，其 SHA256 为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`；认证客户端 `lib/features/auth/data/http_auth_repository.dart` 为 `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`，与前次相同。未写App或运行Flutter。用户进一步明确底层只有Note/File两条入库线路，未来业务名称另定；源码检查与8项隔离复现见[审计记录](progress.md)。

## 文档解析客户端协议修复（2026-11-16）

本机同级 `../huahuo-ai` 不存在，标记 UNVERIFIED_APP；未复制、修改或运行 App。此次仅修复后端与外部解析服务的状态/回执校验，App 路由、请求参数、响应 Schema、鉴权和 Task 载荷均未变。Server 契约测试及真实解析响应回放分别留证，不能替代移动端实测，见[验收](acceptance/document-trial-api-20261116.md)。

## 节点默认可用与试用就绪检查（2026-11-16）

只读复核api_endpoints.dart与http_auth_repository.dart，哈希仍为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1与d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5。仅Admin删除节点开关并明确试用未就绪错误，App协议不变；未写App或运行Flutter。

## README 与环境规则（2026-11-16）

只读复核真实 App 的 api_endpoints.dart 与 http_auth_repository.dart；客户端仍从 HUAHUO_SERVER/HUAHUO_AGENT 获取地址，认证沿用既有路径。本期仅文档和服务端部署权限默认值，不改 App HTTP 契约。app:reference:diff 仍报告旧基线已有的认证源码/测试差异与工作树状态变化，未覆盖基线或 App；快照保存在 `.local/readme-test-cloud/app-reference.json`，未运行 Flutter。

## 服务端异常诊断（2026-11-15）

只读复核api_endpoints.dart与http_auth_repository.dart，哈希与本轮开始时一致；仍使用原错误envelope/traceId，不新增客户端参数或暴露stack。未写App或运行Flutter，本轮证据见[验收](acceptance/error-diagnostics.md)。

## 解析节点状态专项（2026-11-15）

只读复核真实App的api_endpoints.dart与http_auth_repository.dart，SHA256仍为`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`和`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。本轮调整Admin运行状态、云控制与内网调用边界、发布维护的节点清单及标签；不改App接口或源文件、不运行Flutter。见[验收](acceptance/processing-node-status.md)。

## 发布冒烟只读核对（2026-11-15）

只读核对 App 的 `lib/core/network/api_endpoints.dart`（17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1）及 `lib/features/auth/data/http_auth_repository.dart`（d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5）。冒烟使用已有身份/工作区/任务路由，不新增 App 契约或写 App；证据 `.local/release-smoke/app-reference.json`，见[验收](acceptance/release-smoke.md)。

## Worker 优先交接专项（2026-11-15）

复用前述两份真实App源码参照，前后SHA-256一致；只读证据在 `.local/worker-first-release/app-reference.json`。未修改App或运行Flutter，本轮只补Server交接测试和部署约定，不更改公共协议或验证App长连接重连。见[验收](acceptance/worker-first-release.md)。

## 手动启动与异步回调专项（2026-11-15）

只读复核真实App的api_endpoints.dart及http_auth_repository.dart，SHA256仍分别为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。本轮仅Server编排、Admin启动入口与内部回调，不修改App或运行Flutter，不把本地后台检查当作移动端验收。见[验收](acceptance/document-async-events.md)。

## 容器演练只读参照（2026-11-15）

真实App的api_endpoints.dart和http_auth_repository.dart只读复核，哈希仍分别为`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`，证据`.local/release-rehearsal/app-reference.json`。通用基线仍报告既有工作树差异，未覆盖基线/源码或运行Flutter。本轮容器HTTP、管理会话和文件验证不作为移动端验收。见[演练](acceptance/release-rehearsal.md)。

## 发布基础专项只读参照（2026-11-15）

只读核对真实 ../huahuo-ai 的 api_endpoints.dart（SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）与 http_auth_repository.dart（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`）；认证HTTP有15秒客户端超时，不能用服务端排空预算代替客户端体验验收。旧通用参照基线报告已有App工作树变化，本轮未覆盖该基线/源码，未运行Flutter。新证据 `.local/release-hardening/app-reference.json`，见[验收](acceptance/release-hardening.md)。

## Prometheus 内部监控参照（2026-11-15）

只读核对 `../huahuo-ai/lib/core/network/api_endpoints.dart` 与 `lib/features/auth/data/http_auth_repository.dart`，前后 SHA256 一致；原双 Base URL、认证 Header 与业务 Envelope 保持。新增指标端口只供 Prometheus 拉取，App 无新参数或接线要求。比对记录 `.local/prometheus/baseline.json` / `audit.json`，未写入 App。

## RAG配置与ENV清理复核（2026-11-15）

仅调整Server配置来源、缓存参数生效及独立Admin分类。实际只读api_endpoints.dart/hash仍17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1，http_auth_repository.dart/hash仍d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5；未改App/运行Flutter，不将后端与浏览器验证当移动端验收。

## 试用弹窗与JSON配置复核（2026-11-15）

本轮只调整Server内部节点持久化和独立Admin界面。只读复核api_endpoints.dart与http_auth_repository.dart，SHA256仍分别为17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1、d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5；未写App或运行Flutter，不推进Pxx。

## 分类运行配置只读复核（2026-11-15）

本轮新增独立Admin运行配置，不改变App登录/接口envelope。只读实际 ../huahuo-ai 的 api_endpoints.dart（17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1）及 http_auth_repository.dart（d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5），与开始参照一致。未写App或运行Flutter，后端测试不冒充移动端验收。见[验收](acceptance/runtime-configuration.md)。


## CPU解析机目标切换（2026-11-15）

只读核对实际`../huahuo-ai`的api_endpoints.dart（SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）与http_auth_repository.dart（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`），内容与前次一致。本轮只换Server内部ECS ID/IP，不改App合约、不写App或运行Flutter。见[验收](acceptance/document-parser-cpu-target.md)。

## prod-callback实测只读复核（2026-11-14）

App仍GIT_UNBORN，api_endpoints.dart/hash `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、http_auth_repository.dart/hash `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5` 前后一致，路径仍为 `lib/core/network/` 与 `lib/features/auth/data/`。新异步领取属于Server内部协议；未写App/运行Flutter，也未声称移动端消费新结果通过。见[验收](acceptance/xberg-a10-prod-callback.md)。

## A10 ECI 回退内部调度（2026-11-14）

只读核对 `../huahuo-ai/lib/core/network/api_endpoints.dart`（`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）与 `lib/features/auth/data/http_auth_repository.dart`（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`），当前 GIT_UNBORN。本轮只改 Server 内部云调度，无 App 合约变更；未运行 Flutter 或写 App。见[回退验收](acceptance/document-parser-eci-fallback.md)。

## 图片编辑与查询契约只读核对（2026-11-14）

当前 `../huahuo-ai` 为 GIT_UNBORN。只读核对 `lib/features/inspiration/presentation/inspiration_image_embed.dart`（SHA256 `3b23860d989bf7f9729e092d25d98ef95281492994c4359d590a61c8f7cd3296`），图片仍由 FileImage(File(path)) 读取本地文件，未消费 Server displayMarkdown/imageLinks。全 lib 未找到本轮 Note/RAG 查询／新字段 HTTP 消费者。

双 Base URL 的 `lib/core/network/api_endpoints.dart`（`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）与认证 `lib/features/auth/data/http_auth_repository.dart`（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`）也已核对；三文件前后哈希一致，未写 App 或运行 Flutter 命令。新增响应字段属于 Server CODE/用户确认方案，404/178 后端测试不冒充 Flutter 端到端通过。证据 `.local/markdown-images/baseline.json`、verification.json，见[验收](acceptance/markdown-images.md)。

## Admin 用户列表只读核对（2026-11-14）

当前 App 仍为 GIT_UNBORN。只读核对 `lib/core/network/api_endpoints.dart`（SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）和 `lib/features/auth/data/http_auth_repository.dart`（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`）；前后哈希及工作树状态一致，记录在 Server `.local/admin-users/app-reference-{start,end}.json`。

新用户列表仅装载在独立 Admin 的 `/admin/api/v1/users`，沿用管理员 Session；App 原有手机号登录和用户 JWT 契约没有变化。没有运行 Flutter 或修改 App，不以管理台浏览器验证冒充 App 端到端验收。见[本轮验收](acceptance/admin-users.md)。

## 文档 HTTP/关键词接线核对（2026-11-14）

只读核对当前 `../huahuo-ai`，仍为 GIT_UNBORN。`ApiEndpoints` 使用 HUAHUO_SERVER/HUAHUO_AGENT；认证 HTTP 客户端保持 Authorization、JSON 与 x-idempotency-key。两文件 SHA256 仍为 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`，完整相对路径同下方基线，记录见 Server `.local/ecs-power/extraction-app-reference.json`。

当前 App 未找到 rag/ingestions、text-ingestion 或 sourceResourceId 的调用代码，本轮端点接线为 Server CODE/用户协议，不冒称 Flutter 端到端通过。只新增后端文件请求可选母资源/批次 UUID、受控产物/图片读取；既有 envelope、Task 身份和原生文本行为保留。未写 App 或运行 Flutter 命令。

## 解析机运行库只读核对（2026-11-14）

当前实际 App 为 `../huahuo-ai`，Git 为 GIT_UNBORN、尚无 commit/remote。再次只读核对 `lib/core/network/api_endpoints.dart`（HUAHUO_SERVER/HUAHUO_AGENT，SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）及 `lib/features/auth/data/http_auth_repository.dart`（既有 `/api/v1/auth/*`、x-idempotency-key，SHA256 `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`）。

本次是内部库和 scheduler 事件监听，不新增 App 请求/响应字段或控制实例接口；未修改或运行 App 命令。源码核对为 CODE，解析协议与真实端到端调用为 UNVERIFIED；只读记录在 Server `.local/ecs-power/app-reference.json`，见[验收](acceptance/document-parser-machine.md)。

## A10续测的App只读核对（2026-11-13）

本轮仍只在Server内使用独立测试链路；读取../huahuo-ai的api_endpoints.dart和http_auth_repository.dart，结束时哈希一致，Git复核GIT_UNBORN。未写App或运行Flutter，GPU/KB协议未冒充App接线。详见[验收](acceptance/xberg-a10-kbxml-retest.md)。

## Xberg T4续测的App只读参照（2026-11-13）

本轮仅在Server内操作独立GPU测试工具、结果和docs；读取../huahuo-ai的api_endpoints.dart、http_auth_repository.dart，两份SHA前后一致，Git GIT_UNBORN，未运行Flutter命令或写App。未把Xberg新KB协议伪装成App接通。详见[验收](acceptance/xberg-oss-kbxml-trial.md)。

## Xberg OSS/KBXML核对与申请未完成（2026-11-13）

新镜像digest c8ad143d…783e25/build xberg-kbxml-v1-20261113-r4已静态核对；新增北京I交换机已加入本机GPU配置。T4单区/四区及A10两档实际申请均NoStock，关闭缓存和570驱动也未成功，无325页解析或性能结果。所有自有调度实例和临时输入已清理，新镜像缓存Ready并保留。长期GPU仍disabled，未改业务/App/数据库。本轮App只读基线仍GIT_UNBORN，两个实际参照文件SHA阶段末一致。详见[本轮记录](acceptance/xberg-oss-kbxml-trial.md)。

## A10测试的当前App只读参照（2026-11-13）

当前只读../huahuo-ai，Git仍GIT_UNBORN。实际读取lib/core/network/api_endpoints.dart（SHA256 17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1）和lib/features/auth/data/http_auth_repository.dart（d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5），阶段末一致。本轮只是独立云端镜像测试，无App接线、Flutter运行或App文件写入；不复用历史huahuo-app提交号，也不宣称客户端解析流程验收通过。详见[本轮验收](acceptance/xberg-a10-native-first-trial.md)。

## 当前只读源码基线（2026-11-12，用户修正目录）

当前 App 根目录为 `../huahuo-ai`，已替换活动 AGENTS、Pxx 规范、默认路径、示例配置及实际本机配置。App Git 根目录一致，分支 main，尚无 commit、未配置 origin，登记为 `GIT_UNBORN`，不沿用旧 App 的 HEAD 或 GitHub 地址。此前 `huahuo-app` 和 Flutter/packages 的材料保留为历史证据，不能用于宣称当前 App 已兼容。

已读 `HttpAuthRepository.sendCode/verifyCode/_post/_readSession` 及认证测试。新 App 明确使用 purpose=sign_in、clientType/clientId、x-idempotency-key、success/data/error envelope，服务端现有认证契约可直接承接；Base URL 从 `HUAHUO_SERVER` 注入，Agent 地址由 `HUAHUO_AGENT` 单独注入。只核对本次认证消费者，不声明其他业务兼容。

| 当前 App 相对路径 | SHA-256 |
| --- | --- |
| `lib/core/network/api_endpoints.dart` | `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1` |
| `lib/features/auth/data/http_auth_repository.dart` | `3ba7ab4618094cc535860312fed9fe892d233799ed610a321d75ceac75b03bf0` |
| `lib/features/auth/domain/auth_repository.dart` | `7804ece505e60e7c2269bd56068fcd923d024ab7f4448a1cd6d186a42de8aebe` |
| `test/auth_api_test.dart` | `d7ac13fac8f7ec45bae706478a56a03ce93e291df9504aab2502978c36c70eb6` |
| `test/auth_flow_test.dart` | `91cbf6077a98d14af13447f2db8983176b5c053be3c89cb4343cb693dc28fa42` |

`app:reference` 与 `--diff`、本机路径预检通过；未运行 Flutter、pub get、构建、格式化或改动 App。工作树状态摘要与上述文件哈希在本轮结束复核，私有证据位于 `.local/sms-service/`。

## Xberg 新图片策略测试的只读参照（2026-11-12）

App HEAD20f61b78887f9288d1fd3227f326e6374d516f27。只读核对endpoint_catalog.dart及work_ai_task_api.dart，SHA分别c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92、3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e；阶段末一致。本轮仅独立ECI测试和本机证据，没有App API消费接线、Flutter运行或App文件写入，不宣称客户端联调完成。详见[本轮验收](acceptance/xberg-cuda-image-policy-trial.md)。

## 文件解析供应商移除的只读核对（2026-11-12）

App HEAD `20f61b78887f9288d1fd3227f326e6374d516f27`；实际读取 `endpoint_catalog.dart:437` 的工作区Note导入路径、JWT和幂等声明，目录中没有供应商专属API，不能与Server通用 `/api/v1/rag/ingestions` 直接等同。目录文件SHA-256 `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92`；domain_clients.dart哈希 `28ac16b834fd4bd4491ef25fab26b53ec66f12428ea7cecc7b04b09e1099853e`。本轮仅移除Server外部解析适配器，未写入App或运行Flutter，不声明客户端联调通过。见[移除验收](acceptance/mineru-removal.md)。

## FunASR ECI 申请只读核对（2026-11-12）

App HEAD仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`。实际读取 `endpoint_catalog.dart:805` 的taskDetail/retryTask与 `work_ai_task_api.dart:16` 的任务接口，SHA-256仍分别为 `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92`、`3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e`。本轮只申请独立FunASR实例，无App写入、Flutter运行或ASR任务接线。见[实例记录](acceptance/funasr-eci.md)。

随后完整音频转写仍由Server本地试验脚本直接调用镜像HTTP完成，没有接入App任务/录音契约；真实响应和重复“嗯”的质量问题独立记录，不作为移动端/语音业务验收。

## Xberg CUDA全文试验只读核对（2026-11-12）

App HEAD仍20f61b78887f9288d1fd3227f326e6374d516f27，两个Task参照文件SHA仍c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92、3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e。真实Task ID查询/重试只读核对；本轮仅云端325页测试，无App写入、Flutter运行或契约接线。见[全文CUDA验收](acceptance/xberg-cuda-full-trial.md)。

## Xberg CUDA镜像试验只读核对（2026-11-12）

App HEAD仍20f61b78887f9288d1fd3227f326e6374d516f27；真实Task ID查询/重试源码只读核对。endpoint_catalog.dart、work_ai_task_api.dart SHA仍c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92、3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e。无App写入、Flutter运行或接口接线；本轮仅临时T4镜像与调用配置测试，见[CUDA验收](acceptance/xberg-cuda-trial.md)。

## Xberg全文试验只读核对（2026-11-12）

App HEAD仍20f61b78887f9288d1fd3227f326e6374d516f27，endpoint_catalog.dart和work_ai_task_api.dart SHA仍c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92、3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e。只读核对真实Task ID查询/重试源码；本轮仅云端全文试验，无App写入、Flutter运行或接口接线。见[全文验收](acceptance/xberg-full-trial.md)。

## Xberg优化对照的只读核对（2026-11-11）

App HEAD及endpoint_catalog.dart、work_ai_task_api.dart SHA与前轮一致，实际Task ID查询/重试契约不变。本轮只测试镜像官方按页OCR/线程参数，未接移动端、改App或运行Flutter。哈希仍c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92、3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e，HEAD20f61b78887f9288d1fd3227f326e6374d516f27。见[验收](acceptance/xberg-optimization-trial.md)。

## Xberg独立测试只读核对（2026-11-11）

App HEAD仍为20f61b78887f9288d1fd3227f326e6374d516f27，endpoint_catalog.dart、work_ai_task_api.dart的SHA仍分别为c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92、3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e。实际源码继续按Task ID查询/重试；本轮仅镜像HTTP前20页测试，无App接线、Flutter运行或写入。详见[验收记录](acceptance/xberg-trial.md)。

## 新镜像对照的只读核对（2026-11-11）

App HEAD仍20f61b78887f9288d1fd3227f326e6374d516f27，既有endpoint_catalog.dart和work_ai_task_api.dart哈希与前述GPU记录一致；只读核对，无Flutter运行或App写入。本轮为独立云端10页测试。详见[对照验收](acceptance/gpu-parse-ocr-trial.md)。

## huahuo-parse 试验核对（2026-11-11）

再次只读核对同级 App HEAD 与下表两个 Task 文件，哈希仍分别为 `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92`、`3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e`，HEAD 仍 `20f61b78887f9288d1fd3227f326e6374d516f27`。本轮仅运行 Server 本地操作脚本及用户授权的云端容器，不注册 App 路由，不修改 Task DTO，未运行 Flutter 或向 App 写入。

## 阿里云 AK 配置修复核对（2026-11-11）

再次只读核对 App HEAD `20f61b78887f9288d1fd3227f326e6374d516f27` 与下列两个任务文件 SHA-256，均与 GPU 阶段记录一致。仅修改 Server 环境读取、Compose、示例和测试，不改 App 文件或 HTTP/Task 契约，未运行 Flutter。

## GPU 底层模块的只读核对（2026-11-11）

本机 App HEAD 为 `20f61b78887f9288d1fd3227f326e6374d516f27`。工作树原有 iOS 工程/Info.plist、V3 页面、pubspec 及未跟踪设计/资源文件的用户改动；未覆盖、暂存或还原。只读取以下文件，阶段末复核哈希；未运行任何向 App 写入的命令。

| App 相对路径 | 本轮依据 | SHA-256 |
| --- | --- | --- |
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | `taskDetail/retryTask/regenerateTask`，805—826 行；目录无 GPU/ECI 管理端点 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/src/lib/features/work_ai/data/work_ai_task_api.dart` | `WorkAiTaskApiPort`、`getTask/retryTask`、`parseWorkAiTaskDetail`，16—115 行 | `3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e` |

本轮没有新增 App 消费端或修改 HTTP 契约，ECI 内部状态不直接写入移动端 Task DTO。源码核对、Mock SDK 测试和后端契约回归不等于 Dart/真机或真实 GPU 验收。

北京 T4/网络配置细化时再次复核上述 HEAD 与两个 SHA-256，均一致；只变更 Server 内部配置、网络校验和 CLI。真实 VPC/ECS 网络查询不作为移动端或 GPU 计算验收。

一次性真实试申请及初始化元数据修复后再复核上述 HEAD/哈希，仍一致；原用户 App 工作树改动保持。没有新增 App 云资源管理端点，也没有运行 Flutter。实际云端验收独立记录于 `acceptance/gpu-spot-trial.md`。

第二次真实阶段计时再次只读核对上述 HEAD 与两个 SHA-256，均一致；读取实际 `WorkAiTaskApi` 仍按 Task ID 查询/重试。仅补 Server 本地采集与文档，无 App 写入或契约变更。31.785 秒为 Nginx 实例 Ready 的观测时序，详见 `acceptance/gpu-spot-timing.md`，不作为移动端或模型计算验收。

## 知识库检索重构的实际消费者核对（2026-11-10）

本轮仍只读同级 App，未运行 Flutter、生成器、格式化或包管理命令。实际 HEAD 为 `20f61b78887f9288d1fd3227f326e6374d516f27`，本轮证据在忽略提交的 `.local/kb-refactor/app-reference.json`。App 当前有用户自己的移动端界面/iOS改动；未覆盖、暂存或还原，以下契约文件哈希按实际读取内容记录。

| 真实 App 路径 | 核对点 | SHA-256 |
| --- | --- | --- |
| `Flutter/packages/huahuo_api/lib/src/contracts/contract_models.dart` | SharedWorkspaceSearchResult 的 ownerRef、part、revisionId | `5a248f30bd1fa04594072bbd57afe6c70edfa9973fc3627dc03b7edd16aa01a0` |
| `Flutter/packages/huahuo_api/lib/src/api/domain_clients.dart` | note GET 的 revisionId（1257行附近）、part GET 的 partRevisionId（1311行附近） | `28ac16b834fd4bd4491ef25fab26b53ec66f12428ea7cecc7b04b09e1099853e` |
| `Flutter/desktop/lib/features/editor/presentation/editor_workspace.dart` | `_openWorkspaceSearchResult`（2802行附近）、`_openExactWorkspaceNote`；要求part和精确整篇修订 | `a44e26b903c5920943f7d294f660eeec8e143d5e6c815de7201ca1461ef020fa` |
| `Flutter/desktop/lib/features/integration/data/desktop_api_domains_adapters.dart` | 转发整篇与part读取的不同修订参数 | `da448533c040bdd2f06efe74ce17dd76b68a54164b687cd5ea035839b0f27ad1` |

服务端关键词/混合搜索返回 `part=raw`、整篇 Note 的 `revisionId`，另提供 `partRevisionId`。读取整篇和读取part分别验证自己的修订，不再将raw part UUID作为整篇修订。独立真实PG/Redis/Milvus与HTTP契约测试覆盖搜索→精确读取、错误修订和跨用户读取失败；没有宣称执行了Dart运行时或手机联调。旧客户端技术路径仍保留，不在产品界面或集合命名中增加工作区概念。图谱继续按标签关系运行。

以下保留各阶段的原始读取证据。

- 来源仓库：https://github.com/kyriswu/huahuo-app
- Server 根：本机 `huahuo-server`；App 路径相对为 `../huahuo-app`
- 记录时间：2026-10-09
- 当前 commit：`20f61b78887f9288d1fd3227f326e6374d516f27` (`main`)
- 工作树：clean；未执行 fetch/pull/Flutter 命令；App 未修改。

P01 读取并记录哈希的源码证据：

| 路径 | 符号/内容 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/api/api_client.dart` | `ApiClientConfig`、`buildCommonHeaders`、`resolveAuthHeader`、`buildUrl` | `5916960ae6d0704c440bf01ca96d0730a690aed99cc51630ff754a57ccc160fe` |
| `Flutter/packages/huahuo_api/lib/src/api/api_envelope.dart` | `ApiEnvelopeResult`、`parseApiEnvelope`、`parseApiError` | `fa30b010514105c2ef9b37adc3b5bc37829874ce571537a4bc15badb5d1e4815` |
| `Flutter/packages/huahuo_api/lib/src/api/request_parsing.dart` | JSON object/parser/分页/If-Match 辅助 | `d7bc4c4e662a1de9928577c704d9f27e3c969d014614a30b522c27d78dd83b05` |
| `Flutter/packages/huahuo_api/test/api_foundation_test.dart` | formal envelope 与 Bearer 请求 fixture | `938bcfbed29f1bde7faf76cf751b305c8789c478194d6bc46f02ffa2042ab1fb` |
| `Flutter/src/lib/app/bootstrap/core_provider_module.dart` | `HUAHUO_API_BASE_URL`、Debug HTTP/非 Debug HTTPS 校验 | `d084b55a9ecb2f56d0bf9c3558f530deb088ac9aea4949bda7dec9edf00b62cb` |

本阶段核对结论：App 发送 `Accept`/JSON、`X-Trace-Id`、`X-Request-Id`、客户端/设备/平台/locale/timezone 头；有 token 时发送 `Authorization: Bearer …`；endpoint 路径自身包含 `/api/v1`；严格成功响应为 `{success:true,data,traceId}`，失败为 `{success:false,error,traceId}`。后端 health 和错误 envelope 保留这些关键字段，健康以外未提前声明业务兼容。

`config/app-reference.local.json` 与 `docs/app-reference.local.json` 是被忽略的本机路径/哈希记录；`node scripts/app-reference.mjs --diff` 在阶段末返回无差异。App 后续变化需先更新参照，再核对受影响契约。

## P02 读取证据

阶段开始和结束均确认同一 App commit `20f61b78887f9288d1fd3227f326e6374d516f27`、`main`、工作树 clean；未执行 fetch/pull 或 Flutter 命令。读取入口覆盖 Auth、workspace、onboarding 与 profile：

| App 相对路径 | 符号/契约用途 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/auth/auth_client.dart` | AuthClient：sms/login/refresh/status/timezone 请求 | `1ce22418b975e37fa24799e1f291fa3b98fc466196ac79c6ef6bddd327ce8bc2` |
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | auth/me/workspace/onboarding endpoint 路径与方法 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/packages/huahuo_api/lib/src/contracts/contract_models.dart` | SharedWorkspace* 与定位 DTO 解析 | `5a248f30bd1fa04594072bbd57afe6c70edfa9973fc3627dc03b7edd16aa01a0` |
| `Flutter/packages/huahuo_api/lib/src/workspace/workspace_lifecycle_client.dart` | workspace CRUD、If-Match、幂等键 | `658057db0bb1581f0433866ce53638c86f2a9392f093a0718629ba672f2e5472` |
| `Flutter/src/lib/features/auth/data/auth_api.dart` | 登录字段、token/status 解析 | `0c78f60b36631ded7f5ea5766c2e97064e62e938a8d8f7b01a5ce11e2489e755` |
| `Flutter/src/lib/features/onboarding/data/onboarding_api.dart` | content line/creative positioning 字段别名与 completion 解析 | `1e7ea2e0ba6061a95999b5d2e507ceb4e9bad2814984ed0ca2faeb7088041675` |
| `Flutter/src/lib/features/onboarding/data/onboarding_progress_repository.dart` | 本地 onboarding draft：mode/stepIndex/answers/deferredAt | `2c65b2034fbcea6745b62d48e31c7a7acd1952d7372075dc0986af68822e36ea` |
| `Flutter/src/lib/features/ui_v3/application/user_profile_controller.dart` | profile load/save、displayName/avatar 引用 | `e8f61a54bc42869df76391dc2d877667b860a5cd534ef8b5fa508aa8722a3437` |

契约证据链已记录于 `docs/adr/0002-identity-workspace.md` 和 `docs/contract-compatibility.md`。App 只读；新增云草稿与服务端 logout 是后端先行契约，提案见 `docs/app-change-proposals.md`，未修改客户端。

关键定位行号（对应上述哈希）：`auth_client.dart:16` 请求短信、`:34` 登录、`:51` 刷新；`auth_api.dart:265` 登录、`:529` status 解析、`:740` workspace 解析；`contract_models.dart:117` Summary、`:158` BootstrapResult、`:189` Detail；`onboarding_api.dart:163` 创建、`:291` 包装解析、`:455` ID 别名；`onboarding_progress_repository.dart:11` snapshot、`:166` repository；`user_profile_controller.dart:178` load、`:226` save、`:481` profile 解析。

## P03 读取证据

| App 相对路径 | 符号/用途 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | taskDetail/retry/regenerate/runningTasks、Agent Run events/stream 路径 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/src/lib/features/work_ai/data/work_ai_task_api.dart` | task detail/retry/regenerate 请求和严格字段解析 | `3075a15afa3ce959b83c3ffe38555562cdfe5a8d3c241f1828a99263a4151a6e` |
| `Flutter/src/lib/features/work_ai/domain/work_ai_task.dart` | WorkAiTaskInfo 状态/错误/重试模型 | `0539c7714263bbe6e870e5c626f6cd09ad88fbd589160c1a0ac05bd767496db4` |
| `Flutter/packages/huahuo_api/lib/src/api/domain_clients.dart` | AgentRunClient detail/events/Last-Event-ID | `28ac16b834fd4bd4491ef25fab26b53ec66f12428ea7cecc7b04b09e1099853e` |
| `Flutter/src/lib/features/chat/domain/assistant_runtime.dart` | run 状态、事件流和 afterSequence 抽象 | `afe8ac28c7b12bad260daeb1beee9b3a12bdadc1d5370cbec183248753bd311c` |
| `Flutter/src/lib/features/chat/data/remote_project_assistant_runtime.dart` | 远端 run/events 请求 | `9148a9d89005fc1d2176799a8271967cceee80fc9dcd44ac130927a2d7fc87ab` |
| `Flutter/src/lib/features/chat/application/chat_run_tracker.dart` | 断线补读、顺序游标和终态判定 | `dbfccde4b121bcc2a39663fba0d44045191c50e79049e1630b1f190edbb2134b` |
| `Flutter/src/lib/features/onboarding/application/initial_positioning_task_coordinator.dart` | 定位任务 receipt/status 恢复 | `1dbd9537afe3a7501d2b7f18a66ffffafd595c89d876dd1a01f0b58fb9b9a566` |

## P04 读取证据

App commit 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27` (`main`)，工作树 clean；未 fetch/pull、未运行 Flutter 命令、未修改 App。P04 读取文件及 SHA-256：

| 路径 | 符号/用途 | SHA-256 |
|---|---|---|
| `Flutter/packages/huahuo_api/lib/src/billing/account_usage_client.dart` | membership、account credits、run usage、home quota 请求 | `74fdaf7e88715720396667b73ea5968e24a1854d9ab0baf6ab843b169b2b6c00` |
| `Flutter/packages/huahuo_api/lib/src/billing/account_usage_models.dart` | SharedAccountMembership/CreditSummary/RunUsage 严格解析 | `846d945b76b2d955ef5f18c038b8a465fa30f67d487765ee5e21f534dad4c2b5` |
| `Flutter/packages/huahuo_api/lib/src/billing/account_quota_balance.dart` | quotaSummary.balances、整数/日期解析 | `2e0a3b4a5e011c48c1c75d64ce72a6df91bb69cc14f7d52a7a38ab69ae5fb1fb` |
| `Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart` | membership/accountCredits/runUsage/home endpoint 路径 | `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92` |
| `Flutter/src/lib/features/billing/data/account_usage_repository.dart` | App billing result mapping and unavailable behavior | `c8ca48ef42bd8d5569c4ff61634346c1db8cd5e095b9b9152c16b4c0077e7a89` |

P03 仍确认 App 工作树 clean、未修改、未运行 Flutter 命令；`node scripts/app-reference.mjs --diff` 返回无变化。

## P05 参照记录

App commit `20f61b78887f9288d1fd3227f326e6374d516f27`，`node scripts/app-reference.mjs --diff` 返回 `headChanged:false,statusChanged:false,changedFiles:[]`。本阶段读取上传客户端、媒体资源删除客户端、端点目录，以及聊天/相册/头像播放解析；App 只读且未修改。

## P06 参照记录

本阶段追加核对 `domain_clients.dart`、`contract_models.dart`、`api_contract_manifest.dart` 与 `endpoint_catalog.dart` 中的 folders/notes/parts/search/relations/content-navigation 契约。App HEAD 仍为 `20f61b78887f9288d1fd3227f326e6374d516f27`，只读工作树无变化。

## P06 标签化补充修订（只读）

App HEAD `20f61b78887f9288d1fd3227f326e6374d516f27`，原基线差异为空；新增以下有针对性的参照文件后扩充哈希基线。未运行 Flutter/生成器或修改 App。

| App 路径 | 用途 | SHA-256 |
|---|---|---|
| `Flutter/src/lib/features/ui_v3/data/knowledge_user_metadata_repository.dart` | 20 标签/24 runes 上限与字面去重 | `dd441629534349c44c2dccf104b503aa1408fa0728e6d05e6ffcffe63874bcbe` |
| `Flutter/src/lib/features/ui_v3/application/knowledge_library_controller.dart` | effectiveTags/updateEffectiveTags 当前本地写入 | `b4753a8a25780f8b32e023b5021588e005511bbd721bd7fd39b2746f1fb516ef` |
| `Flutter/src/lib/features/ui_v3/data/mirofish_graph_api.dart` | 请求 content-navigation/overview | `21d60697079edc9c229113d7625f3729ea1ff6022d4da64b2bcf5f4d8459d8ae` |
| `Flutter/src/lib/features/ui_v3/data/mirofish_graph_mapper.dart` | items/path/revision-or-version 解析，当前忽略后端 edges | `4be2d9e6f442976576e814bece6bf206e1f6361207095256bbca51d24ddaeb06` |
| `Flutter/src/lib/features/ui_v3/data/graph_snapshot_mapper.dart` | 通用 nodes/edges 接受 id/source/target/kind | `a0fb56e131ba05024a1b28de06e3e7ec87629cb00e48f53ff47564356356545d` |
| `Flutter/src/lib/features/ui_v3/data/graph_repository.dart` | 当前图谱注入与加载边界 | `f4d2353747641f895c8140123d464974ac3b4b3e2a10296787184846d6077f9d` |

请求和解析器另核对 domain_clients.dart:1372/1387、contract_models.dart 的 Search/ownerRef/relative path/敏感字段白名单，后端真实 Fastify + PG 的 tags CRUD、search、navigation 测试覆盖这些数据形状；没有执行 Dart runtime 或手机联调。
