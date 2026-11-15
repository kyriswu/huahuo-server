# 团队发布

## 分支与环境的含义

- `main` 是 Git 分支：当前提供受保护的发布 workflow、调用器、依赖及 Compose 等部署控制文件。下文“从 main 启动 Action”表示执行 main 中的流程，不表示测试业务代码来自 main。
- `test` 是 Git 分支：提供测试服务器实际运行的业务代码和本期发布清单，镜像按选定的 test 提交构建。
- 测试／生产环境是部署目标及各自配置，不是分支名称；正式生产尚未接入，不能从 main 的存在推定生产已部署。

操作示例：GitHub Action 选择 **main** → 运行 main 的 workflow → 校验 **test** 的提交与 CI → 将该 test 版本部署到测试服务器。业务 SHA 与流程控制 SHA 分别记录。

`main` 是受保护的发布流程来源，`test` 是测试服务器的业务代码来源。团队通过 PR 合入 test，等待 test 的同 SHA push CI，通过 main 中的手动 Action 发布该 test SHA。main/test 同步通过 PR 完成，不强推受保护分支；本地开发使用 test。

## 权限与当前状态

| 操作 | 已保存的权限限制 |
| --- | --- |
| 合入 `test` | 团队按已配置的 PR 和 CI 规则合并并部署 |
| 人工发布测试 | 从 main 手动发起，部署已通过 CI 的 test SHA |
| 合入 `main` | 只有 owner |
| 生产发布 | 人工发起，必须 owner 批准 |
| 测试 Action 的来源与目标 | 从 `main` 发起，使用 `test` environment；继续部署原测试机 |

main/test 分支规则已保存并通过 API 回读。main 的原规则仍要求 PR、strict `Server CI`、禁止删除/强推且无 bypass；独立的 owner-update 规则只给本仓库 owner 管理员 PR-only 例外。这个例外只针对 update 限制，不绕过原来的 PR 或 CI，owner 也须走满足检查的 PR。test 要求 PR、strict `Server CI`、禁止删除/强推且无 bypass，团队可按 PR 合并。

test/production 两个 environment 均只允许 main 分支、0 个标签，管理员绕过关闭；production reviewer 仅 `kyriswu`，允许本人发起后本人批准。RAM 使用 `environment:test` subject，旧分支 subject 已移除。本次仅调整原测试发布的代码来源，不改变环境、云角色、保存命令或服务器目标。

上述权限配置尚未用真实协作者账号做拒绝操作的反向实测。原 test 候选方案已完成一次真实手动发布；本次恢复 test 候选及新增配置断言须另行合并和验收，不能用上次成功代替。Skill 是准备指南，GitHub 权限才执行强制限制。本次不接正式生产，也不增加生产发布入口。分项证据见[手动发布验收](../acceptance/manual-release.md)。

## 发布测试版本

1. 从测试环境实际成功 SHA 整理代码、配置和迁移影响，使用发布技能和 PR 模板提交上线清单。
2. 流程变更先由 owner 合入 main；业务变更合入 test。需要同步时先 main → test 的 PR，等待 test push CI 成功。
3. Actions 选择 `Test server release`，分支 main，人工 Run workflow。主分支提供调用器、依赖及 Compose，test 提供业务候选与清单；分别固定完整 SHA。
4. 调用前与宿主锁内核对双方未移动，失败停止，不自动换候选。查看五阶段结果后才记录该测试环境成功版本。

正式生产尚未接入，成功部署基准为“未初始化”（null），不拿 main Git HEAD 或测试成功记录冒充生产部署。测试成功记录仍保留实际 SHA、配置及迁移历史；分支同步不会重置环境或数据库。

## 共享资源与进度

本地开发与测试服务共用数据库及云资源，本地结构变更会立即影响测试旧服务，须先确认兼容。迁移阶段始终保留：核对编号和 checksum 后，无 pending 显示“无需执行”，有 pending 执行已审 SQL，差异则停止。不得改历史 checksum 或清空共享库来消除冲突。CI 使用独立临时 PG/Redis，不调用真实付费业务。

进入远端发布后显示五阶段：**1 预检（含构建、配置）→ 2 迁移 → 3 迁移验收 → 4 容器切换退出 → 5 冒烟清理**。此前的源分支、CI、checkout 或 OIDC 校验失败显示在对应 Actions 步骤，远端发布尚未开始。收到阶段记录后的失败结果列出已完成 N/5、当前失败阶段和未执行项；仅有终态证据时只做终态复核，不补造阶段通过记录。`OK_WITH_FORCED_DRAIN` 明确表示发生过到期强退，不代表旧工作全部自然完成。

失败或超时先查本次调用及实际服务状态，不直接重复触发。详细迁移、配置、退出和恢复规则见[标准发布](standard-release.md)；接口与实际验证边界见[测试服务器发布](test-server-release.md)和[验收记录](../acceptance/standard-release.md)。
