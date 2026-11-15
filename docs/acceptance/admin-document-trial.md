# Admin 文档解析试用与代码清理（2026-11-15）

用户要求仅在管理员后台试解析，复用业务逻辑，不走资料入库；节点状态文案指定为“在线 / 不在线”。

## 已完成

- 后台“运行配置 → 解析与模型”标题旁的“文档解析试用”按钮打开Modal，不占独立菜单或页面。支持本地文件和HTTP(S)直链、异步状态/取消、下载/节点等待/解析请求/总耗时、完整Markdown与JSON查看及下载。关闭再打开保留当前任务；文案、配色沿用当前黑白灰后台。
- TXT/Markdown/CSV复用现有原生文本解析，PDF/Office复用完整DB配置、DocumentExtractionClient协议和ProcessingNodes共享整机占用。没有复制OCR、模型、表格、图片策略或建立第二条识别实现。
- 不创建notes、resources、rag_ingestion_versions、text_ingestion_jobs、Task入库任务或关键词/向量索引。只保留管理员审计和必要的节点占用元数据；图片上传仍由现有解析镜像按原配置执行，不自动登记为业务素材。
- 试用仅superadmin，沿用有效Admin Session、Origin/CSRF和结果归属检查；下载沿用业务域名白名单/类型与大小验证。单次最高32MiB且受业务限额约束，全局一次一个试用；结果内存临时保留15分钟，数量有界，重启不保留。Admin多副本时需保持试用请求的实例亲和，不能把内存试用当生产持久任务系统。
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
