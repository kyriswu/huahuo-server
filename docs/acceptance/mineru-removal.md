# MinerU 适配器移除验收（2026-11-12）

按用户要求移除 huahuo-server 的 MinerU 解析 API 调用、适配代码、配置与环境变量。本轮为现有功能清理，不推进 P07，不接入替代解析器，也不修改 App。

## 已移除

- 在线提交/轮询/结果下载客户端、Mock 解析器及其返回类型。
- ZIP、full.md、content_list_v2、model.json、图片/OCR 绑定和专属结构提示处理。
- Worker 中的 PDF/Office 外部解析分支、供应商任务身份与解析器快照参数。
- `RAG_MINERU_BASE_URL`、`RAG_MINERU_TOKEN`、`RAG_MINERU_MODEL`、`RAG_MINERU_POLL_INTERVAL_MS`、`RAG_MINERU_TIMEOUT_MS` 的类型、校验、默认值和 Compose 注入。
- 根 `.env`、`.env.compose.local` 与六份环境示例中的上述五个变量。移除前后使用解析值哈希核对其余配置，保持原权限（本机文件0600），未重置任何其他凭据。
- 专属绑定测试、`scripts/verify-rag-fixture.mjs`、对应 package script，以及仅该适配器使用的直接依赖 `fflate`；lockfile已同步。
- 唯一初始化基线中五个 `mineru_*` 列定义。没有新增迁移链，没有对已有业务数据库执行DDL或删除原数据。

删除的模块不会出现在新构建产物中；本机 dist 内旧编译文件也已定向清除。原历史验收与本地原始数据保留，历史提及不代表当前支持该服务。

## 当前 API 行为

`POST /api/v1/rag/ingestions` 为通用文件导入入口，保留原身份、幂等、Task/Outbox、完整正文检查点、TOC和关键词索引，只接受UTF-8文本、Markdown、CSV。PDF/Word/Excel/PowerPoint请求返回HTTP400 / `RAG_FILE_TYPE_UNSUPPORTED`，不创建版本或任务；声明与实际字节不符返回 `RAG_FILE_TYPE_MISMATCH`。

独立导入的FILE_UPLOAD也仅使用相同原生文本处理。原文空格、换行和Unicode保持，下载的域名、签名有效期、逐跳重定向、体积/超时约束继续执行。原生文本不再依赖外部模型/解析模式开关或解析凭据；生产Mock限制仍由全局配置检查执行。

已有正文、图文资产、检索、授权读取与删除清理保留。当前不产生新的图片/OCR资产，不从文件名或Mock结果伪造PDF正文。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 32个文件、309项unit/contract全部通过 |
| `node scripts/integration.mjs --milvus` | 10个文件、118项integration全部通过 |
| 真实依赖范围 | 全新隔离的本机PostgreSQL 17.9 / Redis 7.4.8 / Milvus 2.6.26；模型为确定性替身，未调用付费服务 |
| 受影响链路 | 真实JWT下PDF/Office受理拒绝且无任务；Markdown原文入库/关键词查询；权限、租约、重试、删除等既有回归 |
| 基线数据库 | 业务Schema物理外键数量0，关系索引和普通CRUD回归通过；无开发库清空 |
| 静态/构建 | Typecheck、Lint、Build、diff检查通过 |
| Compose | 脱敏解析校验通过；api-server/admin/worker/scheduler独立，migrate仍一次性；无供应商变量注入 |
| 环境文件 | 8份文件各删除5个专属键，其余解析值哈希一致、权限保持 |

集成测试只创建本轮带归属标签的临时容器，使用tmpfs和独立测试库；结束后容器及临时凭据全部清理，不删除数据卷，不读取开发库配置。最初定向单测被本地源码快照的测试扩展名干扰，修正快照名称后全量通过；不作为业务代码失败记录。

本地证据在 `.local/mineru-removal-20261112/`，包含环境清理哈希证明、脱敏Compose证明、App源码哈希和作用范围核查。环境校验脚本首次断言因对象原型差异异常，工具输出曾回显敏感配置；随后改为哈希比较并只输出字段名/结果，未重置既有凭据。

## App 与部署边界

只读核对App HEAD `20f61b78887f9288d1fd3227f326e6374d516f27`，实际 `endpoint_catalog.dart:437` 声明的是工作区Note导入接口，没有供应商专属路由；本轮不把它与Server通用文件导入入口合并。目录文件SHA-256为 `c91cdd32b5f7ca9a9da082b1407b45ebb0f4d7ed88acea61219cb7059ccbed92`，domain_clients.dart为 `28ac16b834fd4bd4491ef25fab26b53ec66f12428ea7cecc7b04b09e1099853e`。无App写入、Flutter运行或真实客户端联调声明。

本轮已完成源码、本机环境文件和构建产物清理；运行中的业务Compose容器未重建，既有业务库未执行删列或重新初始化。运行服务须采用新镜像和新Compose配置后生效，不能把代码测试通过当作已完成部署。
