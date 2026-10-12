# P06 标签化补充修订

正文/资源/不可变 revision 延续 P05/P06。有效 `note_tags` 是唯一标签关联事实；`note_relations` 仍用于来源引用，不混入图谱。没有向量服务或持久图谱副本。

## HTTP 接口

基础路径 `/api/v1/workspaces/:workspaceId/notes/:noteId`，Bearer 对应的工作区所有者才能访问。所有写请求带 `Idempotency-Key` 或兼容的 `X-Idempotency-Key`；标签改写额外带最新 `If-Match: <tagEtag>`，不可用 noteEtag 替代。

| 方法/相对路径 | 输入 | 语义 |
|---|---|---|
| GET `/tags` | 无 | 当前集合、tagEtag/version、人工状态、待应用建议、处理/提取状态 |
| POST `/tags` | `{name}` | 此篇增加一个标签，字面去重 |
| PUT `/tags` | `{tags:[{name}]}` | 此篇替换集合，空数组表示全部移除 |
| PATCH `/tags/:tagId` | `{name}` | 只改此篇；其他文章和旧全局标签不变 |
| DELETE `/tags/:tagId` | `{}` | 只解除映射 |
| POST `/tag-extractions` | `{}` | 显式重提取，活跃同版本任务复用，返回 taskId |
| POST `/tag-suggestions/:suggestionId/apply` | `{}` | 只有正文和标签版本仍匹配的建议才能显式应用 |

标签 1–24 Unicode 字符；NFKC/trim/小写去重，不做语义合并。人工最多 20 个（与 App 源码一致）；自动结果最多 5 个，允许 0 个。412 表示标签版本冲突，重读后由用户选择；幂等键重放返回原结果，同键不同请求 409。

图谱：`GET /api/v1/workspaces/:workspaceId/content-navigation/:map`，map=`overview|graph|tags` 是同一投影。可选 `tagId|noteId|cursor|maxNodes|maxEdges`，默认/最大 100 节点、200 边，素材页最多 50 篇。无标签素材也返回；共享标签边明确列 evidence。`totalNotes` 为当前授权查询的全量活跃素材数，主题 `count` 为全工作区活跃素材数（非 revision 数）；`hasMore/nextCursor/truncated/edgesTruncated` 明确局部截断。只有当前页素材之间按需算边，不生成全库两两关系。

标签修改/删除后的新读取直接查询 PG 一致性快照，HTTP `Cache-Control:no-store`；旧游标遇到 contentCursor 变化返回 409 GRAPH_CURSOR_STALE，客户端从首页重新获取。当前 App overview mapper 能解析 items，但尚未使用显式共同标签边，也未发送上述局部查询参数；数据层接线缺口已记录，不修改 UI 或伪造路径关联。

搜索仍只 keyword，hybrid 请求降级返回 keyword，semantic 明确不可用；返回 App 白名单字段，不泄露正文/SQL。按 tagIds、sourceKinds、时间、folderIds 和最新正文筛选。返回最多 30 条、单条 SQL 5 秒超时；现有 App search 不提供分页游标，本轮不虚报搜索全库分页或 10 万篇检索 SLA。

## 提取与原文件

创建/修改先提交正文与 Outbox，Worker 才提取。只有标签版本为 0 且未人工修改的首次提取可自动应用。已有有效集合或人工修改后的新提取为建议；旧集合版本、旧正文、删除/恢复生命周期及旧 attempt/lease 均不能覆盖。标签写入、任务结果和既有账本结算在同一事务，幂等完成不重复计数。

默认 `TAG_EXTRACTOR_PROVIDER=disabled`，可读材料任务失败为 TAG_PROVIDER_UNAVAILABLE；无正文任务完成 outcome=needs-readable-text，不调用 provider。获取文章/图谱/聊天不会触发提取。开发 fixture 显式开启，真实 LLM/Dify transport 在 P08 才接入；P08 必须结合现有调用意图/用量/未知消耗恢复机制，不能仅打开配置就付费调用。

分段协调输入身份/版本/标题/正文，最多 32 段、每段 16,000 UTF-16 单元，逐段输出严格校验后按频次稳定合并最多 5 标签。超预算/不合法结果拒绝整个结果，不写部分标签；分段临时内存处理，无向量切片表。

无法解析的文件先通过 P05 upload/complete 持久化，再用 `note-imports.resourceRefs` 引用，状态 needs-processing，正文为空且允许人工标签。单独不可读 contentBase64 没有持久引用返回 IMPORT_ORIGINAL_RESOURCE_REQUIRED，不能把丢弃文件说成导入成功。不会扩展 OCR、音视频语义理解。

## 已执行验证与边界

`node scripts/verify.mjs`：Node24 Docker typecheck/lint/build、18 unit、9 contract、67 real PG/Redis integration。100k 高频单标签测试在随机独立数据库，空正文元数据批量 fixture，2 页与 2 个聚焦查询加 EXPLAIN 合计 427ms；单页节点<=12/边<=8，全量计数 100000，移除后99999，游标失效。执行计划使用 notes_graph_page 和 note_tags_topic_members 索引；环境：本机 Colima aarch64，Docker VM 2 CPU / 2,054,778,880 bytes RAM，PostgreSQL 17.9、Redis 7.4.8、Node24 工具容器。这是本机容量样例，不代表生产全文/并发负载或任何 100k 内容都能固定延迟。其余测试涵盖 A/B/C、多共同标签、篇内重命名、人工/正文/删除/文件夹在提取中变化、重复完成、失效租约、provider 失败/非法结果、跨用户/同用户不同工作区、原文件下载保留、真实 HTTP 序列化。

构建 `huahuo-server:p06-tags`，同一 Compose 迁移 0008（保留 0001–0007、正文和数据卷），api-server/worker/admin/scheduler 独立运行，schema 8。下一阶段 P07；持续约束见 specs/backend-plan/13_知识图谱标签化补充要求.md。
