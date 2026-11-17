# 外部文档解析 URL 输入协议核对

核对日期：2026-11-17。协议依据来自已有接口快照与官方公开源码，以下改造已在本机实现并通过隔离验证；未启动真实解析节点、提交真实文件或调用付费服务。

## 真实接口快照

本仓保存的 Xberg 回调验收快照：

`.local/gpu-spot/xberg-callback/callback-1794640404449-037b61c2-6eab-4d98-a268-9a4986c847a6/export/api-openapi.json.json`

文件 SHA-256：`50843d0d5e2ff17d3aa17c92d5286b6b664f0154e3c108e9a6389ae217469186`。外层 `body` 为 OpenAPI 文档。

- `paths./extract.post.requestBody.content.application/json` 与 `/extract-async` 均存在。
- JSON 必需字段为 `inputs` 数组；可选 `config` 为对象、`file_contexts` 为数组。
- 异步端点另有可选 `callback_url` 字符串。
- `FileContext` 只接受 `source_resource_id`、`parse_run_id` 两个必需 UUID；不允许附加属性。知识库模式按文件位置传递上下文。
- 快照将 `inputs.items` 留为空对象，不能单凭该快照推断输入元素的属性或文件大小控制字段。

## 官方输入元素实现

已读取 [官方 HTTP handler](https://github.com/xberg-io/xberg/blob/b6f2661aa5381719c7f1979b3f3ecce6cc704e41/crates/xberg/src/api/handlers.rs) 的固定提交 `b6f2661aa5381719c7f1979b3f3ecce6cc704e41`：

- `JsonExtractInputObject`（259 行起）定义 `kind`、`uri`、`mime_type`。
- `UnifiedExtractRequest` 根据 `Content-Type: application/json` 进入 JSON 解析。
- `object_to_api_input`（605 行起）将 `uri` 与 `mime_type` 转为 URI 输入；服务从 URL 获取文件。
- URI 分支不使用对象中的 `filename`，因此请求不依赖它。

业务与管理试用发送的协议为：

```json
{
  "inputs": [{"kind": "uri", "uri": "https://example.oss-cn-beijing.aliyuncs.com/document.pdf", "mime_type": "application/pdf"}],
  "file_contexts": [{"source_resource_id": "00000000-0000-4000-8000-000000000001", "parse_run_id": "00000000-0000-4000-8000-000000000002"}]
}
```

目标为配置节点的 `POST /extract-async`，请求类型为 `application/json`。节点 `documentApi.parameters` 非空时原样作为 `config` 对象发送；为 `null` 时省略。业务任务保留 `callback_url`，管理端临时试用继续轮询结果，不登记业务回调。

## 大小限制与验证边界

[官方配置定义](https://github.com/xberg-io/xberg/blob/b6f2661aa5381719c7f1979b3f3ecce6cc704e41/docs-site/src/content/docs/reference/configuration.md) 的 `UrlExtractionConfig.crawl` 下有 `max_body_size` 与 `document_max_size`。但本仓真实 OpenAPI 快照没有细化 `config`，本次也未确认当前节点镜像支持同一版本字段。因此不向现有参数注入这些配置，不声称 Server 按下载字节执行了文件大小限制；实际下载与大小限制由解析服务负责。

Admin 只接受经白名单、协议和有效期校验的 OSS 链接；PDF、Office、TXT、Markdown、CSV 均发送外部服务。删除试用二进制上传路由、本地文件选项、本地文本解析、源文件下载指标和 `maxBytes` 能力字段，无旧入口兜底。

自动化证据分别记录：静态类型与 lint 检查；隔离 PostgreSQL/Redis 集成测试中的外部解析 fetch 替身。替身断言 URL JSON 协议与零源文件下载，不能作为当前真实节点在线解析通过的证据。

## 本轮实现与验收（2026-11-17）

- 正式 RAG 文档、FILE_UPLOAD、Admin 试用均提交 URL JSON；删除源文件下载/缓存再转发、UTF-8 文件本地读取、DOCX 本地内容提取和试用上传入口。Server 对外部返回的 Markdown 做目录、分段和索引，这不承担源格式解析。
- Note imports 只接受已提取的 text/plain / text/markdown 正文；旧 DOCX Base64 和空正文占位结果不再接受。
- 媒体 upload-token 签发 OSS V4 PUT URL，绑定 MIME、字节数并禁止覆盖；客户端直接上传 OSS。Server 二进制 PUT 路由、capability 和对应 service 方法删除，非 OSS 配置明确拒绝直传申请。complete 保留归属、工作区、配额、幂等和对象完整性校验。失败时保留预占，到签名过期后由 Worker 清理并释放，避免签名仍有效时绕过额度。
- 媒体对象完整性核验仍会流式读 OSS 做 SHA-256、类型/时长检查，这与提取文档正文不同；没有以 HEAD 或客户端声明冒充真实校验。OSS stat/read 删除整文件 get Buffer 与旧 SDK fallback；文本编码检查复用有界哈希缓冲，DOCX 类型识别只读有限文件头。此处不声称整个存储模块零文件读取。
- 指定 sourceResourceId 时，URL 必须对应已拥有资源的 bucket/endpoint/key，拒绝对象错配；签名参数不作为身份。新任务及提交前检查 URL，已提交任务在 URL 过期或白名单收紧后仍可查询/取消。bound 过期释放名额，模糊 intent 不重发，回调与租约隔离保留。
- 删除失效下载超时/源文件大小运行配置；规范正文接收、恢复读取统一16MiB，图片清单回读16MiB，外部响应按节点预算限制。外部服务自己约束源文件下载。保留手动正文字符数限制。
- 删除无调用 tokenizer、旧 BGE-M3 资源（17,099,034字节）、mammoth/pdf-parse/diff/HF依赖及仅由自测引用的辅助函数；锁文件同步，无新增依赖。该数字是仓库文件体积减少，不作为进程 RSS 优化实测。

验证结果：

| 命令/范围 | 结果与边界 |
| --- | --- |
| `pnpm test` | 993项单元/契约通过；HTTP/对象存储供应商均为替身或纯本地 SDK 签名 |
| `pnpm test:integration` | 338项通过、4项Milvus相关跳过；真实临时PG/Redis、loopback解析服务与本地对象存储，不触及业务库 |
| 直传最终定向复测 | 22项PG/Redis通过；覆盖最后收敛的 failed 预占保留、到期清理及 Note 图片引用 |
| `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` | 通过；构建仍有既有前端chunk大小及依赖use-client提示 |

证据目录 `.local/oss-url-repair/`：`unit-contract.log`、`integration.log`、`storage-final.log`、`typecheck.log`、`lint.log`、`build.log`。首次单测发现上传准入旧local夹具不满足新OSS直传要求，已改成明确OSS替身后重跑；首次lint发生在并行新增恢复测试期间，最终重跑通过。不掩盖早期失败，也不将模拟解析当作真实云端验收。

本项没有新增SQL迁移；隔离测试同时检查工作区已有0004/0005从已部署版本3升级到5及重复执行、零物理外键。已执行历史迁移未改写。没有提交、部署、重启现有服务、修改凭据或共享业务数据；真实外部节点的URL下载/长文档解析仍待内网验收。本轮只完成文件入口/解析链路与相关无用依赖清理，系统审查中的其他条目仍以各自验收记录为准。

## 历史分支复核与进一步清理（2026-11-17）

用户再次明确本次清理不保留废弃的历史兼容路径。用户随后要求此类工作偏好只作为会话指令，已撤回自行加入 AGENTS.md 的内容。复查真实调用后继续删除：无人注入的 Text prepareSource 旁路及专属类型、无业务调用的 parse-runs resources 客户端方法、旧本地上传临时文件清理钩子、旧增强正文 URL 回退、无写入方的 processing_info 标题排除范围及其结构选项、四个已无产生路径的 RagStage 状态。文档状态直接读取现行非空 cleanup_status，接口说明统一所有文件都需外部解析。归属、幂等、租约、取消和未知提交恢复保留，不属于历史兼容。

删除功能对应的3项自测一并删除。最终990项单元/契约通过，338项真实隔离PG/Redis通过、4项Milvus相关跳过；类型、lint、build与diff check通过。证据在同目录的 `cleanup-unit-contract.log`、`cleanup-integration.log`、`cleanup-typecheck.log`、`cleanup-lint.log`、`cleanup-build.log`。已执行SQL迁移未改写，没有共享数据变更或发布，不将此局部复核声称为全系统技术债全部清零。
