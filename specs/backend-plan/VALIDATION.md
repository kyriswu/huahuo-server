# v3 指令包验证记录

日期：2026-10-09。验证对象是**完整指令、配置蓝图与两个宿主辅助脚本**，不是后端业务或用户Mac运行环境。

## 本次真实完成

- 使用Files读取v2启动/容器/App参照规范，并读取已挂载v2完整ZIP中的配置与阶段文件进行增量编辑；不是用早期UI文档替代当前指令。
- 保留v2全部44个文件路径与P01—P16完整业务，新增3份规范/变更文档、1份本机模板及2个辅助脚本。包内共50个文件（含本记录与manifest）。
- 检查16阶段连续编号、文件对应、业务实施/验证段、App来源URL、本机../huahuo-app与huahuo-server写入范围。
- 检查相对Markdown链接、JSON索引、YAML结构、7服务/4业务入口、迁移依赖、端口/卷/角色、local/cloud必需插值字段。
- node --check：preflight-local.mjs、healthcheck.mjs通过；bash -n：ensure-docker-local.sh通过；sh -n：PG初始化范例通过。
- 在临时**人工测试目录**中实际验证：从Code/Server定位、空/非空Server保护、缺失App、同路径拒绝、无Git副本、Git dirty与相关文件哈希、remote示例凭据脱敏、前后文件内容一致。
- 用**模拟docker/open/uname命令**测试Docker检查脚本：已就绪不重启、默认不启动、远端拒绝、显式macOS Desktop启动、open -a Docker回退、非Mac自动启动拒绝。本测试没有连接真实Docker。
- 上述检查共 **176项通过，0项失败**。辅助Node脚本测试环境为Node v22.16.0；它不是目标Node24业务镜像构建验证。
- 最终打包时生成逐文件SHA-256 manifest，验证ZIP CRC与解包内容哈希一致。

## 没有执行，不能声称完成

- 未连接用户Mac，未读取其真实App或Server目录，未启动其Docker。截图只用于确定用户给出的目录关系。
- 当前生成环境无Docker CLI/daemon，未执行docker compose config/build/up，也未访问实际PG/Redis。Python YAML检查不是Docker Compose实测。
- 未实现Fastify业务src/dist/package/lockfile，不是可直接运行的完整后端。镜像版本与凭据保留待P01落实的占位。
- 未重跑旧healthcheck脚本的HTTP fixture或执行PG初始化到真实库；本次对继承脚本只做语法检查。
- 未验证本机Node24、Apple Silicon/Intel镜像、管理员网页、Dify、ASR、支付、短信、云PG、真机或商店审核。
- 未执行用户App代码、Flutter构建/测试、生产迁移、付费调用或资源删除。

## Codex接手后的验证

P01先按11规范在本机预检，生成实际工程与可运行独立容器，连接真实本地PG/Redis，运行迁移/health/隔离测试。每阶段读本机App，最终按12/P15真实联调。

Docker安装、daemon就绪、Compose config、镜像构建、容器健康、业务通过、App解析、硬件真机与真实供应商接通分别记录。模拟/沙箱/生产不可混用结论。
