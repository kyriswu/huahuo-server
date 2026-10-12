# 花火 Fastify 后端 · Codex 完整实施包 v3

**2026-10-09｜本机 huahuo-app / huahuo-server 同级目录版。** 完整替代v2，保留P01—P16全部业务，不是差量补丁。

App来源：https://github.com/kyriswu/huahuo-app

## 最短使用方式

```text
Code/
├─ huahuo-app/                    # 用户现有代码，只读
└─ huahuo-server/                 # 后端建设根，不改名
   └─ specs/
      └─ backend-plan/           # 将压缩包根目录backend-plan放这里
```

1. 解压本包，把 `backend-plan` 放入现有 `huahuo-server/specs/`。没有specs可创建，有旧指令先核对备份或交Codex合并，不覆盖运行代码/.env。
2. 本机Codex主工作区选huahuo-server，读取App的权限单独保持只读。把 [00_启动指令.md](00_启动指令.md) 全文发给它。
3. 先按 [11_本机双目录与Docker开工规范.md](11_本机双目录与Docker开工规范.md) 做短预检，随后直接实施P01。用户已装Docker，必要时允许启动，不重装。
4. 阶段完成后审阅真实验证，再说“继续下一阶段”。App每阶段本地参照，不默认联网clone/pull。缺供应商配置按模块标记，不把完整工程卡死。

这是**指令/规格与配置蓝图**，不是完成的Fastify源码；没有接入用户Mac，没有替用户启动Docker。本机实际运行由Codex执行。examples缺业务src/lock/真实版本与凭据，不能直接compose up冒充后端完成。

## 固定拓扑

```text
huahuo-server/compose.yaml
├─ api-server  独立App接口容器
├─ worker      独立后台执行容器
├─ admin       独立管理API＋最小运营网页容器
├─ scheduler   独立调度与Outbox扫描容器
├─ postgres    本地PG容器，local-db profile可切云PG
├─ redis       本地缓存与BullMQ容器
└─ migrate     一次性迁移，完成退出0
```

可共用镜像与领域服务，不能同一容器混跑。api/admin默认回环3000/3001；PG/Redis不公开。首次迁移成功再启动应用，业务容器不自动跑迁移。

## 核心内容

| 文件 | 用途 |
|---|---|
| [00_启动指令.md](00_启动指令.md) | 直接给本机Codex，从当前两个目录开工 |
| [01_项目总提示词.md](01_项目总提示词.md) | 完整产品/技术/安全与执行规则 |
| [02_架构与配置约定.md](02_架构与配置约定.md) | 任务、数据、权限、存储与云PG |
| [03_业务模块与阶段映射.md](03_业务模块与阶段映射.md) | 全部业务与16阶段 |
| [04_全项目验收与发布门槛.md](04_全项目验收与发布门槛.md) | E2E、计费、隔离、故障与发布 |
| [05_来源与决策边界.md](05_来源与决策边界.md) | 用户事实、原计划、建议与官方来源分开 |
| [06_容器职责与Compose部署规范.md](06_容器职责与Compose部署规范.md) | 独立角色、网络、卷、迁移与重启 |
| [07_App代码持续参照与契约核对.md](07_App代码持续参照与契约核对.md) | 本机../huahuo-app优先，每阶段有依据 |
| [08_Admin独立管理台规范.md](08_Admin独立管理台规范.md) | 独立鉴权、网页、受控管理与审计 |
| [09_v2变更记录.md](09_v2变更记录.md) | 历史v1→v2说明，不覆盖v3当前路径 |
| [10_容器拓扑与阶段验收矩阵.md](10_容器拓扑与阶段验收矩阵.md) | 阶段/容器职责 |
| [11_本机双目录与Docker开工规范.md](11_本机双目录与Docker开工规范.md) | 本次新增重点：路径、权限、Docker、保护已有环境 |
| [12_本地App联调地址与验证.md](12_本地App联调地址与验证.md) | Mac/容器/模拟器/真机/云回调地址 |
| [13_v3变更记录.md](13_v3变更记录.md) | v3变更及已有工程无损衔接 |
| [13_知识图谱标签化补充要求.md](13_知识图谱标签化补充要求.md) | P06 标签驱动图谱的持续约束，覆盖 P07/P08/P09/P10 |
| prompts/ | 16份完整阶段指令，均包含本地App路径和源URL |
| templates/ | AGENTS、App参照、进度、供应商、容器及本机预检 |
| [examples/README.md](examples/README.md) | Dockerfile/Compose/env及辅助脚本蓝图 |
| stage-index.json | 阶段路径、依赖、服务、本地App参照机器索引 |
| package-manifest.json | 包内文件SHA-256与范围 |
| [VALIDATION.md](VALIDATION.md) | 本包真实验证，不冒充用户机器运行 |

## 范围不变

文件空间、录音卡与ASR、标签/关键词、图谱数据、Dify/Chat/创作、数字孪生、外部世界、支付/会员/用量、通知/设置/隐私、Admin与Worker/Scheduler全部保留。标签先做，语义检索后置；数字孪生原名称和UI不重构；Dify插件查询自己的受控API。

## 本次不再需要

默认重新clone App、搭建huahuo-backend新目录、复制旧后端、创建父目录monorepo、修改App UI、重装Docker或全局清理容器。已有App有本地改动不回退；已有Server文件和卷不覆盖。后端独立部署不依赖App checkout，源码只是开发时参照。

P01交真实独立容器骨架，不是全部业务完成；P02补Admin身份、P03补Worker任务、P14补运营网页，P15真实App联调，P16发布准备。不同验证状态与外部阻塞分开记录。
