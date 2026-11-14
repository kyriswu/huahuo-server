# Admin 基础用户列表验收（2026-11-14）

本轮仅交付用户指定的基础只读页面，是既有 Admin 的增量，不宣称完成整个 P14，也不推进其他阶段。

## 使用与契约

- 入口：`http://127.0.0.1:3001/admin#users`；使用既有管理员登录，侧栏新增“用户管理”。
- 展示昵称、完整用户 ID、已验证身份的脱敏手机号、账号状态、注册时间（北京时间）；无已验证手机号显示“未绑定”。
- 支持昵称字面子串搜索、完整 UUID 精确查询、状态筛选、每页 20 条分页、重置、刷新与复制用户 ID。
- 桌面为表格，窄屏为纵向列表；包含加载、空结果、失败重试与会话过期处理。原工作台继续保留明确标记的示例记录，用户列表读取真实数据库。
- `GET /admin/api/v1/users`：`search?`（最多 120 字符）、`status?`（active/suspended/deleted）、`page?`（1–10000，默认 1）、`pageSize?`（1–100，默认 20）。返回 `items/total/page/pageSize`；单项仅包含 `userId/displayName/phoneMasked/status/createdAt`。
- 按 `created_at DESC,id DESC` 稳定排序，同一个 repeatable-read 事务中查询总数与分页；多条登录身份不会重复用户。查询使用参数绑定，`%`、`_` 和 SQL 形式文本均按字面处理。
- 沿用管理员 Session，operator 与 superadmin 可查询；不接受 App JWT。成功访问追加 `user.list` 审计，仅记录管理员、动作和 trace，不保存查询文本或返回的用户资料。响应 `Cache-Control: no-store`。

## 数据与权限

唯一基线 `migrations/0001_initial_schema.sql` 只追加两条列级只读授权：

```sql
GRANT SELECT(id,display_name,status,created_at) ON users TO huahuo_admin;
GRANT SELECT(id,user_id,provider,subject_masked,verified_at,created_at) ON user_identities TO huahuo_admin;
```

没有增加表、字段、物理外键、关系触发器或新迁移。隔离数据库中的受限 Admin 角色能执行列表查询，但不能读身份摘要、provider_subject、用户会话、Refresh Token、API Key，也不能修改或删除用户。现有开发 RDS 凭据角色本就拥有更广的既有权限，本轮没有重置凭据或回收旧授权；不能把隔离环境最小角色测试误报为真实 RDS 已全面降权。

开发 RDS 在核对旧基线校验值后，以事务同步这两条授权和唯一基线校验值，没有执行初始化、清库或数据回填。用户/身份/用户会话/管理员数量核对前后分别为 1/1/2/1。业务 Schema 物理外键仍为 0；既有关联索引与 CRUD 由隔离集成测试继续验证。

新基线 SHA-256：`fd6bf4454370cb1d9926df6d7105b6923ea0b33fa14ca9df0bd8e3af39c96859`。更新后迁移重放成功：`applied=[] / current=1`。

## 自动验证

| 验证 | 实际结果与边界 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint` | 通过；主题色小调整后再次通过，最终空结果文案颜色修正后前端类型检查与该文件 lint 通过 |
| `pnpm build`、最终 `pnpm build:admin-ui` | 通过；Ant Design 的既有浏览器构建提示与大 chunk 提示非失败 |
| `pnpm test` | 36 文件、394 项单元/契约测试通过；不作为真实服务供应商证据 |
| `node scripts/integration.mjs` | 13 文件、167 项真实隔离 PostgreSQL/Redis 集成测试通过；1 项需 Milvus 的无关文档提取测试跳过 |
| 新增 `admin-users.test.ts` | 8 项真实 PG 测试：两种管理员角色、字段白名单/脱敏、稳定分页、查询筛选、字面搜索、输入边界、JWT/匿名拒绝、列级权限、审计及撤销后拒绝 |
| API 隔离 | 新契约检查及部署后请求：公开 API 的该管理路径为 404，Admin 未登录为 401 |
| UI 检测 | Impeccable mechanical detector 对改动前端文件执行一次，结果 `[]` |

集成测试由原有安全 runner 新建本轮自有、带标签的 tmpfs PostgreSQL/Redis 容器；没有读取开发 `.env` 或访问开发库。模型/提取器采用各测试原有替身，不将其计为真实供应商或真实 Milvus 验证；结束仅删除本轮临时容器及凭据，没有删除现有数据卷。

## 浏览器与部署

Safari 中使用另一组隔离 PostgreSQL/Redis、23 位合成用户和独立测试管理员实际验证登录、刷新恢复会话、分页、UUID 与昵称查询、停用状态筛选、清除空结果、复制 ID、长昵称换行以及 HTML 形式昵称按文本显示。桌面与 390×844 窄屏检查均读取真实 Admin 路由，不是 mock API；没有把合成用户写入开发库。截图在 Server `.impeccable/review/`，本轮私有过程证据在 `.local/admin-users/`。

原生 Safari 截图流曾保留加载中旧画面；通过只读 DOM 检查确认 `aria-busy=false`、查询和刷新按钮均已启用，重新绑定截图目标后同路径重拍，未为截图修改产品 DOM 或业务代码。

独立界面复核确认基础布局符合既有后台，指出一项空结果文案对比度不足。已统一使用 `text-console-muted`（`#606378`，白底约 5.9:1）并重拍；复核该项为 resolved、disposition=ship，此次最终评分仅覆盖该项修正。停止隔离服务后还通过浏览器验证了“加载失败，请重试”的真实网络错误提示，测试 runner 随后确认只清理本轮自有资源。

本机部署基于当前运行镜像制作窄范围覆盖镜像，仅替换 `dist/modules/admin/`、`dist/admin-ui/` 与唯一基线，保留其他未发布业务模块的运行版本。为了统一基线校验，主 Compose 的 api-server/admin/worker/scheduler 使用同一覆盖镜像重建；四角色均 healthy、readiness 200。API/Admin 仍仅绑定 `127.0.0.1:3000/3001`，Worker/Scheduler 无宿主业务端口。Redis 与用户文件卷未变。

最终对比度修正仅再次更新 Admin 静态产物和容器：Admin 为 `sha256:5a32d2dc19e42a2bd50bc3d783d6842f56767f11be050be56827674ff8c2a79d`，其余三角色保留首轮覆盖镜像 `sha256:3cf371700533eb23dac7f33f6dbcfbe576de3c226f335f1e0ccabe8ce3a1fa6b`；两者基线完全相同。部署后 HTML/JS/CSS 均为 200，逐字节匹配最终本机构建产物，四角色再次 healthy/readiness 200。

开发环境部署后只验证页面/静态资源、未登录拒绝、公开 API 隔离与依赖健康；没有代登录真实管理员或生成用户 JWT。认证后的浏览器业务验收来自上述隔离测试环境。

## App 参照与范围

只读核对当前 `../huahuo-ai` 的 `lib/core/network/api_endpoints.dart`、`lib/features/auth/data/http_auth_repository.dart`。Git 仍为 GIT_UNBORN；前后文件哈希及工作树状态一致。Admin API 与 App 的 `/api/v1/auth/*` 分离，本轮没有改变 App 消费契约，也没有写入或运行 App。

本轮未新增用户信息导出、用户编辑/删除、代登录、JWT 获取、个人上传操作台或私有正文浏览；不调用真实短信、模型、解析或其他付费服务。JWT 事项按用户要求延期。
