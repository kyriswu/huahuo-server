# 统一真实短信与常规发布核验

本期基准为测试服实际成功版本 `b729842c687251e7bb5620d8ac506a50f7412353`。所有环境的验证码直接调用现有阿里云 SDK；应用不再读取短信模式或测试验证码回显开关，不再提供模拟/禁用适配器。验证码响应只保留票据、冷却时间和 `providerMode: live`，不返回验证码。历史模拟票据不能重放或登录，历史 SQL、OTP 行和既有会话不改写。

API 启动必须具备共享 RAM 凭据、审核通过的签名与验证码模板。其余角色无需短信模板。沿用既有幂等、持久化限流、明确拒绝/未知结果分类和超时不自动重发规则。Agent 现有 Studio 转发及响应解析已兼容，无需增加模拟验证码展示或修改其 API。

| 配置 | 操作与角色 | 必填/默认 | 准备与验收 |
| --- | --- | --- | --- |
| `SMS_PROVIDER`、`SHOW_TEST_OTP` | 所有角色移除 | 不再读取 | 私密候选与 Compose 均移除；本期断言拒绝残留注入 |
| `SMS_ALIYUN_SIGN_NAME`、`SMS_ALIYUN_TEMPLATE_CODE` | API 补齐真实配置 | 必填，无默认 | 复用现有已审核配置；本期断言验证目标值 |
| `SMS_ALIYUN_REGION_ID`、`SMS_ALIYUN_CODE_PARAM` | API 明确准备 | 默认 `cn-hangzhou`、`code` | 本期断言验证 |
| `SMS_ALIYUN_CONNECT_TIMEOUT_MS`、`SMS_ALIYUN_READ_TIMEOUT_MS` | API 明确准备 | 默认 3000ms | 本期断言验证 |
| `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET` | 复用测试服现有身份 | API 必填 | 私密来源比对一致；不更换、输出或提交凭据 |

新候选在宿主私密配置目录按本期计划 ID 准备，不修改上一成功配置快照。无数据库迁移、回填、额外付费资源或入口配置变更。旧应用恢复会带回其旧短信行为，不能把旧版健康通过当成真实短信功能已恢复；优先向前修复。

本地 Typecheck、Lint、Build 通过；939 项 unit/contract 通过；296 项真实隔离 PostgreSQL/Redis integration 通过，4 项依赖独立 Milvus 场景的用例未执行。传输替身仅存在于测试目录，验证码从替身捕获，不依赖公开接口回显。HTTP E2E 客户端已改为仅在自身临时库中准备 OTP，本轮未运行旧 E2E 栈。没有调用真实模型或发送短信来代替自动化测试。

常规发布链路已只读核验：GitHub workflow 调用固定保存命令，该命令只执行常规宿主发布入口和准确候选 SHA。实际安装入口包含完整兼容、实际基准、配置与历史校验，不引用首次切换维护脚本，也没有本次固定版本的豁免分支。首次维护文件仅保留作历史证据。最终上线结果以对应 Actions 和宿主成功记录为准，准备完成不代表已发布。
