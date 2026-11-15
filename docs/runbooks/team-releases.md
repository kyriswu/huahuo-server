# 团队发布

`main` 是 Git 分支，不是另一个服务器。本方案用 owner 保护的 `main` 保存发布控制代码；测试业务取 `test`，生产业务计划取 owner 合入 `main` 的版本。两个环境都遵循“人工 Merge → CI 通过 → 人工 Action”，合并和 CI 都不自动发布。

## 权限与当前状态

| 操作 | 预期执行者与限制 |
| --- | --- |
| 合入 `test`、人工发布测试 | 已授权团队成员，先经过 PR 和 CI |
| 合入 `main` | 只有 owner |
| 生产发布 | 人工发起，必须 owner 批准 |
| 测试 Action 的流程来源 | 从 `main` 发起，使用 `test` environment；环境只允许 `main` |

已核对的部分：`test` environment 仅允许 `main` 分支、0 个标签，管理员绕过关闭；RAM 已切换到 `environment:test` subject 并移除旧分支 subject。新宿主入口已安装并核对完整性和权限，四角色未重启。

`main`/`test` 分支规则和生产 environment 审批仍在设置，新的手动发布也尚未执行。仓库内 Skill 是准备指南，GitHub 权限才执行强制限制；不能把部分配置完成当作整套方案已通过。生产服务器、专用云角色及真实发布入口还未接入，目前不能执行生产发布。分项证据见[手动发布验收](../acceptance/manual-release.md)。

## 发布测试版本

1. 从测试环境实际成功 SHA 整理本期代码、配置和迁移影响，更新发布清单及验收，提交 PR。
2. 人工合入 `test`，等待该 SHA 的 push `Server CI` 成功。
3. 在 Actions 选择 `Test server release`，从 `main` 人工运行。这里选择的是流程代码所在分支；业务版本由流程读取 `test` 当前最新 SHA，若它未通过对应 push CI 就拒绝，不改选更早的成功版本。
4. 查看阶段进度与结果。流程还会核对 `main` 和选中的 `test` 未移动；若已移动，等待新提交检查完成后重新准备，不能强行发布旧候选。

工作流、云调用器及其依赖从受保护的 `main` 执行，不 checkout `test` 的控制代码取得云身份。Compose 同样由 owner 控制的 `main` 提供，并要求 `test` 中的 Compose 字节一致。控制配置需要改动时，先由 owner 合入 `main`，再同步到 `test`；不一致会拒绝，不会静默忽略。

## 共享资源与进度

本地开发与测试服务共用数据库及云资源，本地结构变更会立即影响测试旧服务，须先确认兼容。迁移阶段始终保留：核对编号和 checksum 后，无 pending 显示“无需执行”，有 pending 执行已审 SQL，差异则停止。不得改历史 checksum 或清空共享库来消除冲突。CI 使用独立临时 PG/Redis，不调用真实付费业务。

进入远端发布后显示五阶段：**1 预检（含构建、配置）→ 2 迁移 → 3 迁移验收 → 4 容器切换退出 → 5 冒烟清理**。此前的源分支、CI、checkout 或 OIDC 校验失败显示在对应 Actions 步骤，远端发布尚未开始。收到阶段记录后的失败结果列出已完成 N/5、当前失败阶段和未执行项；仅有终态证据时只做终态复核，不补造阶段通过记录。`OK_WITH_FORCED_DRAIN` 明确表示发生过到期强退，不代表旧工作全部自然完成。

失败或超时先查本次调用及实际服务状态，不直接重复触发。详细迁移、配置、退出和恢复规则见[标准发布](standard-release.md)；接口与实际验证边界见[测试服务器发布](test-server-release.md)和[验收记录](../acceptance/standard-release.md)。
