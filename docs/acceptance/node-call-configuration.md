# 配置分组与直接节点调用（2026-11-17，本地实现）

## 行为

按用户要求删除 `PROCESSING_NODES_ENABLED`，不保留恒 true 字段、旧键读取或另一套准入开关。登记并配置好的节点直接参与任务分配；没有匹配节点时返回 `PROCESSING_NODE_UNAVAILABLE`。有节点但网络不通时，实际健康观察显示 `serviceStatus: unreachable`，任务仍遵守既有启动/调用期限、取消和未知结果查证规则，不自动重复提交已可能发生的外部请求。

清理覆盖 ProcessingNodesConfig、RAG/FileUpload 入库入口、parser snapshot、节点分配与执行、CLI 状态、Admin bootstrap/list/capabilities、UI 和测试。入库继续按现有异步任务机制创建意图，节点选择时判定可用节点；没有新增本地解析或云服务回退。Admin 试用按已登记文档节点提供入口，执行时探测实际可达性。

云端启停仍有其既有独立权限；移除调用开关不绕过其显式 false、RAM 凭据、管理员/CSRF、实例锁和租约。开发环境默认云控制只依据完整 RAM 凭据，测试/生产既有默认规则保留，不再读取已删除的解析开关。

## 配置整理

实际 `.env`、`.env.compose.local`、`.env.gpu-spot` 及七份根级/规格 ENV 示例按运行、HTTP、DB、Redis、认证、RAM、对象存储、模型、节点、指标等分组，删除过时 tokenizer、双向鉴权空标题、历史验收叙述和重复注释。GPU Spot 独立 CLI 配置仍有效，保留短分组。

纯整理阶段以 Node parseEnv 对比逐键值和原始赋值行；实际两份 Compose 展开结果相同。随后移除用户明确授权删除的节点调用开关，逐文件比较其余值不变，Compose 仅少旧环境变量。未输出秘密、重建凭据或改变其他配置值。当前发布清单只记录废弃键 remove/required:false；未执行环境更新。

## 验证

| 检查 | 结果 |
| --- | --- |
| 单元/契约 | 1163项通过，unit-contract.log；删除原仅重复验证部署开关false的旧用例，改为空节点/实际调用边界测试 |
| 隔离 PostgreSQL/Redis | 458项通过，4项Milvus相关跳过，integration.log |
| 关键行为 | 无匹配节点503；文件意图正常创建；实例启动不依赖私网API；状态SSE显示unreachable；观察不额外开停实例；独立云控制拒绝仍生效 |
| 类型/Lint/构建 | 全部退出0；既有Admin大chunk提示保留，git diff --check通过 |
| 配置 | 逐键与原始赋值行对比通过；实际Compose变化仅删除已退役开关，其他值不变；全部运行ENV、模板和四角色注入无旧开关 |
| 数据 | 独立临时库累计0003→0011及四角色验收、零物理外键通过；本项无新迁移，测试临时容器和凭据已清理 |

日志保存在 `.local/node-call-configuration/`。测试使用独立临时 PostgreSQL/Redis、回环假解析服务、显式 ECS/HTTP 替身，没有真实云或私网请求。

定向测试覆盖空节点不执行 parser、合法文件意图不再被部署开关拒绝、实例启动不依赖私网 API 可达、SSE 实测不可达状态以及云启停权限独立。旧 per-node JSON 的持久化字段及已执行 SQL 不属于本次部署开关，不重写历史迁移。

本轮不写共享数据库、不启动节点、调用真实解析服务、提交或发布；App 和 Agent 项目未修改。其他并行资源重构保留，累计迁移和全仓验证不归本项新增表或数据改动。
