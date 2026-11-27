# 创作页外部链接导入

## HTTP 契约

创作页用现有鉴权和 `X-Idempotency-Key` 调用 `POST /api/v1/link-extractions`，请求体为 `{"url":"https://mp.weixin.qq.com/s/example"}`。HTTP 202 的 `data.taskId` 标识已持久化的任务。无效 URL 或未支持域名在受理前返回 400。

`GET /api/v1/link-extractions/{taskId}` 使用同一账号的登录态。处理中返回 HTTP 200 和 `data.state`；成功后从 `data.result` 读取 title、platform、contentType、markdown、contentAssetId，失败后从 `data.error` 读取 code、userMessage、retryable。终态为 succeeded、failed 或 cancelled。其它用户、非链接任务或不可见的结果资产返回 404。创作页保存 taskId，断线后继续查询。

按完整 hostname 在本地识别平台。四个平台共用一个 JustOneApiAdapter；长链按路径提取作品 ID。对 xhslink.cn、xhslink.com、www.xhslink.com、v.douyin.com 和 b23.tv，Worker 请求一次完整短链，只读首个跳转响应的 Location。同平台长链含 ID 时直接请求详情；未返回可用跳转、首跳等待超过 4 秒或同平台中间页未含 ID 时，用原链接调用供应商分享解析。跨平台或未收录目标停止处理。仅 Worker 读取 JUSTONE_API_TOKEN，缺少令牌时任务记录 LINK_PROVIDER_UNAVAILABLE。替换供应商时实现 LinkProvider，在应用组装时注入 LinkExtractor。设计与后续确认见[评审稿](https://r1mn4zjib7v.feishu.cn/docx/ZIL2dB2ICoSstVxv6CQcCCCCnMc)。

| 来源 | 当前行为 | 联调关注点 |
| --- | --- | --- |
| 小红书 | 用笔记详情 V1 提取正文和有序图片，视频进入媒体分支 | V6 仅面向视频下载。[V1](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v1) |
| 抖音 | 识别普通视频、图集及明确的私密、删除标记。未识别的作品类型返回访问状态待确认 | 免费公开回放需要真实样例核对其返回类型。[视频详情](https://docs.justoneapi.com/zh/api/douyin-tiktok-china/video-details-v2) |
| 哔哩哔哩 | 检查付费标记、稿件状态、分 P 总数和序号。按原序保留每个 cid | 详情中的 cid 是内容标识，各 P 的可用媒体地址仍需在转写服务接入时核实。[视频详情](https://docs.justoneapi.com/zh/api/bilibili/video-details-v2) |
| 微信公众号 | 解析 HTML 正文，原位置保留图片。混排文章以封面替换播放器，缺封面跳过。纯视频进入媒体分支 | 用实际图文和付费试读样例核实播放器属性与访问标志。[文章详情](https://docs.justoneapi.com/zh/api/wechat-official-accounts/article-details-v6) |
| 小宇宙、花火 | 预留独立图文适配器。识别后缺少实现时返回 LINK_SOURCE_UNAVAILABLE | 尚无样例。HUAHUO_SHARE_HOST 可指定实际分享主机。花火还需核对分享标识的有效性与分享范围 |

媒体识别由 Worker 判断。转码服务暂无契约，需要转写的媒体任务结束为 failed，错误码 LINK_ASR_UNAVAILABLE，提示“暂不可转写”。公众号混排只取封面。付费、私密、已删除、访问状态不明分别映射为任务业务错误。单次解析限时 60 秒，可重试的上游故障使用已有任务退避策略。真实回放标记和媒体地址待联调。

## 图片、事务与重试

链接资产允许标准 Markdown 外部 HTTP(S) 图片 URL。外部图片和封面保留原位置与 URL。链接资产的创建、详情与后续编辑共用该规则；自有 OSS 和 Resource 引用继续校验归属。

24 小时内，同用户、同键、同 URL 重放原 taskId。不同 URL 返回 409 IDEMPOTENCY_CONFLICT。遇到有效的旧同步回执返回 409 LINK_LEGACY_RECEIPT，避免重复创建资产。提交事务记录任务输入、幂等回执、首个事件和投递记录。Worker 完成事务核对租约，在同一事务内创建资产、写入 content_jobs 的 import 关联并标记任务成功。输入放在 task_inputs；关联仅记录来源平台、内容类型和资产标识。再次查询返回资产当前标题及 raw 正文，保留原提取的平台和内容类型。删除资产后查询返回 404。

## 验收证据

2026-11-27 用 Worker 的真实首跳请求验证了三条分享短链：小红书取得 noteId `6b043504000000001f016668`，抖音取得 videoId `7703532570956352778`，B 站取得 bvid `BV1XJxf69Ed3`。测试在详情请求发出前截获参数；真实作品详情及视频转写仍待联调。

在含既有标签任务的隔离库从 0006 直接升级至 0007，核对了任务行保留、来源字段为空、快照表不存在、业务外键为零；重跑迁移时待执行数为零。

隔离 PostgreSQL / Redis 上用真实 API 与 Worker 数据库角色验证了迁移 0007、幂等并发、用户隔离、失败提示、唯一资产、编辑后的最新标题及正文及删除后的可见性。平台内容采用测试替身。既有 FunASR 用于录音和音频资产；真实平台视频到转写结果仍待联调。

只读核对了 App 的 `CDContentAssetRepository.importLink`。当前实现仍消费同步响应，需改为受理后查询；提交契约仅含 url，草稿附言由客户端处理。[飞书设计稿](https://r1mn4zjib7v.feishu.cn/docx/ZIL2dB2ICoSstVxv6CQcCCCCnMc)

Apifox「花火AI」主分支已回读核对两个接口的请求、响应和示例。[提交链接任务](https://app.apifox.com/project/8965877/apis/api-541196538) · [查询链接任务](https://app.apifox.com/project/8965877/apis/api-542251357)
