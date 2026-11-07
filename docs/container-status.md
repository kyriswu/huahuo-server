# 当前容器与数据库状态

2026-11-05 已在现有远程RDS数据库`huahuo`启用统一用户结构；未新建数据库、重置数据库账号或更改连接凭据。当前public基线为唯一`0001_initial_schema.sql`，current1及checksum均验证通过，物理外键0。

旧Schema在同库`initialization_backup`保留58张表4149行，数据/OID/存储标识核验一致且运行角色无访问授权；当前应用只访问新public，没有归档兼容查询。用户和会话为空，需要重新登录。

api-server/admin/worker/scheduler均运行最新`huahuo-server:dev`且healthy。API实际PostgreSQL、基线checksum、Redis cache和queue探针均true；API/Admin readiness200。API/Admin分别只绑定127.0.0.1:3000/3001，Worker/Scheduler无宿主业务端口。JWKS EdDSA/Ed25519 server-current正常。

Redis沿用既有容器；本地PostgreSQL未用作业务库，原数据卷保留。共享OSS和Milvus不随本次Schema初始化删除，不以旧向量测试样本冒充新业务链路验收。没有真实短信或模型调用。

质量检查：typecheck/lint/build、229项unit/contract、115项独立PG/Redis integration、6项真实权限拓扑归档安全实验通过。证据在忽略提交的`.local/huahuo-unified-cutover/`与`.local/schema-archive-safety.log`。
