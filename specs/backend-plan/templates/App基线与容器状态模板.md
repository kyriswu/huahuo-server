# docs/app-reference.md 模板

仓库：https://github.com/kyriswu/huahuo-app
后端仓库：本机huahuo-server（不要写成App子目录）
本地只读路径：默认../huahuo-app，相对Server根；从不提交的config/app-reference.local.json读取
当前基线commit：待Codex实际填写；不是历史聊天里的commit
远端分支检查：默认不执行；本机是第一依据，只有另行授权才登记远端检查
工作树是否dirty：待核对；用户改动仅只读

| 阶段 | 使用的App commit/工作树状态 | 本次读取的路径/符号/行号 | 实际请求/解析要点 | 后端route及fixture | 与上阶段基线差异 | 验证状态 |
|---|---|---|---|---|---|---|
| P01 | 待核对 | — | — | — | 首次基线 | UNVERIFIED_APP |

# docs/container-status.md 模板

| 服务 | 镜像/commit | entrypoint | 内部/宿主端口 | DB角色/池上限 | 启动/healthy证据 | 单独停止/恢复结果 | 限制 |
|---|---|---|---|---|---|---|---|
| api-server | 未构建 | api-server | 3000/回环3000 | 待实现 | 未运行 | 未运行 | 无admin路由 |
| admin | 未构建 | admin | 3000/回环3001 | 待实现 | 未运行 | 未运行 | 独立Session/RBAC |
| worker | 未构建 | worker | 3100/不公开 | 待实现 | 未运行 | 未运行 | 初期单容器多队列 |
| scheduler | 未构建 | scheduler | 3100/不公开 | 待实现 | 未运行 | 未运行 | 默认单副本但需防重 |
| migrate | 未构建 | migrate | 无 | 专用迁移角色 | 未运行 | 非常驻 | schema/退出码单记 |
| postgres | 未选定 | 镜像默认 | 5432/不公开 | — | 未运行 | 未运行 | local-db profile |
| redis | 未选定 | redis-server | 6379/不公开 | — | 未运行 | 未运行 | AOF/noeviction |

不要写密码或可重放token。镜像存在不等于容器跑过，schema校验不等于docker compose up通过。

# docs/app-change-proposals.md 模板

| API/流程 | 当前App基线与消费者 | 原协议 | 不能直接兼容的原因 | 建议的最小数据层变化 | 测试/回退 | 用户授权状态 |
|---|---|---|---|---|---|---|

默认仅提案，不改App UI；本次后端实施不能自动授权另一仓库写入。

无Git源码副本：SOURCE_COPY_NO_GIT，并填写本次实际阅读的相对文件路径/哈希；每阶段末复核这些文件。私有绝对路径只放本地忽略记录，不公开原文diff。
