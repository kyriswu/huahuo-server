# P02 身份运行与验证

身份与会话使用当前 `users` / `user_sessions` 契约；历史初始化和迁移记录保留在验收文档中。当前目标版本与部署状态以实际成功记录为准。

当前业务启动以根目录 `.env` 和 [本地开发手册](local-development.md) 为准。新环境从 `migrations/0001_initial_schema.sql` 顺序执行编号迁移，已有环境只执行新增迁移，已执行文件及校验和冻结。`pnpm verify` 运行静态检查、构建、单元及契约测试、独立 PostgreSQL／Redis 集成测试和 Compose 模板检查。

`pnpm test:e2e:p02` 在专用本地测试栈中启动两个临时 HTTP 容器和随机数据库，验证两用户与 Admin 会话。结束时清理本次测试资源。`pnpm test:container-isolation` 验证四角色独立性和依赖恢复。两条命令均在测试栈的 API 使用云 PG 时拒绝执行。

## 真实短信验证码

开发、测试和正式环境统一调用真实阿里云短信平台，启动前须提供已审核签名、模板和 RAM 凭据。`POST /api/v1/auth/sms-code` body `{phone:"13800000001",purpose:"sign_in"}` 返回 smsRequestId/cooldownSeconds/providerMode=live，不返回验证码。手机号仅支持 CN 11 位移动号或 +86 E.164，其他区域明确拒绝。

登录请求必须包含 phone、smsRequestId、smsCode、clientType（`app` 或 `web`）、clientId、agreementAccepted=true、agreementVersion、privacyVersion、clientVersion，可选 timeZone。clientId 是客户端生成并保留的安装或浏览器实例标识；它不决定用户身份，用户身份由验证后的 JWT `sub` 决定。短信请求和登录请求只接受上述字段契约，不保留旧参数别名。当前开发协议与隐私版本均为 2026-08-20。不要将验证码或 token 写入共享日志。升级前的模拟票据不能重放或登录。隔离自动测试通过测试目录中的传输替身捕获验证码；HTTP E2E 只在自身随机临时数据库中准备 OTP，不增加应用的模拟模式或回显接口。

```json
{
  "phone": "13800000001",
  "smsRequestId": "<smsRequestId>",
  "smsCode": "<code>",
  "clientType": "app",
  "clientId": "<stable-client-instance-id>",
  "agreementAccepted": true,
  "agreementVersion": "2026-08-20",
  "privacyVersion": "2026-08-20",
  "clientVersion": "<client-version>",
  "timeZone": "Asia/Shanghai"
}
```

`users` 是用户资料与状态的唯一主表，保存 display_name、time_zone、avatar_resource_id；仅 `status='active'` 的用户可以访问用户业务接口。手机号身份、摘要和掩码保存在 `user_identities`，响应中的 phoneMasked 从身份记录读取。会话保存在 `user_sessions`，记录 client_type 和 client_id；协议接受记录保存在 `user_agreement_acceptances`。这些表使用普通关联 ID 和业务校验，不建立物理外键。

Access 为 Ed25519 签名的 JWT Bearer，默认 15 分钟，包含 `sub`、`iss`、`aud=["huahuo-server","huahuo-agent"]`、`iat`、`exp`、`jti`，并带有当前公钥的 `kid`；Server 校验自己的 audience `huahuo-server`，Agent 应校验 `huahuo-agent`。Token 绑定数据库会话；refresh 为至少 256 bit 的随机值，默认 30 天绝对期限，哈希存储、单次轮转，复用旧值撤销对应客户端 session。token/OTP 表只存摘要；为了安全重试，登录幂等响应使用 AES-GCM 加密且仅保留 5 分钟重放有效期。

Server 在 `GET /.well-known/jwks.json` 仅发布当前 Ed25519 公钥。`APP_JWT_PRIVATE_KEY` 只在 Server 配置，`APP_JWT_PUBLIC_KEY` 可分发给受信验证方；只接受当前 `APP_JWT_KEY_ID`，更换密钥后旧 Access Token 立即失效，客户端需重新登录。

