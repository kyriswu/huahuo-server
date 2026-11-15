# 测试服务器人工触发发布接口

首次真实发布已在 [PR #2 的 Action](https://github.com/kyriswu/huahuo-server/actions/runs/43700035519/attempts/2) 通过，历史成功提交为 `1f7adfdaf02dd6d0733f7afa7f87a25a7c3f07da`。后续标准化发布结果由[验收记录](../acceptance/standard-release.md)维护。本轮改为人工触发并拆分 `main` 控制代码与 `test` 业务候选；测试 environment、RAM 信任及宿主安装已核对，分支规则与生产审批仍在设置，新流程尚未真实发布。分项证据见[手动发布验收](../acceptance/manual-release.md)，团队步骤见[团队发布](team-releases.md)。

本流程用于已确认的北京 ECS 测试机，不等同于生产完整发布验收。`Server CI` 已在 [PR #1](https://github.com/kyriswu/huahuo-server/pull/1) 与合并后的 main 上真实通过。本轮预期通过 GitHub 分支规则和 environment 限制实现“团队操作测试、owner 合入 main 及批准生产”，不能用旧规则的验证结果代替新权限方案验收；生产目标和云角色尚未接入。

## 触发与身份

候选 `test-server-release.yml` 只有 `workflow_dispatch`，必须从 `main` 手动发起，使用 `test` environment。先人工合入 `test`，等待该提交 push 的 `Server CI` 成功，再人工点 Action；合并及 CI 完成不会自动发布。`Server CI` 同时覆盖 `main` 和 `test` 的 push。

Action 从 GitHub 读取 `test` 最新 SHA，核对它同 SHA 的 push CI 成功，作为业务候选；checkout、依赖安装和云调用器始终使用发起时受保护的 `main` SHA。获取身份后、调用前再次核对 `main` 和选中的 `test` 均未移动。发布串行，不自动取消正在执行的命令；失败后先核查已有调用，不能直接重复提交。

GitHub `test` environment 已实际保存为仅允许 `main` 分支、0 个标签，并关闭管理员绕过。RAM 信任已更新为此仓库的 `environment:test` subject 并回读，旧分支 subject 已移除；5400 秒会话上限和原权限 Policy 未改变。工作流另核对 `ref=main`、`event_name=workflow_dispatch` 和控制 SHA。新的手动 Action 身份交换尚未执行，配置核对不能替代真实运行验证。

每次运行交换短期 STS 凭据，GitHub 不保存长期 AK；候选使用 90 分钟会话。专用策略仍仅允许对指定实例和指定命令使用 `InvokeCommand` 与 `DescribeInvocationResults`，不授权启动/停止其他实例、修改 RAM 或任意创建命令。

本仓库创建于 2026-10-12，使用带 owner/repository 数字 ID 的默认 subject；workflow 同时验证 issuer、audience、subject、仓库和 ref。签名和授权最终由阿里云 STS 验证。OIDC 的 HTTPS CA 指纹按当前证书计算，换证后按阿里云要求更新，不能复制过期教程中的固定值。[GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) · [阿里云 OIDC](https://help.aliyun.com/en/ram/manage-an-oidc-idp)

## 仓库 Variables

| 名称 | 用途 |
| --- | --- |
| `TEST_RELEASE_REGION_ID` | 固定 `cn-beijing` |
| `TEST_RELEASE_INSTANCE_ID` | 已确认的 `i-2zegtoygiiked53yntmj` |
| `TEST_RELEASE_COMMAND_ID` | 一次性准备的固定云助手命令 ID |
| `TEST_RELEASE_OIDC_PROVIDER_ARN` | 专用 `github-actions-huahuo-server` Provider ARN |
| `TEST_RELEASE_ROLE_ARN` | 专用 `huahuo-server-test-release` Role ARN |

按用户选择，以上五项在 GitHub 仓库 Variables 中配置，并由 workflow 顶层 `env` 读取。均为非秘密标识；调用器及角色信任仍限制实际目标。固定命令为 `c-bj07369lkmmf8cg`。调用器只接受指定测试机、完整 40 位 SHA 和 STS 凭据，拒绝长期 AK；唯一命令参数为 `sha`，不从 workflow 输入接收任意 shell。

## 宿主结果协议

固定命令调用宿主维护的发布入口。宿主文件、入口配置和详细构建日志独立于本仓库；本仓库只保存调用接口。执行前宿主须在锁内核对业务 SHA 为当前 `test` 及计划实际成功基准。Compose 来自 owner 控制的 `main`，且 `test` 候选 Compose 必须字节一致；控制变更先 owner 合入 `main` 再同步 `test`，否则拒绝，不静默丢弃候选配置。使用已验证的配置快照与现有存储，不覆盖服务器未提交改动。候选代码停止读取、清单标记为非必需删除的旧 ENV 键可以保留在成功快照中，配置审查仍不可跳过。

以下是一条最终结果示例；五阶段进度使用固定脱敏报告，不转发原始命令输出：

```json
{"version":1,"sha":"完整40位提交SHA","stage":"complete","status":"passed","code":"OK"}
```

失败使用 `status:failed`、`code:FAILED`。只有云助手记录的实例/命令/调用 ID 一致、执行成功、退出 0、输出完整且 SHA 对应的 `complete/passed` 才可接受。普通成功使用 `OK`；`OK_WITH_FORCED_DRAIN` 表示检查通过但发生了预算到期强退，Action 必须显示警告。宿主成功记录中的 `forcedRetirements` 保留该事实，不能把它说成全部工作自然完成。

进入远端发布后，Action 展示五阶段：1 预检（含构建、配置）、2 迁移、3 迁移验收、4 容器切换退出、5 冒烟清理。此前的源分支、CI、checkout 或 OIDC 失败由对应 Actions 步骤显示，表示远端发布未开始。收到阶段记录后，失败展示已完成 N/5、当前失败阶段及后续未执行项；如果只有终态记录，只显示终态复核，不推断五步均已执行。

本地开发和测试服务当前共用数据库及云资源。迁移阶段保留：编号、checksum 均匹配且无 pending 时显示“无需执行”，存在 pending 就正常执行，差异停止。本地结构变更会即时影响测试旧服务，必须兼容；CI 继续使用独立临时 PG/Redis，不清共享库或调用真实付费业务。

最多调用一次 `InvokeCommand`。调用器上限为 90 分钟、最多轮询 1080 次；首次链路当时使用 20 分钟、240 次上限。调用失败或超时不自动重发；远端可能继续执行，须查看本次云助手记录与宿主日志，不能直接假设未部署。宿主锁须覆盖完整操作。Actions 日志仅固定阶段、状态、错误码、次数及耗时，不转发云端原始输出或凭据。

## 本轮候选的退出与时间预算

`deployment.drainTimeoutMs` 由数据库配置，默认 600000 毫秒，允许 10—60 分钟。首次排空固定本次预算，工作提前完成即退出，到期仍未完成则强制结束；应用以退出码 124 标识排空超时，提前失败仍按失败处理。Compose 3630 秒只是保护配置上限，实际预算取数据库值。首次升级的旧镜像仍有固有的 5 分钟/30 秒行为，新增键不能追溯改变旧代码。

候选 Action 上限为 100 分钟；STS 会话、保存命令与调用器均按 90 分钟衔接，宿主全程上限为 5300 秒。写库前必须确认剩余时间可覆盖六次退出预算加 600 秒预留，不足即拒绝，不缩短应用的配置预算。本轮新宿主入口已安装，内容 hash、0700 权限和发布锁空闲核对通过，四角色未重启；云端 5400 秒上限保持不变。新手动入口、分支和环境身份仍需通过实际发布验收，不能把安装或此前身份结果当作通过。

## 当前验收边界

首次接口准备时，调用器 48 项本地替身测试及全部 561 项 unit/contract、Lint/Typecheck 通过。这是当时的本地证据；本轮新增规则的验证范围与结果以[手动发布验收](../acceptance/manual-release.md)为准，标准化及排空预算的历史结果保留在[标准发布验收](../acceptance/standard-release.md)。

首次发布前，旧 `4e28a98` 镜像因初始化 SQL 校验和与数据库记录不同而 ready 503；该镜像不能记作上一健康版本。后来已真实完成 `1f7adfd` 的自动发布，不能再将当时“尚未执行发布”的准备状态作为当前结论。历史迁移与 checksum 仍冻结，不为恢复旧镜像重写它们。

最新实际成功版本以宿主记录和验收证据为准，不以 `main` 或 `test` 最新提交替代。测试 environment、RAM 信任及新宿主安装已完成分项核对；`main`/`test` 分支规则、生产 environment 审批仍在设置，本期候选尚未合并或部署。生产没有服务器、云角色或真实发布接入。专用账号的认证业务冒烟仍按用户要求暂缓，现有[默认冒烟](release-smoke.md)不跳过缺失凭据而假报成功；既有健康验收成功不等于认证业务已验证。
