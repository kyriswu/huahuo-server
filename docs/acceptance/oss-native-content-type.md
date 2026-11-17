# OSS 原始 Content-Type 与 App 联调修复

日期：2026-11-17。

iOS 模拟器通过 App 通用上传库，真实测试服授权、直 OSS PUT、Server complete 均成功，文件为 65,536 字节。随后使用 Server playback 签名地址读取存在的对象，OSS 返回 HTTP 400 / `InvalidRequest`，消息为 `Can not override response header on content-type`。URI 原文未改变、没有 versionId，上传与读取均确认使用测试 Bucket。取消请求成功；第二轮诊断对象通过独立 OSS HEAD 返回 404 确认已清理。读取失败不能记录为完整联调成功。

原因与 [OSS 官方错误说明 0017-00000902](https://help.aliyun.com/zh/oss/user-guide/0017-00000902) 一致：签名 GET 不支持 `response-content-type`。对已删除对象的 GET 返回 404 不能验证存在对象时的响应头限制。

修复去掉签名读取的 Content-Type 覆盖，使用 OSS 对象本身的元信息。Server 写入文件时显式指定 MIME，App multipart 初始化原本已经写入 MIME。保留响应 disposition、encoding 与实际 OSS version 定位，不增加失败回退、代理文件流或兼容参数。业务响应仍返回 MIME，不改变公开 API 路径、JWT、用户所有权或资源认领机制。

发布基准通过测试机只读成功记录重新核对，为 `5af896d88eefb24c1173371276e9a9b55760f3f1`，四角色均健康。本期只更新 API Server 和 Worker，共享的 OSS 读写适配与文档提取路径在这两者中使用；Admin、Scheduler 不更新。数据库、任务载荷、配置、依赖版本、Compose 和宿主入口均无变化，无新增迁移或回填。配置复用成功快照，无需手动调整。数据库验收仅验证现有资源查找字段，通用门禁继续核对历史迁移与零物理外键。

已有对象不会重写元信息：读取使用其原始 Content-Type，资源 API 的 MIME 元信息继续提供给业务。不能把新写入行为当作对历史对象做过回填。升级期间旧签名可能仍返回 400，升级后应重新取得读取地址；新旧版本的资源/任务格式保持兼容。测试服自动健康冒烟与之后的 App 实际认证上传验收分别记录，不把健康通过当作业务通过。

本地验收：类型检查、Lint、构建通过；1166 项单元/契约测试通过；独立 PostgreSQL/Redis 集成测试 458 项通过、4 项 Milvus 用例跳过（本轮未启动 Milvus），包括升级演练及资源/文档提取契约。OSS 单元测试调用真实 SDK 构造签名和上传 HTTP 请求，但网络为替身，不等于真实 OSS 成功。App 68 项自动测试、静态检查通过。

保留失败事实：首次全量单元测试与会清理 dist 的构建同时运行，4 项读取 dist 的历史外部门禁用例因产物尚未生成失败；构建完成后顺序重跑 1166 项通过，未修改测试或放宽门禁。

实际测试发布已完成：[PR #28](https://github.com/kyriswu/huahuo-server/pull/28) 经 PR CI、准确合并提交 push CI 后自动发布，[发布运行](https://github.com/kyriswu/huahuo-server/actions/runs/44046156448) 远端五阶段均通过，终态 `TEST_RELEASE_OK`，无排空强退信号。业务 SHA 为 `8b27e01c9ab78188e45573ff1fde98a04d699274`，控制 SHA 为 `64e2a46cee7f89b238875e585c51fda9945fdccf`。随后独立只读核对 current.json、实际镜像及健康：API/Worker 为新业务 SHA，Admin/Scheduler 保留 `5af896d` 镜像，四角色均 healthy。没有新增迁移、真实配置调整或宿主入口操作。

修复后在现有 iPhone 17e 模拟器复用用户登录态，经 App 通用上传库完整验收通过：65,536 字节直传及 complete，Server 新 playback 签名无禁用参数，OSS GET 200 读回 65,536 字节且内容完全一致。取消已受理后，同一个仍有效的签名 GET 在约 45.36 秒后返回 404 / NoSuchKey，确认物理清理；总耗时约 46.79 秒。上传/读取目标均明确验证为测试 Bucket，没有业务认领、短信或模型请求。该次只证明已测前台小文件链路，不外推后台续传、所有移动网络或生产环境。

联调前一轮测试曾将合法的 disposition/encoding 参数也误判为禁用，在发 GET 前失败；更正为仅禁止 response-content-type 后完整通过。失败事实保留。更早的会话探测误用了 drive 默认卸载行为，影响模拟器沙盒，已向用户说明；后续均显式 --keep-app-running，服务器数据未清理。App 详细证据保存在其仓库 docs/acceptance/oss-upload-20261117.md，敏感定位报告不提交。
