# Provider 与业务存储状态

唯一初始化基线`migrations/0001_initial_schema.sql`已应用至原阿里云 `huahuo` 库的新 `public` 并部署统一用户模型。旧 `public` 整体改名封存为 `initialization_backup`，58表4149行及OID/relfilenode/视图内容摘要一致，旧行零删除；四运行角色无归档Schema的USAGE/CREATE，不做兼容查询。没有新建数据库，数据库凭据、环境配置和JWT私钥未变。

## 基础设施与统一认证

| 能力 | 当前实现 | 验证与边界 |
| --- | --- | --- |
| PostgreSQL | 日常业务使用根`.env`的阿里云连接；隔离测试使用独立临时数据库 | 原库同库切换完成；新public版本1重放幂等、全库FK0；旧Schema封存，日常启动不重复初始化 |
| 关联模型 | 普通ID、主键/唯一/NOT NULL/CHECK与查询索引；无物理外键或模拟外键触发器 | 迁移提交前与重放后检查FK；业务事务校验归属，保留软删除语义 |
| 统一用户 | `users`保存资料与`active/suspended/deleted`状态；`user_identities`保存身份摘要与掩码 | 新public产品用户/会话均为0，未复制旧账号；仅active用户可进入业务，真实短信本轮未调用 |
| 客户端认证 | 短信`purpose=sign_in`；登录必填`clientType=app|web`与`clientId` | JWT身份来自`sub`，客户端实例字段不能覆盖用户身份，不保留旧参数别名 |
| JWT与会话 | Ed25519/EdDSA、JWKS、Server/Agent audience；`user_sessions`与`refresh_tokens`管理会话和轮转 | Server校验active用户、会话、撤销及业务权限；Agent本地验签，不持有签发私钥 |
| 协议接受 | `user_agreement_acceptances`记录版本、时间和接受入口 | 生产需配置协议与隐私版本；记录接受不等于法律文案已审核 |
| Service Key | 两个方向独立Key，通过`X-Huahuo-Service-Key`发送 | 内部用户接口要求JWT+Service Key；Service Key不能替代用户身份 |
| Redis / BullMQ | 本地Redis、Outbox、任务、租约和补偿；PG为状态事实来源 | 独立临时PG/Redis测试与业务部署分开记录；认证不因缓存故障降级放行 |
| SMS | 显式mock与`LiveSmsProvider`接口 | mock需`ALLOW_MOCK_PROVIDERS=true`，回显另需`SHOW_TEST_OTP=true`，生产禁止；真实短信transport未配置时拒绝调用 |
| Billing | 基线包含既有账务结构与开发政策，预留、账本和未知用量状态由业务事务管理 | active用户与任务/Run归属校验；默认disabled，开发政策不代表正式价格或真实支付接通 |
| Dify / ASR / Push / Payment | 未接入相应真实供应商流程 | 不把接口占位、已有上传或文件解析描述成这些能力已完成 |

## 对象存储与笔记业务

| 能力 | 当前实现 | 验证与边界 |
| --- | --- | --- |
| StoragePort | Local、S3-compatible、Aliyun OSS共用端口及全局`STORAGE_*`配置 | Local真实文件/Range/故障测试与各供应商真实网络验证分别记录；本次Schema清理不要求重新上传资产 |
| Aliyun OSS | 全局`AliyunOssStorageAdapter`支持流式上传、读取、删除、批量删除与签名URL | RAG直接复用，不新增解析器专用凭据；短期URL只在授权响应生成 |
| 上传与清理 | 临时上传/播放capability，校验MIME、大小、hash、时长；任务处理inspect/delete/expire | 完成上传不代表ASR、图片LLM或正文解析完成；任务和资源必须属于同一用户/Workspace |
| Note / Folder / Revision | 事务、ETag、tombstone、content cursor、完整raw修订 | 创建与raw编辑可自动触发Note索引；有文本的导入复用同一路径；外链目前只存来源信息，不抓取网页 |
| Note普通搜索 | PostgreSQL普通业务查询与全文/ILIKE能力 | 不属于RAG召回；不与Milvus候选执行本地RRF融合 |
| TagExtractor | 默认disabled；显式deterministic fixture仅用于开发测试；llm/dify transport未接通 | 失败、过期修订及人工标签fence不覆盖原文；没有正文时不调用Provider |
| 标签图谱 | 有效`note_tags`的有界实时投影、计数和共同标签证据 | 不建图谱正文副本、Neo4j或语义相似边；App显式edges消费需单独联调 |

