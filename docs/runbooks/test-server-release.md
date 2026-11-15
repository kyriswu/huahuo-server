# 测试服务器自动发布接口

首次真实自动发布已在 [PR #2 的 Action](https://github.com/kyriswu/huahuo-server/actions/runs/43700035519/attempts/2) 通过，目标实际成功提交为 `1f7adfdaf02dd6d0733f7afa7f87a25a7c3f07da`。本轮标准化及数据库排空预算仍是候选，新版宿主入口尚未安装。迁移、候选配置与验收的可复用规范见[标准发布](standard-release.md)，后续启用状态见[标准发布验收](../acceptance/standard-release.md)。

本流程用于已确认的北京 ECS 测试机，不等同于生产完整发布验收。`Server CI` 已在 [PR #1](https://github.com/kyriswu/huahuo-server/pull/1) 与合并后的 main 上真实通过。main 的活动规则要求 PR、同名检查通过及分支更新到最新，并禁止强推/删除，无绕过名单。个人维护允许审批人数为 0。

## 触发与身份

`test-server-release.yml` 在 main 的 push CI 成功后触发，也支持从 main 手动运行。两种入口都核对候选是当前 main 且同 SHA 的 `Server CI` 成功；不同来源或旧候选不会部署。发布串行、不自动取消正在执行的命令。

既有宿主入口、固定云助手命令及专用 RAM 授权已经真实跑通；main 合并后的成功 CI 接续触发发布。本轮候选还需要同步宿主入口及下述云端时间上限。需要暂停时可在 GitHub Actions 停用此 workflow。任何跳过不能记作发布成功。

发布身份是阿里云授予 GitHub Actions 的权限：专用 OIDC Provider 信任 GitHub，专用 Role 只接受此仓库 main 的身份。每次运行交换短期 STS 凭据，GitHub 不保存长期 AK；首次链路使用 30 分钟会话，本轮候选申请 90 分钟，需同步角色上限后才能使用。专用策略仅允许对指定实例和指定命令使用 `InvokeCommand` 与 `DescribeInvocationResults`。不授权启动/停止其他实例、修改 RAM 或任意创建命令。

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

固定命令调用宿主维护的发布入口。宿主文件、入口配置和详细构建日志独立于本仓库；本仓库只保存调用接口。执行前宿主仍须在锁内核对 SHA 为当前 main 及实际成功基准，使用已验证的配置快照与现有存储，不覆盖服务器未提交改动。候选代码停止读取、清单标记为非必需删除的旧 ENV 键可以保留在成功快照中，不因此强制准备另一份 ENV；配置审查仍不可跳过。

固定命令的 stdout 仅返回一条 JSON：

```json
{"version":1,"sha":"完整40位提交SHA","stage":"complete","status":"passed","code":"OK"}
```

允许的 stage：`preflight`、`checkout`、`build`、`migrate`、`deploy`、`health`、`cleanup`、`complete`。失败使用 `status:failed`、`code:FAILED`。只有云助手记录的实例/命令/调用 ID 一致、执行成功、退出 0、输出完整且 SHA 对应的 `complete/passed` 才可接受。普通成功使用 `OK`；本轮候选新增 `OK_WITH_FORCED_DRAIN`，表示检查通过但发生了预算到期强退，Action 必须显示警告。宿主成功记录中的 `forcedRetirements` 保留该事实，不能把它说成全部工作自然完成。

最多调用一次 `InvokeCommand`。本轮候选将调用器上限设为 90 分钟、最多轮询 1080 次；首次已部署链路的上限仍是 20 分钟、240 次。调用失败或超时不自动重发；远端可能继续执行，须查看本次云助手记录与宿主日志，不能直接假设未部署。宿主锁须覆盖完整操作。Actions 日志仅固定阶段、状态、错误码、次数及耗时，不转发云端原始输出或凭据。

## 本轮候选的退出与时间预算

`deployment.drainTimeoutMs` 由数据库配置，默认 600000 毫秒，允许 10—60 分钟。首次排空固定本次预算，工作提前完成即退出，到期仍未完成则强制结束；应用以退出码 124 标识排空超时，提前失败仍按失败处理。Compose 3630 秒只是保护配置上限，实际预算取数据库值。首次升级的旧镜像仍有固有的 5 分钟/30 秒行为，新增键不能追溯改变旧代码。

候选 Action 上限为 100 分钟；STS 会话、保存命令与调用器均按 90 分钟衔接，宿主全程上限为 5300 秒。写库前必须确认剩余时间可覆盖六次退出预算加 600 秒预留，不足即拒绝，不缩短应用的配置预算。云端保存命令与角色会话上限已同步到 5400 秒，已核对命令内容和信任范围不变；新版宿主入口也已安装并核对。候选尚未合并，数据库设置及新容器退出行为仍需随实际发布验收，不能把安装当作上线成功。

## 当前验收边界

首次接口准备时，调用器 48 项本地替身测试及全部 561 项 unit/contract、Lint/Typecheck 通过。这是当时的本地证据；本轮新增规则的验证范围与结果以[标准发布验收](../acceptance/standard-release.md)为准。

首次发布前，旧 `4e28a98` 镜像因初始化 SQL 校验和与数据库记录不同而 ready 503；该镜像不能记作上一健康版本。后来已真实完成 `1f7adfd` 的自动发布，不能再将当时“尚未执行发布”的准备状态作为当前结论。历史迁移与 checksum 仍冻结，不为恢复旧镜像重写它们。

当前实际成功版本仍为 `1f7adfd`。本轮云端预算及新的宿主入口已准备，数据库排空设置与候选容器尚待真实发布验证，应分别记录安装、调用和服务验收结果。专用账号的认证业务冒烟仍按用户要求暂缓，现有[默认冒烟](release-smoke.md)不跳过缺失凭据而假报成功；既有健康验收成功不等于认证业务已验证。