`POST /api/v1/auth/logout` 撤销当前客户端 session；`POST /api/v1/auth/logout-all` 撤销该用户全部 session。普通用户 Token 可以访问其 audience 声明的 Server 和 Agent，不能作为管理员凭证。

## 会话活动记录（2026-11-17，待发布）

Bearer 会话按[入口鉴权契约](gateway-auth.md#bearer-会话缓存)缓存至 Redis。首次鉴权或缓存失效时读取已提交的用户/会话状态，Studio Cookie 鉴权仍逐次检查。查库时的 `last_seen_at` 最多每 60 秒更新，行锁忙则由后续请求补记。登录与刷新沿用原活动记录。该字段是近似活跃时间，不参与令牌或会话有效期。

鉴权读取与可选更新在同一条主库SQL中完成，业务`assertScope FOR SHARE`不变。注销或封禁提交后的新鉴权拒绝；撤销尚未提交、鉴权快照已经开始的在途请求可能通过，不承诺撤回已放行请求。本项无新表、缓存或ENV；验证见[会话活动验收](../acceptance/session-activity.md)。

## 工作区和草稿

用户修改请求必须有 X-Idempotency-Key 或 Idempotency-Key；两者同时给出不同值返回 400。同 key 不同请求返回 409，数据写入和响应记录同事务提交。工作区更新/切换/停用/恢复还需 If-Match 对应响应 etag；过期版本 412。默认空间不能直接停用，应先切换。没有共享成员或团队 API。

P02 云草稿新增 GET/PATCH `/api/v1/workspaces/{workspaceId}/onboarding-draft`；保存字段 mode、stepIndex、answers、deferred、expectedVersion。返回 deferredAt/version，版本冲突409；所有读写核验账号归属。与手机本地草稿的同步未接线，见 app-change-proposals。

creative-positioning 仅存用户输入，返回 onboardingCompleted=false；当前 profile 的 conclusions 为空。P09 才产生正式 AI 报告。P05 前非空 avatarResourceId 返回409。

## 管理员 CLI 和会话

没有默认管理员、默认密码或公开注册。首次 bootstrap 通过 stdin JSON，避免在命令参数或日志输出密码：

```bash
# 私密 JSON 文件放 .local/ 且 chmod 600；字段 username/password，密码至少16字符。
docker compose --env-file .env exec -T admin node dist/entrypoints/admin-bootstrap.js < .local/admin-bootstrap.json
# 已有任何管理员时 bootstrap 拒绝再创建。
# 撤销使用 username/reason JSON，不需要重启服务器。
docker compose --env-file .env exec -T admin node dist/entrypoints/admin-revoke-sessions.js < .local/admin-revoke.json
```

等价 pnpm 命令：admin:bootstrap / admin:revoke-sessions（在配置好的 Admin 环境中执行）。本轮只在临时测试库运行 bootstrap，开发库保持无管理员，不替用户选择真实管理密码。

`POST /admin/api/v1/login` 需要 JSON username/password 及精确 Origin=http://127.0.0.1:3001（生产使用配置 HTTPS origin）。返回 HttpOnly、SameSite=Strict、Path=/admin cookie 和 csrfToken；生产 cookie 追加 Secure，不设置 Domain。GET `/admin/api/v1/me` 取当前身份/CSRF；所有受保护写入要 Origin + X-CSRF-Token。

operator 只能撤销自己的当前 session，superadmin 可 POST `/admin/api/v1/sessions/{adminId}/revoke`，需要 reason 并追加审计。登录按 IP/用户名持久限流，未知用户同样受限。浏览器请求 `/admin` 的 HTML 时显示管理页，页面使用 `/admin/api/v1/me` 恢复会话。`/admin` 的 JSON 请求继续返回认证后的身份。
