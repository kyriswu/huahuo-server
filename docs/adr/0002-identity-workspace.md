# ADR 0002 — 用户、个人工作区、创作定位与引导

状态：P02 实施；证据为本机 App commit 20f61b7（具体哈希见阶段基线）。

App 的 AuthApi 发送 CN 手机号、smsRequestId、smsCode、deviceId、agreementAccepted/Version、privacyVersion、clientVersion、timeZone。登录/恢复需要 user.phoneMasked、workspace.status 和 workspaceId；不能只返回通用 JWT。

WorkspaceLifecycleClient 使用 workspaceId、ETag/If-Match 及持久幂等键。工作区是个人资产授权范围；每个用户恰有一个默认 ready 工作区，登录事务确保默认空间存在。可创建/切换多个个人工作区，不开放成员或团队功能。

OnboardingApi 将“内容线”映射为 creativePositioningId，且返回 creativePositioning/contentLine。使用一个 workspace_profiles 记录该工作区唯一定位资料，兼容两种 DTO 别名；不再建同义 content_lines 表。答案保存和正式 AI 定位结果分开：P02 不标 basicPositioningCompleted，不生成 Markdown/AI 报告、不注册 agent run；P09 才生成报告。

当前 OnboardingProgressRepository 在手机本地保存 mode、stepIndex、answers、deferredAt，没有云草稿 endpoint。P02 提供同字段的 /api/v1/workspaces/:workspaceId/onboarding-draft（PROPOSED），用户未授权 App 修改；实际 App 云草稿接线留在提案。已有 /onboarding/creative-positioning 只存用户填写定位字段，返回 onboardingCompleted=false，不冒充 AI 完成。

App 内容同步 DTO 要求 bootstrapReceiptId 和 decimal cursor：工作区创建时持久化真实 bootstrap receipt，空内容 cursor=0；P06 才实施内容同步，不伪造已有文件。

手机号 P02 明确限定中国大陆 CN：接收 11 位移动号码或 +86 E.164，规范化为 +86；其他区域明确拒绝，供应商/区域以后扩展。持久 phone lookup 为带服务密钥 HMAC，响应仅掩码。验证码/访问令牌/刷新令牌只存摘要；refresh 单次轮转，旧 token 复用撤销整个设备会话。App access 为短期不透明 Bearer（带固定 app_ 前缀），每次验证 PG 会话撤销状态；无需引入自签 JWT。

幂等结果在 PostgreSQL 存储，按身份/操作/key/requestHash 校验。登录/SMS 中可能包含凭证的响应仅 AES-GCM 密文短期保存，令牌表仍只保存摘要。恢复旧登录响应前检查原 session 存活；刷新接口按 App 契约禁止幂等头，旧 refresh 重放不能获得新 token。

管理员使用独立表、密码 scrypt、admin cookie、服务端撤销/CSRF/RBAC；不识别 App Bearer，也无公开注册。bootstrap 必须 CLI 显式输入密码且首次执行；审计仅追加不授予修改/删除。

协议版本从配置读取；开发例子沿用 App 当前 2026-08-20 版本号，只记录确认版本/时间/动作，不生成法律文本，不代表法律审核。
