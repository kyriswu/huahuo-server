# 应用异常日志与 Dozzle

沿用 Docker 标准输出的 JSON 日志和已有 Dozzle，不新增组件、端口或服务。中心已有 [Grafana](https://grafana.chuda.cc/d/huahuo-server) 与 [Dozzle](https://dozzle.chuda.cc/) 入口；本轮未修改中心配置。

traceId：入口接受 X-Trace-Id，缺失或不合法时生成；一次请求后续调用沿用该值。任务在创建时写入非空 tasks.trace_id，Worker 重试/恢复读取原值。解析回调通过 callback_url 的 traceId 参数关联，仅在回调路径生效。这是不透明关联号，与 W3C trace_id 不混用。原有实现证据见 [验收](../acceptance/trace-id.md)；本次候选的标准父子链路与新增配置见 [观测契约](../observability/contract.md)。

1. 从 Grafana 5xx 表确认角色、路由和时间。
2. 在 Dozzle 对应角色容器中定位 `Request failed`，复制 `traceId` 搜索请求上下文。它与响应头 `X-Trace-Id`、错误正文 traceId 一致。
3. Server 异常读取 `err.type`、`err.message`、`err.code`、`err.stack` 和嵌套 `err.cause`，定位 `src/...ts:行:列`。记录统一包含 env、service（huahuo-server）、role（角色）、version、service_instance_id，以及 method、路由模板 route、statusCode 和 errorCode；在 span 中另有 trace_id/span_id。Agent 框架事件只保留受控元数据与安全异常位置，不展开任意框架消息。

公共 500 与 DomainError 的 5xx 记录一次，正常 4xx 不新增错误级日志。日志不记录请求路径参数、查询串、请求正文或认证头；客户端仍只收到既有通用提示及 traceId，不返回内部异常。关联字段不增加到 Prometheus 标签。

异常只保留诊断字段，不直接展开驱动的 SQL、参数、detail、请求/响应及配置对象。已配置凭据、URL 用户信息/查询值/fragment、Bearer/Basic、密码/密钥/Cookie、私钥、邮箱及手机号会被脱敏；消息中的 SQL/参数/payload 转储也会遮盖。原因链最多四层、聚合最多三个分支，诊断文本总预算约 32 KiB，循环引用和异常 getter 有保护。业务代码仍应避免把正文或完整供应商响应拼进 Error.message；字符串规则无法判断任意未知业务文本的敏感性，已丢弃的原因也无法由采集工具还原。

Server 构建生成 js.map 并内嵌源内容；Docker 复制完整 dist，服务端 map 不在 Admin 静态目录公开。四角色 Compose 命令、pnpm start:* 和镜像默认 API 命令使用 `--enable-source-maps`，不改写已有 NODE_OPTIONS。自定义入口同样保留参数，例如 `node --enable-source-maps dist/entrypoints/api-server.js`。仅生成 map 或静态依赖加载后才开启映射，不保证原有模块的 TypeScript 定位。

沿用 `LOG_LEVEL=info` 可查看请求接收和完成上下文；silent 会关闭日志。须部署含新代码、map 和启动参数的版本后生效，不能补回旧日志缺失的堆栈。验证范围见[验收](../acceptance/error-diagnostics.md)。
