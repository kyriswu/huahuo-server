# 用户资源目录与套餐存储额度方案

2026-11-14。用户已明确“升级、扩容、缩容”指用户套餐／存储额度调整。本文件是结合当前源码的建议，**目录迁移、套餐配额和统一资源回收尚未实施**；没有移动或删除现有 OSS 对象，没有改 Bucket、凭据、基线或开发库。

## 项目现状

| 内容 | 当前实现 | 对套餐容量的影响 |
| --- | --- | --- |
| 普通图片、音频和文件上传 | `StorageService` 生成 resource UUID，`resources.object_key` 是 UUID 类型；适配器叠加配置的 Key Prefix，没有文件后缀 | 上传受理时按用户汇总 `storage_reservations` 的 reserved/confirmed requested_bytes，与全局 `STORAGE_QUOTA_BYTES` 比较 |
| 用户头像 | 复用普通资源，以 `resource_refs.ref_kind=avatar` 关联用户 | 不应另存一份或重复计量 |
| Note 正文图片／导入附件 | 正文在 PG revision 表；图片稳定引用资源 UUID，当前关联和历史 revision pin 分开 | 正文移除引用不等于原文件可删；历史仍可读则仍保留文件 |
| 文件入口的原始文档 | 能复用自有上传资源；其他来源可保存到 `rag/{versionId}/source/...` | 尚未统一接入普通上传的容量受理入口 |
| 结构化解析产物 | `extractions/{sourceResourceId}/{parseRunId}/{hash}.md`、`.json.gz`、`.assets.json`；图片实际位置来自解析上传回执 | 文件入口资产在 `rag_document_assets`，FILE_UPLOAD 在提取清单；尚无覆盖所有产物的用户容量台账 |
| 套餐 | `account_memberships` 和现有权益／积分策略 | 尚未提供按套餐解析存储上限的唯一策略入口；Billing 的存储预留方法也未执行统一容量检查 |
| 清理 | 普通资源删除由 Worker 检查引用后执行、成功后释放额度；文档 cleanup 目前主要退役检索索引 | 文档 cleanup_status=ready 不能解释为 OSS 物理清理完成 |

依据：[上传与读取](../../src/modules/storage/service.ts)、[头像](../../src/modules/workspaces/service.ts)、[删除 Worker](../../src/modules/storage/jobs.ts)、[文件处理](../../src/modules/rag/jobs.ts)、[解析产物](../../src/modules/ingestion/document-extraction.ts)、[FILE_UPLOAD](../../src/modules/text-ingestion/jobs.ts)、[套餐](../../src/modules/billing/service.ts)。

## 建议的 Object Key

正式用户内容统一按用户归属组织，下面按工作区、资源以及解析批次分层。示例省略当前配置的环境 Key Prefix；环境优先由部署配置／私有 Bucket 隔离，沿用已有配置，不再在业务代码硬编码第二层环境前缀。

```text
users/{userId}/
  profile/{resourceId}/original.webp
  workspaces/{workspaceId}/resources/{resourceId}/
    original.pdf
    derived/{parseRunId}/
      canonical.md
      structure.json.gz
      assets.json
      images/{imageResourceId}.png
      previews/{previewResourceId}.webp

tmp/users/{userId}/uploads/{uploadId}/...
tmp/users/{userId}/jobs/{taskId}/...
```

- `profile` 放账号级头像等内容；业务文件／录音／正文图片放 workspace 下的 resources。图片、音频、PDF 使用同一资源模型，按用途和 MIME 查询，不再按 `.jpg`／`.pdf` 创建一套平行目录。
- 原文件 immutable；替换内容生成新 resourceId，重新解析生成新 parseRunId。缩略图可按尺寸／算法版本再分层。正文不写目录、Bucket、套餐等级或临时签名，统一通过资源 UUID 定位。
- `resourceId` 表示业务身份，`objectKey` 表示实际位置，两者分开存。图片回执 UUID 还须绑定母资源和解析批次，防止错清另一批结果。目录本身不提供授权，读取和删除仍校验用户、工作区和引用。
- 后缀按服务端校验后的 MIME 固定映射，例如 JPEG→`.jpg`、PNG→`.png`、WebP→`.webp`、PDF→`.pdf`、MP3→`.mp3`、M4A→`.m4a`、Markdown→`.md`；压缩 JSON 用 `.json.gz`。保留原格式；转换格式必须另建衍生产物，不能只改后缀。原始文件名保存在 DB 供显示／下载，不进入 Key。
- 临时文件独立放 `tmp/`，方便配置一致的过期规则；每个对象依然记录用户和任务。用户彻底删除需覆盖 `users/{id}/` 与 `tmp/users/{id}/` 的资源清单。
- 不把用户套餐、手机号、昵称、容量档位写进 Key，也不每个用户新建 Bucket。后续升级／降级无需搬文件。

