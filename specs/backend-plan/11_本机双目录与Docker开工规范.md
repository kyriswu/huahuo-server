# 本机双目录与 Docker 开工规范 · v3

## 1. 本次已知事实与尚待检查

用户当前把 `huahuo-app` 和 `huahuo-server` 放在截图所示的同级 Code 目录，说明 App 是现有代码、Server 是新后端起点，并已安装 Docker、授权必要时启动。本包生成环境不是用户的 Mac，不能从截图确认绝对路径、Server 内部文件、Git状态、Docker daemon/context、CPU架构、可用内存和现有卷。

因此预检用于安全开工，不是一轮重新分析产品的阶段0。完成可执行的检查后，立即进入 P01，不仅给计划。

## 2. 定位后端，禁止扩大写入范围

```text
Code/                     # 只作为共同父目录，不变成工程
├─ huahuo-app/            # 只读源码参照
└─ huahuo-server/         # 唯一业务写入根
   ├─ specs/backend-plan/
   ├─ AGENTS.md
   ├─ package.json
   ├─ compose.yaml
   ├─ Dockerfile
   ├─ src/
   ├─ migrations/
   ├─ tests/
   ├─ config/
   └─ docs/
```

从 Code 启动则将 `SERVER_ROOT` 定为 `./huahuo-server`；从 Server 启动则用当前目录。默认 `APP_ROOT` 解析为 Server 的 `../huahuo-app`。路径通过真实文件系统解析，支持空格；所有 shell 路径加引号。不从提示符猜 `/Users/kyriswu/Code`，不改目录名字。

先看顶层和隐藏文件，不打印秘密文件内容。`.git`、README、specs、已有代码不算可以删除的杂项。若有 v1/v2 已实现内容，先判断可复用范围，不从空项目覆盖。工作区存在上级 Git 时，避免把 Code 当成仓库根；确认独立仓库后只在 Server 初始化。无授权不得 commit/push App，不能修改 App 的文件权限来“做只读”。

禁止通过符号链接将 Server 写入引导到 App；发现同路径、嵌套或异常 symlink 必须停止写操作并确认。工具缓存/包缓存可使用已批准的正常位置，业务输出、报告、fixtures和配置都在 Server。

## 3. 本地 App 是第一依据

- 来源顺序：当前本机源码与本地改动 → 已登记契约证据 → 经用户明确授权后的远端对照。
- GitHub 地址始终保留：https://github.com/kyriswu/huahuo-app 。它用于识别来源，不要求每阶段联网。
- 使用 `git --no-optional-locks -C "$APP_ROOT" ...` 读取根、HEAD、状态；先确认 Git 根就是 App，不能误读上级 Code 仓库。
- 只复制了源码、没有 `.git` 仍可读。标 `SOURCE_COPY_NO_GIT`，记录实际阅读文件的相对路径和 SHA-256，不能随意编一个 commit。
- 本地与远端不同、不干净都不是自动修复条件。禁止 fetch/pull/reset/checkout/stash/clean 等改动 App 或其 Git 元数据的操作；远端比对另经批准，在独立位置做，不替换当前参照。
- 不执行 Flutter pub get/build/test、生成代码或格式化，因为这些可能写入 App。实际 Dart/真机验证另授权；此前做源码分析与后端契约fixture。
- 每阶段记录所读文件的哈希与版本状态，不把完整私人源码或 diff 复制到提示词/公共日志。变化发生在阶段中时，停止受影响契约的验收，确认后重新核对；不要覆盖用户的并行改动。

## 4. Codex 工作区和权限

推荐主工作区直接选择 `Code/huahuo-server`，读取其上级同目录的 App。源码读取权限与写权限是两回事；权限受限时请求对 ../huahuo-app 的读取和本地 Docker 命令执行，不关闭审批/沙箱。

不要用“移动到父目录就默认可以改全部文件”的方式放大授权。CLI 的 `--add-dir` 是额外写目录授权，不是只读挂载；此处不以 `--add-dir ../huahuo-app` 作为默认解法。工具版本不同，应使用该版本支持的受控读取/审批机制。

根 AGENTS 应明确 App 只读；它是行为约束，不是假装建立了操作系统级只读保护。若组织已有严格目录权限，遵循该权限。

## 5. Docker 检查与启动

先获取（不要输出含认证信息的连接配置）：

