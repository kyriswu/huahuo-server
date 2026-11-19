# 在花火 Server 本地安装 CodeGraph

CodeGraph 是可选开发工具。在本地 Codex 打开包含 CodeGraph 项目配置的 `huahuo-server` 目录，把下面整段发给 Codex，即可让它执行安装和验证。

```text
请直接在当前花火 Server 仓库为我安装并验证可选的 CodeGraph。完成实际操作后，告诉我装到了哪里、版本是多少、能否从当前项目查到调用链。

1. 用 `git rev-parse --show-toplevel` 确认当前 Git 根目录，读取根目录的 `AGENTS.md`、`.codex/config.toml` 和 `scripts/codegraph-worktree.sh`。用已有的项目级 MCP 配置。当前分支如果缺少配置或脚本，就说明缺的是哪一项，并保留当前分支和已有改动。

2. 先检查 `PATH` 上是否有可用的 CodeGraph CLI，再检查项目脚本支持的本地安装位置。已有版本能正常索引和查询就直接复用。若 `PATH` 中的版本有冲突，先说明原因，保留现有安装。

3. 如果需要新装，使用官方 `colbymchenry/codegraph` 的 `v1.6.3` Release。按 `uname -s` 和 `uname -m` 选择 `codegraph-darwin-arm64.tar.gz`、`codegraph-darwin-x64.tar.gz`、`codegraph-linux-arm64.tar.gz` 或 `codegraph-linux-x64.tar.gz`。Windows 使用本项目的 WSL2/Linux 环境。只从 `https://github.com/colbymchenry/codegraph/releases/download/v1.6.3/` 下载对应压缩包和 `SHA256SUMS`，校验对应文件的 SHA-256，再解包。

4. 跟随项目脚本的路径约定，用 `git rev-parse --path-format=absolute --git-common-dir` 找到 Git 通用目录，再在其上一级的 `.local/codegraph/` 安装。先确认目标受 Git 忽略并且没有需要保留的同名文件。官方压缩包有一层顶层目录，将其解包到 `dist/` 时跳过这层。创建可执行的 `.local/codegraph/codegraph` 启动器，内容如下。已有的仓库配置会找到这个启动器，无需改全局 PATH。

   #!/bin/sh
   export DO_NOT_TRACK=1
   exec "$(dirname "$0")/dist/bin/codegraph" "$@"

5. 回到当前 Git 根目录，执行 `sh scripts/codegraph-worktree.sh version` 和 `sh scripts/codegraph-worktree.sh status`。已有索引需要补齐时运行 `sh scripts/codegraph-worktree.sh sync .`。再执行 `sh scripts/codegraph-worktree.sh explore registerStorageRoutes`，核对它定位到本项目的存储路由。用 `git check-ignore .codegraph/codegraph.db` 确认索引被忽略。如果当前会话提供 `codegraph_explore`，再实际查一次。若当前会话还没加载 MCP，区分 CLI 已通过和 MCP 待确认，告诉我在同一项目目录重新打开会话即可继续验证。若 Codex 提示信任项目，请交由我在界面确认。

安装和验收只使用本机的 `.local/codegraph/` 和 `.codegraph/`。保留已有未提交改动和其他工具配置。沿用仓库提供的启动器配置，跳过 `codegraph install`，保持 Git hooks、全局 Codex 配置、Server、App、数据库和发布流程原样。遇到 Codex 的下载审批时，展示实际下载命令并等我确认。
```

安装包与校验文件可在官方 Release 查看。项目级 MCP 配置由 Codex 在受信任的项目里读取。[CodeGraph v1.6.3](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.3) · [Codex 配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)
