# OSS 直传直读收敛（2026-11-17，历史验收）

> 本记录保留当时普通 PUT／PG 上传会话方案的实现与测试证据，已被同日后续的[通用上传验收](generic-uploads.md)取代。下面的 1109／393 等测试数字只对应当时版本，不能作为当前 Redis 24 小时临时上传、单分片授权、业务认领、用户存储汇总字段或 0007／0008 迁移的通过证据。

当前方案由客户端直传 OSS，Server 只签发 part 1 上传能力并负责 Complete／Abort。上传阶段仅保留 Redis 临时回执；有效期最多一天，即首次申请起 24 小时，重试、续签和上传完成不延长，到期后不能业务认领。业务事务提交后立即尽力删除临时回执；未认领记录及清理所需元信息在安全清理前不会被 Redis TTL 抹掉。后续业务事务才写入正式 `resources` 和容量记录；Worker 定期先查统一资源表，已经认领的只清 Redis，未认领的才执行远端清理。没有新增复制、回调或扣费流程。本次 24 小时调整尚待复测，下面的历史验收不覆盖它。

临时上传不计用户空间，也不设置临时总量配额。后续业务认领按 `users.storage_used_bytes`、`storage_reserved_bytes` 检查正式容量，在同一业务事务中登记资源、引用和 confirmed 明细并增加 used，不逐次 SUM 明细。正式删除与现有独立 storage reserve／confirm／release 在各自事务中同步维护汇总；PG reserved 与临时上传无关。明细和索引保留给细分统计／对账，不新增统计表或后台对账任务。本记录的历史验证不覆盖这一增量，结果以新验收为准。

完整对象仍使用同一个 UUID Key，不能配置 OSS 24 小时自动删除；未完成分片生命周期需要部署时实际检查。Redis 灾难性丢失须用 OSS 清单对账，不能声称能够自动无损恢复。业务提交后的 Redis 清理失败只会留下临时回执，不重复计算空间；到期清理先查 `resources`，已登记资源只清 Redis。旧签名与在途 PUT 的停止不能仅由数据库 guard 证明。完整契约与运维边界以[当前手册](../runbooks/user-storage-layout.md)和新验收为准。

## 当时行为（已被后续上传协议替代）

- 客户端向 OSS 上传文件，Server 只签发绑定大小、Content-Type、禁止覆盖的 PUT 地址。完成接口执行一次 HEAD，确认对象存在、字节数、声明的 Content-Type 和 ETag/版本；成功重试直接复用完成记录，不重复 HEAD。并发完成可能各执行 HEAD，但不下载正文。
- 不再接受上传 SHA-256 参数，也不把 OSS ETag 当成文件 SHA-256。新资源 `sha256=null`，音视频 `durationSeconds` 明确是客户端声明；Server 不嗅探文件格式、不解析时长、不进行全文件摘要校验。
- 资源播放、图片预览和原文件下载统一返回 15 分钟 OSS GET 签名 URL；Server 先按用户、工作区、ready 状态与 bucket 授权，不读取文件。客户端直接向 OSS 读取；删除 Server `/media/resources/:resourceId/object` 代理、播放令牌和后台 `storage.inspect` 生产/执行代码，没有代理回退或旧 URL 兼容。
- RAG extraction/assets 下载接口返回 JSON Envelope 的签名链接。压缩提取产物返回 `mimeType: application/json, contentEncoding: gzip`，签入对应 OSS 响应头；支持 HTTP 内容编码的客户端自动解码，不是 Server 解压转发。章节接口仍返回业务 Markdown，内部按区段读取规范正文。
- Note/手动文本继续只返回一个标准 Markdown 正文字段。输入按已配置 OSS 的 bucket、endpoint 和 Object Key 查归属资源；签名有效期不参与 UUID 识别，过期 URL 仍能保存。原节点 fragment 保留 OCR/属性定位。未知外链、旧 Server 图片代理 URL、越权或其他工作区资源明确拒绝。
- 服务端必要读取仍包括：外部解析后保存的规范 Markdown（索引/检索/恢复）、章节 Range、受限图片 manifest。自产解析产物保留流式 SHA-256 完整性校验；这不读取客户端原始 PDF/Office/音视频，也不调用本地内容解析器。

