# Agent 内部 API 鉴权

统一用户模型已部署到原 `huahuo` 库的新 `public`，版本1基线与readiness通过。旧Schema仅封存在 `initialization_backup`，不参与运行查询，产品用户和会话未复制。JWT私钥未变，JWKS已真实核对为EdDSA、Ed25519、`server-current`；Server仍依据新 `public` 的用户与会话执行最终校验。

服务间使用两个方向独立的 Service Key：

```env
HUAHUO_AGENT_TO_SERVER_API_KEY=<至少 32 字节随机 Base64URL>
HUAHUO_SERVER_TO_AGENT_API_KEY=<至少 32 字节随机 Base64URL>
```

Server 验证 `HUAHUO_AGENT_TO_SERVER_API_KEY`，调用 Agent 时使用 `HUAHUO_SERVER_TO_AGENT_API_KEY`。Agent 方向相反。Service Key 只放在 `X-Huahuo-Service-Key`，不能放到 Authorization Bearer。

用户 JWT 的跨服务验签规范见 [agent-jwt.md](./agent-jwt.md)。Service Key 只识别可信 Agent 服务，JWT 才识别 APP 或 Web 登录用户；两者不能互相替代。Server 统一从 `users` 验证 active 状态，再执行会话与业务数据归属校验。

请求统一使用：

```http
Authorization: Bearer <USER_JWT>
X-Huahuo-Service-Key: <HUAHUO_AGENT_TO_SERVER_API_KEY>
```

当前 RAG 内部查询入口是 `POST /internal/v1/rag/query`。Service Key 只证明请求来自 Agent，用户 JWT 的 `sub` 由 Server 重新验证并用于 workspace 数据归属校验；Service Key 和 JWT 都不得放入模型上下文、Tool 参数、用户消息或普通日志。

当前接口策略：

- `POST /api/v1/rag/ingestions`：`user`
- `GET /api/v1/rag/ingestions/:jobId`：`user`
- `POST /api/v1/rag/query`：`user`
- `POST /internal/v1/rag/query`：`user+service`

当前没有注册仅 `service` 的用户数据接口。新增系统接口时必须显式声明为
`service`，不能用裸 userId 访问用户私有数据。

生成 Key：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

