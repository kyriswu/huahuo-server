# Admin 文档解析试用与代码清理（2026-11-15）

## 后续现有环境更新

手动启动与正式回调专项已将最新纯内存试跑一并更新到现有本地主栈，见[部署与验证](document-async-events.md)。下方“未部署”属于此前测试记录。独立测试Admin角色无回调读取授权；实际开发RDS账号已有角色继承，不能套用该最小权限结论，本轮未修改账号关系。试跑本身继续零数据库写入，不参与正式任务或云开停。

## 单一入口、纯内存试跑简化（2026-11-15）

用户明确只需在现有入口验证功能。试跑改为读取现有鉴权/配置后直接调用已可访问的解析 API，结果仅在内存临时保留并回传；只保留“运行配置 → 解析与模型”弹窗，不扩展通用试跑平台。移除试跑审计写入、PG 回调/结果收件、节点分配、开停机调度、LISTEN 唤醒、恢复重试与前端 sessionStorage；关闭服务后丢弃状态，刷新页面不尝试恢复。PDF/Office 使用原 DocumentExtractionClient 的异步提交/GET 结果协议，节点须预先启动并可访问，不自动启动或切换节点。

未上线唯一基线去掉试跑专用 trial_id/索引和 Admin 回调表权限；持久回调表仅服务用户正式任务。API/Worker 用户提交、回调认证、intent 收敛、取消及结果事务保持，回归通过；没有修改现有业务库、ENV 或主容器，也没有旧表回填/兼容分支。

最终 473 项 unit/contract、239 项真实隔离 PG/Redis integration 通过（1 项真实 Milvus 跳过），typecheck/lint/build 通过。原生 Markdown 与 PDF 试跑验证任务、文档、资源、索引、Outbox、回调、节点分配及审计表行数不变；中断关闭后另一实例找不到旧试跑，也没有第二次提交，Admin 账号没有回调表读取权限。正式业务回调仍由 Worker 准备、API 接收。供应商 HTTP 使用替身，没有真实开机/解析/OSS/模型调用。

首次回归暴露业务回调测试夹具缺少任务归属，已补真实用户/工作区；既有 1.2 秒租约排空测试连续失约，改为 5 秒租约并显式等待真实 lease_until 延长，11 秒任务超过两轮租约且一次 attempt 成功，未改生产默认 15 秒租约。完整最终命令日志在 `.local/admin-trial-simple/verification-final.json` 及同目录 `*-final.log`。

前端沿用现有样式，只更新临时结果/中断重试说明与耗时项。Impeccable 检测无发现；原生 Chrome 查看当前构建的本地替身 API 预览，唯一入口与新弹窗说明可见。窄屏复核因浏览器发生用户操作而未继续，不冒充已完成移动端或真实部署验证。App 仍只读，真实 PDF 服务须在可达内网单独验证。

## 使用已部署 ECS 默认参数（2026-11-15）

当前 CPU ECS 直接走既有 API，不要求镜像或完整提取 JSON。删除全局四项 document 设置和重复开关，调用参数归各节点 config JSON；默认 /extract 同步调用且不发送 config，提取器沿用服务端默认模型/设备。节点分配快照覆盖调用参数，已知 job 恢复只 GET，安全文件重试仍用原分配参数。CPU 页面默认仅核心字段，其他选项折叠，GPU ECI 镜像配置对 CPU 隐藏；试用仍在解析与模型 Modal，关闭原因区分部署开关与无在线节点。

本轮仅验证本地后端及 Admin，不请求 ECS/ECI 控制面、内网解析或付费模型。真实依赖测试使用独立临时 PostgreSQL/Redis，提取服务由 loopback/fetch 替身提供；不能作为 CPU 实机解析验收。未修改识别核心、App、Schema 或唯一基线。最终检查与主环境同步证据见 `.local/node-api/`。

