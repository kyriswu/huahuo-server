# 脱敏异常诊断验收 · 2026-11-15

修复公共 500 只记录 INTERNAL_ERROR、序列化器清空 stack 的问题。沿用 Fastify/Pino、Docker 日志和 Dozzle，无新增依赖或日志组件。

## 改动

- `src/lib/error-log.ts` 提供受限序列化，保留类型/原因/堆栈/code/cause 与有限聚合，遮盖凭据、URL 签名、认证、私钥、联系方式及 SQL/payload 转储，不展开驱动和请求/响应对象。
- `src/apps/base.ts` 共用处理器记录 500 和 DomainError 5xx，携带现有 traceId、角色/实例、路由模板、方法和状态；客户端 envelope 不变。可选 loggerStream 用于验证真实 logger，无新增 ENV。
- `src/lib/domain-error.ts` 兼容现有 commit 参数并追加 ErrorOptions；RAG 查询、短信、上传包装保留 cause，不改变事务、重试或外部调用行为。
- `tsconfig.build.json` 生成 sourceMap/inlineSources；Compose 四角色、package start 脚本和镜像默认 API 命令在启动时启用映射，不替换 NODE_OPTIONS，不改端口/监听/存储。Compose 其余在途改动不归本轮。
- 现有发布 plan 更新无数据变化说明和构建配置审查范围，保留原基准、服务、配置复用及迁移清单。

## 证据

| 检查 | 结果 |
| --- | --- |
| 脱敏/异常链及四角色真实 HTTP 日志专项 | 12 项通过 |
| 全量 unit/contract | 50 文件、679 项通过 |
| 真实隔离 PG/Redis integration | 21 文件、274 项通过、1 项 Milvus 跳过 |
| Typecheck / Lint / Build | exit 0；保留已有 Vite 体积提示 |
| 编译产物定位 | Node 26.11.0 和 Docker Node 26.12.1 均映射至 src/config/metrics.ts:行:列 |
| 启动配置 | Compose 实际渲染的四角色命令与宿主 start 脚本都有 --enable-source-maps；migrate 未变 |

专项实际运行 loopback Fastify 与 JSON logger，不连接业务数据库：每个角色 500 只记一次，traceId 与 HTTP 响应相同，类型/消息/stack/cause/code 和路由状态完整；503 保留 DomainError/cause，400/404 不新增错误级日志。认证、Cookie、query、路径参数、配置密钥及驱动私有行数据未进入捕获日志，客户端无内部原因或 stack。另测循环、大小/深度、聚合、异常 getter、非 Error、PEM/转义凭据及 SQL 转储。这些是有意构造的错误输入，不表示真实供应商故障已在生产复现。

编译验证使用实际 dist；额外 Node26.12 容器仅只读挂载 dist、关闭网络、自动移除，物理 TS 文件未挂载。Compose 只渲染检查，不应用配置。集成运行器仅使用其自有临时 PG/Redis，包含基准升级、普通业务、零物理外键与关系索引验证；未写开发 RDS、调用短信/模型/解析器或云机启停。

初次检查发现 URL 脱敏后的用户名被邮箱规则误匹配、SQL 标签误匹配 postgresql、运行时开启 source maps 不能映射已加载依赖。失败保留，最终修正为去掉 URL 用户信息、限定标签边界和启动时启用映射，没有放宽脱敏断言。

原始记录在 `.local/error-diagnostics/`：四角色 jsonl/500-response、focused 日志、`unit-contract-verified.log`、`integration-verified.log`、类型/Lint/构建 verified 日志、`compiled-source-map.json`、`compose-source-maps.json`、`baseline.json` 与 `verification.json`。实际 ENV、冻结 0001 及只读 App 参照哈希与开始时一致。

按仓库 huahuo-release 规范核对了日志/构建/启动影响。无新 SQL、数据或 API/任务格式变化；工作区还有其他在途修改，本轮未提交，也未运行要求干净候选提交的 release:check。未执行线上发布，正式发布仍核对目标实际成功 SHA 与累计候选。新日志随新版本部署生效，未宣称线上已修复，不推进 Pxx。操作见[应用日志](../runbooks/application-logs.md)。