## 文档处理与RAG

当前架构见[模块化文档处理](runbooks/modular-document-processing.md)和[Milvus手册](runbooks/milvus.md)。文件目标为`huahuo_chunks`，Note正文目标为`huahuo_manual_text`；它们是两类业务的Collection，不是迭代副本。现有代码配置名`manual-text`实际表示Note正文，人工输入或上游生成不再细分为不同Chunk类型。

| 能力 | 当前实现 | 验证与边界 |
| --- | --- | --- |
| 文档解析和资产 | 复用现有文件解析入口、图片/OCR绑定、原始Markdown与enriched Markdown | 生产不读layout；本地Fixture不冒充真实供应商调用；本次不改解析器 |
| 章节分析 | 同次生成TOC、临时章节和不重叠正文范围 | PDF保存完整Markdown及TOC；Note不生成TOC；最终Schema没有持久化章节Parent表 |
| 子Chunk | LangChain 1.0.2、模型本地tokenizer；默认500/800/64 tokens | 保留UTF-16 offset、Unicode、overlap及最终Embedding输入上限；数量由正文和配置决定 |
| 正文和Chunk | 文件`rag_ingestion_versions/rag_child_chunks`；Note`note_index_jobs/document_ingestion_chunks` | PG是正文/状态事实来源；parent_id分别指向整篇来源，普通关联键由业务校验 |
| 通用RAG入库 | `indexChunks()`与明确绑定的向量适配器；有界批次/并发/超时/重试 | 核心、薄Tool和业务编排分离，不查询数据库猜测元数据或目标 |
| Embedding | Qwen/Qwen3-Embedding-8B，4096维，OpenAI-compatible `/embeddings` | 历史公开样本真实验证不等于本次新文档已完成；本次SQL初始化不隐含模型调用 |
| Milvus | SDK2.6.17；Dense HNSW/COSINE、原生BM25、多语言Analyzer、Hybrid/RRF | 保持两个业务Collection及既有Schema，不因SQL模型切换重建或付费补向量 |
| RAG查询 | Milvus召回后执行PG归属/有效状态复核，读取真实正文，再走独立HTTP Rerank | 无PG RAG关键词召回或Node本地RRF；无章节Parent回溯；新模型发布后仍须PG归属复核，不能仅靠旧Milvus记录返回结果 |
| 修订、恢复与清理 | 来源/修订、模型/tokenizer/目标快照、稳定ID及任务lease fence | 缺快照明确失败；新索引成功前保留其有效前版，发布后定向清理；SQL与Milvus无跨库事务 |

## 验收状态

本地Fixture历史证据（2026-11-04）：238资产、235引用、3 orphan、1002条完整OCR记录，91个临时章节范围、0章节Parent和152个Child。它验证本地绑定、offset和真实模型tokenizer，不表示新public已完成真实文件RAG入库。

历史真实Milvus与公开向量验证证明过Dense/BM25/Hybrid、Analyzer、稳定写入和删除；这些证据不替代新public的新用户、新文档、新任务验收。原业务数据完整保留在封存Schema，但不复制到新public、不参与运行兼容查询；Milvus/OSS未清理，旧smoke不被当前业务查询返回。

本次typecheck、lint、build、229项unit/contract、115项独立PG/Redis integration和额外6项隔离Schema归档安全检查通过。原库真实切换、四角色healthy、API数据库目标/基线checksum/Redis/readiness200及EdDSA/Ed25519/server-current JWKS均通过；初始化和重放实际使用既有配置的`huahuo_admin`。管理员保留逻辑确认`retainedAdminAccounts=0`（原管理员表即为空）。本轮模型与短信调用均为0，未做真实文件RAG入库；Mock、真实本地依赖和供应商验证分开记录。