上述路径采用常规 OSS Object Key 前缀，上传即可形成控制台目录，无需提前创建空文件夹。参见 [OSS 目录文档](https://www.alibabacloud.com/help/en/oss/user-guide/manage-directories)。

## 容量与套餐规则

建议由同一个配额入口覆盖上传、解析、缩略图、转写等持久化写入，复用现有 reservations／Task／Outbox；收敛当前分散入口，不新增一条旁路。

```text
effectiveLimit = 当前生效套餐额度 + 生效的额外存储包
availableBytes = max(0, effectiveLimit - usedBytes - reservedBytes)
允许新增 = usedBytes + reservedBytes + 本次预留 <= effectiveLimit
```

`usedBytes` 按用户保留的物理对象及版本的实际字节数汇总，`reservedBytes` 是有效在途预留，分别展示。一个对象被多篇 Note／历史 revision 引用仍只算一次；同用户原文件和解析图片是不同对象则分别计入。保留的回收站／历史内容仍占用；可重建缓存和短期中间文件进入系统临时预算，不假装没有云存储成本。

解析前预留输出预算；输出超预算时追加同一受控预留或停止并清理本次未发布产物，不能先无限写 OSS 再统计。确认时将预留转换为实际字节，失败／过期释放预留；仅在对象删除确认后减少实际用量。请求级预留、对象计量和清理均须有唯一键，Worker 重试不重复扣减。

套餐切换与新增预留使用同一用户事务锁，避免并发上传绕过额度。套餐升级立即增加可用额度；降级后若超额，保留读取、下载、删除及不增加存储的编辑，阻止新的容量占用，向用户显示超出多少及可清理内容。降级前已受理的有效预留按既定规则收尾，不以降级为由删除在途数据。套餐到期走同一规则；不因到期或缩容自动清空资料。

套餐容量、加购方式、历史／回收站保留期、超额宽限期尚待产品决定，本轮不编造数值，也不创建自动删除策略。数据库统计是准实时依据，OSS Inventory／受控扫描用于对账，不能每次上传都列举整个用户目录。

## 清理与回收

1. 用户执行删除／历史版本退役，Service 在事务中解除相应引用，记录审计及 Outbox。软删除和“仅移出正文”不算彻底删除。
2. Worker 在资源锁和有效 Task lease 下复核所有引用：头像、正文、历史 revision、文档来源和衍生产物。仍有引用就保留，不能仅看一份 Note 的 diff。
3. 对无引用且满足已明确保留策略的资源生成明确对象／版本清单，幂等删除；远端失败保留重试状态，不能先标已回收容量。开启 OSS 版本控制时还要核对旧版本，不能把 delete marker 当作全部字节已释放。
4. 解析产物按母资源＋parseRunId 管理，保留正在使用的批次；过期上传、中断任务和无主产物按受控规则回收。OSS 生命周期只用于已定义的临时／可退役类别，不对整个用户目录设置固定天数删除。
5. 用户注销先阻断新的写入与任务发布，再按所有权清单处理文件、衍生图片、正文、索引和临时产物；正常套餐降级不走注销流程。

OSS 生命周期按前缀／标签筛选，也能处理未完成分片；不支持 `users/*/tmp/` 这种通配路径或按文件后缀筛选。因此临时文件采用统一 `tmp/` 前缀，持久原文不套临时规则。见 [生命周期说明](https://www.alibabacloud.com/help/en/oss/user-guide/overview-54/)。

## 后续实施顺序

先统一资源定位与产物台账，再把所有写入接到同一额度策略，最后补历史／回收站彻底删除和产物清理闭环。当前 Note 软删除仍保留历史，无完整历史退役产品入口；不能承诺“删掉正文图立即释放空间”。

新 Key 需要将当前 `resources.object_key` 从 UUID 定位器调整为文本，并联动上传会话、过期回收、读取、OSS 前缀只加一次及外部解析上传配置；并非只改拼字符串。遵守唯一初始基线、零物理外键与事务内关联校验规则；本轮未作该变更。

目录切换前列出真实对象、DB 定位和占用对账，明确现有环境的数据处理方案。历史对象搬迁、复制／校验／删除或清库不包含在本方案实施授权中。本轮完成的是[图片 UUID 与展示链接分离](../acceptance/markdown-images.md)，后续目录改变不应要求重写正文 UUID。
