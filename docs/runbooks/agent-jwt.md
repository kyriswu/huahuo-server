# huahuo-agent JWT 接入规范

统一用户模型已部署到原 `huahuo` 库的新 `public`，版本1基线与readiness通过。旧Schema仅封存在 `initialization_backup`，不参与运行查询，产品用户和会话未复制。JWT私钥未变，JWKS已真实核对为EdDSA、Ed25519、`server-current`；Server仍依据新 `public` 的用户与会话执行最终校验。

Server 是用户 Access Token 的唯一签发方。Agent 只保存验证公钥，不保存 JWT 私钥，也不调用 Server 鉴权接口验证每一次请求。

## Token 约定

- 算法：`EdDSA`（Ed25519）。
- `iss`：`huahuo-server`（以 Server 的 `APP_JWT_ISSUER` 为准）。
- `aud`：`["huahuo-server", "huahuo-agent"]`。Agent 验证时必须要求包含 `huahuo-agent`，不能只验证签名。
- `sub`：可信用户 ID；不要接受请求体、普通身份 Header 或模型输出覆盖它。
- `iat`、`exp`、`jti`：必须存在且类型正确；`exp` 必须未过期。
- Header：`typ=JWT`、`alg=EdDSA`、`kid=<当前密钥版本>`。

## 公钥获取与轮换

从 Server 的公开地址读取：

```http
GET /.well-known/jwks.json
```

JWKS 只包含公钥，响应中的 `kid` 与 JWT Header 的 `kid` 对应。Agent 应缓存 JWKS，并在遇到未知 `kid` 时刷新一次后重试验签；不要把私钥、Access Token 或完整 JWKS 写入日志。Server 在轮换窗口可以同时发布当前和上一把公钥，旧 Token 在自身 `exp` 到期前仍可验签。

## Agent 请求入口

1. 从 `Authorization: Bearer <access_token>` 读取 Token。
2. 读取 `kid`，从 JWKS 选择对应 Ed25519 公钥。
3. 严格验证 `alg=EdDSA`、签名、`iss`、`aud`（`huahuo-agent`）、`iat`、`exp`、`jti`。
4. 从已验证 Claims 的 `sub` 获取 userId。
5. 将 userId 写入 Mastra `RequestContext`，例如使用约定键 `huahuoUserId`。
6. Agent 工具访问 Server 业务 API 时，仍须让 Server 做最终 workspace/资源归属校验；不能信任客户端额外传来的 userId 或 workspaceId。

Agent 不应实现 Refresh Token。Access Token 过期后由 APP 或 Web 客户端调用 Server 的刷新接口，再把新的 Access Token 用于后续请求。两个客户端使用相同 JWT 契约；登录时通过 clientType 和 clientId 记录客户端会话，不改变 `sub` 的用户身份语义。

## Server 当前签发示例

```json
{
  "alg": "EdDSA",
  "typ": "JWT",
  "kid": "server-current"
}
{
  "sub": "<user-id>",
  "iss": "huahuo-server",
  "aud": ["huahuo-server", "huahuo-agent"],
  "iat": 0,
  "exp": 0,
  "jti": "<token-id>"
}
```

当前 `/internal/v1/rag/query` 要求用户 JWT 与独立的 Service Key 同时存在：

```http
Authorization: Bearer <USER_JWT>
X-Huahuo-Service-Key: <HUAHUO_AGENT_TO_SERVER_API_KEY>
```

JWT 识别登录用户，Service Key 识别可信 Agent 服务。Server 会从 `users` 校验用户仍为 active，并校验数据库会话与资源归属；Agent 保持本地 JWT 验签，不读取用户数据库。不要把任一认证信息暴露给模型上下文。
