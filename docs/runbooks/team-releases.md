# 团队发布

## 分支与环境的含义

- `main` 是 Git 分支：当前提供受保护的发布 workflow、调用器、依赖及 Compose 等部署控制文件。下文“从 main 启动 Action”表示执行 main 中的流程，不表示测试业务代码来自 main。
- `test` 是 Git 分支：提供测试服务器实际运行的业务代码和本期发布清单，镜像按选定的 test 提交构建。
- 测试／生产环境是部署目标及各自配置，不是分支名称；正式生产尚未接入，不能从 main 的存在推定生产已部署。

操作示例：GitHub Action 选择 **main** → 运行 main 的 workflow → 校验 **test** 的提交与 CI → 将该 test 版本部署到测试服务器。业务 SHA 与流程控制 SHA 分别记录。

`main` 是受保护的发布流程来源，`test` 是测试服务器的业务代码来源。团队通过 PR 合入 test，等待 test 的同 SHA push CI，通过 main 中的 workflow_dispatch 发布该 test SHA；AI／脚本可自动完成测试合并和触发，无需逐次人工点击。main/test 同步通过 PR 完成，不强推受保护分支；本地开发使用 test。

## 权限与当前状态

| 操作 | 已保存的权限限制 |
| --- | --- |
| 合入 `test` | 团队按已配置的 PR 和 CI 规则合并并部署 |
| 发布测试 | AI／脚本可从 main 自动触发，部署已通过 CI 的 test SHA |
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

1. 从测试环境实际成功 SHA 整理代码、配置和迁移影响，使用发布技能和 PR 模板提交上线清单。
2. 流程变更先由 owner 合入 main；业务检查通过后可由 AI／脚本锁定 PR head 自动合入 test。owner 已审 main 内容同步到 test 可自动合并，等待 test push CI 成功。
3. AI／脚本触发 `Test server release` 的 workflow_dispatch，流程来源 main，无需用户逐次点击；人工操作时也选择 main。主分支提供调用器、依赖及 Compose，test 提供业务候选与清单；分别固定完整 SHA。
4. 调用前与宿主锁内核对双方未移动，失败停止，不自动换候选。查看五阶段结果后才记录该测试环境成功版本。

正式生产尚未接入，成功部署基准为“未初始化”（null），不拿 main Git HEAD 或测试成功记录冒充生产部署。测试成功记录仍保留实际 SHA、配置及迁移历史；分支同步不会重置环境或数据库。

## 固定测试发布脚本

在已审 main 控制代码上运行：

```bash
node scripts/release/test-publish.mjs --pr <test目标PR编号>
# 进程中断后读取原状态续查，不重新触发
node scripts/release/test-publish.mjs --pr <编号> --resume
```

运行环境提供 `GH_TOKEN`（已有 GitHub App／用户授权身份），需要该仓库读取、PR/Contents 合并与 Actions 触发权限。不要用内置 GITHUB_TOKEN 完成合并：GitHub 会抑制它触发的 push CI，脚本会停在等待 CI 而不能发布；脚本不因此改用未经约定的 CI 事件或绕过检查。不在命令参数、仓库或日志中放令牌，脚本不绕过 GitHub 的分支/负责人规则。它只接受本仓库目标为 test 的 PR，锁定 head、检查 CI、调用合并 API、等待合并后的 test push CI，再从 main 触发固定测试 workflow 并按返回的 run ID 等待终态。main 保护、test Skill 负责人审核、云端固定实例及五阶段门禁不变。

发布 Skill/CODEOWNERS 只能自动同步 owner 已合入 main 的相同内容。纯文档/归属变更跳过应用部署；owner 已审 main 同步若仅额外包含这份发布控制器及其单测，也不重建应用。其他脚本、SQL、ENV 或业务变更不会进入此例外。程序保存 `.local/test-publish/pr-<编号>.json`，锁文件拒绝并发执行，状态原子更新；合并响应丢失可只读确认并续查。dispatch 响应不明确时保留 `dispatching` 并拒绝再次触发，须先核对已有 GitHub run；不删除状态盲目重跑。进程异常留下的锁也须确认无在途进程/发布后再处理。

脚本复用 workflow 的完整预检、迁移、验收、切流和冒烟。`deployment:passed` 表示该固定 workflow 终态成功，独立实机验收仍按 Skill 执行；本期脚本验证是本地 API fixture 与真实 Node 子进程验证，不能冒称脚本已经真实触发过线上发布。

## 共享资源与进度

本地开发与测试服务共用数据库及云资源，本地结构变更会立即影响测试旧服务，须先确认兼容。迁移阶段始终保留：核对编号和 checksum 后，无 pending 显示“无需执行”，有 pending 执行已审 SQL，差异则停止。不得改历史 checksum 或清空共享库来消除冲突。CI 使用独立临时 PG/Redis，不调用真实付费业务。

进入远端发布后显示五阶段：**1 预检（含构建、配置）→ 2 迁移 → 3 迁移验收 → 4 容器切换退出 → 5 冒烟清理**。此前的源分支、CI、checkout 或 OIDC 校验失败显示在对应 Actions 步骤，远端发布尚未开始。收到阶段记录后的失败结果列出已完成 N/5、当前失败阶段和未执行项；仅有终态证据时只做终态复核，不补造阶段通过记录。`OK_WITH_FORCED_DRAIN` 明确表示发生过到期强退，不代表旧工作全部自然完成。

失败或超时先查本次调用及实际服务状态，不直接重复触发。详细迁移、配置、退出和恢复规则见[标准发布](standard-release.md)；接口与实际验证边界见[测试服务器发布](test-server-release.md)和[验收记录](../acceptance/standard-release.md)。
