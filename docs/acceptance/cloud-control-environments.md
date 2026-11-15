# 运行入口与云控制环境规则（2026-11-16）

本期重写根 README，按实际版本、四角色拓扑、首次运行、ENV 与后台配置、日常检查、发布排空和恢复组织入口。宿主 Node 使用 Volta pin 26.11.0，pnpm 10.15.1；Docker Node 独立固定 26.12.1。已有测试库和历史迁移不重新初始化，不提供默认管理员或覆盖现有凭据。

## 环境与行为

| APP_ENV | 用途 | 未明确配置云控制开关时 |
| --- | --- | --- |
| development | 本地开发 | 保留原规则：完整 RAM 凭据或启用节点调用时允许，否则关闭 |
| test | 线上测试 | 默认允许云控制，实际操作仍需要有效 RAM 凭据 |
| production | 线上生产 | 默认允许云控制，实际操作仍需要有效 RAM 凭据 |

所有环境均保留显式 false 的禁用作用。私网 API 的 PROCESSING_NODES_ENABLED 默认值仍是 false；它与云端开停机独立。云控制默认允许不证明 RAM 权限、内网解析或实例启动成功。

本期发布目标仍为测试服，清单基准来自 [Action 43737455276](https://github.com/kyriswu/huahuo-server/actions/runs/43737455276) 的实际成功记录：业务 SHA ce1123ed4ff6c6007ff1cc26de1a2ffd02cdb795，控制 SHA 30ed25cfbea55c06b6d275d7d00449ca68a4e954。日志明确记录候选与完整五阶段通过、TEST_RELEASE_OK；此次只读查询没有触发新发布。未来发布仍需在目标锁内重新核对，不能直接采用分支最新头。

## 配置准备

| 键 | 本期要求 / 时点 | 角色 | 验收 |
| --- | --- | --- | --- |
| APP_ENV | 测试候选快照为 test，禁止沿用本地 development | 四常驻角色及 migrate | 写库前精确匹配 |
| PROCESSING_NODES_CLOUD_CONTROL_ENABLED | 省略/空使用线上默认值；建议明确 true；旧 false 须修改 | API/Admin/Worker/Scheduler | 禁止 false 或非法值进入本期测试发布 |
| ALIYUN_RAM_ACCESS_KEY_ID | 提前在私密部署配置中提供既有授权值 | API/Admin/Worker/Scheduler | 只检查非空，不输出值 |
| ALIYUN_RAM_ACCESS_KEY_SECRET | 与 ID 配套，沿用既有授权值 | API/Admin/Worker/Scheduler | 只检查非空，不证明权限或值正确 |
| PROCESSING_NODES_ENABLED | 保留实际解析调用需要的原值 | API/Admin/Worker/Scheduler | 云控制配置不自动开启私网调用 |

真实测试 ENV 尚未由本轮修改或核验；没有将本地凭据复制到云端。准备好后由正常发布流程以同一配置快照重建四角色，restart 不读取新 ENV。本期 verify-config.mjs 只做本地断言，失败停止在写库前，不写配置、不访问网络或云服务。

无新依赖、迁移、任务载荷、API 结构或 App 契约改动，保留历史 SQL 与已有只读数据库断言。production 的默认值属于代码能力，生产执行器仍未接入。

## 验证与边界

类型检查、Lint（含本期嵌套配置脚本）和构建通过；57份文件共817项单元/契约测试通过，真实隔离 PostgreSQL/Redis 的21份文件共275项通过，1项Milvus跳过。最终结果保存在 `.local/readme-test-cloud/`。集成运行器明确禁止云控制和真实供应商，不继承业务凭据。首次演练因发布清单的只读 SQL 路径不属于新编号而失败，已修正路径，保留失败日志与后续成功记录。

Compose 使用合成配置渲染三环境共15份角色配置，验证线上测试/生产默认值、测试发布五角色门禁及 migrate 不注入 RAM；12次负面断言分别拒绝四角色的显式禁用、缺失ID、缺失Secret。不使用业务 .env，不启动容器。README 的31个本地链接、5段shell语法检查通过。App 只读快照已保存；参照基线仍报告既有源码/测试差异，未覆盖基线或修改App。

本轮未提交/推送；要求干净候选提交的 release:check 尚待执行。未执行真实云开停机、PDF/模型调用、测试服 ENV 更新或容器部署。线上原告警的具体原因仍需核对实际容器，不能仅凭本地默认值修改宣称已修复线上。
