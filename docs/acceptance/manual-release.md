# 人工发布与权限分工验收（2026-11-15）

本期将测试发布改为人工 Merge 后再人工 Action，分离受 owner 保护的 `main` 控制代码和 `test` 业务候选，补充远端五阶段进度。候选编号为 `20261115-manual-release`，实际成功基准为 `f80a0c2d498d5ade321c1d1675c76a9a1b7559a9`；该基准的真实测试机发布及到期强退事实见[标准发布验收](standard-release.md)。

本期没有新增 SQL、业务结构或应用 ENV 变化，迁移清单为 `[]`，配置使用 `reuse`。既有 0001/0002 保持冻结；流水线仍核对实际编号和 checksum，无 pending 才显示“无需执行”，并保留后续数据库验收。本地开发与测试共享的数据库不属于 CI 清理范围。

## 已完成的本地验证

- 737 项 unit/contract、Typecheck、Lint、Build 通过。这些是候选代码的本地结果，不是新云身份或真实发布通过。
- 本轮真实隔离 PostgreSQL/Redis：21 个文件、275 项通过，1 项既有 Milvus 用例跳过。按新基准 f80 到候选执行 SQL 2→2 演练，`applied=[]`、`replayApplied=[]`；执行器已清理本次自有临时容器和凭据，没有删除数据卷或连接共享业务库。
- 来源校验覆盖：仅允许从 main 手动发起；业务 SHA 必须为 test 当前最新完整 SHA，且同 SHA 的 push CI 成功；控制代码保持为发起时 main SHA，调用前再次核对两分支未移动。OIDC 校验绑定 test environment、main ref、手动事件及控制 SHA。
- 宿主控制流 48 项 mock 演练通过；这是替身控制流证据，不等同于真实 Docker、云助手或 GitHub 权限验证。
- Skill 的 `quick_validate` 静态检查通过；它验证技能文件结构，不代表云身份、权限或真实发布已经通过。
- 五阶段进度区分预检、迁移、迁移验收、容器切换退出、冒烟清理；失败保留完成项数、失败位置和未执行项，只有终态证据时不补造阶段通过记录。进入远端前的来源、CI 或 OIDC 失败由 Actions 对应步骤显示，远端发布未开始。

## 已完成的配置与安装核对

- GitHub 分支规则已保存并通过 API 回读：原 main 规则 `27305183` 保持 PR、strict `Server CI`、禁止删除/强推且无 bypass；新增 `main-owner-merge`（`27310844`）精确匹配 main，其 update 限制仅给 `RepositoryRole 5` 的 PR-only 例外。该个人仓库的管理员即 owner；例外只属于新增的 update 限制，不绕过原规则的 PR、CI 或删除/强推保护。
- `test-release-protection`（`27310971`）精确匹配 test，要求 PR、strict `Server CI`，禁止删除/强推，无 bypass；团队成员按 PR 流程合并。test 分支尚未初建，不代表规则尚未配置。
- GitHub `test`、`production` 两个 environment 均已实际保存：仅允许 main 分支，允许标签数为 0，管理员绕过关闭。production reviewer 只有 `kyriswu`，`prevent-self-review` 关闭，以允许 owner 本人发起后本人批准；这不等于生产发布目标已接入。
- RAM 信任已更新为本仓库 `environment:test` subject 并回读核对，旧分支 subject 已移除；5400 秒会话上限及原权限 Policy 保持不变，没有扩大云资源权限。
- 新宿主入口已安装，内容 hash、0700 权限及发布锁空闲状态核对通过；四个运行角色未重启。这是安装核对，不是本期候选已经部署。

## PR 与待验项目

[PR #4](https://github.com/kyriswu/huahuo-server/pull/4) 已创建，首个候选提交 `dce2dca` 的 [Server CI 43709616888](https://github.com/kyriswu/huahuo-server/actions/runs/43709616888) 成功。后续提交按各自 SHA 重跑检查，是否可合并以 PR 当前提交的检查结果为准。

新手动流程尚未合并或运行。首次启用顺序为：用户人工 Merge PR #4 → main 该 SHA 的 CI 成功 → 初建 test 分支指向这个已审已测的 main 提交 → test push CI 成功 → 用户从 main 人工 Run workflow。这是一次性分支初始化；之后 test 的业务变更照常通过 PR 合并。

权限配置、RAM 信任和宿主安装已分别留证，但尚未使用实际协作者账号做禁止操作的反向实测，不能宣称已经验证拒绝结果。新手动流程的真实身份交换、test 来源、main Compose 字节一致性和发布结果仍需通过实际 Action 留证，不能用配置保存、本地测试或旧发布结果替代。

生产尚未接入服务器、专用云角色及真实发布入口。专用认证冒烟凭据仍按既定范围暂缓，本期清单采用测试环境已接受的 health 范围；不宣称认证业务或生产发布通过。真实发布后应补充 main 控制 SHA、test 业务 SHA、对应 CI/Action、实际五阶段或终态证据、镜像与迁移结果，以及有无 `OK_WITH_FORCED_DRAIN`。

操作步骤见[团队发布](../runbooks/team-releases.md)，执行与恢复原则见[标准发布](../runbooks/standard-release.md)。本期结果不覆盖旧阶段的测试数量和初次失败记录。
