# OSS 原始 Content-Type 与 App 联调修复

日期：2026-11-17。

iOS 模拟器通过 App 通用上传库，真实测试服授权、直 OSS PUT、Server complete 均成功，文件为 65,536 字节。随后使用 Server playback 签名地址读取存在的对象，OSS 返回 HTTP 400 / `InvalidRequest`，消息为 `Can not override response header on content-type`。URI 原文未改变、没有 versionId，上传与读取均确认使用测试 Bucket。取消请求成功；第二轮诊断对象通过独立 OSS HEAD 返回 404 确认已清理。读取失败不能记录为完整联调成功。

原因与 [OSS 官方错误说明 0017-00000902](https://help.aliyun.com/zh/oss/user-guide/0017-00000902) 一致：签名 GET 不支持 `response-content-type`。对已删除对象的 GET 返回 404 不能验证存在对象时的响应头限制。

修复去掉签名读取的 Content-Type 覆盖，使用 OSS 对象本身的元信息。Server 写入文件时显式指定 MIME，App multipart 初始化原本已经写入 MIME。保留响应 disposition、encoding 与实际 OSS version 定位，不增加失败回退、代理文件流或兼容参数。业务响应仍返回 MIME，不改变公开 API 路径、JWT、用户所有权或资源认领机制。

发布基准通过测试机只读成功记录重新核对，为 `5af896d88eefb24c1173371276e9a9b55760f3f1`，四角色均健康。本期只更新 API Server 和 Worker，共享的 OSS 读写适配与文档提取路径在这两者中使用；Admin、Scheduler 不更新。数据库、任务载荷、配置、依赖版本、Compose 和宿主入口均无变化，无新增迁移或回填。配置复用成功快照，无需手动调整。数据库验收仅验证现有资源查找字段，通用门禁继续核对历史迁移与零物理外键。

已有对象不会重写元信息：读取使用其原始 Content-Type，资源 API 的 MIME 元信息继续提供给业务。不能把新写入行为当作对历史对象做过回填。升级期间旧签名可能仍返回 400，升级后应重新取得读取地址；新旧版本的资源/任务格式保持兼容。测试服自动健康冒烟与之后的 App 实际认证上传验收分别记录，不把健康通过当作业务通过。

本地验收：类型检查、Lint、构建通过；1166 项单元/契约测试通过；独立 PostgreSQL/Redis 集成测试 458 项通过、4 项 Milvus 用例跳过（本轮未启动 Milvus），包括升级演练及资源/文档提取契约。OSS 单元测试调用真实 SDK 构造签名和上传 HTTP 请求，但网络为替身，不等于真实 OSS 成功。App 68 项自动测试、静态检查通过。

保留失败事实：首次全量单元测试与会清理 dist 的构建同时运行，4 项读取 dist 的历史外部门禁用例因产物尚未生成失败；构建完成后顺序重跑 1166 项通过，未修改测试或放宽门禁。

实际目标发布与修复后的 iOS 完整联调尚待执行，不以本地结果代替。
