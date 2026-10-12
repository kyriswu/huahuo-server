# P02 身份运行与验证

本机 Docker 项目仍为 huahuo-server-dev；运行镜像 huahuo-server:p02；迁移 version=2。`node scripts/verify.mjs` 包括类型/lint/build、unit/contract、真实临时 PG/Redis 集成测试。`node scripts/e2e-p02.mjs` 用同一个 P02 运行镜像启动两个临时 HTTP 容器和随机测试数据库，运行两用户与 Admin 会话流程，finally 仅删除这些测试资源。`node scripts/container-isolation.mjs` 仍验证四角色独立性和依赖恢复。

## 本地短信模拟

API 显式注入 SMS_PROVIDER=mock、ALLOW_MOCK_PROVIDERS=true、SHOW_TEST_OTP=true；不会发送真实短信。`POST /api/v1/auth/sms-code` body `{phone:"13800000001",scene:"login"}` 返回 smsRequestId/cooldownSeconds/providerMode=mock/testCode。手机号仅支持 CN 11 位移动号或 +86 E.164，其他区域明确拒绝。

登录 body 与 App 一致：phone、smsRequestId、smsCode、deviceId、agreementAccepted=true、agreementVersion、privacyVersion、clientVersion，可选 timeZone。当前开发版本均为 2026-08-20。不要将 testCode 或 token 写入共享日志。生产不允许 mock、测试 OTP 回显或开发绕过。

Access 为 `app_` 不透明 Bearer，15 分钟，服务端每次查询 session；refresh 为 `refresh_` 随机值，30 天绝对期限，单次轮转，复用旧值撤销同设备 session 的全部当前凭证。token/OTP 表只存摘要；为了安全重试，登录幂等响应使用 AES-GCM 加密且仅保留 5 分钟重放有效期。数据库未实现物理 TTL 清理，过期记录不可再用，维护清理留待 P03。

`POST /auth/logout` 撤销当前设备 session；`POST /auth/logout-all` 撤销该用户全部 session。不同 audience/prefix 不互通，普通 App token 永远不作为管理员凭证。

## 工作区和草稿

用户修改请求必须有 X-Idempotency-Key 或 Idempotency-Key；两者同时给出不同值返回 400。同 key 不同请求返回 409，数据写入和响应记录同事务提交。工作区更新/切换/停用/恢复还需 If-Match 对应响应 etag；过期版本 412。默认空间不能直接停用，应先切换。没有共享成员或团队 API。

P02 云草稿新增 GET/PATCH `/api/v1/workspaces/{workspaceId}/onboarding-draft`；保存字段 mode、stepIndex、answers、deferred、expectedVersion。返回 deferredAt/version，版本冲突409；所有读写核验账号归属。与手机本地草稿的同步未接线，见 app-change-proposals。

creative-positioning 仅存用户输入，返回 onboardingCompleted=false；当前 profile 的 conclusions 为空。P09 才产生正式 AI 报告。P05 前非空 avatarResourceId 返回409。

## 管理员 CLI 和会话

没有默认管理员、默认密码或公开注册。首次 bootstrap 通过 stdin JSON，避免在命令参数或日志输出密码：

```bash
# 私密 JSON 文件放 .local/ 且 chmod 600；字段 username/password，密码至少16字符。
docker compose --env-file .env.compose.local exec -T admin node dist/entrypoints/admin-bootstrap.js < .local/admin-bootstrap.json
# 已有任何管理员时 bootstrap 拒绝再创建。
# 撤销使用 username/reason JSON，不需要重启服务器。
docker compose --env-file .env.compose.local exec -T admin node dist/entrypoints/admin-revoke-sessions.js < .local/admin-revoke.json
```

等价 pnpm 命令：admin:bootstrap / admin:revoke-sessions（在配置好的 Admin 环境中执行）。本轮只在临时测试库运行 bootstrap，开发库保持无管理员，不替用户选择真实管理密码。

`POST /admin/api/v1/login` 需要 JSON username/password 及精确 Origin=http://127.0.0.1:3001（生产使用配置 HTTPS origin）。返回 HttpOnly、SameSite=Strict、Path=/admin cookie 和 csrfToken；生产 cookie 追加 Secure，不设置 Domain。GET `/admin/api/v1/me` 取当前身份/CSRF；所有受保护写入要 Origin + X-CSRF-Token。

operator 只能自己的 session；superadmin 可 POST `/admin/api/v1/sessions/{adminId}/revoke`，需要 reason，并追加审计。登录按 IP/用户名持久限流，未知用户同样受限。P14 再建设管理网页，此阶段 /admin 返回认证后的身份 JSON。
