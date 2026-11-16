# Admin 独立部署的服务地址

2026-11-16 入口契约：`API_BIND_HOST` / `API_HOST_PORT` 直接控制 API 容器的受限宿主监听；Admin 使用独立端口。公开入口由宿主维护，详见[入口鉴权契约](gateway-auth.md)。内部调用使用部署方提供的稳定地址，不绑定某个发布实例。

Agent 的调用地址使用其自身配置 `HUAHUO_SERVER_BASE_URL`；本仓的 `API_SERVICE_BASE_URL` 用于下述解析回调，二者不互相代替。Agent / Server 的 IP、服务名及横向扩展约定见[内部身份传递](internal-auth.md#ip服务名与扩容)。

当前部署边界为 API + Worker + Scheduler 一组，Admin 可单独部署到另一台机器。本轮只整理需要通过网络访问的 API 地址；数据库、OSS、缓存共享和其他角色跨机拆分留待后续，不改现有数据链路。

Admin 页面请求它自身的 `/admin/api/v1/*`，管理会话和权限仍由 Admin 后端处理。API/Worker/Scheduler 的现有任务交接使用持久队列，不调用 Docker exec 或容器管理 API。本轮不为它们添加额外 RPC 接口。

Admin 仅在既有“解析与模型”弹窗直接试用已配置的解析服务，结果只在内存中，不写数据库、不生成 API 回调。因此 Admin 试跑不依赖 `API_SERVICE_BASE_URL`；该地址用于用户正式文档任务的持久回调。

## 三种地址的职责

| 配置 | 用途 |
| --- | --- |
| `APP_PUBLIC_BASE_URL` | App/客户端可访问的业务 API 地址，继续用于现有上传、下载等链接 |
| `ADMIN_PUBLIC_BASE_URL` | 管理页面自身地址及 Origin 校验，与业务 API 独立 |
| `API_SERVICE_BASE_URL` | 其他服务和解析服务可到达的 API 地址，当前用于生成认证解析回调 URL；可用域名或 IP |

`API_SERVICE_BASE_URL` 设置后优先使用；留空时仅继承明确配置的 `APP_PUBLIC_BASE_URL`，不根据容器名、当前 Admin 地址或 HOST/PORT 猜测 API 地址。两者都未配置时，准备异步回调会报 `API_SERVICE_ADDRESS_REQUIRED`，不会生成错误的 localhost 回调。地址拒绝用户名/密码、query 和 fragment；支持 HTTP/HTTPS 和反向代理路径前缀。

例如业务组在服务器 A，Admin 在服务器 B：业务组的调用角色配置可被解析节点访问的 `API_SERVICE_BASE_URL`，Admin 配置自身地址，试跑目标使用已有处理节点的 baseUrl。

```dotenv
# A 的调用角色：示例值需替换成实际可达地址。
APP_ENV=test
API_SERVICE_BASE_URL=http://<服务器A私网IP>:3000
APP_PUBLIC_BASE_URL=https://<业务API域名>
# B 的管理端：与 API 地址分开配置。
ADMIN_PUBLIC_BASE_URL=https://<管理后台域名>
```

API 地址须同时能被实际发送回调的解析节点访问。若服务器 A 的 API 宿主端口只绑定 127.0.0.1，它不能作为跨机 IP 目标；需使用已有可达服务入口，或在 A 的部署配置中设置合适的 `API_BIND_HOST`/映射端口。宿主入口与代理仍由运维独立管理，本仓库不配置 Nginx 或证书。

若解析服务启用了回调主机白名单，须允许该 API 服务地址的 hostname；本轮不修改解析服务的运行配置。

同一份 Compose 把服务地址传给四个角色，不假设 API 与 Admin 在同一容器网络。解析节点的目标 API 地址继续由后台「处理节点」的 baseUrl 配置。复制代码或镜像到新机器只改变部署配置，无需把容器名写进业务调用。

Worker/Scheduler 没有新增服务地址或开放业务端口。Admin 的管理端口继续按原部署约束绑定，`API_SERVICE_BASE_URL` 不会改变 Admin 的监听地址或暴露范围。监控仍使用各实例的独立 `/metrics`，迁移 Admin 时只更新该实例的 Prometheus target。

## 验证

- `tests/unit/service-addresses.test.ts` 验证域名/IP、独立 API/Admin 地址、公共地址默认值、缺失地址及秘密 URL 拒绝。
- `tests/integration/runtime-configuration.test.ts` 用两个独立 loopback 监听运行 Admin/API，由 Worker 的正式任务准备回调，再通过真实 HTTP 验证认证、持久化及伪造令牌拒绝；Admin 试跑不使用该持久路径。PostgreSQL/Redis 为独立临时测试依赖，不把此验证称为真实双服务器部署。
- 现有文档流水线测试使用与 App 公共地址不同的 API 服务地址，防止回归到 localhost 或 Admin URL。完整证据见 `.local/service-addresses/`。