436项unit/contract、223项真实隔离PG/Redis集成通过（1项Milvus跳过），typecheck/lint/build、Compose展开及UI检测通过。与镜像构建并行的一轮集成出现PG连接中断和既有5秒用例超时；构建结束后原样重跑通过，未放宽时限。新增覆盖CPU省略config、显式GPU覆盖、两节点不同同步/异步参数、已知job在节点编辑后仍只GET、文件重试保留原调用参数，以及业务FILE_UPLOAD/试用共用客户端。

现有开发库先回滚演练再单事务调整：移除四项旧全局键，CPU节点增加server-defaults调用配置，保留实例/地址/16并发/文档音频能力/不在线状态；运行配置revision2→3，节点3→4。Chrome用原账号完成两次原值保存验证后节点revision6，仍只有一条记录。用户/管理员/工作区各1条，笔记/资源/入库表0，原132条维护任务与结果保留，物理外键0；Schema和基线checksum未改，无凭据或ENV变动。

主Compose四角色使用同一完整镜像huahuo-server:node-api-20261115（2f171262…2e798e），healthy/readiness200；HTML/JS200，匿名管理401，App同路径404。Chrome确认默认六项核心字段、CPU无镜像项、高级配置可折叠、空提取覆盖直接保存及成功反馈、试用入口与新关闭原因；1512px/390px无横向溢出。云开机和节点在线开关保持关闭，不发出云控制面、内网解析或付费请求，真实PDF/Office待用户部署内网后验证。

证据：.local/node-api/ 的 db-rehearsal.json、db-result.json、runtime-result.json、测试/构建日志与node-config.jpg / node-config-390.jpg。App两份只读参照哈希一致，不改App、不推进Pxx，当前代码未提交/推送。


用户要求仅在管理员后台试解析，复用业务逻辑，不走资料入库；节点状态文案指定为“在线 / 不在线”。

## 已完成

- 后台“运行配置 → 解析与模型”标题旁的“文档解析试用”按钮打开Modal，不占独立菜单或页面。支持本地文件和HTTP(S)直链、异步状态/取消、下载/节点等待/解析请求/总耗时、完整Markdown与JSON查看及下载。关闭再打开保留当前任务；文案、配色沿用当前黑白灰后台。
- TXT/Markdown/CSV复用现有原生文本解析，PDF/Office复用完整DB配置、DocumentExtractionClient协议和ProcessingNodes共享整机占用。没有复制OCR、模型、表格、图片策略或建立第二条识别实现。
- 不创建notes、resources、rag_ingestion_versions、text_ingestion_jobs、Task入库任务或关键词/向量索引。只保留管理员审计和必要的节点占用元数据；图片上传仍由现有解析镜像按原配置执行，不自动登记为业务素材。
- 试用仅superadmin，沿用有效Admin Session、Origin/CSRF和结果归属检查；下载沿用业务域名白名单/类型与大小验证。单次最高32MiB且受业务限额约束，全局一次一个试用；结果内存临时保留15分钟，数量有界，重启不保留。用户确认以用户侧稳定为最高优先级：试用发布/重启中断或跨副本找不到状态时允许重新发起，不新增持久化、跨实例接续或强制实例亲和，也不要求等待试用完成才能发布；必要的共享节点占用核对与资源回收沿用现有机制。
- 节点“在线 / 不在线”表示是否接收新任务；不在线后原已分配任务继续恢复。没有将此字段冒充实时云实例健康。

## 清理

删除旧DOCUMENT_PARSER/DOCUMENT_EXTRACTION环境加载器及默认process.env回退，DB直接构造类型化配置；移除用于校验的假AK、闲置构造参数、未使用回调/开关及旧configure-idle旁路。测试改为显式配置/夹具，删除失效环境项。构建先清理生成的dist，避免旧产物残留；OS元数据加入忽略。历史验收、运行日志、DB变更前快照只保留在文档或忽略的.local，不进入发布镜像。

## 首轮验证与部署

