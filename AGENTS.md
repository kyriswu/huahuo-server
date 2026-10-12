# 花火 Server

只在本仓库开发后端；同级 `../huahuo-app` 只读，不运行任何会写入 App 的命令。
按 `specs/backend-plan/00_启动指令.md`、总规范及当前 Pxx 阶段执行；每阶段核对真实 App 源码，更新 docs 证据并停在验收点。
Fastify + PostgreSQL + Redis，Node 24、严格 TypeScript/ESM；同一 compose.yaml 中四个独立运行角色及一次性 migrate。
不得操作其他项目、删除现有数据卷、重置已有凭据、公开管理端或调用生产付费服务。
保持真实依赖测试与 mock 单元测试的证据区别；测试库独立，不能清空开发库。
