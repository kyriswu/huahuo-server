# 花火 Server

只在本仓库开发后端；同级 `../huahuo-ai` 只读，不运行任何会写入 App 的命令。
按 `specs/backend-plan/00_启动指令.md`、总规范及当前 Pxx 阶段执行；每阶段核对真实 App 源码，更新 docs 证据并停在验收点。
Fastify + PostgreSQL + Redis，Node 26.11.0（Volta 管理）、严格 TypeScript/ESM；同一 compose.yaml 中四个独立运行角色及一次性 migrate。
不得操作其他项目、删除现有数据卷、重置已有凭据、公开管理端或调用生产付费服务。
保持真实依赖测试与 mock 单元测试的证据区别；测试库独立，不能清空开发库。

涉及跨模块功能、公开接口、数据库、鉴权或异步任务时，首次编辑前用当前 Git worktree 的 CodeGraph 从真实入口核对调用方和下游。改完复查受影响的调用方并运行相关测试。MCP 不可用时，在当前 worktree 运行 `sh scripts/codegraph-worktree.sh explore <入口符号>`。索引不可用时，用当前源码核对并说明限制。文案和单文件小修直接核对源码。

用户管理的内容统一称为资产（`ContentAsset`），原文件称为 `Resource`。资产归用户，工作区和文件夹关系单独表达。搜索实现的模式使用通用的 `hybrid`、`keyword`，业务来源可用于存储命名。新增代码、接口、数据库、日志和说明遵循 [资产与搜索术语](docs/content-assets.md)。

域名入口、Nginx、Certbot 与证书自动续期由宿主机独立管理；相关配置、脚本及运维文档不放入本仓库，不接入应用、Worker、Scheduler、Compose 或项目部署脚本。项目只维护应用监听、公开 URL 和可信代理等应用配置。

搜索功能确定需要，现有技术实现可以保留；具体业务范围、交互、接口和排序等细节尚未确定。不得把现有代码或 App 本地搜索界面当作用户已确认的产品需求，也不据此继续扩展功能；后续按明确业务调整。

数据库规则：PostgreSQL / 阿里云 RDS 不设计、不新增任何物理外键。禁止在业务 Schema、增量迁移或 ORM Model 中使用 `FOREIGN KEY`、`REFERENCES`、`.references()`、`foreignKey()`，也不使用触发器模拟外键。关联 ID 使用普通字段及必要的普通索引；主键、唯一约束、NOT NULL 和业务 CHECK 继续保留。
关系存在性、用户/工作区归属、并发写入及删除清理由所属 Service / Repository 在事务边界显式处理，不依赖数据库级联；不得通过移除外键放宽权限校验，不新增重复兼容路径。迁移验收必须确认业务 Schema 的外键数量为 0，并验证关系查询索引和普通 CRUD 行为。

测试服务器已于 2026-11-15 首次完成自动发布。`migrations/0001_initial_schema.sql` 及以后任何已执行迁移均冻结；新环境从 0001 顺序建立，后续变更新增编号，不重写历史或 checksum。原“未上线只维护单基线”规则到此结束。不恢复旧用户表别名或旧认证参数。清空已有数据库必须有用户明确授权并通过执行审批，禁止在应用启动时自动DROP或重置。

发布准备使用 `.agents/skills/huahuo-release/SKILL.md` 与 `docs/runbooks/standard-release.md`。清单根据目标实际成功提交整理，不能只看 SQL/ENV 文件差异。小且有界的数据修正可经评估随迁移执行；耗时或风险不确定的回填通常独立运行，说明依据并与用户确定方案，不采用一刀切规则。合并后的自动化只执行已审代码/清单，不临时生成 SQL。默认不触碰其他实例、真实付费服务或未授权数据。