- typecheck、lint、build通过。
- 434项unit/contract通过；移除了一项仅针对已删除旧开关的测试，未削弱当前配置校验。
- 219项真实隔离PG/Redis集成通过，1项Milvus跳过。新增验证：Session/角色/CSRF、原生Markdown试用、业务数据/索引/任务表行数不变、非法文件/未配置PDF/元数据地址拒绝，以及使用同一完整配置与节点占用的模拟PDF请求。
- PDF协议/节点测试使用替身，不冒称真实CPU或GPU验收，没有发起付费解析。
- 原有实际RDS仅补管理员对节点占用表的必要操作授权，并按已核对差异CAS更新基线校验；没有新增业务表或清空/改写资料。
- 主Compose四个既有独立角色更新到同一完整镜像，均healthy/readiness200，保留原账号与数据。HTML/JS200，匿名试用401，App同路径404；Chrome工具仍报告browser host unavailable，未宣称截图/交互验收通过。CPU节点/解析模式/部署总开关继续关闭，TXT/Markdown/CSV可原生试用；PDF/Office须先取得CPU完整参数并配置可用节点。

本机证据：`.local/runtime-config/cleanup-unit.log`、`trial-integration-final.log`、`trial-build.log`、`trial-design.json`，运行发布记录在 `.local/runtime-config/document-trial/`。未提交/推送工作区，不推进新的Pxx。App仍只读，未执行Flutter命令。

## 弹窗入口调整与本轮验证

- 删除独立试用菜单、页面分支和hash入口；试用按钮放在“运行配置 → 解析与模型”标题旁。使用AntD Modal的焦点管理、关闭和Esc；弹窗限制视口高度并滚动，正文/结果不另套卡片。
- 关闭不取消后台任务，保留当前文件/链接/任务ID与结果；重新打开刷新已保存的配置能力并恢复状态查询，隐藏时停止轮询。配置未就绪提示中的“解析配置”按钮关闭弹窗并返回当前tab，不提交未保存参数。
- 434项unit/contract、220项真实隔离PG/Redis集成通过（1项Milvus跳过）；typecheck/lint/build及Compose校验通过。PDF协议仍为测试替身，不能写成云端识别通过。
- Chrome本轮已连接真实主后台，确认侧栏无试用菜单、标题旁按钮、Modal显示、空文件提示、Esc关闭、重开保留链接及返回配置后焦点回到触发按钮。自动上传合成样本在fileChooser.setFiles阶段被扩展的“Allow access to file URLs”设置阻止，没有上传成功或开始解析；接口流式上传与原生Markdown提取已有真实PG集成证据。
- PDF/Office实机检查仅做只读Describe与健康接口探测：当前CPU实例Stopped + StopCharging，172.18.102.103:8000不可达；未开机、提交解析或改用其他云资源。CPU完整提取配置仍未验证，试用能力提示保持未就绪。
- 用户确认当前只是本地开发环境，不在解析机可达的内网中，即使开机也无法发送请求；后续由用户将代码部署到真正的内网测试机再做PDF/Office实测。本轮明确选择暂不开机、只完成本地验证，保留内网地址与原按需启停逻辑。
- 最终Chrome验证1512px/390px布局均无页面横向溢出，弹窗可滚动且关闭焦点正确；浏览器error/warn为空。修复原配置页网格自动最小宽度及移动导航溢出，未修改识别服务。四角色同一镜像healthy/readiness200，静态HTML/JS200，匿名试用401，API同路径404；原CPU节点仍1条/revision3/并发16，资料/笔记/入库表仍0。结构转换事务前后任务均125条；后续最终运行采样为130条，已核对全部是既有每小时maintenance.check且succeeded，未创建文档任务，未删除这些正常调度记录。

当前主环境使用完整构建的同一镜像，节点JSON无损同步与本轮截图/检查记录在 `.local/runtime-config/node-json-modal/`。App只读参照哈希一致，不推进Pxx，工作区未提交/推送。
