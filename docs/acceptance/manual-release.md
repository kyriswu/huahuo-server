# 人工发布与权限分工验收（2026-11-15）

首轮将测试发布改为人工 Merge 后再人工 Action，分离受 owner 保护的 `main` 控制代码和 `test` 业务候选，补充远端五阶段进度。该轮候选编号为 `20261115-manual-release`，发布前成功基准为 `f80a0c2d498d5ade321c1d1675c76a9a1b7559a9`；该基准的真实测试机发布及到期强退事实见[标准发布验收](standard-release.md)。下文保留首轮证据，并分别记录后续调整，不将候选代码等同于已经上线。

首轮没有新增 SQL、业务结构或应用 ENV 变化，迁移清单为 `[]`，配置使用 `reuse`。既有 0001/0002 保持冻结；流水线仍核对实际编号和 checksum，无 pending 才显示“无需执行”，并保留后续数据库验收。本地开发与测试共享的数据库不属于 CI 清理范围。后续业务候选的变化以各自发布清单为准。

## 首轮本地验证

- 737 项 unit/contract、Typecheck、Lint、Build 通过。这些是候选代码的本地结果，不是新云身份或真实发布通过。
- 本轮真实隔离 PostgreSQL/Redis：21 个文件、275 项通过，1 项既有 Milvus 用例跳过。按新基准 f80 到候选执行 SQL 2→2 演练，`applied=[]`、`replayApplied=[]`；执行器已清理本次自有临时容器和凭据，没有删除数据卷或连接共享业务库。
- 来源校验覆盖：仅允许从 main 手动发起；业务 SHA 必须为 test 当前最新完整 SHA，且同 SHA 的 push CI 成功；控制代码保持为发起时 main SHA，调用前再次核对两分支未移动。OIDC 校验绑定 test environment、main ref、手动事件及控制 SHA。
- 宿主控制流 48 项 mock 演练通过；这是替身控制流证据，不等同于真实 Docker、云助手或 GitHub 权限验证。
- Skill 的 `quick_validate` 静态检查通过；它验证技能文件结构，不代表云身份、权限或真实发布已经通过。
- 五阶段进度区分预检、迁移、迁移验收、容器切换退出、冒烟清理；失败保留完成项数、失败位置和未执行项，只有终态证据时不补造阶段通过记录。进入远端前的来源、CI 或 OIDC 失败由 Actions 对应步骤显示，远端发布未开始。

## 已完成的配置与安装核对

- GitHub 分支规则已保存并通过 API 回读：原 main 规则 `27305183` 保持 PR、strict `Server CI`、禁止删除/强推且无 bypass；新增 `main-owner-merge`（`27310844`）精确匹配 main，其 update 限制仅给 `RepositoryRole 5` 的 PR-only 例外。该个人仓库的管理员即 owner；例外只属于新增的 update 限制，不绕过原规则的 PR、CI 或删除/强推保护。
- `test-release-protection`（`27310971`）精确匹配 test，要求 PR、strict `Server CI`，禁止删除/强推，无 bypass；团队成员按 PR 流程合并。test 分支后续已用于首轮真实发布，本次不删除或改变该分支。
- GitHub `test`、`production` 两个 environment 均已实际保存：仅允许 main 分支，允许标签数为 0，管理员绕过关闭。production reviewer 只有 `kyriswu`，`prevent-self-review` 关闭，以允许 owner 本人发起后本人批准；这不等于生产发布目标已接入。
- RAM 信任已更新为本仓库 `environment:test` subject 并回读核对，旧分支 subject 已移除；5400 秒会话上限及原权限 Policy 保持不变，没有扩大云资源权限。
- 新宿主入口已安装，内容 hash、0700 权限及发布锁空闲状态核对通过；四个运行角色未重启。这是安装核对，不是本期候选已经部署。

## 首轮真实手动发布

[PR #4](https://github.com/kyriswu/huahuo-server/pull/4) 已创建，首个候选提交 `dce2dca` 的 [Server CI 43709616888](https://github.com/kyriswu/huahuo-server/actions/runs/43709616888) 成功。后续提交按各自 SHA 重跑检查，是否可合并以 PR 当前提交的检查结果为准。

随后 [Action 43713175343](https://github.com/kyriswu/huahuo-server/actions/runs/43713175343) 真实执行了首轮手动流程，部署 SHA 为 `0771fd501fc3d4b7d257979032ed753492625b8b`。针对同一固定云助手调用的只读查询确认五阶段全部通过、云状态 `Success`、终态 `complete/passed/OK_WITH_FORCED_DRAIN`。发生了预算到期后的强制停止，不能表述为旧工作全部自然完成。终态输出 SHA-256 为 `d046acc7a24e2186d07b710cfd9e726825273265f75d655c0055826ceff12494`；本地脱敏结果保存在 `/tmp/huahuo-current-release-progress.json`，临时文件不作为永久唯一证据。

权限配置、RAM 信任和宿主安装已分别留证，但尚未使用实际协作者账号做禁止操作的反向实测，不能宣称已经验证拒绝结果。首轮运行证明当时的 test 来源流程可执行，不自动证明后续不同来源或不同业务候选已验证。

专用认证冒烟凭据仍按既定范围暂缓，首轮采用测试环境已接受的 health 范围；不宣称认证业务或生产发布通过。

## 历史尝试：原测试机直接使用 main（已停止采用）

当时用户明确不接正式生产，暂时让测试服务器直接部署 main。候选保留现有 `Test server release` 手动入口、`test` environment、OIDC subject、固定实例和保存命令；不创建 production workflow，不删除 test 分支，不修改云资源或 GitHub 设置。

当时的来源校验改为只读取 main：业务 SHA、控制 SHA、Compose SHA 均为发起时同一完整 SHA，必须有该 SHA 的 main push `Server CI` 成功记录。获取身份后、调用前重新确认 main 未移动；锁定的目标 SHA 不允许变为其他提交。test 分支的 SHA 和 CI 不再参与默认发布选择。宿主入口需同步只核对 main，唯一命令参数继续为 `sha`，五阶段及失败不自动重发规则不变。

这部分是新候选修改，须完成对应本地检查，并在 owner 人工 Merge、同 SHA CI 成功后再人工 Action 验收。候选修改或上面的首轮成功都不能视为本次已部署。

操作步骤见[团队发布](../runbooks/team-releases.md)，执行与恢复原则见[标准发布](../runbooks/standard-release.md)。本期结果不覆盖旧阶段的测试数量和初次失败记录。


## 当前规则：恢复 test 业务来源

PR #6/#7 已合并，main/test 代码树一致。测试业务 SHA 为 `5b844ba89e28032d4d47435d8727f9a4a0b143bc`，main 控制 SHA 为 `19a7f1841ec817d297846548d017358a76cca86e`；test push CI 已通过。宿主修复已安装回验，本地及服务器原部署目录均为干净 test。本次 [Action 43725571994](https://github.com/kyriswu/huahuo-server/actions/runs/43725571994) 已完成五阶段 5/5，结果为 `OK`，无到期强退。正式生产基准未初始化，测试历史不清空。
