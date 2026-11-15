# 团队发布

`main` 是 Git 分支，不是另一个服务器。按当前约定，已有测试服务器直接部署 owner 合入 `main` 的版本；流程代码、业务代码和 Compose 使用同一完整 SHA。遵循“人工 Merge → 同 SHA 的 CI 通过 → 从 main 人工 Action”，合并和 CI 都不自动发布。保留现有 `test` 分支，暂不将它作为发布候选；以后需要时再调整。

## 权限与当前状态

| 操作 | 已保存的权限限制 |
| --- | --- |
| 合入 `test` | 仍按已配置的 PR 和 CI 规则；暂不作为部署来源 |
| 人工发布测试 | 从 main 手动发起，部署该次 main SHA |
| 合入 `main` | 只有 owner |
| 生产发布 | 人工发起，必须 owner 批准 |
| 测试 Action 的来源与目标 | 从 `main` 发起，使用 `test` environment；继续部署原测试机 |

main/test 分支规则已保存并通过 API 回读。main 的原规则仍要求 PR、strict `Server CI`、禁止删除/强推且无 bypass；独立的 owner-update 规则只给本仓库 owner 管理员 PR-only 例外。这个例外只针对 update 限制，不绕过原来的 PR 或 CI，owner 也须走满足检查的 PR。test 要求 PR、strict `Server CI`、禁止删除/强推且无 bypass，团队可按 PR 合并。

test/production 两个 environment 均只允许 main 分支、0 个标签，管理员绕过关闭；production reviewer 仅 `kyriswu`，允许本人发起后本人批准。RAM 使用 `environment:test` subject，旧分支 subject 已移除。本次仅调整原测试发布的代码来源，不改变环境、云角色、保存命令或服务器目标。

上述权限配置尚未用真实协作者账号做拒绝操作的反向实测。原 test 候选方案已完成一次真实手动发布；本次 main 候选调整须另行合并和验收，不能用上次成功代替。Skill 是准备指南，GitHub 权限才执行强制限制。本次不接正式生产，也不增加生产发布入口。分项证据见[手动发布验收](../acceptance/manual-release.md)。

## 发布测试版本

1. 从测试环境实际成功 SHA 整理本期代码、配置和迁移影响，更新发布清单及验收，提交 PR。
2. 由 owner 按 PR 规则人工合入 `main`，等待该 SHA 的 push `Server CI` 成功。
3. 在 Actions 选择 `Test server release`，从 `main` 人工运行。流程只接受发起时的完整 main SHA，且必须有同 SHA 的 main push CI 成功记录；不改选更早的成功版本，也不读取 test 最新提交。
4. 查看阶段进度与结果。获取身份后、调用前再次核对 `main` 未移动，宿主在发布锁内也核对该 SHA。若 main 已移动，等待新提交检查完成后重新准备，不自动切换候选。

工作流、云调用器、依赖、Compose 和业务代码都来自同一受保护的 `main` SHA。现有 `test` 分支的存在、提交内容和 CI 状态不参与这次选择。测试机仍使用既有 `test` environment/OIDC 身份、固定实例和固定保存命令，唯一命令参数仍是 `sha`，不接受任意目标或 shell。

## 共享资源与进度

本地开发与测试服务共用数据库及云资源，本地结构变更会立即影响测试旧服务，须先确认兼容。迁移阶段始终保留：核对编号和 checksum 后，无 pending 显示“无需执行”，有 pending 执行已审 SQL，差异则停止。不得改历史 checksum 或清空共享库来消除冲突。CI 使用独立临时 PG/Redis，不调用真实付费业务。

进入远端发布后显示五阶段：**1 预检（含构建、配置）→ 2 迁移 → 3 迁移验收 → 4 容器切换退出 → 5 冒烟清理**。此前的源分支、CI、checkout 或 OIDC 校验失败显示在对应 Actions 步骤，远端发布尚未开始。收到阶段记录后的失败结果列出已完成 N/5、当前失败阶段和未执行项；仅有终态证据时只做终态复核，不补造阶段通过记录。`OK_WITH_FORCED_DRAIN` 明确表示发生过到期强退，不代表旧工作全部自然完成。

失败或超时先查本次调用及实际服务状态，不直接重复触发。详细迁移、配置、退出和恢复规则见[标准发布](standard-release.md)；接口与实际验证边界见[测试服务器发布](test-server-release.md)和[验收记录](../acceptance/standard-release.md)。