## 当时配置与迁移

- 本地 `.env` 的 `STORAGE_DRIVER` 改为 `aliyun-oss`，保留现有 endpoint/bucket/RAM 凭据；未输出秘密、未重建凭据、未启动服务。
- 当前候选配置清单声明 `STORAGE_DRIVER=aliyun-oss`，附本地断言脚本，只检查角色实际 ENV，不联网；目标候选配置未生成/应用。
- 新增可选 `STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT`，由 api-server/worker 接收。默认与 `STORAGE_ALIYUN_OSS_ENDPOINT` 相同；Server 使用标准 OSS internal endpoint 时必须配置公网签名 endpoint，禁止把 internal 地址签发给客户端。
- 新增 `0006_oss_direct_access.sql`：允许新资源没有实测 hash；把 inspection_pending 更新为 metadata_confirmed；取消已移除的非终态检查任务、收尾其 attempt/outbox 并记录任务事件。保留历史实测 hash 和已终态审计记录，不保留运行时代码兼容路径。
- 已执行的历史迁移未改。本轮只准备 SQL/只读验收清单和隔离演练；没有执行共享数据库迁移。真正应用前仍需核对目标检查任务规模和排空旧 Worker，不能混跑旧 inspect 执行器；本地结果不冒充环境升级成功。
- 其他会话已有工作保留，未提交、推送、触发发布或重启业务角色。

## 当时验证（不代表新上传方案已通过）

| 检查 | 结果 |
| --- | --- |
| 单元/契约 | 1109项通过，`.local/oss-direct-access/unit-contract-verified.log` |
| 隔离 PostgreSQL/Redis | 393项通过，4项Milvus相关跳过；`integration-final.log` |
| 增量迁移演练 | 独立临时库从基线0003执行0004/0005/0006，重复执行无新增；四运行角色只读验收通过；新增5项0006状态/回滚用例通过 |
| 上传与权限 | 17项storage、15项Note图片、8项手动文本；元信息确认不读正文、成功重放不再HEAD、并发失败不覆盖已完成、配额/到期/删除租约、bucket/driver/归属、过期URL往返与OCR恢复通过 |
| 文档下载 | 真实OSS SDK离线签名；gzip响应头、对象版本、错/缺版本拒绝、图片bucket/prefix与下载权限覆盖；原文件/图片下载不调用read |
| 静态/构建 | typecheck、lint、build与git diff --check通过；构建保留已有Admin大chunk提示 |
| 本地配置 | Compose静态展开后核对api-server/worker实际ENV，OSS配置断言通过；输出不含凭据；仅存在性/结构校验，不声称云凭据已联网验证 |
| 边界 | 业务Schema无物理外键；本次临时容器与临时凭据已清理，无业务数据卷删除 |

首次完整单测与build并行导致4项依赖dist的旧门禁测试找不到正在重建的文件；构建结束后按依赖顺序重测全部通过。首次数据库预演发现验收SQL直接查询Scheduler无权访问的resources表，已改为公共catalog的列/已验证约束检查，没有新增业务读权限。之后3项检索fixture仍声明local资源，按当前OSS契约修正样本后全量通过；失败日志原样保留，均不计作成功证据。

测试仅使用随机临时 PostgreSQL/Redis、真实 OSS SDK 的离线签名和显式对象替身；不访问真实 OSS/模型/外部解析服务。未做真实OSS联调或线上吞吐压测。

## 当时 App 参照

只读检索 `../huahuo-ai/lib`：未发现 upload-token、media/uploads、media/resources、extractionUrl/downloadUrl、KBIMAGE/contentMarkdown 的当前 HTTP 消费实现。未修改 App 或执行 Flutter 命令，不宣称移动端已联调。
