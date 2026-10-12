# 本地 App／Docker 联调地址与验证 · v3

App本地目录：`../huahuo-app`；来源：https://github.com/kyriswu/huahuo-app 。Server本地根为 `huahuo-server`。本文件是部署与验证指令，不代表已经修改了App运行配置。

## 1. 同机源码，不等于所有连接地址都用localhost

| 调用方 | 目标地址策略 | 注意 |
|---|---|---|
| Mac浏览器/curl → API | `http://127.0.0.1:<API_HOST_PORT>` | 默认3000，以实际启动配置为准 |
| Mac浏览器 → Admin | `http://127.0.0.1:<ADMIN_HOST_PORT>/admin` | 默认3001；仅Admin加载管理路由 |
| Compose里的API/Worker → PG | `postgres:5432`（local-db） | 不是127.0.0.1；云PG改真实endpoint＋TLS |
| Compose里的业务角色 → Redis | `redis:6379` | 不向宿主/手机公开 |
| 同一Compose内受控工具调用 → API | `http://api-server:3000` | Docker服务名不返回给手机或外部云服务 |
| 容器 → Mac上已运行的可信服务 | `host.docker.internal:<port>` | Docker Desktop专用方向；不是手机访问Mac的地址 |
| iOS模拟器／Android模拟器 → API | 依当前模拟器网络核对可达地址 | 不把Android模拟器、iOS模拟器或真机一概配置成相同localhost；不运行改写App的命令 |
| 同一LAN的真实手机 → API | Mac实际LAN IP＋API发布端口 | 手机localhost指手机本身；默认回环绑定需显式改成LAN接口后才可达 |
| 云Dify工具、ASR/支付回调 → API | 经过授权的可达HTTPS测试地址 | 不能访问Mac的localhost、api-server或普通内网IP；不要为了测试公开Admin |

Docker容器监听 `0.0.0.0:3000` 与宿主端口发布到 `127.0.0.1:3000` 不矛盾。默认仅本机可用。

## 2. 真机联调时最小开放

需要LAN联调且用户授权后，只修改实际本地.env中的API_BIND_HOST为合适的Mac网卡IP；确有需要也可0.0.0.0，但会扩大到所有接口。Admin继续回环绑定，PG/Redis不公开。检查Mac防火墙/Wi-Fi客户端隔离，不直接关闭系统防火墙。

`APP_PUBLIC_BASE_URL` 必须与手机/下载者可访问地址一致，用于授权资源URL等。`INTERNAL_API_BASE_URL` 用于内部连接；可选 `TOOLS_PUBLIC_BASE_URL` 单独表达云工作流回调地址。地址从可信配置取得，不能信任客户端Host头来签发下载URL。

这些配置是开发者提供的环境，不是自动获取公网隧道的授权。不替用户安装隧道、开放公网或上传私人素材。ASR供应商必须能安全取得媒体，必要时使用有时效授权的对象存储URL；本地磁盘路径不能直接发给云ASR。

## 3. App环境配置只读核对

P01发现现有App如何注入Base URL、认证头和环境开关；P15在 `docs/runbooks/local-app-integration.md` 给出**根据真实代码核对过**的命令/配置建议。

不能猜测App必然支持 `--dart-define=API_BASE_URL`，不能直接改App源码硬编码本机IP。已有运行参数支持时给出准确用法；必须修改数据层配置时先写App改动提案，等待授权。

通常服务监听测试、后端fixture契约测试可先完成，不要求安装Flutter/Xcode/Android工具链才能开始后端项目。实际Flutter构建/测试可能写.dart_tool等目录，应明确另行授权或隔离测试副本；未执行不能写真机通过。

## 4. P01与P15的验证区别

P01：确认Mac到API/admin可达、内部容器到PG/Redis可达、角色隔离、记录App连接注入方式。不要求真实设备/支付/Dify都通过。

P15：逐项验证App真实解析、登录、上传、Range播放、流式断线恢复、保存结果、数字孪生确认和购买沙箱。底层API只返回200不算前端兼容。手机录音卡蓝牙传输与后端音频处理是不同验证范围。

每份证据写清调用方、实际地址（脱敏）、测试环境、输入fixture、结果与未覆盖项。支付/短信/模型/公网测试需要授权，不因在本机就默认免费或无外部影响。

## 5. 首版完成后的本机检查示例

先完成P01实际代码与配置，这些命令不是对当前空目录的承诺：

```bash
# 当前在huahuo-server；已有真实.env.compose.local和compose.yaml
docker compose --env-file .env.compose.local config --quiet
docker compose --env-file .env.compose.local up -d --build
docker compose --env-file .env.compose.local ps -a
# 下列端口与实际.env一致；若不是3000/3001则按实际替换
curl --fail http://127.0.0.1:3000/health/ready
curl --fail http://127.0.0.1:3001/health/ready
# 确认公共API未挂管理路由（预期404）
curl -i http://127.0.0.1:3000/admin/api/v1
```

不要公开粘贴 `docker compose config` 展开后的所有环境秘密，优先 --quiet；日志同样脱敏。健康就绪不能代替业务、权限、支付或负载验证。