```bash
pwd -P
uname -s
uname -m
docker --version
docker compose version
docker context show
# 检查所选 context 的 endpoint 是否本机 unix socket；不是就停止自动操作。
docker info
```

`docker` 命令存在不等于 daemon 可达。先区分未启动、权限不足、socket 路径问题、远程 context、网络/代理和资源不足。不得以安装第二套容器运行环境来掩盖原因。

用户已授权必要时启动本机已安装的 Docker。确认本地 context 后：

```bash
# 先检查当前 Docker CLI 是否支持
# docker desktop start --help
# 支持时：
docker desktop start --timeout 120
# 不支持但 Mac 已安装 Docker.app 时：
open -a Docker
# 等待后再次 docker info，不能仅凭 open 返回0宣称 Docker 就绪。
```

以上是选择分支，不是要求依次启动两次。出现系统权限、Docker协议、keychain等弹窗，由用户处理；不代替用户接受条款，不申请不必要的全盘/管理员权限。

本包提供 `examples/scripts/ensure-docker-local.sh`，默认只检查；显式 `--start` 才尝试启动。它不安装Docker、不切context、不停止服务、不创建项目容器。脚本必须在用户机器/已批准的本机命令环境执行。

## 6. 保护机器上现有环境

先检查 context、现存Compose项目/容器、同名卷与端口。只操作带本项目 Compose label 且路径归属已确认的资源。新环境建议项目名 `huahuo-server-dev`；已有本项目数据时保留原项目名/卷名，避免“升级指令后数据看起来没了”。发生撞名就选择新名称并记录，不能删旧资源腾位置。

禁止自动执行全局 stop/restart、system prune、volume prune、down -v、factory reset、删除未知文件、修改Docker socket为全员可写。端口被其他程序使用时，调整本项目的 API_HOST_PORT/ADMIN_HOST_PORT；不自动杀进程。

不要在业务容器挂宿主Docker socket，不用privileged/host network。四业务角色只与本项目PG/Redis和受控供应商交互。

## 7. 真正的启动顺序

1. 补齐 Server 的真实工程和 app 工厂、entrypoint、迁移、测试；不要对纯提示词目录直接 compose up。
2. 检查已有 Node/pnpm；缺少时申请安装或选 Dockerfile 的 tooling target，临时工具容器只挂 Server，不挂 Code/App。
3. 选择可用、受支持、多架构的精确镜像，记录 Mac 的 arm64/x86_64；不强制 linux/amd64，不以模拟执行成绩代替原生性能。
4. 为新本地环境生成随机、分角色、忽略提交的凭据；已有.env/数据库卷不重新生成口令。PG初始化只对空卷生效，换.env不能自动轮换旧库密码。
5. 在 **Server 根**执行 Compose config --quiet；其 build.context 为 `.`，不是 `..`。每个挂载路径指向 Server 内已准备的目录/卷。
6. 首次 local-db profile 启动 PG/Redis；migrate 根据实际目标有限重试并执行受锁迁移。常驻服务等待 migrate成功与Redis健康。
7. 检查 `ps -a`：4个业务容器＋PG＋Redis常驻，migrate退出0。不要要求7个容器都长期Up。
8. 验证API/admin健康与隔离、PG迁移记录、Redis读写、worker/scheduler角色不同。依赖异常时ready如实不就绪，不能全程硬编码200。
9. P01之后每一阶段修改迁移时，用新构建明确运行迁移，不能用上次旧migrate容器的退出码冒充本次成功。

macOS本机可以继续供日常开发，但不是默认生产服务器。本地已安装Docker不代表已经分配足够的RAM/磁盘；资源不足记录事实，不直接调到无限资源。远端云PG验证、真实供应商调用和生产部署仍另需授权。

## 8. 只读预检脚本和记录

可在Node可用时运行：

```bash
# 当前在 huahuo-server。这里只检查，不写项目代码，不启动Docker。
node specs/backend-plan/examples/scripts/preflight-local.mjs
# Docker权限尚未开放时可先只核查目录：
node specs/backend-plan/examples/scripts/preflight-local.mjs --skip-docker
```

脚本输出预检信息，不替代Codex读取真实业务。缺Node时使用等价shell检查继续；不要把该脚本作为必须先安装全套依赖的前置条件。

记录模板见 `templates/本机预检记录模板.md`；私密绝对路径/context细节放忽略提交的本地记录。可提交docs只保留相对路径、版本、状态、脱敏摘要和实际测试结果。
