# 内部身份传递

外部用户通过宿主入口的鉴权子请求认证：Server 验 JWT、账号有效状态、会话撤销及有效期。
普通业务接口不接受 Bearer 作为身份来源；它们接收网关注入或可信内部服务转传的身份头：

- `X-Huahuo-User-Id`：用户 UUID。
- `X-Huahuo-Session-Id`：会话 UUID。
- `X-Huahuo-Auth-Method`：`bearer` 或 `cookie`。
- `X-Trace-Id`：追踪 ID，缺省/无效时生成。

Agent 通过 `HUAHUO_SERVER_BASE_URL` 使用部署方维护的稳定内部地址调用 `/internal/v1/rag/query`，
不携带 JWT 或 ServiceKey。工作区、文档归属及事务内 `assertScope` 校验保留。
两端删除 `HUAHUO_AGENT_TO_SERVER_API_KEY`、`HUAHUO_SERVER_TO_AGENT_API_KEY` 配置；
Server 的 JWT 签发与统一认证密钥继续保留。业务端口只允许可信入口和内部服务访问。

Studio Cookie 认证和刷新集中在 Server 鉴权适配层，登录、刷新、退出均使用
一致的 `/agent` Cookie Path。独立注销入口允许过期 Cookie 清理，并撤销可认证的会话。
无用户后台任务使用专用内部接口，不制造用户会话。认证状态码、Cookie 与身份头约定见
[gateway-auth.md](gateway-auth.md)。这是接口契约说明，不是联合发布要求。Server与Agent各自独立发布；旧调用方式不兼容时由调用方在自身发布中调整，不在Server流水线中检查或操控Agent。

内部目标不能绑定一次性发布实例，Server切流完成后验证本项目外部业务与受限内部接口；Agent自身的调用链由Agent接入验收。内部请求继续保留事务内会话和资源权限校验，包括会员、余额、配额及用量查询，注销、过期、封禁状态不能仅靠身份头格式检查放行。

## IP、服务名与扩容

两端的内部 HTTP 接口均支持通过可达的 IP 或可解析的服务名访问，不要求公开域名、HTTPS 证书或 `/agent` 公开前缀。用户身份仍按上述契约传递，不能因为来自内网就省略用户权限校验。

| 调用方向 | 应用地址与路径 |
| --- | --- |
| Agent → API Server | `HUAHUO_SERVER_BASE_URL` 接受 `http://IP:端口` 或 `http://服务名:端口`，只配置 origin；客户端追加 `/internal/v1/...` 等实际路径 |
| API Server → Agent | Agent 监听接受相同两种地址形式，业务接口使用原生 `/api/...`；当前 Server 尚无主动调用 Agent 的业务客户端，不新增没有调用方的地址变量 |

同机容器在同一 Docker 网络时，可直连 `http://api-server:3000`、`http://agent:4111`。两个 Compose 项目默认网络各自独立，服务名只有在共享网络或部署方配置了相应 DNS 时才可解析。跨机器使用宿主私网 IP 与发布端口，或能跨机器解析的内部服务名；不固定容器 IP。绑定 `127.0.0.1` 的宿主端口不作为跨机入口。

地址可用不等于发布无中断。直连单个容器时，容器替换会影响连接；要求跨发布稳定的调用方应配置部署方提供的逻辑服务入口，其后选择健康实例。Agent 后续扩为多个实例时，调用方仍使用一个逻辑目标，由部署侧维护实例选择，业务代码不保存 IP 列表或蓝绿槽位。

目前 Agent 客户端没有自动重试；Agent 自身仍是单实例固定端口发布，允许短暂中断。现有候选的 API 切流及排空验证不代表 Agent 已具备无损滚动发布能力，也不保证超出退出预算的请求完成。内部地址与公开 Studio Origin 分开配置，不能将浏览器 Origin 改成内部服务名。
