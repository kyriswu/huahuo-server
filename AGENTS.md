# 花火 Server

只在本仓库开发后端；同级 `../huahuo-ai` 只读，不运行任何会写入 App 的命令。
按 `specs/backend-plan/00_启动指令.md`、总规范及当前 Pxx 阶段执行；每阶段核对真实 App 源码，更新 docs 证据并停在验收点。
Fastify + PostgreSQL + Redis，Node 26.11.0（Volta 管理）、严格 TypeScript/ESM；同一 compose.yaml 中四个独立运行角色及一次性 migrate。
不得操作其他项目、删除现有数据卷、重置已有凭据、公开管理端或调用生产付费服务。
保持真实依赖测试与 mock 单元测试的证据区别；测试库独立，不能清空开发库。

数据库规则：PostgreSQL / 阿里云 RDS 不设计、不新增任何物理外键。禁止在业务 Schema、增量迁移或 ORM Model 中使用 `FOREIGN KEY`、`REFERENCES`、`.references()`、`foreignKey()`，也不使用触发器模拟外键。关联 ID 使用普通字段及必要的普通索引；主键、唯一约束、NOT NULL 和业务 CHECK 继续保留。
关系存在性、用户/工作区归属、并发写入及删除清理由所属 Service / Repository 在事务边界显式处理，不依赖数据库级联；不得通过移除外键放宽权限校验，不新增重复兼容路径。迁移验收必须确认业务 Schema 的外键数量为 0，并验证关系查询索引和普通 CRUD 行为。

当前未上线初始化采用唯一 `migrations/0001_initial_schema.sql`；不保留旧用户表别名、旧认证参数或数据回填兼容分支。新环境从该基线创建；清空已有数据库必须有用户明确授权并通过执行审批，禁止在应用启动时自动DROP或重置。
