# 内部 HTTP 入口与出站封装（2026-11-17，本地实现）

## 范围

内部注册收敛到src/http/internal-routes.ts；src/http/internal-api.ts拥有统一前缀、策略校验及Fastify中间件。RAG、gateway、解析回调仍在业务模块。策略漏配启动失败；隐藏公开OpenAPI并统一no-store；没有引入新认证凭据或历史地址兼容。

RAG公开/内部复用createRagQueryRoute的Schema/handler/timing，内部运行配置从route metadata接入，api-server不再按完整内部路径判断。可信用户身份头继续由入口/Agent传递，Service事务做真实会话与资源授权。gateway authorize在preHandler执行，保证非法query/JSON不会刷新或撤销会话；callback capability在onRequest检查，保证未授权请求不会先读取大体积正文。

解析回调迁为/internal/v1/document-parser/callbacks，prepare URL与requestTrace query识别、当前手册和测试同步。旧公开callback明确404。当前Agent到Server RAG路径不变；Server没有主动调用Agent的业务，不新增空壳AgentClient。完整约定见[内部服务协定](../runbooks/internal-services.md)。

出站embedding/rerank/解析/健康探针都通过ServiceHttpClient使用原生fetch连接池；通用层统一trace、取消、响应头+正文deadline、拒绝重定向、JSON字节上限与响应释放。业务客户端保留凭据、URL、状态校验、错误映射、embedding重试及attempt观测；解析提交unknown不自动重发。未新加依赖或pool、schema迁移和ENV键；SDK继续使用其自身连接管理。

## 验证

| 检查 | 结果 |
| --- | --- |
| 单元与契约 | 1168项通过；unit-contract.log |
| 隔离 PostgreSQL/Redis | 456项通过，4项Milvus相关跳过；integration-verified.log |
| 关键现有集成 | runtime-configuration含内部/公开RAG候选7→11与在途快照；document-extraction含新回调地址、trace延续与旧路径404；既有身份、注销、解析取消/恢复通过 |
| 静态与构建 | typecheck、lint、build、git diff --check通过；保留Admin既有大chunk提示 |
| 数据边界 | 测试临时库执行当前累计0003→0011并重复为空、四角色只读验收与物理外键0通过；本项未新增或执行共享迁移 |

日志在.local/internal-services/。首次集成448通过、6失败、4跳过：并行资源身份重构中的4项旧fixture/字段引用已经按当前模型更新，另2项会话连接/正文测试超时未靠放宽预算处理；独立重跑全部通过。没有为测试恢复旧字段、放宽业务授权或变更认证逻辑。首次失败记录保留在integration.log。

新增9项共享HTTP层loopback/显式替身测试、4项生产注册入口契约、5项内部策略与16项gateway测试；outbound既有和新增120项定向测试通过。边界包括真实loopback连接复用、响应正文超时、重定向凭据不转发、不自动重复POST、reader取消释放、严格RAG字段、可信头校验、策略漏配、非法请求无会话副作用。

本轮测试不调用真实模型、OSS或解析器；PG/Redis只用独立临时依赖，测试结果与真实云联调分别标识。既有资源身份重构等并行工作保留；其迁移不归本轮新增。

## 交接

只实现并验证Server仓库。App仅读入口与认证文件，未修改/构建；其他Agent仓库没有访问或修改，未做跨服务真实联调。callback路径变化需要实际交接时核对在途任务与外部解析网络入口，本轮没有部署或改宿主配置；不提供旧回调路径兜底。未提交、推送、重启服务或写共享数据库。

## 双向 Key 配置清理复核

按用户后续要求，从本仓库.env、.env.compose.local和specs/backend-plan/examples两份ENV示例移除双向废弃Key，各2项。生产src/config/Compose原已不读取，无需增加兼容或忽略逻辑。删除过时agent-jwt手册，修正当前接入说明；负向测试中的旧头样本继续证明它不能替代可信身份，未提供实际密钥配置。

42项相关配置/网关/内部策略/入口契约测试通过，Compose静态解析确认所有角色均未收到旧键，检查输出仅含键存在性不含值。当前请求共用同一RagQueryService与createRagQueryRoute；本轮未修改或声称清理其他Agent仓库，也未重启或发布。
