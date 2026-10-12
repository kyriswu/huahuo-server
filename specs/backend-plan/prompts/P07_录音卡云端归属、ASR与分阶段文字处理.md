# P07 · 录音卡云端归属、ASR与分阶段文字处理

持续约束：执行前阅读 [知识图谱标签化补充要求](../13_知识图谱标签化补充要求.md)；图谱只做标签驱动的素材关联，后续也不得自行增加向量/RAG/Dify 知识库。与旧条款冲突时以该补充要求为准。

前置阶段：P03—P06。

## 本阶段固定部署与 App 参照

- App只读参考仓库：**https://github.com/kyriswu/huahuo-app**。本机后端根为 `huahuo-server`，App位于同级 `../huahuo-app` 且只读；禁止把服务写进App、复制Flutter作为运行依赖或擅自修改UI。
- 同一根目录Compose：`api-server`、`worker`、`admin`、`scheduler`独立容器；`postgres`（可切云）、`redis`、一次性`migrate`。本阶段涉及：api-server设备/回调/状态；worker ASR与后处理；scheduler轮询任务投递。
- 先按 `07_App代码持续参照与契约核对.md` 核对本阶段：录音卡云端归属、recording/ASR、speaker、transcript及分阶段重试。路径/符号从当前checkout发现，不猜它们一定在旧目录；记录实际commit和本地改动。
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

承接手机上传的录音卡素材，形成可追溯的转写、说话人与内容，而不是重写蓝牙驱动。

## 实施要求

1. Device/DeviceBinding/上传来源建立归属校验。设备claim需要可信proof/平台确认；SN本身不足以证明所有权。具体硬件证明协议未知时记录blocking，不开放任意SN抢绑定。
2. 记录device file identity、手机resource、recording、ASR job、transcript revision、note间映射；设备上报电量/状态标observedAt，不将云缓存说成实时值。云端解绑不假称手机已擦除卡内文件。
3. AsrProvider的submit/status/cancel（实际支持时）、规范化回调或轮询。Dify ASR与独立ASR二选实际配置，不重复给同音频转写。API密钥、region、model版本在适配层。
4. 内容验证后创建ASR任务和额度预留，持久providerJobId。长任务采用提交+轮询/回调的阶段，不让API长连接等整个ASR；未知提交结果优先核查。
5. 转写按segment存text、start/end、speakerLabel与来源revision。说话人聚类不等于实名/本人；提供用户确认接口及后续数字孪生可用片段范围。
6. 原始转写、摘要/纲要、深度洞察分别状态、分别重试。转写成功先可读，不因摘要失败重做ASR。修改转写保留版本并让依赖结果待更新。
7. 批量任务是子任务组合，有已完成跳过、partial、逐文件错误；通知在P13接入，当前PG任务状态先可靠可查。
8. 声纹等敏感资源按现有能力支持/禁用，单独授权保留/删除，不从普通转写默默构建声纹。

## 必须验证

- 已到手机、已上传、ASR运行、文本可读、摘要失败各自准确。
- 重复音频提交在明确scope策略下去重，不暴露别人相同文件存在性。
- 重复/乱序回调、杀worker、ASR超时结果未知、用量迟到、批量部分失败均不重复收费。
- 本人确认变更后候选来源失效能被数字孪生检查。
- 使用合法测试音频和供应商sandbox需授权；无供应商仅模拟语料，状态登记。

## 不做或不得误报

只验云端素材链，不声称已验证真实录音卡硬件；不新增手机内录/外录入口。

转写形成可读素材后，复用 P06 的 TagExtractor 任务入口和版本检查。未转写时仅保留原文件与待处理状态，可人工分类。
