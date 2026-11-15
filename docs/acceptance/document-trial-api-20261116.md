# 文档试用 API 实测（2026-11-16）

用户要求实际通过 API 复现。北京时间 02:15，调用本机已运行 Admin 的同一管理 API，使用用户提供的管理员凭据完成真实登录；每轮结束均调用 logout 撤销本轮会话。凭据、Cookie、CSRF 和签名链接未保存到证据。

- 运行镜像 revision 为 `e0da7c727fb6f15652e6c82d444dcd87925830fa`，当前工作区 HEAD 为 `ce1123e`，两者不同。以下结论针对运行镜像，不将工作区源码当作线上实现。
- capabilities 返回 HTTP 200，配置版本 6、候选节点 1、上限 33,554,432 字节。候选存在不代表 API 已就绪。
- processing-nodes 状态接口返回 HTTP 200：CPU ECS `Stopped`、`state=offline`、`serviceStatus=not_running`、`serviceReady=false`。同时仍有 `startup.state=running`、更新时间 02:07:59 的旧启动任务；此处仅记录现象，未据此断言任务故障原因。
- 用户新提供的 OSS PDF 链接通过 `POST /admin/api/v1/document-trials` 实际提交，返回 HTTP 400、`RAG_SOURCE_HOST_NOT_ALLOWED`；未进入下载或解析。traceId：`920497c7-4cc1-4590-86c8-10c7e578a3ac`。
- 另以已有测试 PDF（61,403 字节）调用上传入口，返回 HTTP 202，trialId 为 `01d52dde-e46a-412f-a5be-44c76a87b705`。轮询得到失败：`ADMIN_TRIAL_SERVICE_UNREACHABLE`，总耗时 5,005.614 ms、下载 0 ms，无 remoteJobId；结果接口返回 `result=null`。
- 只读核对运行容器的编译代码：提交前健康 GET 使用 5,000 ms 超时，失败即终止，尚未调用 `/extract-async`。从 Admin 容器直接健康探测也在约 5,002 ms 超时，与本次上传结果吻合。

本次是真实管理 API 与真实节点状态检查，解析 API 因不可达未完成，不是成功解析验收。未开停云机、修改白名单或运行配置、部署镜像、修改数据库结构或 App。登录按正常实现产生会话和审计记录。原始脱敏响应位于忽略提交的 `.local/document-trial-api-20261116/evidence.json` 与 `upload-evidence.json`。本机未发现同级 App 参照目录，不补造 App 核对证据；不推进 Pxx。

## 后续指定 18127 端口实测

用户随后指定 已配置节点的 `18127` 端口。真实 `/health`、`/ready` 均 HTTP 200；提供 docling-cpu 异步 API。下载用户提供的电子标书链接成功，81,249,929 字节，SHA-256 `d9c063dfe3f9b8107e7d78c9e27574ac8b23d9dd21096f84e32d9c31b07ac59f`。首次容器内临时 Node 测试进程在准备大文件提交期间以 137 退出，容器 OOM 标志为 true；Admin 主服务后续 live/ready 均 200。没有取得首次提交任务 ID，不能证明首次请求是否到达服务。

随后从宿主流式上传同哈希的已有 PDF 副本，不再将大文件装载到 Admin 容器。提交 HTTP 202，jobId `7ac70a34-c1bc-4fc7-8fcb-f30dc3d2f612`。服务约 257.192 秒后完成，结果 GET 200；325/325 页、101 张表、978 条图片记录，summary 为 1 输入/1 结果/0 错误，Markdown 527,967 字符。完整 JSON 与 Markdown 在 `.local/document-trial-api-20261116/18127-result.*`。

这仅证明解析服务完成；实际后端结果校验仍失败 `DOCUMENT_EXTRACTION_RESPONSE_INVALID`。已定位图片回执存在重复 resource_id（首个重复出现在索引 29），不将其冒充 Admin 完整成功。未验证重复回执是否逐字段相同，也未放宽校验或更改服务。

## RT-Thread 内网链接失败原因

用户提供第二个链接后，真实 Admin 配置已由外部更新为节点 revision 9、端口 18127；状态为 ECS Running、API ready。本轮未修改该配置。

实际管理 API 提交成功（HTTP 202），下载 2,712,113 字节用时约 120 ms，trialId `4fa7135b-c269-4167-9486-dfcbd05b1d82`，remoteJobId `a89098dd-e0f0-4ecc-9a33-87d78fdcb421`。总计约 156 ms 即失败 `DOCUMENT_EXTRACTION_JOB_STATE_UNKNOWN`。直接读取远端任务返回 HTTP 200、`state=queued`、`result_state=pending`；现有 DocumentExtractionClient 仅接受 pending/running 等状态，未接受 queued，导致将正常排队误判为未知状态。

