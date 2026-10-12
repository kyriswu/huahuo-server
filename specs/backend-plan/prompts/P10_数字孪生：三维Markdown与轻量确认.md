# P10 · 数字孪生：三维Markdown与轻量确认

持续约束：执行前阅读 [知识图谱标签化补充要求](../13_知识图谱标签化补充要求.md)；图谱只做标签驱动的素材关联，后续也不得自行增加向量/RAG/Dify 知识库。与旧条款冲突时以该补充要求为准。

前置阶段：P06—P09。

## 本阶段固定部署与 App 参照

- App只读参考仓库：**https://github.com/kyriswu/huahuo-app**。本机后端根为 `huahuo-server`，App位于同级 `../huahuo-app` 且只读；禁止把服务写进App、复制Flutter作为运行依赖或擅自修改UI。
- 同一根目录Compose：`api-server`、`worker`、`admin`、`scheduler`独立容器；`postgres`（可切云）、`redis`、一次性`migrate`。本阶段涉及：api-server数字孪生CRUD/确认/工具；worker候选提炼；admin默认只看处理元信息。
- 先按 `07_App代码持续参照与契约核对.md` 核对本阶段：digital_twin模型/维度/Markdown投影、候选/来源revision/ETag/确认回执。路径/符号从当前checkout发现，不猜它们一定在旧目录；记录实际commit和本地改动。
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

在保留数字孪生名称和原页面结构的前提下，实现可维护、可追溯、用户确认后使用的个人信息。

## 实施要求

1. 核对当前App维度与逻辑文件结构，默认标识user_profile、viewpoints_and_methods、language_and_expression需经源码确认；内部分短Markdown条目、category、source refs、revision、状态。
2. 用户手动新增/编辑直接是确认行为；AI从用户授权材料或对话提出candidate。无需建立另一个向量知识库，也不搞周期自动学习；没有本人身份确认的多人录音不写用户事实。
3. candidate支持add/update/no_change/conflict；稳定source revision+extractor/prompt版本+维度的幂等。不同录音重复经历做内容去重，不只靠任务幂等。
4. 正式内容通过小事务confirm：权限、candidate未消费、source仍有效、baseRevision匹配→写正式条目/简短修订记录→候选已处理→返回正式版本。失败不能通知已记住。
5. 编辑/删除/停用语义按客户端保持简单。对删除和拒绝保留必要的处理标识，旧source/job重试不能重新复活；历史恢复不重引已彻底删除的条目。
6. 原文修正、本人归属改变、source删除使依赖candidate过期，正式条目标记待复核，默认工具不返回。不是把所有采集内容自动当成用户观点或本人经历。
7. 提供数字孪生概要/三维文件投影、条目列表/CRUD、待确认、查看来源与轻量修订API，兼容旧数字形象/文件页面需要的字段；不生成“我的记忆”新一级产品或人格分数。
8. 工具get_twin_context可按维度/小节/关键词返回bounded Markdown与版本，只读取已确认且允许使用内容。内容少时读取完整所需维度，不因主题词过滤掉表达偏好。
9. 创作使用开关和本次不参考分开；修改/撤销后缓存版本更新，调用provider之前再核权。已向模型发送的上下文/历史文章无法假称自动撤回。

## 必须验证

- 手动新增、候选确认、编辑、删除四种数据变化正确；更新不增加条目数。
- 双击确认只一次，旧revision确认409，unknown核验不能伪成功。
- 第三方素材不会变成本人经历；未确认候选不在工具返回中。
- 删除后历史job重放、源文改变、权限撤销不会静默恢复/泄露。
- 三个逻辑Markdown文件可呈现，不依赖真实向量服务或模型训练。

## 不做或不得误报

保留“数字孪生”名称与老UI，不做白底记忆产品重构、周期维护或重型档案工作台。

数字孪生保持独立：素材标签不自动成为用户个人经历、观点或表达风格。
