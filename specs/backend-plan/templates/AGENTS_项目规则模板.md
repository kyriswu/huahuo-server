# AGENTS项目规则模板 · 合并到独立后端，不覆盖已有规则

- 当前仓库：独立花火Fastify后端；前端只读参照仓库：**https://github.com/kyriswu/huahuo-app**。
- 读取specs/backend-plan/总提示词、06容器规范、07App参照规范与当前阶段；开始读docs/progress.md与docs/app-reference.md。
- 一份compose.yaml：api-server、worker、admin、scheduler、postgres、redis、一次性migrate。前三者必须独立容器，不用同容器多进程伪装；同镜像复用允许。
- buildApiServer与buildAdminServer分开，公共端不注册admin路由；worker消费，scheduler投递/扫描，所有角色共用已审核领域服务。
- App仅编码期只读，记录实际commit/dirty状态；每阶段查看当前消费者和解析，不等P15；基线更新显式记录。不改App代码，不把App源码复制到镜像/后端repo。
- App不可读标UNVERIFIED_APP，继续可独立实现部分但不标兼容通过。最小数据层适配也先提出，经授权再改。
- 固定Fastify、PG、Redis；TS/Drizzle/pg/BullMQ为方案默认；不迁移coze-js-api，不引入重型Agent框架/向量库/Rerank。
- 数字孪生名称/原UI不变、Markdown候选确认后生效；录音卡是日常音频来源；不增加周期自动学习。
- PG正式数据与账本，Redis缓存/队列，文件StoragePort。正式任务有outbox/状态/幂等；provider未知结果不盲重跑。
- admin独立身份/Session/RBAC/CSRF，普通用户token无权访问。admin网页按阶段实现，不以Swagger代替；高风险操作复用任务/账本服务并审计。
- 迁移凭据只给migrate，业务容器非superuser；角色配置最小化，DB池总预算考虑worker副本。
- 不生成全仓符号镜像，不用TODO/硬编码成功/空数组冒充业务。所有provider mock需显式开发身份，生产禁用。
- 每阶段提供真实代码、迁移、契约、测试和服务重启证据，更新progress/provider/contract/App基线/container-status；未运行不得写通过。
- 不执行未经授权的付款/退款/短信/付费调用、生产迁移/发布，不覆写未提交文件、不push、不提交secret。

## v3本机路径与Docker（应用到根AGENTS，保留已有规则）

- 唯一项目写入根是现有huahuo-server；App默认../huahuo-app只读，源URL https://github.com/kyriswu/huahuo-app 。不另建huahuo-backend，不在Code根初始化混合工程。
- 开始先检查当前/隐藏文件与git边界，不能把“用户说空目录”当允许清空。已有.env、口令、卷、代码必须保留。
- 本地源码优先，未提交改动要纳入证据；不自动clone/pull/fetch/checkout/stash/reset。无.git用所读文件哈希，不能编造commit。
- 本机Docker已安装且用户允许必要时启动。先查context本地性/权限/daemon；只操作本项目，禁止全局清理、down -v或动其他项目。权限受限申请最小必要审批，不绕过沙箱。
- compose build.context只包含Server，不把Code/App打包；app:reference只宿主运行，APP_LOCAL_PATH不进入业务容器。
- P01真实搭建并测试，预检不是长篇阶段0；P15按12规范核对本地/真机地址，不猜App环境参数，不擅自改UI或客户端配置。
