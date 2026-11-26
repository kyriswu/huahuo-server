# 创作页外部链接导入

## HTTP 契约

客户端用现有鉴权和 `x-idempotency-key` 调用 `POST /api/v1/link-extractions`，请求体为 `{"url":"https://mp.weixin.qq.com/s/example"}`。接口同步返回标准 envelope。HTTP 200 表示链接资产已提交。客户端取 `data.title`、`platform`、`contentType`、`markdown`、`contentAssetId`，可用已有资产详情接口继续读取或编辑。图文的 contentType 为 article。

按完整 hostname 在本地识别平台。四个平台共用一个 JustOneApiAdapter；分享短链在适配器内交给供应商换取作品标识。仅 api-server 读取 JUSTONE_API_TOKEN，缺少令牌时返回 503。替换供应商时实现 LinkProvider，在应用组装时注入 LinkExtractor。设计与后续确认见[评审稿](https://r1mn4zjib7v.feishu.cn/docx/ZIL2dB2ICoSstVxv6CQcCCCCnMc)。

| 来源 | 当前行为 | 联调关注点 |
| --- | --- | --- |
| 小红书 | 用笔记详情 V1 提取正文和有序图片，视频进入媒体分支 | V6 仅面向视频下载。[V1](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v1) |
| 抖音 | 识别普通视频、图集及明确的私密、删除标记。未识别的作品类型返回访问状态待确认 | 免费公开回放需要真实样例核对其返回类型。[视频详情](https://docs.justoneapi.com/zh/api/douyin-tiktok-china/video-details-v2) |
| 哔哩哔哩 | 检查付费标记、稿件状态、分 P 总数和序号。按原序保留每个 cid | 详情中的 cid 是内容标识，各 P 的可用媒体地址仍需在转写服务接入时核实。[视频详情](https://docs.justoneapi.com/zh/api/bilibili/video-details-v2) |
| 微信公众号 | 解析 HTML 正文，原位置保留图片。混排文章以封面替换播放器，缺封面跳过。纯视频进入媒体分支 | 用实际图文和付费试读样例核实播放器属性与访问标志。[文章详情](https://docs.justoneapi.com/zh/api/wechat-official-accounts/article-details-v6) |
| 小宇宙、花火 | 预留独立图文适配器。识别后缺少实现时返回 LINK_SOURCE_UNAVAILABLE | 尚无样例。HUAHUO_SHARE_HOST 可指定实际分享主机。花火还需核对分享标识的有效性与分享范围 |

媒体接口预留音轨提取和转写两步。当前默认未接入，本应转写的媒体返回 503 LINK_ASR_UNAVAILABLE（暂不可转写）。明确付费返回 422 LINK_PAID_CONTENT（付费内容不可导入），限制访问、删除、信息不完整、上游故障分别返回 403、404、422、503。供应商普通 HTTP 错误不作为付费证据。供应商文档未统一定义试读、收费和回放标记，真实覆盖范围待验收。请求时限为 60 秒，超时返回 504。

## 图片、事务与重试

链接资产允许标准 Markdown 外部 HTTP(S) 图片 URL。外部图片和封面保留原位置与 URL。链接资产的创建、详情与后续编辑共用该规则；自有 OSS 和 Resource 引用继续校验归属。

同用户、同键和同 URL 重放成功结果（24 小时），同键不同 URL 返回 409。并发处理中返回 409 LINK_EXTRACTION_IN_PROGRESS，可用原键重试。短期占用和最终提交复用 api_idempotency，网络调用在事务外完成。提交前锁定并核验占用凭证，资产和加密回执在同一事务内提交。业务表及迁移无变更。

## 验收证据

- Node 26.11.0 下以模拟 HTTP 响应验证域名识别、分享链接、付费分类、转写不可用、混排封面及分 P 顺序。真实 JustOneAPI、转码和语音识别服务均待联调。
- 在临时 PostgreSQL / Redis 上运行资产与图片集成测试。HTTP 鉴权、成功响应与资产正文一致、其他用户不可读、失败不建资产、同键并发及历史结果重放均有覆盖。平台数据使用替身。
- 本机同级 App 目录缺失，标记 UNVERIFIED_APP。新接口与原有资产接口的外部图片行为尚未做移动端联调。

2026-11-25 复核。Node 26.11.0、pnpm 10.15.1，类型检查、Lint、构建及 Compose 配置校验通过。全仓单元与契约测试 1,158 项通过。完整隔离集成套件 462 项通过、7 项跳过。仓库原测试启动器首次等待 PostgreSQL 就绪超时，本次用同内容、带可执行权限的初始化脚本临时副本挂载后完成全套，临时容器已清理。

2026-11-25 已通过 Apifox CLI 同步「花火AI」主分支，并回读核对[链接导入接口](https://app.apifox.com/project/8965877/apis/api-541196538)的鉴权、幂等键、请求体、九种响应状态和三个响应示例。[创建资产](https://app.apifox.com/project/8965877/apis/api-539018651)与[更新资产](https://app.apifox.com/project/8965877/apis/api-539018661)的接口说明和 `parts.raw` 字段说明已回读确认，均记录了链接资产保留外部图片 URL 的行为。主分支未找到 `PUT /api/v1/content-assets/{contentAssetId}/parts/{part}` 的既有条目。
