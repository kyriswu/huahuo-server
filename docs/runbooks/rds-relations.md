# RDS 普通关联键与初始化基线

PostgreSQL / RDS 使用普通关联 ID 和查询索引，不创建物理外键，也不使用触发器模拟跨表外键。主键、唯一、NOT NULL 和业务 CHECK 保留。所属 Service / Repository 在事务边界检查对象存在、用户与 Workspace 归属、修订和有效状态；删除遵循软删除或显式定向清理，不依赖数据库级联。

## 数据库初始化

新库从 `migrations/0001_initial_schema.sql` 开始按编号执行到当前版本，已有库依据 `public.schema_migrations` 中的编号与校验和只执行待应用的增量。应用和 ORM 使用增量执行后的表结构。下方归档和单基线结果属于 2026-11-05 的同库切换。 [迁移流程](standard-release.md#migration-与只读验收)

## 统一用户与关联模型

| 数据 | 当前表及普通关联 |
| --- | --- |
| 用户资料与状态 | `users`；仅 `status='active'` 的用户可进入用户业务操作 |
| 登录身份 | `user_identities.user_id → users.id`；身份摘要与掩码不放在用户资料表 |
| 客户端会话 | `user_sessions.user_id → users.id`；客户端由 `client_type + client_id` 描述 |
| 刷新令牌 | `refresh_tokens.session_id → user_sessions.id`；服务层处理轮转、撤销和复用检测 |
| 协议接受 | `user_agreement_acceptances.user_id/session_id`；记录协议与隐私版本及接受入口 |
| 业务归属 | `workspaces.user_id`；资产、Folder、资源、任务与账务分别保存明确的所属 ID |
| 资产内容 | `content_asset_parts.content_asset_id`、标签映射、资源引用和显式关系由资产业务校验 |
| 文件 RAG | `kb_document_keyword_builds.source_type/source_id` 指向所属整篇资料；分段只存构建 ID 与位置 |
| 资产 RAG | `kb_content_asset_hybrid_builds.source_id` 指向整篇 `content_assets`；修订定位真实 raw part，分段不存正文 |

箭头表示应用语义，不是物理外键声明。普通关联字段建立与实际过滤、连接和清理路径匹配的索引；不为替代外键增加全局关系模拟器或逐请求全表扫描。

## 应用层校验与删除

- Identity 统一验证 JWT、用户 active 状态、数据库会话和撤销；业务层不能用请求中的裸 userId 覆盖身份。
- Workspace、资产、Folder 和 Tag 写入在所属业务事务内检查目标、归属与 ETag；来源或 Workspace 不匹配时拒绝。
- 资源绑定复用 `attachResource()`，校验资源和真实 Workspace 归属，并与删除使用同一资源行锁。资产 的资源引用与引用计数在同一事务中写入。
- 上传完成核对 Workspace、预留额度的用户/资源键/大小，以及资源与上传的实际关联。存储任务创建和执行都核对目标及用户/Workspace 范围。
- Billing 在写入额度前验证 active 用户，并检查任务、Run、预留额度的归属和关联一致性。
- 资产、Folder、Resource 保留软删除语义；标签集合替换只删除映射，显式关系删除只删除该叶关系。不存在依赖数据库 CASCADE 硬删这些主记录的运行路径。
- RAG 清理固定来源、整篇 ID、修订、稳定 Chunk ID 和原目标；失败保持可重试状态，不能扩大范围。

如果未来新增主记录硬删除，所属业务必须显式设计子记录清理和失败恢复；不能恢复物理外键或依赖隐藏级联。

## Schema 约束与验证

`src/db/migrate.ts` 在提交 Schema 前检查全部应用 Schema 的物理外键；发现外键会回滚该次变更。已应用文件重放后仍检查数据库漂移。该检查不执行运行时关系模拟，允许现有更新时间、检索和生命周期等业务触发器。

验证范围：

- `tests/integration/no-foreign-keys.test.ts`：真实临时数据库无物理外键，ORM 不声明外键，普通关联索引覆盖。
- `tests/integration/infrastructure.test.ts`：引入外键的 Schema 变更会回滚，已初始化数据库发生外键漂移时拒绝继续。
- Identity 和业务集成测试：不存在或跨用户/Workspace 的身份、资源、任务与账务引用被业务层拒绝；软删除保留恢复所需正文和关系。

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
git diff --check
```

集成测试使用独立临时 PostgreSQL／Redis。2026-11-05 的验收包括 229 项单元及契约测试、115 项集成测试和 6 项独立归档实验。一次性归档实验的结果保留在本记录中，日常验证使用上面的回归用例。真实 RDS 切换另见下方记录。

## 真实同库切换验收（2026-11-05）

- 原数据库仍为`huahuo`，没有新增数据库。旧`public`整体改名为`initialization_backup`；58张旧表、4149行、OID、relfilenode及视图内容摘要前后一致。
- 归档Schema已封存，API/Admin/Worker/Scheduler四个运行角色均无USAGE/CREATE，不参与旧模型兼容查询。旧数据保留与新业务模型运行分开，不是删除数据后重建。
- 新`public`已完成唯一基线初始化，产品`users/user_sessions`均为0；没有复制任何产品用户或会话。管理员凭据保留逻辑已执行，但原`admin_users`本身为0行，因此`retainedAdminAccounts=0`。
- 全数据库物理外键为0，基线checksum一致，迁移重放返回`applied=[]/current=1`。本次RDS没有独立`huahuo_migrator`账号，初始化及重放实际使用既有配置的`huahuo_admin`，未向不存在的迁移账号授权。
- 数据库账号密码、环境配置和JWT私钥未更改。统一用户代码已发布至四角色，均healthy；数据库目标`huahuo`、基线checksum、PG/schema/Redis状态均通过，API/Admin readiness均为200；JWKS为EdDSA/Ed25519、kid=`server-current`。运行证据为`.local/huahuo-unified-cutover/runtime-result.json`。
- 本轮模型与短信调用均为0，Milvus和OSS未清理；未执行真实文件RAG入库，不能将历史向量样本当作新业务验收。