管理状态与结果 GET 都是 HTTP 200，业务失败放在 data.state/error 中；浏览器控制台没有网络异常与此一致。试跑 execute 的 catch 将错误写入内存状态，没有自动向浏览器抛出 JavaScript 异常。远端任务已受理，后端试跑失败不代表远端取消，不应盲目重提。

新链接实测证据保存在 `.local/document-trial-api-20261116/rtthread-evidence.json`、`rtthread-remote-status.json`；通用 evidence.json 已被此轮覆盖。此轮仅定位原因，没有部署或修复状态协议。

## 后端协议修复与验证

用户随后要求解决，修复共用 DocumentExtractionClient：状态查询与 202 结果查询均接受 queued，继续轮询或按 singleStep 让出执行；未知状态仍失败，既有 job 不重新 POST。重复图片回执允许同一资源跨页复用，但必须通过原字段校验，且归属、bucket、object_key、SHA-256、大小、MIME、etag 等必须一致；不修改结果正文、图片列表或原回执。真实 978 条回执对应 817 个唯一资源，重复项差异仅 page_number、reused 和 upload_ms，符合此规则。

47 项协议 mock 单元测试、Server/Admin TypeScript 检查、修改文件 ESLint 通过。额外使用 Node 26.12.1 的一次性容器运行修复源码：原始 325 页结果通过 validateExtractionResponse 且序列化前后逐字一致；真实 RT-Thread job 仅执行一次状态 GET，返回 ParserExecutionDeferred(external)，未重提、未消费结果。证据为 `.local/document-trial-api-20261116/fix-verification.json`。本机 Volta 缺 pnpm/Node26.11，使用已有镜像 Node26.12.1 和固定 pnpm10.15.1 安装冻结依赖，没有全局升级工具或更改 lockfile。

远端 RT-Thread job 仍 queued，而 /ready 为 true、8 个 Worker ready、queued_chunks=0。客户端状态修复不代表远端调度已恢复，也未确认其调度停滞原因；不能宣称此 PDF 完整解析通过。此次没有修改外部解析服务或部署应用，代码修复需按现行发布流程上线。

最终全量 unit/contract：56 个文件、816 项全部通过，日志 `fix-tests-with-git.log`。首轮同一套测试为 762 通过、54 失败，失败集中在两个发布工具测试文件，原因是运行镜像没有 git（spawnSync git ENOENT）；在一次性测试容器中安装 git 后重跑全量通过，没有改测试断言或运行服务。未运行需要独立数据库的集成测试，不将 mock 单测或只读 HTTP 探测称为 PG/Redis 回归。

## 测试环境发布候选

用户授权发布后，以宿主成功记录与四角色镜像共同确认的 `e0da7c727fb6f15652e6c82d444dcd87925830fa` 为基准。将本次修复移至该 test 头，保留已经发布的节点配置、0003 及其冻结 checksum；唯一合并冲突为 docs/progress.md 的同期进度条目，双方内容均保留。发布控制仍来自受保护 main。

清单 `20261116-parser-queued`：四角色更新，SQL 增量为空、数据处理 none、配置 reuse 且无 ENV 键变化、无新增依赖或独立回填。通用迁移历史和零物理外键检查继续执行；迁移阶段仍需返回无需执行。API/Task/数据库格式不变，新旧镜像可共用现有数据与队列；恢复仅回退应用，不撤销迁移。健康冒烟沿用测试环境既有验收范围，另用本次真实状态/响应回放核对修复。

原同级 App 在本机缺失，UNVERIFIED_APP；本次不声明移动端实测通过。发布前的重跑结果与最终部署证据分开记录，不用早期 816 项结果替代最新基准检查。

移至实际成功基准后的重跑：832 项 unit/contract 全部通过，Server/Admin TypeScript、完整 ESLint 与构建通过（Node26.12.1/pnpm10.15.1）。隔离迁移演练基准与候选均为版本3，首次与重复迁移均为空；后续完整隔离集成结果另记。

发布前完整隔离 PostgreSQL/Redis 回归：277 项通过，1 项 Milvus 跳过；临时资源已按归属清理，未清空开发/测试共享库。解析服务在此套集成中为替身，与前述真实解析响应回放分开记录。日志 `release-integration.log`；提交后的 release:check 通过，确认累计7文件、0增量迁移、四角色及 health 验收。PR #16 按现行 test 原生自动合并及 main 自动发布流程推进；此记录不提前宣称部署成功。
