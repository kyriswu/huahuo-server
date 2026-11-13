# 独立内容导入

独立导入内容仍由 `text_ingestion_jobs` 保存完整正文、原始来源 URI、处理状态和当前任务。它不是 Note，不进入笔记混合集合；解析完成后统一走资料关键词模式，索引元数据在 `kb_document_keyword_builds/chunks`，正文分段在 `huahuo_kb_keyword_chunks`。

现有 `/api/v1/text-ingestions` 的创建、列表、详情、编辑和重试均使用用户 JWT。MANUAL_INPUT 保留原文空格/换行/Unicode，只有该来源允许修改原文；FILE_UPLOAD 的 UTF-8 文本/Markdown/CSV 继续本地解析，PDF/Office 在开启文档提取时走同一 Xberg/ECS/Redis 运行库，原文保存后进入现有关键词索引；关闭时明确失败。配置和恢复约定见[文档提取手册](document-extraction.md)。WEB_CRAWL、IMAGE_OCR、MEDIA_ASR、BOOK_OCR 尚未接通的适配器继续返回 `TEXT_SOURCE_ADAPTER_UNAVAILABLE`，不凭文件名伪造正文。

当前处理状态为 pending / parsing / chunking / success / failed，没有 Embedding 阶段。关键词链路不读取模型 tokenizer、不调用 Embedding 或 Rerank。来源输入上限沿用现有正文限制，超限失败，不截断。

编辑后固定新正文 hash 与原目标，旧修订立即不能召回。Worker 写完并校验租约后发布，新旧索引不双读，旧点通过对应构建的精确目标和点 ID 清理。解析正文和对象存储资产仍由业务管理，四张索引表均不重复保存正文。查询使用 `sourceType=text`，或由业务选择资料关键词入口；细节见 [知识库手册](milvus.md)。
