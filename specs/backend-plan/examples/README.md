# 配置蓝图：交给Codex落实，不是已可启动的后端

App只读参照：https://github.com/kyriswu/huahuo-app 。本目录不含App源码或实现后的Node源码。

P01把本目录中的Compose/Dockerfile/脚本范例落实到**独立后端根目录**，生成实际src、package.json、lockfile、migration、build和启动入口后再运行。不要直接在此目录执行compose up宣称后端已经完成。

- `compose.yaml`：一份文件定义4个应用角色＋PG/Redis＋一次性migrate。
- `.env.compose.local.example`：本地PG、Redis服务名；`COMPOSE_PROFILES=local-db`。
- `.env.compose.cloud.example`：云PG、验证TLS；不启用local-db。云账号和角色需预先授权准备。
- `Dockerfile`：共用镜像的多阶段构建蓝图，4角色用不同command；build须复制admin模板/静态资源到dist。
- `.dockerignore`：排除App参考目录、.git/.env、私钥、用户文件等。
- `scripts/healthcheck.mjs`：HTTP健康探测程序，可在实现相关端点后使用。
- `infra/postgres/init/010-roles.sh`：本地首次空卷初始化非superuser角色，不是生产密码轮换脚本；业务表权限由migrate逐迁移明确授予。

版本标签使用需替换的占位值；P01应查询可用稳定版本并锁定完整tag/digest，PG模板volume针对17系路径，如选18及以上需核对官方镜像PGDATA/volume布局。不要把latest放进生产。

凭据全部为占位说明。P01实现本地随机secret生成，推荐hex避免URL特殊字符问题；提交只留example，真实.env/git凭据/商户私钥不入库。云PG不支持自建角色时记录人工准备条件，不自动使用superuser。

同一Compose在本地和cloud上分别用.env启动。所有长期角色只收到自身DATABASE_URL，迁移角色只给migrate。初始建库postgres容器仅开发本地含所需建角色密码；实际生产应使用secret挂载/编排系统。

示例资源限制是可配置预算，不是并发承诺。redis默认仅Docker网络可达，无公网端口；发布时按威胁模型增加ACL/TLS，不能把当前本地示例等同生产安全验收。

`migrate`具有所有表的DDL权限，但业务服务没有默认所有表授权；每条migration需同时授予api/admin/worker/scheduler实际所需操作，schema ready检查验证后再启动。表权限做不到业务行隔离，用户/工作区授权仍不可省。

migrate不能重复依赖自身，应用也不depends_on postgres。postgres首次init后就绪，migrate通过实际endpoint重试；cloud不启动本地PG也能使用同一拓扑。

## v3 本机蓝图

默认目录Code/huahuo-server，App在../huahuo-app。新增 `scripts/preflight-local.mjs`（无第三方依赖，只读预检）和 `scripts/ensure-docker-local.sh`（默认检查，--start才启动已装本机Docker）。两者可以在规范目录阅读/执行，**不是业务已经完成**。工具脚本不得作为业务容器必须运行的启动步骤。

Dockerfile新增可选tooling target；主机缺Node/pnpm时可用固定镜像的临时工具容器生成Server依赖/锁文件并验证。只挂后端，合理设置文件所属用户，不能为了“看App”把整个Code目录挂载到构建或运行容器。

compose.yaml必须由P01落实到Server根再构建，当前examples没有应用源码。环境示例的镜像/凭据占位必须替换；脚本不会自动清空现有环境，也不会自动填充商户或Dify密钥。所有本机/外部回调地址见12规范。
