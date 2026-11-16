# 入口鉴权应用契约

应用 Compose 只维护 API、Admin、Worker、Scheduler、一次性 migrate 及已有数据依赖。宿主入口、域名、证书和切流独立维护，配置、脚本和操作手册不放在本仓库。API 的 `API_BIND_HOST` / `API_HOST_PORT` 是受限应用监听，不是匿名用户可直连的公开认证入口。

## 认证子请求

`GET /internal/v1/gateway/auth` 无请求体，只允许可信入口调用。入口将原请求的 `Authorization`、`Cookie`、`Origin`、`Accept` 及真实 `X-Forwarded-Method`、`X-Forwarded-Uri` 传入。后两项必须由入口覆盖；不能接受客户端伪造值。身份认证优先使用 Bearer，只有启用 Studio 且请求位于其公开路径时才允许 Cookie。

| 结果 | 响应及入口行为 |
| --- | --- |
| 通过 | 204，入口转发业务请求，并覆盖下述身份头 |
| 无有效身份 | 401，阻止业务调用 |
| Cookie 写操作跨源 | 403，阻止业务调用 |
| 依赖故障 | 5xx，拒绝业务调用，不能当作注销或跳转登录 |
| 未登录的 Studio HTML 导航 | 401，另有 `X-Huahuo-Login-Redirect`，值为配置的 `<publicPath>/studio-login`；由入口生成浏览器重定向 |

认证接口不返回 302。API、资源文件、带无效 Bearer 的请求都不会获得登录重定向提示。响应不缓存；账号封禁、会话过期及注销每次重新验证。

通过后的身份头为 `X-Huahuo-User-Id`、`X-Huahuo-Session-Id`、`X-Huahuo-Auth-Method`、`X-Trace-Id`。入口覆盖客户端同名头，并移除发送给业务上游的 Authorization、Cookie 和旧 ServiceKey。公开登录、签名资源等无需用户认证的入口也必须清除客户端自报身份。业务权限继续在所属 Service 的事务中检查。

## Studio Cookie 与退出

原生认证子请求不会自动向浏览器转发所有 Set-Cookie，因此 Server 将 Cookie 完整值放入四个不同的内部响应头；入口逐项原样转换成四条 `Set-Cookie`，不能拼成一个逗号分隔值，也不能把内部头透传给浏览器或业务上游。

| 内部响应头 | 内容 |
| --- | --- |
| `X-Huahuo-Clear-Access-Cookie` | 删除旧根路径 access Cookie |
| `X-Huahuo-Clear-Refresh-Cookie` | 删除旧根路径 refresh Cookie |
| `X-Huahuo-Studio-Access-Cookie` | 设置或清除公开 Agent 路径的 access Cookie |
| `X-Huahuo-Studio-Refresh-Cookie` | 设置或清除公开 Agent 路径的 refresh Cookie |

这些头只在刷新或未登录导航清理时出现。Cookie 的 HttpOnly、SameSite、Secure、Path、有效期由 Server 生成。业务返回错误时也需保留刷新结果，避免丢失已旋转的 refresh token。

`POST /internal/v1/gateway/logout` 供公开 Studio 注销入口映射，直接接受原始 Cookie/Authorization，不先做认证子请求。它验证同源、撤销有效会话，过期 Cookie 也能清除；普通响应直接返回四条 Set-Cookie。跨源拒绝时不改 Cookie。

配置仅为 `HUAHUO_STUDIO_AUTH_ENABLED`、`HUAHUO_STUDIO_ORIGIN`、`HUAHUO_AGENT_PUBLIC_PATH`。生产关闭 Studio；测试按需要开启。移除代理 Dashboard 后，没有 Dashboard 分支开关或分支探测脚本。

## 公开与内部业务边界

- `/api/v1/...` 使用 Server 原路径；登录/刷新、健康、公钥及已有能力令牌路径按原方法和签名规则处理。
- `/agent/api/...` 到 Agent 时移除 `/agent`，内部业务 API 不改名；Studio 页面和静态资源保留其原生 `/agent` 前缀。
- Admin 保持独立端口与管理会话。内部 API、指标和管理功能不通过普通用户入口开放。
- Agent 到 Server 使用部署方提供的稳定内部地址和同一可信身份头，不绑定某个发布槽位。该地址只允许授权内部调用方访问。
- 单跳入口默认 `API_TRUST_PROXY_HOPS=1`，独立进程默认 `HTTP_TRUST_PROXY_HOPS=0`；信任跳数只处理客户端地址，不能代替业务监听的访问隔离。

API 接受已到达的请求并按现有数据库排空预算退出；入口切流与旧进程退出需配套验证。模型用量由 Agent 上报 Server 结算，与 SSE 连接是否正常关闭分开；本轮不新增收费功能。
