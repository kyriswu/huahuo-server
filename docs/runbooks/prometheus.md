# Prometheus 应用指标

四个常驻角色各一个 Node 进程；Worker 进程内的 BullMQ 队列消费者共享同一个 Registry。没有 cluster、PM2 或 worker_threads。依赖固定 `@prometheus-io/client@0.16.1`，其 Node engines 为 `^22 || ^24 || >=26`；本地 Volta 26.11.0、Docker 26.12.1 均满足。[客户端官方文档](https://github.com/prometheus/client_js)、[Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/)。

## 环境与端口

环境标签只来自现有 `.env` 的 `APP_ENV`，不另设一份监控环境：`development → development`、`test → test`、`production → prod`。本地实际环境是 development；云测试机使用 `APP_ENV=test`。Docker 的 NODE_ENV=production 不作为监控环境来源。`service` 来自 `METRICS_SERVICE`（默认 huahuo-server），`role` 为运行角色，中心添加 `host` 和 `instance`。

| 角色 | Compose 宿主映射端口 | 路径 |
| --- | --- | --- |
| api-server | 9464 | /metrics |
| admin | 9465 | /metrics |
| worker | 9466 | /metrics |
| scheduler | 9467 | /metrics |

这些端口只提供指标。业务、Admin 和健康检查仍使用原应用端口；不在业务端口重复输出指标。四个容器内均监听 `0.0.0.0:9464`；宿主默认绑定 `127.0.0.1`。云测试机在自身 `.env` 设置：

```dotenv
APP_ENV=test
METRICS_ENABLED=true
METRICS_SERVICE=huahuo-server
METRICS_BIND_HOST=<本节点私网IP>
METRICS_API_HOST_PORT=9464
METRICS_ADMIN_HOST_PORT=9465
METRICS_WORKER_HOST_PORT=9466
METRICS_SCHEDULER_HOST_PORT=9467
```

按项目既有部署方式构建/更新四个角色后，从中心机请求 `http://<本节点私网IP>:9464/metrics`，另三个端口同理。私网安全组需允许中心机到这些端口。此处无需改 Nginx、域名或证书。

宿主直接运行时使用 `METRICS_HOST`（默认 127.0.0.1）和可选 `METRICS_PORT`；四角色默认依次使用 9464–9467。migrate 不启动指标服务。一个进程的 Registry 同时汇集 HTTP 和其全部任务消费者；增加 Worker 副本时必须为每个进程分配独立抓取地址并全部加入 targets，不能只抓负载均衡后的一个地址。

## 指标口径

- `http_requests_total{method,route,status}`：全局 onRequest 开始计时、onResponse 在响应真正结束后记录一次，status 为最终三位状态码，包括 schema 400、鉴权 401、未匹配 404 和异常 500。
- `http_request_duration_seconds{method,route}`：秒制 Histogram，覆盖完整响应时长；有限桶范围 5ms–3600s，并保留 +Inf。route 是 Fastify 匹配模板（如 `/api/v1/tasks/:taskId`）；未匹配为 `unmatched`。method 为有限 HTTP 方法集合，其他为 OTHER。
- `/metrics`、`/health/live`、`/health/ready` 排除统计；连接未完成的响应不当作完成。URL 参数、查询字符串、UUID、用户、任务和 trace ID 均不进入标签。
- `task_processing_attempts_total{kind,result}`：TaskEngine.finish/fail 的 PG 事务成功提交后才增加，result 仅 success/failure。显式失败且进入重试队列的本次尝试计 failure；后续尝试独立计数。重复完成、事务回滚、过期租约、延后继续和外部结果未知不计。kind 为固定已知任务类型，未知类型统一 other。
- `application_info`：值 1，可在尚无业务请求时确认每个角色的标签和存活抓取。每个进程的 Counter 在重启后重置，Grafana 使用 rate/increase。

客户端 Registry 生成正文与 Content-Type，不手写指标格式。指标监听失败会令角色启动失败；关闭角色时同时关闭指标监听。

## Grafana 查询

成功率沿用 2xx+3xx 占所有已完成响应的口径，不把全部 4xx 算成功。无流量时显示无数据，不伪造成功率：

```promql
100 * sum(rate(http_requests_total{service="huahuo-server",env="test",status=~"2..|3.."}[$__rate_interval]))
  / sum(rate(http_requests_total{service="huahuo-server",env="test"}[$__rate_interval]))
```

P95 的面板单位设 seconds，不能平均各实例的 P95：

```promql
histogram_quantile(0.95,
  sum by (le, method, route) (
    rate(http_request_duration_seconds_bucket{service="huahuo-server",env="test"}[$__rate_interval])
  )
)
```

## 中心 targets/apps.yml

可直接追加下列列表项。私网 IP 和节点主机名目前未提供，必须用测试机实际值替换；端口和 service 为项目默认配置。不需要 `__metrics_path__`，实际路径就是 `/metrics`：

```yaml
- targets:
    - "<测试节点私网IP>:9464"
    - "<测试节点私网IP>:9465"
    - "<测试节点私网IP>:9466"
    - "<测试节点私网IP>:9467"
  labels:
    env: "test"
    host: "<测试节点主机名>"
    service: "huahuo-server"
```

验证抓取四个 `application_info` 的 role 都存在；测试机 APP_ENV 改为 production 时，中心条目的 env 同步设 prod。验收结果见 [Prometheus 验收](../acceptance/prometheus.md)。
