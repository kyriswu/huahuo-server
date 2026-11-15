# 测试服务器自动发布接口

本流程用于已确认的北京 ECS 测试机，不等同于生产完整发布验收。`Server CI` 已在 [PR #1](https://github.com/kyriswu/huahuo-server/pull/1) 与合并后的 main 上真实通过。main 的活动规则要求 PR、同名检查通过及分支更新到最新，并禁止强推/删除，无绕过名单。个人维护允许审批人数为 0。

## 触发与身份

`test-server-release.yml` 在 main 的 push CI 成功后触发，也支持从 main 手动运行。两种入口都核对候选是当前 main 且同 SHA 的 `Server CI` 成功；不同来源或旧候选不会部署。发布串行、不自动取消正在执行的命令。

宿主入口、固定云助手命令及专用 RAM 授权已准备，启用 PR 合并后由 main CI 成功接续执行。需要暂停时可在 GitHub Actions 停用此 workflow。任何跳过不能记作发布成功。

发布身份是阿里云授予 GitHub Actions 的权限：专用 OIDC Provider 信任 GitHub，专用 Role 只接受此仓库 main 的身份。每次运行交换约 30 分钟 STS 凭据，GitHub 不保存长期 AK。专用策略仅允许对指定实例和指定命令使用 `InvokeCommand` 与 `DescribeInvocationResults`。不授权启动/停止其他实例、修改 RAM 或任意创建命令。

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

宿主维护的固定命令调用 `/usr/local/sbin/huahuo-test-release`。宿主文件、入口配置和详细构建日志独立于本仓库；本仓库只保存调用接口。执行前宿主仍须在锁内核对 SHA 为当前 main，复用现有配置与存储，不覆盖服务器未提交改动。

固定命令的 stdout 仅返回一条 JSON：

```json
{"version":1,"sha":"完整40位提交SHA","stage":"complete","status":"passed","code":"OK"}
```

允许的 stage：`preflight`、`checkout`、`build`、`migrate`、`deploy`、`health`、`cleanup`、`complete`。失败使用 `status:failed`、`code:FAILED`。只有云助手记录的实例/命令/调用 ID 一致、执行成功、退出 0、输出完整且 SHA 对应的 `complete/passed/OK` 才通过。

最多调用一次 `InvokeCommand`，轮询最多 240 次、总计 20 分钟。调用失败或超时不自动重发；远端可能继续执行，须查看本次云助手记录与宿主日志，不能直接假设未部署。宿主锁须覆盖完整操作。Actions 日志仅固定阶段、状态、错误码、次数及耗时，不转发云端原始输出或凭据。

## 当前验收边界

调用器 48 项本地替身测试通过；包括它的完整 unit/contract 为 561 项，Lint/Typecheck 通过。这些不计作 OIDC 或云部署通过。

云助手只读检查已确认测试机在线、Docker/Compose 可用，项目为 `/root/huahuo-server`，四角色使用旧 `4e28a98` 镜像。其初始化 SQL 哈希与已更新的数据库记录不同，导致 ready 503；PG/Redis正常。应升级镜像后验证，不重写数据库 checksum 或重跑初始化；旧镜像不能记作上一健康版本。服务器有一项未提交文档改动，应保留。

用户已明确确认云端授权，专用 Provider、Role、仅含两项云助手权限的 Policy 和固定命令已创建；宿主入口已安装为 root:root、0700，内容 SHA256 为 `332bfe0fed42e326dfb08d56705e7b87395b9ce33405c622001bb4246294bd44`，必要工具、IMDS 和语法核对通过。尚未执行发布；云授权和宿主发布的实际执行结果仍需分别验证，不能把创建权限或安装脚本当作部署成功。专用账号的认证业务冒烟仍按用户要求暂缓，现有 [默认冒烟](release-smoke.md) 不跳过缺失凭据而假报成功。
