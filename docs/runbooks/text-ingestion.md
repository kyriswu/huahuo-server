# 独立内容导入

独立导入记录由 `text_ingestion_jobs` 保存完整正文、来源 URI、处理状态和当前任务。`keyword` 索引的构建和分块元数据分别保存在 `kb_document_keyword_builds`、`kb_document_keyword_chunks`，索引目标为 `huahuo_kb_keyword_chunks`。创建可编辑资产使用资产写入入口。 [资产与搜索术语](../content-assets.md)

现有 `/api/v1/text-ingestions` 的创建、列表、详情、编辑和重试均使用用户 JWT。MANUAL_INPUT 保留原文空格/换行/Unicode，只有该来源允许修改原文；FILE_UPLOAD 读取已上传文件的 OSS 链接，TXT、Markdown、CSV、PDF 和 Office 走已配置的 Xberg 文档提取，保存原文后由 Worker 创建 `keyword` 索引。配置和恢复约定见[文档提取手册](document-extraction.md)。WEB_CRAWL、IMAGE_OCR、MEDIA_ASR、BOOK_OCR 尚未接通的适配器继续返回 `TEXT_SOURCE_ADAPTER_UNAVAILABLE`，不凭文件名伪造正文。

当前处理状态为 pending / parsing / chunking / success / failed，没有 Embedding 阶段。关键词链路不读取模型 tokenizer、不调用 Embedding 或 Rerank。来源输入上限沿用现有正文限制，超限失败，不截断。

编辑后固定新正文 hash 与原目标，旧修订立即不能召回。Worker 写完并校验租约后发布，新旧索引不双读，旧点通过对应构建的精确目标和点 ID 清理。解析正文和对象存储原文件由各自业务管理，四张索引表均不重复保存正文。查询统一使用 `sourceType=file` 或资料关键词入口，结果来源仍标记为 `text`；细节见 [知识库手册](milvus.md)。
