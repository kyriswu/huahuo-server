# P08 · Dify运行、Chat历史、附件与流式恢复

持续约束：执行前阅读 [知识图谱标签化补充要求](../13_知识图谱标签化补充要求.md)；图谱只做标签驱动的素材关联，后续也不得自行增加向量/RAG/Dify 知识库。与旧条款冲突时以该补充要求为准。

前置阶段：P03—P07。

## 本阶段固定部署与 App 参照

- App只读参考仓库：**https://github.com/kyriswu/huahuo-app**。本机后端根为 `huahuo-server`，App位于同级 `../huahuo-app` 且只读；禁止把服务写进App、复制Flutter作为运行依赖或擅自修改UI。
- 同一根目录Compose：`api-server`、`worker`、`admin`、`scheduler`独立容器；`postgres`（可切云）、`redis`、一次性`migrate`。本阶段涉及：api-server会话/SSE/工具API；worker Dify执行；scheduler失联运行对账。
- 先按 `07_App代码持续参照与契约核对.md` 核对本阶段：chat/thread/message/agent/run/SSE、文件身份与历史继续聊天。路径/符号从当前checkout发现，不猜它们一定在旧目录；记录实际commit和本地改动。
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

让现有Agent工作流通过自有后端稳定运行，历史文本与附件可重载，运行有计量与恢复。

## 实施要求

1. Conversation/Thread、Message、MessageAttachment、Run、RunEvent、ContextSnapshot、provider identity映射。并行run是否允许按场景明确，不随便串入同一provider conversation。
2. WorkflowProvider实现Dify真实HTTP adapter+模拟adapter。先核对实际Dify部署版本与应用类型：workflow/chatflow各自能力和协议，不把所有应用都当同一接口。
3. profileId/业务场景→workflow配置由服务端管理。对外稳定业务标识，内部keys和workflow id不暴露给App。先复用用户工作流，不自动生成大量新workflow。
4. 用户消息/附件/已选素材/数字孪生使用授权形成snapshot，调用前重新核权。provider文件ID与本地resource映射，可在过期后重新上传；不把图片显示出来等同于模型支持该图片。
5. 每次外部请求持久意图与相关身份，启动/流中断/终态查询能力如实处理。Dify缺少全局幂等或可查外部ID时用reconciling，不把内部Idempotency-Key当外部保证。
6. SSE规范化event，序号/游标/心跳/背压/保留窗口，先持久化批次再发布。重连重放或结果快照，不重复创建消息；最终文本、附件、引用落库后才宣告结果成功。
7. 素材查询工具API采用服务端发行的短期任务凭证，限定scope/audience/user/workspace/run；输入为query、filters、assetIds等白名单，不接受SQL。可返回带来源版本的bounded片段。
8. Dify云端不能直接访问开发机localhost；文档分别说明自托管Docker网络地址、公共HTTPS受控入口或用户授权的开发隧道，不自动暴露数据库。
9. Run调用P04准入/预留/测量/结算。未知消耗与取消不直接清零；供应商token/API成本与用户credits分别记账。TagExtractor等后台文本任务复用相同预算和provider接口。
10. 历史删除范围、对话重命名、当前run取消与只是离开页面分开。记录AI生成标记与引用，不保存私有思维链或内部secret事件。

## 必须验证

- 创建thread→带resource发送→流式→断线→恢复→同一结果→下一轮继续。
- 过期附件URL可重新授权；无权限附件不发送给provider；不支持媒体明确拒绝/转换。
- 两用户同名thread、重放token、伪造工具userId、越scope查询全部拒绝。
- provider超时/重复终态/用量缺失有状态和账本证据；回放不重复扣费。
- 缺Dify配置时只本地fixture；真实workflow集成状态不混用，读取当前用户工作流不擅自改写。

## 不做或不得误报

不新增LangChain/Haystack替代Dify；不实现任意SQL Agent插件。

标签提取复用 P06 可配置接口，接通直接 LLM 或 Dify 工作流、逐段预算与 provider 用量/未知调用恢复。素材插件按指定资产、标签、关键词、时间、来源查询授权原文，不接 Dify Dataset 或知识检索节点。
