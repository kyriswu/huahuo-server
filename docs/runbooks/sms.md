# 阿里云短信服务与命令行工具

服务使用官方 `@alicloud/dysmsapi20170525@4.6.0` SDK，通过 HTTPS 调用中国站 `dysmsapi.aliyuncs.com`。通用发送和回执查询位于 `src/integrations/aliyun-sms.ts`；登录验证码适配器位于 `src/integrations/sms.ts`，原 `POST /api/v1/auth/sms-code` 已按 `SMS_PROVIDER` 选择真实适配器。业务层不执行阿里云 CLI，也不依赖宿主用户级 Skill 或 `~/.aliyun/config.json`。

官方依据：[API 接入说明](https://help.aliyun.com/zh/sms/getting-started/use-sms-api)、[SendSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)、[QuerySendDetails](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-querysenddetails)。

## 环境配置

本机主服务从根目录 `.env` 读取 `ALIYUN_RAM_ACCESS_KEY_ID`、`ALIYUN_RAM_ACCESS_KEY_SECRET` 及已审核的花火身份验证码模板。

```dotenv
SMS_ALIYUN_REGION_ID=cn-hangzhou
SMS_ALIYUN_SIGN_NAME=触达科技
SMS_ALIYUN_TEMPLATE_CODE=SMS_508520316
SMS_ALIYUN_CODE_PARAM=code
SMS_ALIYUN_CONNECT_TIMEOUT_MS=3000
SMS_ALIYUN_READ_TIMEOUT_MS=3000
```

本机 API 使用 `SMS_PROVIDER=live` 和 `SHOW_TEST_OTP=false`。环境示例预设 `SMS_PROVIDER=disabled`，填入 RAM 凭据、已审核的签名和模板后设为 `live`。API 启动时校验这些配置。

Compose 只向 API 注入短信参数；Admin/Scheduler/Migrate 不新增短信凭据要求。登录验证码由服务端随机生成，使用配置的单一变量名写入模板；模板若包含其他变量，应使用通用工具显式提供，不能直接用于当前登录适配器。

## 登录验证码

```http
POST /api/v1/auth/sms-code
Content-Type: application/json
X-Idempotency-Key: <本次请求的稳定唯一键>

{"phone":"<接收手机号>","purpose":"sign_in"}
```

成功响应仍为既有 envelope，包含 `smsRequestId`、`cooldownSeconds:60`、`providerMode:live`；真实模式不返回 `testCode`。后续 `/api/v1/auth/login` 使用该票据、手机收到的验证码、`clientType:app` 和稳定 `clientId`。

沿用真实 PostgreSQL 的每手机号 60 秒冷却、每天 10 次、每 IP 每小时 20 次和请求键幂等，不另开绕过限流的公开发短信接口。手机号存储与验证码哈希规则不变。

## Flutter 真实短信联调

Flutter 真实短信联调统一使用 `huahuo-server-dev` 的 `127.0.0.1:3000` API。本机服务由根目录的 `.env` 和 `compose.yaml` 启动，开发 RDS 与镜像中的 `migrations/0001_initial_schema.sql` 对齐。

```sh
docker compose --env-file .env ps api-server
docker compose --env-file .env up -d --no-deps --build --wait api-server
curl --fail http://127.0.0.1:3000/health/ready
```

Android 调试包使用 `--dart-define=HUAHUO_SERVER=http://localhost:3000`。在选定设备上运行 `adb -s <device-id> reverse tcp:3000 tcp:3000` 后打开 Flutter 登录页。使用可接收短信的测试号码，首次发送后等 60 秒再重发，勾选协议并输入第二条短信里的验证码。验证通过后 App 应进入首页。收件情况由测试人确认，服务端按 OTP 记录和会话确认重发及登录结果。

如果 Mac 键盘在 Android 模拟器的输入框中无效，检查对应 AVD 的 `config.ini` 是否设置 `hw.keyboard=yes`。修改后重启 AVD，`adb -s <device-id> shell am get-config` 应显示 `qwerty`，并重新建立 `adb reverse`。本机 `Huahuo_API_31` 和 `Huahuo_API_36` 已启用该设置。

2026-11-12 在 Android API 36 模拟器和现已退役的 `13000` 实例完成真实联调。Flutter 发起首次发送和重发，两次请求相隔 119 秒。冷启动模拟器后从当前页面重新获取一条验证码。三次 `POST /api/v1/auth/sms-code` 均返回 200，隔离库记录三条 `live` 受理。用户输入最新短信中的验证码后，`POST /api/v1/auth/login` 返回 200，最新票据被消费，创建了一个 App 会话和一个默认工作区，模拟器进入首页。

Flutter 登录页在手机号无效或填入六位码但缺少当前请求票据时显示对应提示。后端 Typecheck、Lint 和 35 项短信及认证相关测试通过。Flutter 定向分析、7 项认证测试和 Android 调试构建通过。隔离数据库迁移成功，`public` 物理外键数为 0。

## 通用工具

`pnpm sms --help` 查看用法。输入从 stdin 读取，限制 8 KiB；支持一个中国大陆号码，不接受逗号群发。

```json
{
  "phone": "<接收手机号>",
  "signName": "触达科技",
  "templateCode": "SMS_508520316",
  "templateParams": {"code": "<验证码>"},
  "outId": "<可选业务关联标识>"
}
```

```sh
# 校验并显示脱敏预览；不发起网络请求。
pnpm sms preview < /path/to/sms-request.json

# 显式提交一次；命令级 live 设置不改变 .env 或运行中的 API。
SMS_PROVIDER=live pnpm sms send < /path/to/sms-request.json
```

工具输出为 JSON，包含 `status:accepted`、`bizId`、`requestId`、`outId`、脱敏手机号和中国时区的 `sendDate`。它不输出短信变量、短信正文或密钥。无需 tsx 的构建产物入口为 `node --env-file-if-exists=.env dist/entrypoints/sms.js`，先执行 `pnpm build`。

查询输入使用上次受理结果中的 `bizId` 和 `sendDate`：

```json
{"phone":"<接收手机号>","bizId":"<发送返回的BizId>","sendDate":"<yyyyMMdd>","page":1,"pageSize":10}
```

```sh
pnpm sms query < /path/to/sms-query.json
```

返回状态 `sending/delivered/failed/unknown`，空列表表示当前尚未查到记录。API 支持最近 30 天的记录；服务校验真实日历日期和分页边界，超出供应商查询窗口由其返回错误。查询结果省略供应商的 `Content` 和原始手机号。

通用工具不创建登录 OTP 记录，手工发送的数字不能据此用于 App 登录；App 登录必须通过上述认证接口生成票据。

## 受理、送达与重试

`Code=OK` 仅表示网关受理，只有 `QuerySendDetails.SendStatus=3` 才标为送达；`1/2` 分别表示发送中/失败。发送不会自动轮询或自动重发，由调用方用回执查询确认最终结果。

`SendSms` 无供应商幂等能力。SDK 的新旧两套重试配置均禁用；`outId` 是关联字段，不是供应商幂等键。每次手工执行 `send` 都是一次新的发送，同一 `outId` 也不能用于安全重发。

SDK 超时、网络异常或缺失受理字段归为 `unknown`。登录流程保留已有 `pending` 记录，同请求键重试返回 `SMS_DELIVERY_NOT_CONFIRMED`，不会再次调用供应商，也不能用该票据登录。明确业务拒绝才写 `failed`。已有 `sent` 表示网关已受理，不宣称运营商已送达。未知结果需人工在控制台按号码/日期核实；本轮未增加自动对账任务。

错误只输出受控错误码、结果分类和供应商 RequestId，不转发可能含签名请求、手机号或验证码的 SDK message/data/cause。

## 2026-11-12 短信适配器验收

- Typecheck、Lint、Build、337 项 unit/contract 全部通过；其中短信 28 项使用模拟 SDK 响应，覆盖 HTTP 200 业务失败、超时不重试、脱敏、前导零、模板变量、回执枚举及配置边界。
- 120 项真实隔离 PostgreSQL/Redis/Milvus 集成测试通过；新增的两个短信用例使用模拟供应商，真实验证 OTP 持久化、登录、同键不重发、未知结果保持 pending 及拒绝登录。测试临时容器已清理，没有操作开发库或现有数据卷；外键为 0 和关系索引/CRUD 检查通过。
- 使用现有真实 RAM 配置，只读查询并核对签名与模板审核通过。用户明确提供测试号码后，通过本服务/工具和真实 SDK 只提交一条随机验证码短信；第一次查询无记录，随后 sending，第三次查询 delivered，用户另行确认收到。验证码未落盘；原号码输入文件已删除。脱敏结果和关联 ID 保留在忽略提交的 `.local/sms-service/live-result.json`。
- 当前 App 为 `../huahuo-ai`，Git 已初始化但尚无 commit、无 origin。实际 `HttpAuthRepository` 的 `purpose:sign_in`、`clientType/clientId`、幂等头及响应解析与现有后端一致；只做源码核对和后端测试，未运行 Flutter 或改动 App。
- 业务四角色未重建，数据库 Schema/迁移未修改。本次止于短信服务、工具、配置和验收，不推进其他阶段。
