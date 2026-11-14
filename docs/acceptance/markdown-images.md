# Markdown 图片稳定引用与按需展示验收

2026-11-14。复用已存在的 Note／文件／FILE_UPLOAD 与查询入口，不推进 Pxx。用户已授权图片引用优化；JWT 获取按用户要求延期。用户后续确认套餐／存储额度的目录建议另见[资源与套餐方案](../runbooks/user-storage-layout.md)，本轮没有实施目录迁移或套餐配额。

## 实际变更

- Note create/update/part PUT/import 先解析实际图片节点，将 `asset://{resourceId}`、裸 UUID、已配置本应用的资源 object/playback URL、OSS Bucket＋前缀内的对象地址统一为稳定引用，再计算幂等请求摘要、正文 SHA256 和版本差异。UUID／Object Key 经 DB 中同用户、同工作区、ready 的图片资源记录验证，不能从任意 URL 文件名猜测 UUID。
- 标准 Markdown、引用式图片、HTML img、KBIMAGE 均读取源码位置；只替换图片目标。代码围栏、行内／缩进代码、注释、普通链接、CRLF、emoji、正文和 OCR 不被重新序列化。共享普通链接的图片定义仅展开相应图片用法。无上传的 data/file/本地路径拒绝；外部 HTTP(S) 图片原样保留，不抓取／导入外链。
- 正文自动形成 `inline-image` 当前引用，显式附件在 update 中也能正确增删。资源验证和删除复用资源行事务锁；正文删除图片时解除当前引用，历史 part revision 的 `note_revision` pin 保留，防止历史可读正文丢图。引用数不转换为存储份数，没有复制图片。
- 规范正文没有实际变化且标题／文件夹／引用也未改变时，不增加 Note／part revision、content cursor、标签或索引任务。只改变 raw 时才调度 raw 索引；未改的其他 part 保持原 ID。签名刷新不再造成假修改。
- 编辑／列表／历史 part 响应保留 `contentMarkdown` 和对应 `contentSha256`，增加 `displayMarkdown` 与 `imageLinks`。链接由独立、按用户和工作区限定的批量 DB 查询生成，有效期沿用 15 分钟；创建视图不读原图。视图生成在幂等写事务返回之后，临时链接不进持久 receipt；响应 no-store。
- 已有 `/api/v1/rag/query`、`/internal/v1/rag/query` 增加可选 `assetMode: ids | links`，默认 ids。权限／版本检查、候选召回、重排、最后复核、截取 topK 后，才从入选内容收集图片引用并去重。默认不签名或读取图片清单；links 模式一次提交所选引用集合，不再对每个候选签全文所有图片。
- 返回的 `content`、`evidence.child`、`sourceStart/sourceEnd` 始终对应规范正文；`images` 提供 UUID、alt、原文范围，links 模式增加可用 URL／expiresAt 和独立 displayMarkdown。重排没有图片二进制和临时展示链接。KBIMAGE 的 uuid 属性保持 UUID，链接在 images／imageLinks 中按 ID 查找；分片截断标记或引用定义不在分片内时也可用元数据定位。
- Note 图片通过现有受控 object URL 展示；文件入口只签选中的、当前版本的 owned `rag_document_assets` 回执；FILE_UPLOAD 只读取所选源的一份有界 manifest，核对冻结的母资源／解析批次及正文 hash，再签匹配图片。OSS 根前缀去除一次后交给适配器添加一次。不下载原图，不根据任意正文地址读取对象；预览不可用时保留稳定引用。

## 契约用法

```json
{
  "query": "合同里的交付要求",
  "sourceType": "file",
  "mode": "keyword",
  "topK": 5,
  "assetMode": "ids"
}
```

`ids` 适合 Agent 文本选材；需要预览时同一请求设 `links`。现有 Agent 服务 Key＋用户 JWT 校验保持。外部图不会被转换成自有资源，未配置／不可签的图片不返回伪造链接。

编辑客户端使用 displayMarkdown／imageLinks 显示，可提交展示稿让服务端重新归一化；差分基准、hash 和原文坐标使用 contentMarkdown。展示稿不是另一份权威正文。临时 URL 到期后重新读取授权接口，不把临时链接长期保存。

## 验证证据

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 通过；Admin Vite 保留已有大 chunk 提示，非构建失败 |
| `pnpm test` | 404 项 unit/contract 通过，其中 10 项新增 Markdown 图片解析用例；包含 50,000 字符原文、源范围、共享定义和代码／HTML 边界 |
| `node scripts/integration.mjs --milvus` | 178 项、14 文件通过；真实临时 PostgreSQL 17.9／Redis 7.4.8／Milvus 2.6.26，本轮新增 8 项图片生命周期／视图与 2 项最终查询图片验证 |
| DB／隔离 | 真实角色权限、CRUD／关联索引、资源 attach/delete 竞态与业务外键为 0 回归通过；独立随机 `huahuo_test_*` 库和 tmpfs 容器，不读取 `.env`，结束仅清理该轮资源 |
| 模型／解析／云 | Embedding／Rerank、解析 HTTP 和签名测试明确使用替身；真实 Milvus 验证 BM25／召回／版本过滤，不能推导为真实模型、内网解析或 OSS 通过；没有调用生产付费服务 |
| App | 同级 App 只读，相关三个文件前后 SHA256 一致；图像 Embed 仍为本地 FileImage，未找到新 Note／RAG 字段 HTTP 消费者，Flutter 端到端未验收 |
| 运行环境 | 源码及构建产物完成；本轮没有更新主 Compose 业务镜像、开发 RDS、Bucket 配置或现有对象，不能宣称线上／当前运行容器已采用优化 |

原始命令输出在 Server 忽略目录 `.local/markdown-images/`：unit-contract.log、integration.log、typecheck.log、lint.log、build.log、baseline.json、verification.json。首次集成有一处新增测试 fixture SQL 的 UUID/text 参数冲突，修正显式类型后完整复跑通过；不是跳过用例。未改唯一迁移，SHA256 仍为 `fd6bf4454370cb1d9926df6d7105b6923ea0b33fa14ca9df0bd8e3af39c96859`。

## 保留的边界

不搬迁已有对象，不批量重写存量历史正文；未统一现有上传／文档／解析产物的目录及容量台账。历史 pin 保留意味着正文移除图片不会立即释放容量；历史退役／回收站彻底删除需后续明确产品策略并实现。该策略未被暗中替换为固定期限清理。

普通资源 object_key 当前仍是 UUID 类型，未来目录化须联动调整定位字段和所有写入／过期回收路径。本轮只对现有稳定身份与展示链接解耦，不增加数据库表、迁移或物理外键，也不新增签名反查 SDK、CDN 猜测或旧协议旁路。
