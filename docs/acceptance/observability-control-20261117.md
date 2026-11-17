# Server 观测发布控制审查

本控制候选仅为 Server 测试环境的正常发布准备，不部署 Agent，不安装监控平台，不变更宿主入口或现有配置值。

compose.yaml 在共享应用 ENV 中新增 OTEL_SERVICE_VERSION 与 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 的显式注入，两者默认空。前者由候选应用回退至 package 版本，后者不启用外部 Trace 导出；原端口、网络、卷、健康检查、角色和退出预算均不变。四角色业务源码、依赖锁、0012 可空追踪上下文迁移和本期清单随 test 业务 PR 审查，不能因本控制补丁合并而认为已发布。

宿主已安装发布器要求受保护 main 的 Compose 与业务候选一致。本补丁同步相同 Compose 字节；已有调用器仍从 main 固定 SHA 执行，仅依赖现有 Aliyun 调用依赖，不引用 OTel 应用模块。业务 Docker 构建从已通过 CI 的 test 上下文读取其 package.json 和 pnpm-lock.yaml，所以本补丁不机械覆盖 main 旧业务依赖，不夹带其他业务或修改 main 历史发布清单。

目标成功基准已于 2026-11-17 18:36（Asia/Shanghai）只读确认是 8b27e01，四角色 healthy。旧版 runtime readiness 校验自己携带的 1..11 checksum 并接受后续新增迁移；旧迁移器不允许用于 schema12。候选的隔离 schema11→12、重放、角色权限和零物理外键验证已通过；共享数据库未由本机改动。

ENV 均新增、非必填、四角色、有默认，不需要候选秘密配置或人工赋值；实际候选继续由相同成功配置快照解析、检查并发布。冲突处理：无。人工项仅为本 main PR 按仓库规定由 owner 审核合并；本补丁不自动合并 main、不降低 PR/CI/环境门禁。

本控制候选的 GitHub CI 结果应以准确 PR 检查为准。Server 业务开发验收为1199单元/契约、461隔离集成通过（4跳过），与本控制 PR 和实际发布结果分别计证。发布后再记录五阶段、实际 SHA/镜像/健康；不把本地或主分支准备检查当成测试服已升级。
