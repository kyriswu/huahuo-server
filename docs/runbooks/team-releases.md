# 团队发布

## 分支与环境的含义

- `main` 是 Git 分支：当前提供受保护的发布 workflow、调用器、依赖及 Compose 等部署控制文件。下文“从 main 启动 Action”表示执行 main 中的流程，不表示测试业务代码来自 main。
- `test` 是 Git 分支：提供测试服务器实际运行的业务代码和本期发布清单，镜像按选定的 test 提交构建。
- 测试／生产环境是部署目标及各自配置，不是分支名称；正式生产尚未接入，不能从 main 的存在推定生产已部署。

操作示例：GitHub Action 选择 **main** → 运行 main 的 workflow → 校验 **test** 的提交与 CI → 将该 test 版本部署到测试服务器。业务 SHA 与流程控制 SHA 分别记录。

`main` 是受保护的发布流程来源，`test` 是测试服务器的业务代码来源。团队通过 PR 合入 test，等待 test 的同 SHA push CI，GitHub 原生 Auto-merge 合并后，test push CI 成功自动触发 main 中的发布 workflow，无需逐次人工点击。main/test 同步通过 PR 完成，不强推受保护分支；本地开发使用 test。

## 权限与当前状态

| 操作 | 已保存的权限限制 |
| --- | --- |
| 合入 `test` | 团队按已配置的 PR 和 CI 规则合并并部署 |
| 发布测试 | test push CI 成功自动触发 main 发布流程；手动入口仅作恢复 |
| 合入 `main` | 只有 owner |
| 生产发布 | 人工发起，必须 owner 批准 |
| 测试 Action 的来源与目标 | 从 `main` 发起，使用 `test` environment；继续部署原测试机 |

main/test 分支规则已保存并通过 API 回读。main 的原规则仍要求 PR、strict `Server CI`、禁止删除/强推且无 bypass；独立的 owner-update 规则只给本仓库 owner 管理员 PR-only 例外。这个例外只针对 update 限制，不绕过原来的 PR 或 CI，owner 也须走满足检查的 PR。test 要求 PR、strict `Server CI`、禁止删除/强推且无 bypass，团队可按 PR 合并。

test/production 两个 environment 均只允许 main 分支、0 个标签，管理员绕过关闭；production reviewer 仅 `kyriswu`，允许本人发起后本人批准。RAM 使用 `environment:test` subject，旧分支 subject 已移除。本次仅调整原测试发布的代码来源，不改变环境、云角色、保存命令或服务器目标。

上述权限配置尚未用真实协作者账号做拒绝操作的反向实测。test 业务/main 控制流程已通过本次真实发布验收，新增配置断言入口也已随镜像发布；自动执行授权不降低既有验收要求。Skill 是准备指南，GitHub 权限才执行强制限制。本次不接正式生产，也不增加生产发布入口。分项证据见[手动发布验收](../acceptance/manual-release.md)。

## 发布 Skill 审核保护

`.github/CODEOWNERS` 只指定 `/.agents/skills/huahuo-release/` 与 `/.github/CODEOWNERS` 归 `@kyriswu` 审核，没有把 `.agents/skills/` 整体设为专属。新增其他 Skill 与普通业务代码不增加 owner 审核要求。

配套规则 `release-skill-owner-review` 面向 main/test，要求 Code Owner 审核、推新提交后旧审核失效，通用审批人数为 0；它与原有 PR、CI、禁止强推规则叠加。仅 kyriswu 本人允许通过 PR 操作这条新增审核规则，避免自己发起的 PR 无法自己审批；命令行直推不在此例外中，原有 CI 仍不可绕过。规则文件也受自身保护。规则保存与 CODEOWNERS 合入目标分支后共同生效，不能仅凭文件存在宣称权限已启用；尚未使用真实协作者做拒绝测试。

## 发布测试版本

1. 用测试环境实际成功 SHA 整理本期影响，准备 release plan 与 PR 上线清单。业务、SQL、ENV 变化必须修改 `scripts/release/plan.json`；计划更新表达本次需要发布，原数据库/配置/兼容验收仍执行。
2. 创建 test PR 后启用 GitHub 原生 Auto-merge；CI 与负责人审核满足后由 GitHub 合并。AI 可直接设置，无需 owner 对普通 test 业务逐次确认。发布控制变更与 Skill 先由 owner 审核合入 main，再同步 test；main 不自动合并。
3. 合并后的准确 test SHA 完成 push CI，main 的 `Test server release` 经 workflow_run 自动启动。main 提供控制代码、调用器、依赖及 Compose，test 提供业务及清单；GitHub 自动提供只读 API token，云身份仍用原 OIDC，不新增长期令牌。
4. 自动入口验证 CI 类型/分支/仓库/运行 ID、当前双 SHA 与合并 PR 的完整文件清单。修改 release plan 的候选进入既有五阶段；只含文档/归属/已知控制文件的同步跳过应用部署。业务变更缺 plan 更新则失败，不能当作无变化。重命名也检查原路径，文件清单不完整则拒绝。
5. 发布串行且不取消正在排空的发布；旧候选过期就停止。只有终态和验收通过才记录成功。CI 成功与发布成功分别记录。

`workflow_dispatch` 作为显式恢复入口保留，仍从 main 发起、选择准确 test SHA 并验证 push CI；它不跳过配置、迁移或旧服务排空。发布失败不因后续文档提交自动重发，应先核对已有调用、实际容器和已提交迁移，再决定修复或重试。

## main 的自动准备与生产门禁

owner 合入 main 后，main push CI 成功自动触发 `Main release readiness`。只复核准确 CI/main SHA 并生成 plan id、角色、迁移数量和配置键摘要，不输出真实配置值。生产尚未接入：基准仍未初始化，不取得生产身份、执行生产迁移或更新容器。

可选的 `verify_approval` 只演练已有 production 的 owner 审批门禁，使用 `deployment:false`，不会生成 GitHub 生产部署记录，也不访问服务器。生产接入后需在同一 owner 审批边界后连接真实发布执行器；当前准备成功不等于生产发布成功。

## 共享资源与进度

本地开发与测试服务共用数据库及云资源，本地结构变更会立即影响测试旧服务，须先确认兼容。迁移阶段始终保留：核对编号和 checksum 后，无 pending 显示“无需执行”，有 pending 执行已审 SQL，差异则停止。不得改历史 checksum 或清空共享库来消除冲突。CI 使用独立临时 PG/Redis，不调用真实付费业务。

进入远端发布后显示五阶段：**1 预检（含构建、配置）→ 2 迁移 → 3 迁移验收 → 4 容器切换退出 → 5 冒烟清理**。此前的源分支、CI、checkout 或 OIDC 校验失败显示在对应 Actions 步骤，远端发布尚未开始。收到阶段记录后的失败结果列出已完成 N/5、当前失败阶段和未执行项；仅有终态证据时只做终态复核，不补造阶段通过记录。`OK_WITH_FORCED_DRAIN` 明确表示发生过到期强退，不代表旧工作全部自然完成。

失败或超时先查本次调用及实际服务状态，不直接重复触发。详细迁移、配置、退出和恢复规则见[标准发布](standard-release.md)；接口与实际验证边界见[测试服务器发布](test-server-release.md)和[验收记录](../acceptance/standard-release.md)。
