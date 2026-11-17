# KBIMAGE 统一存储与轻量读取（2026-11-17，待发布）

## 当前实现

- Note 的 create/update、part PUT、正文 import，以及 MANUAL_INPUT 文本 create/update，共用 `storage/image-content.ts`。先把普通 Markdown、引用式图片和 HTML img 解析为已授权的资源 UUID，再写成 `<KBIMAGE uuid="…" alt="…" />`，随后计算幂等摘要、正文哈希、版本和索引。新图片必须已经上传到 OSS 并归属于当前用户/工作区的 ready 图片资源；未知外链不下载、不代传，返回 `NOTE_IMAGE_UPLOAD_REQUIRED`。
- 已有 KBIMAGE 保留原属性、OCR/CDATA 和正文其他字节。外部解析契约本来就是 `kb-markdown-v1`：接收端校验真实图片必须为 KBIMAGE，校验回执和母资源/批次，不改写原始 JSON 或其中 content。PDF/Office/TXT/MD/CSV 仍只把 OSS URL 交给外部解析服务；本改动是正文图片标记处理，不是本地解析文件。
- `lib/markdown-images.ts` 只负责写入时接纳客户端图片格式；读取侧统一 `lib/kb-images.ts`，不构建 Markdown AST。无 KBIMAGE 的正文直接返回；代码示例、注释、原始 HTML 文本区域和 OCR 内部内容不当成新图片。扫描返回完整成对标签的 UTF-16 坐标，因此只命中图片 OCR 中段的分块也能关联图片。
- Note HTTP 只返回一个正文 `contentMarkdown`，手动文本 HTTP 只返回 `raw_content`，两者为可编辑的标准 Markdown，不额外返回第二份 Note `displayMarkdown/imageLinks`。一般图片为 `![alt](<url> "title")`；原生 HTML 表格及有尺寸属性的图片用标准 Markdown 支持的 HTML img。响应 `contentSha256` 对应实际返回正文；数据库规范哈希和 revision/ETag 保持稳定，不受签名刷新影响。
- 编辑链接附 `#kbimage=完整原KB节点的SHA256`。fragment 不发送给图片服务器、不参与 OSS 下载签名，只用于同一正文内恢复元数据；权限仍检查用户/工作区/ready 图片。按已配置 OSS Object Key 反查 UUID，不请求图片、不验证旧下载签名。因此过期链接仍能保存，下次读取签发新链接。OCR 不额外展开成可编辑正文，保存时从原节点恢复，避免重复、丢失或同 UUID 多页图片混淆。
- 保存先剔除临时签名并计算稳定请求摘要，再进入幂等事务、校验版本、按当前正文恢复指纹匹配的标签；仅修改 alt/title 等展示属性。原请求在修改后重试直接重放，不依赖已经变化的旧节点。没有指纹时，同 UUID 仅有一套服务端元信息才恢复；多套则明确拒绝歧义。陌生指纹拒绝，不静默丢 OCR。客户端保存成功后应采用响应的新正文/ETag；跨笔记复制带旧指纹不会自动继承原笔记元信息。
- 标准 Markdown 的签名链接比内部标签长。Note/手动文本写入使用局部 8 MiB 请求体、200万字符运输上限，恢复后的正文仍执行原业务限制（Note raw 50万、创建 outline/germination 20万；手动文本不超过配置及5万字符）。不放大全局 HTTP 限额。
- RAG 的机器证据契约保持 `content`、`evidence`、来源哈希和原文坐标。仅最终权限复核后的 topK 在请求 `assetMode=links` 时签发去重图片链接，完整落在分块内的标签可生成 RAG 专用 `displayMarkdown`；跨块标签通过 `images` 提供链接，不修造正文。RAG 预览 OCR 转义为文本，禁止从属性注入脚本；它不作为编辑往返字段。
- Note 当前引用与历史 revision pin 沿用已有实现；手动文本用已有 `resource_refs` 的 `text-image` 引用保护当前正文图片，编辑时同事务同步。文本预览按获取方式明确分派：手动正文读取授权资源，文件解析读取受限 manifest，没有相互兜底。
- 没有新增表、图片偏移缓存、环境变量、SQL 迁移或读取旧图片格式的兼容分支；没有修改 AGENTS.md。

