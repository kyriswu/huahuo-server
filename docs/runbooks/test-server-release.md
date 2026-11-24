# 测试服务器发布

测试发布正在切换到阿里云账号 `1472289886746775` 的 ACK 集群。迁移期间，`test` 分支继续运行 Server CI，部署暂停。

## ACK 发布恢复条件

1. 在目标云账号确认共享 GitHub OIDC Provider `github-actions`、Server 专用 RAM 角色和 Node01 固定云助手命令匹配。角色信任要求本仓库的 `environment:test` OIDC subject。
2. 核对 Node01 的测试 ACK context、应用配置及当前成功发布记录。准备通过同一 SHA 的 push CI、满足发布计划前置条件的 `test` 候选。
3. 按审查流程合入 [ACK 发布工作流](https://github.com/kyriswu/huahuo-server/pull/57)，从受保护的 `main` 手动运行。核对目标提交、镜像 digest、ACK 实际部署和测试入口健康后，再启用 `TEST_ACK_AUTO_RELEASE`。

工作流的变量、权限和宿主校验见 [ACK 发布说明](https://github.com/kyriswu/huahuo-server/blob/codex/test-ack-rolling-release/deploy/k8s/test-workflow.md)。发布计划、迁移和恢复约定见[标准发布](standard-release.md)。已完成的历史验收见[验收记录](../acceptance/standard-release.md)。
