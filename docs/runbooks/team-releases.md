# 团队发布

测试发布入口正在迁移到 ACK。当前 `test` 推送只运行 CI，发布恢复条件见[测试服务器发布](test-server-release.md)。

## 分支与环境的含义

- `main` 是受保护的发布控制分支。
- `test` 是 Git 分支：提供测试服务器实际运行的业务代码和本期发布清单，镜像按选定的 test 提交构建。
- 测试／生产环境是部署目标及各自配置，不是分支名称；正式生产尚未接入，不能从 main 的存在推定生产已部署。

团队通过 PR 合入 `test`，等待合并提交的 push CI。main/test 同步通过 PR 完成，本地开发使用 `test`。

## 权限与当前状态

| 操作 | 已保存的权限限制 |
| --- | --- |
| 合入 `test` | 团队按已配置的 PR 和 CI 规则合并 |
| 发布测试 | 暂停，恢复步骤见[测试服务器发布](test-server-release.md) |
| 合入 `main` | 只有 owner |
| 生产发布 | 人工发起，必须 owner 批准 |

main/test 分支规则已保存并通过 API 回读。main 的原规则仍要求 PR、strict `Server CI`、禁止删除/强推且无 bypass；独立的 owner-update 规则只给本仓库 owner 管理员 PR-only 例外。这个例外只针对 update 限制，不绕过原来的 PR 或 CI，owner 也须走满足检查的 PR。test 要求 PR、strict `Server CI`、禁止删除/强推且无 bypass，团队可按 PR 合并。

`test` 和 `production` 两个 environment 均只允许 `main` 分支，管理员绕过已关闭。Production reviewer 为 `kyriswu`，允许本人发起后本人批准。

上述权限配置尚未用真实协作者账号做拒绝操作的反向实测。历史验收证据见[手动发布验收](../acceptance/manual-release.md)。

## 发布 Skill 审核保护

`.github/CODEOWNERS` 只指定 `/.agents/skills/huahuo-release/` 与 `/.github/CODEOWNERS` 归 `@kyriswu` 审核，没有把 `.agents/skills/` 整体设为专属。新增其他 Skill 与普通业务代码不增加 owner 审核要求。

配套规则 `release-skill-owner-review` 面向 main/test，要求 Code Owner 审核、推新提交后旧审核失效，通用审批人数为 0；它与原有 PR、CI、禁止强推规则叠加。仅 kyriswu 本人允许通过 PR 操作这条新增审核规则，避免自己发起的 PR 无法自己审批；命令行直推不在此例外中，原有 CI 仍不可绕过。规则文件也受自身保护。规则保存与 CODEOWNERS 合入目标分支后共同生效，不能仅凭文件存在宣称权限已启用；尚未使用真实协作者做拒绝测试。

## 发布测试版本

1. 用测试环境实际成功 SHA 整理本期影响，准备 release plan 与 PR 上线清单。业务、SQL、ENV 变化必须修改 `scripts/release/plan.json`；计划更新表达本次需要发布，原数据库/配置/兼容验收仍执行。
2. 创建 test PR 后启用 GitHub 原生 Auto-merge；CI 与负责人审核满足后由 GitHub 合并。AI 可直接设置，无需 owner 对普通 test 业务逐次确认。发布控制变更与 Skill 先由 owner 审核合入 main，再同步 test；main 不自动合并。
3. 核对合并提交的 push CI 和 `release:review` 输出。兼容项存在 `false` 的候选应先完成发布前置条件。
4. 按[测试服务器发布](test-server-release.md)完成 ACK 切换与验收。CI 结果和发布结果分别记录。

### 飞书 CI 通知

受保护的 `main` 上的 `Notify Feishu of test CI` 监听本仓库推送到 `test` 的 `Server CI` 终态。成功显示绿色标题，失败显示红色标题。卡片包含分支、短提交 SHA、北京时间起止和耗时、本次变更，以及 GitHub Actions 和关联 PR 的文字链接。失败时优先展示同一次运行尝试中的失败任务、步骤和已知原因，并说明这次 CI 未执行部署。PR 检查、手动 CI 和已取消的运行不发卡片。

将发布通知群机器人的地址配置为仓库 Actions Secret `FEISHU_CI_WEBHOOK_URL`。机器人开启签名时，另配置 `FEISHU_CI_SIGNING_SECRET`。这两个 Secret 专用于 CI 通知，测试验证码使用自己的机器人配置。通知工作流须位于默认分支；地址缺失时，通知日志会记录跳过。

飞书接受消息后，独立的通知工作流记录 `FEISHU_CI_NOTIFICATION_ACCEPTED`。HTTP 或飞书业务错误记录在通知工作流，CI 原结果独立保留。发送超时且投递结果未知时，先检查群内是否已收到卡片，再决定是否重新运行通知。 [飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)

## main 的自动准备与生产门禁

owner 合入 main 后，main push CI 成功自动触发 `Main release readiness`。只复核准确 CI/main SHA 并生成 plan id、角色、迁移数量和配置键摘要，不输出真实配置值。生产尚未接入：基准仍未初始化，不取得生产身份、执行生产迁移或更新容器。

可选的 `verify_approval` 只演练已有 production 的 owner 审批门禁，使用 `deployment:false`，不会生成 GitHub 生产部署记录，也不访问服务器。生产接入后需在同一 owner 审批边界后连接真实发布执行器；当前准备成功不等于生产发布成功。

## 共享资源与进度

本地开发与测试服务共用数据库及云资源，本地结构变更会立即影响测试旧服务，须先确认兼容。迁移阶段始终保留：核对编号和 checksum 后，无 pending 显示“无需执行”，有 pending 执行已审 SQL，差异则停止。不得改历史 checksum 或清空共享库来消除冲突。CI 使用独立临时 PG/Redis，不调用真实付费业务。

进入远端发布后显示五阶段：**1 预检（含构建、配置）→ 2 迁移 → 3 迁移验收 → 4 容器切换退出 → 5 冒烟清理**。此前的源分支、CI、checkout 或 OIDC 校验失败显示在对应 Actions 步骤，远端发布尚未开始。收到阶段记录后的失败结果列出已完成 N/5、当前失败阶段和未执行项；仅有终态证据时只做终态复核，不补造阶段通过记录。`OK_WITH_FORCED_DRAIN` 明确表示发生过到期强退，不代表旧工作全部自然完成。

失败或超时先查本次调用及实际服务状态，不直接重复触发。详细迁移、配置、退出和恢复规则见[标准发布](standard-release.md)；接口与实际验证边界见[测试服务器发布](test-server-release.md)和[验收记录](../acceptance/standard-release.md)。
