# 默认发布冒烟

入口为 `node scripts/release/smoke.mjs`，也可运行 `pnpm release:smoke`。脚本只依赖 Node 内置模块，生产执行无需安装 pnpm 或业务依赖。成功退出 0，失败退出 1，输出一条脱敏 JSON；Actions 中同时写步骤摘要。

本轮交付默认脚本、仓库 CI 及可复用 Action 接口。用户确认尚未提供专用验收账号凭据，先完成接口；本仓库也尚无完整 `production-release.yml`。合入后自动运行的是隔离测试，生产冒烟须由部署 workflow 在切流完成后调用，不能把 `main` 的 push 本身当作已经部署成功。

## 固定检查

| 顺序 | 请求 | 验收 |
| --- | --- | --- |
| 1 | GET `/health/live` | 200、成功 Envelope、服务为 api-server、状态 live |
| 2 | GET `/health/ready` | 200、成功 Envelope、服务为 api-server、状态 ready |
| 3 | 匿名 GET `/api/v1/me/status` | 401、失败 Envelope、UNAUTHORIZED |
| 4 | 认证 GET `/api/v1/me/status` | 返回指定验收用户及 ready 的默认工作区 |
| 5 | 认证 GET `/api/v1/workspaces` | 列表结构正确，包含指定 ready 默认工作区 |
| 6 | 认证 GET `/api/v1/tasks/running` | 返回有效非终态任务列表，允许为空 |

不创建任务或资产，不执行生成、解析、短信、支付等操作。现有鉴权实现会更新专用会话的 `last_seen_at`，其余为现有业务读取。账号必须专用；脚本不能自行判断一个账号是否属于真实用户，也不绕过正常 JWT、会话撤销及归属验证。

串行最多 6 次请求，不重试，单次（含正文）最多 5 秒，总计最多 30 秒，每份响应最多 64 KiB。超时、错误码、HTML 页面、畸形 JSON、语义不符、错误用户/工作区均失败。生产仅 HTTPS，拒绝带路径、查询、片段或用户名密码的 origin；HTTP 只允许回环地址。任何 3xx 均失败，不把凭据转发到重定向目标。

## 参数

| 环境变量 | 用途 |
| --- | --- |
| `SMOKE_BASE_URL` | 待验收 统一鉴权公开入口的 HTTPS origin；不能指向内部 api-server 端口 |
| `SMOKE_ACCESS_TOKEN` | 专用账号当前有效的 access JWT，只由受保护的调用方注入 |
| `SMOKE_USER_ID` | 预先准备的验收账号 UUID |
| `SMOKE_WORKSPACE_ID` | 该账号现有 ready 默认工作区 UUID |
| `SMOKE_REQUEST_TIMEOUT_MS` | 可选，100–5000，默认 5000 |
| `SMOKE_TOTAL_TIMEOUT_MS` | 可选，100–30000，默认 30000 |
| `SMOKE_REPORT_PATH` | 可选，将同一脱敏报告写到调用方指定文件，适用于本机证据 |

access JWT 默认短期有效，并与数据库会话绑定；不能把一个即将过期的 JWT 当作永久 GitHub Secret。凭据自动取得方式本轮按用户要求暂缓，脚本不自动发短信登录、刷新或延长会话。凭据缺失或过期均明确失败，不能降级成只测健康接口。

## GitHub Actions 接口

`.github/workflows/release-smoke-check.yml` 的固定检查名为 `Server CI`，可作为 main 的必需检查。在 PR 和 main push 自动执行类型检查、Lint、构建、全部 unit/contract 和独立 PG/Redis 集成测试；也支持 Actions 页的手动运行。默认跳过需真实 Milvus 的用例，不访问生产，也不读取生产 secrets。手动运行用于重验已提交代码，不会直接发布容器。

`.github/workflows/release-smoke.yml` 只接受 `workflow_call`，由生产发布 workflow 的部署阶段成功后调用。运行 Node 26.11.0，checkout 指定完整 SHA，仓库权限仅 contents:read，任务超时 3 分钟；实际 HTTP 总预算仍为 30 秒。官方 Actions 固定提交 SHA。以下是调用方 job 片段，不是当前已经存在的部署 job：

```yaml
smoke:
  needs: deploy
  uses: ./.github/workflows/release-smoke.yml
  with:
    revision: ${{ github.sha }}
    base-url: ${{ vars.SMOKE_BASE_URL }}
    user-id: ${{ vars.SMOKE_USER_ID }}
    workspace-id: ${{ vars.SMOKE_WORKSPACE_ID }}
  secrets:
    access-token: ${{ secrets.SMOKE_ACCESS_TOKEN }}
```

这里的 token secret 代表调用时已有效的凭据接口；不能把这个片段当作已经实现了凭据自动续期。调用方清理 job 必须依赖 smoke 成功，不使用 `always()` 或 `continue-on-error` 绕过结果。流水线串行、容器交接、保留当前及上一个成功镜像由发布入口负责。

传入的 SHA 固定本次执行的检查脚本；目标 API 的健康响应没有镜像 SHA，因此本脚本本身不证明流量已到新版本。调用方先核对实际容器镜像并完成切流，再调用；冒烟不是整套跨版本回退、长任务或供应商实测。

每期新业务检查由 AI 按 [脚本约束](../../scripts/release/AGENTS.md)补充代码和测试，随 PR 审查后执行。需要写入、付费或外部操作的场景不属于这份默认生产冒烟。