后续 OSS 直读改动已删除本验收最初使用的 Server 图片代理；当前签名链接与往返测试见 [OSS 直读验收](oss-direct-access.md)。下方测试数量及 HMAC 记录是该次实现的历史证据。

## 验证与范围

最终回归与性能结果见下方验收表。测试使用临时 PG/Redis；模型、索引、解析和 OSS 操作使用明确替身，不冒充真实供应商验收。证据保存在 `.local/kbimage-unification/`。

| 检查 | 结果与证据 |
| --- | --- |
| 单元/契约 | 1049项通过，`unit-contract-verified.log`；包含41项scanner、5项标准Markdown输出、8项OCR恢复、12项输入格式测试 |
| 隔离 PostgreSQL/Redis | 368项通过、4项Milvus跳过，`integration-verified.log`；仅随机临时容器/凭据，不使用业务库/卷 |
| 关键往返 | Note 13项、手动文本8项：真实过期HMAC下载令牌GET返回401，携带该链接PATCH成功；无修改不新增revision/cursor/build；修改正文/alt并新增图片保留OCR/页码；同UUID多OCR重排、原key重放、过期ETag、资源隔离、长度扩张均覆盖 |
| 检索 | 跨OCR中段分块仍关联全KB节点；content/evidence/UTF-16范围一致；仅最终topK去重签发，检索不调用输入Markdown解析器 |
| 静态与产物 | typecheck/lint/build均退出0，见 `*-verified.log`；Admin UI既有大chunk提示保留，无新增构建错误 |
| 数据边界 | 业务Schema外键0、既有迁移重放/升级测试通过；本项无SQL迁移、无共享数据修改 |

首次集成暴露Note资源UUID校验漏组，修正后重测；后续一项旧测试将“超过规范正文上限”仍归为空正文错误，按新的运输/存储分层改为断言 `NOTE_CONTENT_TOO_LARGE`，最终通过。失败日志保留，不算成功证据。

性能对照由 `benchmark.mjs` 以 Node 26.11.0 执行：1 MiB ASCII 合成 Markdown，每种情况 3 个独立进程；导入模块、构造样本和运行前 GC 不计入扫描时间，扫描前后读取 RSS/heap。旧扫描器副本取本轮开始时 HEAD。RSS 差值不是峰值内存或泄漏，不能外推线上吞吐；查询仍需读取来源正文以验证哈希和分块真实性，本轮仅消除图片识别的全文 AST。

| 1 MiB合成样本，中位数 | 旧全文AST | 新KBIMAGE扫描 |
| --- | ---: | ---: |
| 无图片，扫描耗时 | 389.17 ms | 0.28 ms |
| 无图片，RSS前后差 | 420.81 MiB | 0.30 MiB |
| 末尾1个成对KBIMAGE，扫描耗时 | 392.09 ms | 14.17 ms |
| 末尾1个成对KBIMAGE，RSS前后差 | 417.28 MiB | 8.33 MiB |

完整样本/程序/原始数值见 `.local/kbimage-unification/performance.json` 和 `benchmark.mjs`。本次独立进程实验与原审查“同一进程按尺寸顺序运行”的366ms/193MiB不是同一采样条件，不混算比例。

## App 与存量边界

只读核对真实 `../huahuo-ai`，当前没有 KBIMAGE / contentMarkdown / displayMarkdown / imageLinks 的 HTTP 消费实现；法律说明 Markdown 和灵感图片 FileImage 不属于本链路。本轮只完成后端契约，未修改或构建 App。

未提交、部署、重启业务容器或读写共享数据库/OSS。本轮没有盘点既存正文，不能断言测试环境不存在旧 Markdown 图片。正式发布前如有旧格式的 Note revision、手动文本或解析产物，需显式转换、重新计算哈希/引用并重建受影响索引；不得靠读取兼容分支、应用启动重写或改动已执行迁移来处理。
