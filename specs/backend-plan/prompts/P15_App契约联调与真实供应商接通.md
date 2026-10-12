# P15 · App契约联调与真实供应商接通

持续约束：执行前阅读 [知识图谱标签化补充要求](../13_知识图谱标签化补充要求.md)；图谱只做标签驱动的素材关联，后续也不得自行增加向量/RAG/Dify 知识库。与旧条款冲突时以该补充要求为准。

前置阶段：P01—P14。

## 本阶段固定部署与 App 参照

- App只读参考仓库：**https://github.com/kyriswu/huahuo-app**。本机后端根为 `huahuo-server`，App位于同级 `../huahuo-app` 且只读；禁止把服务写进App、复制Flutter作为运行依赖或擅自修改UI。
- 同一根目录Compose：`api-server`、`worker`、`admin`、`scheduler`独立容器；`postgres`（可切云）、`redis`、一次性`migrate`。本阶段涉及：api-server面向App的实际契约；四角色容器联调；admin独立鉴权与入口。
- 先按 `07_App代码持续参照与契约核对.md` 核对本阶段：所有本期实际移动端消费者与解析器，以前15阶段矩阵为起点逐项复核。路径/符号从当前checkout发现，不猜它们一定在旧目录；记录实际commit和本地改动。
- 实施前保存App基线；过程中每个客户端端点均能追到请求与响应解析；结束更新 `docs/app-reference.md` 和契约测试。不能等P15才第一次对照App。
- 读取不到源码时写UNVERIFIED_APP和受影响API，继续可独立开发部分，不声称兼容、不借此重做前端。
- 同一镜像不等于同一容器。api-server不执行worker任务、不注册admin路由；admin不绕过领域服务直接改支付状态；scheduler只投递/扫描。

## 本机工作区约束（v3，全部阶段适用）

- 优先读取 `../huahuo-app` 的当前本地源码和未提交内容，源地址仅用于识别： https://github.com/kyriswu/huahuo-app 。不要默认clone/fetch/pull或新建参考目录；阶段内记录实际阅读文件的哈希。
- 所有实现、文档、依赖和测试都放现有 `huahuo-server`。不是Code父目录，不是App，也不是再新建huahuo-backend。开始先检查隐藏文件，保留已有工作与数据。
- 同一份 `huahuo-server/compose.yaml` 管理独立容器；只操作本项目资源，保留数据卷，不能全局清理或停止其他项目。
- 按 `11_本机双目录与Docker开工规范.md` 检查本机Docker，必要时启动已安装的本机Desktop；若权限受限申请最小权限，不把ChatGPT的沙箱执行当用户Mac执行。

## 执行方式

先读取 `specs/backend-plan/01_项目总提示词.md`、`02_架构与配置约定.md`、`docs/progress.md`（P01尚不存在则新建），遵守当前工作区AGENTS及11规范。不重建已完成阶段，不以本文建议覆盖已核实的客户端契约。

本阶段要实际写代码、migration/schema、测试和可运行命令，不只写方案。依赖的真实provider未配置时完成接口与明确模拟测试并标阻塞，继续其他可实现部分；生产严禁模拟成功。

阶段结束：运行类型/lint/相关测试，更新progress/provider-status/contract-compatibility/app-reference/container-status，报告实际命令、结果、未验证项。别擅自push、上线、发真短信、真支付/退款、付费任务或改App UI。

## 本阶段交付目标

逐项核对移动端实际消费者和真实外部服务，不以内部单测替代产品联调。

## 实施要求

1. 汇总P01—P14每阶段的App核对证据，读取App当前可访问commit并比对冻结基线；只追踪本期路由/Controller/Repository/API解析；生成兼容矩阵，标CODE/USER/PROPOSED/BLOCKED。没有证据不能写100%兼容。
2. 对既有HTTP路径、request headers、幂等别名、ETag、pagination、特殊envelope、binary、SSE、错误与严格enum做fixture契约测试。优先在后端serializer/adapter兼容，不给App额外字段撞严格解析。
3. 数字孪生三个维度、旧数字形象/文件投影、材料候选确认；Chat历史附件；录音阶段；支付SKU/额度政策限制重点验证。保留名称与UI，不把前面已废弃白底“我的记忆”设计再引入。
4. 无法无损兼容的接口形成最小客户端数据层patch提案，含原因、测试和回退；不修改Flutter UI。对App代码实际修改需用户单独授权。
5. 根据provider-status配置真实Dify、ASR、storage、SMS、payment sandbox、push逐项接通；只在授权范围调用。用已批准的测试语料，记录请求/任务关联和脱敏证据。
6. 生成正向与故障E2E：资产→查找→创作、录音上传→转写→引用、数字孪生候选→确认→工作流、付款→权益→Run计量、外部文章→个人副本。
7. 供应商无账户/硬件proof未知/工作流缺输入定义等不阻塞其他已可验证模块；逐项写清需要的资料、风险与禁用范围。绝不以mock日志当真实供应商结果。

## 必须验证

- 关键AppDTO对真实后端返回解析通过；compat测试不只比较status200。
- 开发测试两用户、跨工作区、重新登录、断网/流恢复、删除/版本冲突。
- 各provider分别记录适配代码完成、模拟、sandbox/live验证，缺项未虚报。
- 保存一份完整联调日志索引和最小App改动清单；未读源代码的端点保持未验证。
- Flutter真实/契约测试只连api-server公开地址，不直接连接admin、worker、scheduler、PG或Redis；Dify使用受控工具入口，不要求运行时访问App源码。
- 同一Compose上重启四角色分别测试会话/任务/管理隔离；本地文件在api-server上传后worker能读取，admin不读取共享卷绕过授权。

## 不做或不得误报

不再重开一次全仓架构审计；不把联调阶段变成App全部重写。

## v3 本机前后端同机联调

沿用12规范，区分Mac浏览器、iOS/Android模拟器、真机和云回调。根据../huahuo-app中真实Base URL注入写准确运行说明，不猜dart-define参数，不直接改App。默认API/admin回环发布；真机需要LAN时先明确开放范围，Admin/PG/Redis不顺便对外开放。Dify/ASR云端访问需要已授权可达地址，本机localhost不能直接交给云工具。
