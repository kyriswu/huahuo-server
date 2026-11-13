# Xberg OSS/KBXML镜像核对与GPU申请（2026-11-13）

**后续已在T4完成325页全文实测，质量未全部通过。** 北京I、8核/31GiB、单T4、NoSpot，完整HTTP1411.127秒；核心提取1401.431秒，OSS上传4.292秒。325页/97表格/768图片记录，751个去重对象逐字节和解码校验；第19页ISO9001:2015仍漏。GPU均值5.26%、CPU容器整体1.35核。实例与临时对象已清理，结果、完整日志和原始采样均已取回。

## 已核对与已配置

ACR标签cuda-a10-native-first-oss-kbxml-v1，digest `c8ad143dd5da72b922937afd83554db3c8d79e8a188002b381bce8b3a3783e25`，build-id `xberg-kbxml-v1-20261113-r4`，linux/amd64，压缩镜像13,510,950,698字节。读取实际镜像manifest、config及小文件层；保留入口tini/Python supervisor和8000端口。原生优先、PP-OCRv5 server/ONNX CUDA/batch6/150DPI/JPEG85/每页16图的默认配置与用户JSON相符，未传force_ocr_pages。

镜像内SDK的ResourceStore.concurrency为min(16,max(1,配置值))，仅调整环境变量不能突破16；Rust侧未能运行验证。拟用上传16并发、队列128、API16；这不是实际吞吐实测。若未来提高到64，需要镜像实现同时放开相关上限并核对连接池、实际并行派发及内存占用。用户粘贴的括号说明未作为数值传入。

新增vsw-2zejabzle8p9mbqjwqwp0，真实查询为北京I、VPC vpc-2zervqxqgm7a38ryqkzm9；已加入本机.env.gpu-spot的GPU_SPOT_VSWITCH_IDS，原三个交换机保留，仅修改该行并保持文件权限。长期GPU_SPOT_PROVIDER仍disabled，未改.env凭据或其他配置。

## 库存、报价与实际申请

库存查询与真正申请分别记录，查询WithStock不能当作实际资源已分配。ECI与ECS库存接口均核对；当时返回T4 4核北京H、V100多个区、L20北京L和A10 48核北京I可用。计算参考报价：T4 4核/15GiB 11.630016元/小时，L20 8核/64GiB 14.41512元/小时，A10 48核/310GiB 17.943984元/小时，V100 8核/32GiB 26.46元/小时；新增存储等另计。未根据Scheduling时长估算GPU计算费，实际账单未核查。

用户先选4核T4，实际单区与四交换机申请均OperationDenied.NoStock；随后明确选择48核A10。

| 申请 | 可用区/范围 | 缓存匹配 | 驱动 | 实际结果 |
| --- | --- | --- | --- | --- |
| A10 16核/60GiB | 北京F | 开启 | 默认 | 创建ID后Scheduling/NoStock |
| T4 4核/15GiB | 北京H | 开启 | 默认 | 创建RPC返回OperationDenied.NoStock，无实例ID |
| T4 4核/15GiB | 北京H/L/F/I | 开启 | 默认 | 创建RPC返回OperationDenied.NoStock，无实例ID |
| A10 48核/310GiB | 北京I | 开启 | 默认 | 创建ID后Scheduling/NoStock |
| A10 48核/310GiB | 北京I | 关闭 | 默认 | 创建RPC返回OperationDenied.NoStock，无实例ID |
| A10 48核/310GiB | 北京I | 关闭 | tesla=570 | 创建RPC返回OperationDenied.NoStock，无实例ID |

关闭缓存与指定官方支持CUDA12.8的570驱动后仍失败；不能将原因归结为镜像缓存。GPU申请未完成，因此没有验证该镜像在A10或T4的实际运行，也没有复现维护方的108项API/31项核心/16项SDK测试或80对象验证；维护方提供的数字不计入本机实测证据。第19页已知漏字没有新的复测结论。

## 清理与缓存

全部6轮申请均未Ready/未提交解析。两个实际创建出的调度实例已删除；其余申请无实例ID，归属标签查询均为0。每轮上传的输入已删除，预留结果Key HEAD404，原81MB PDF SHA256保持d9c063dfe3f9b8107e7d78c9e27574ac8b23d9dd21096f84e32d9c31b07ac59f。不曾向业务资源前缀上传图片。

本轮自动生成的新镜像缓存imc-2zecv8evg4al9b7z5pcw已Ready/100%，保留供后续复用；原缓存imc-2zeabjvlm78bshhrntu5保留。缓存完成不代表GPU实例创建或解析验收通过。

## 变更范围与验证

仅本机一次性申请/取证工具、证据、docs以及.env.gpu-spot指定交换机行有本轮变更。一次性工具补充显式OperationDenied.NoStock分类、未绑定VPC的自有调度实例释放，以及缺货重试；ID/归属标签校验仍保留。后续已修正：多规格请求的Pending/Scheduling期间，单条NoStock Warning不再触发释放，等待终态或启动超时，以保留服务端尝试后续规格的机会。未改业务Provider/Task/Worker、App、Compose、网络、数据库或迁移，也未创建NAS或持久业务卷。

当前App只读参照../huahuo-ai，Git为GIT_UNBORN；实际阅读api_endpoints.dart及http_auth_repository.dart，阶段末SHA一致。工具Node/SH语法与内嵌Python语法、真实云API申请/归属清理、OSS HEAD404分别留证；不运行无关业务全量测试，不将静态核对或Mock冒充GPU实测。停在独立镜像验收边界，等待实际可分配容量。

证据目录：`.local/gpu-spot/xberg-a10-kbxml/`。attempt-summary.json汇总各轮；各run内state.json、failed-cleanup.json记录真实申请与清理；alternative-availability.json、alternative-prices.json、existing-switches.json、new-switch.json、switch-config-change.json、image-inspection.json及镜像内只读源码保存。plan.json含临时签名URL，不交付或提交。

## 后续扩展申请与全文结果（2026-11-13 夜间，已完成）

用户授权继续申请，并明确加入T4全四档及跟随市场价的抢占式。一次性工具轮换T4抢占、A10抢占、T4按量、A10按量，每轮均按CPU/内存从小到大排列四档，覆盖同VPC的H/L/F/I四个交换机。抢占使用SpotAsPriceGo和1小时保护期，不启用静默按量回退；每次仅有一份在途申请，成功后停止申请其他实例。T4仍为1张16GB显存，A10仍为1张24GB显存，镜像及完整325页请求配置不变。没有增加生产Provider的重试或机型配置。

此前A10按量自动重试会话完成15轮均未启动；守护进程中断后的未提交计划经归属查询为0后恢复，没有重复创建。扩展会话`resume-1794576192219-1a9235f2-9242-4fbc-ae42-236724809631`保存逐次申请、请求ID和归属清理。输入PDF改为健康后才上传，缺货期间不重复传81MB文件。新的ECI可售查询仍列H区T4 4核/8核WithStock，但对应实际创建尚未成功；抢占可售查询返回Spot.NotMatched，实际创建返回OperationDenied.NoStock，均不得当作分配成功。 扩展第三轮T4按量请求已受理为eci-2ze04nfu5bbryyie7cqy、4核/15GiB、北京H，命中新镜像缓存；截至21:29仍Scheduling，已重复三次NoStock Warning。独立查询本目录全部4个已签发实例ID，仅该调度实例仍存在；旧实例均不在。尚无容器启动或解析。

当前仅为在途记录；最终库存、实例、解析及清理结果以会话状态和本页后续补记为准。已准备保留完整启动/请求日志、GPU 200ms、主进程及OSS worker每秒CPU/RSS采样、归档及图片UUID/字节校验；没有新的GPU性能或OCR质量结论。

21:32更新：同一请求后续按配置顺序切换到ecs.gn6i-c8g1.2xlarge（8核/31GiB）和北京I，13:32:05Z容器开始，13:32:14.938Z首次健康；计算参考价14.000004元/小时，新增存储另计。13:32:36.787Z脚本启动，自动重试器转入testing，不再申请其他实例。额外容器cgroup每秒采样在解析请求前启动，覆盖服务与测试工具的整体CPU/内存；原进程/OSS worker和GPU采样保留。

## 最终全文与输出验收

最终run为kbxml-1794576290275-5d574d7b-5f88-4c2d-9dd8-c6bc0368caf1。同一实例从4核/15GiB的H区调度转为8核/31GiB的I区，收到3次NoStock Warning后仍成功，验证不能把单条Warning当最终失败。T4/A10抢占各实际申请一次均OperationDenied.NoStock；成功的是按量T4。四交换机、四档T4/四档A10轮换；只保留一台赢家，未再申请其他机型。

创建RPC至ID0.724秒、首次Running437.525秒、首次健康444.342秒。最终缓存命中事件至容器开始35秒，镜像已有事件至容器开始10秒，启动至健康9.938秒；这些包含挂载/启动等，不是冷镜像下载耗时。PDF内网下载0.578760秒，与HTTP解析分开。请求至Paddle初始化26.113秒，Paddle初始化日志区间3.751秒。服务HTTP1411.127336秒（23分31.127秒、4.342秒/页），服务上报核心1401.431093秒、输出适配9.157052秒（含OSS上传墙钟4.292279秒）。生成/编码未单独计时，不能伪造独立耗时。

GPU Tesla T4，nvidia-smi总量15360MiB，驱动580.178.04，GPU平均5.263%、峰值100%、VRAM峰值4293MiB；容器cgroup CPU平均1.350568核（分配8核的16.882%），主进程1.319634核，OSS worker0.003593核；cgroup内存采样峰值6985.828MiB。最后206.707秒GPU零活动、已采样进程合计CPU1.007核，不能整段归为JSON或OSS。CPU受限计数未增长，未采集函数/算子级剖析。计算参考报价14.000004元/小时，新存储另计，未核对实际账单。

HTTP200/summary.errors=0，325页均非空、336143字符（含XML）、97表格、768个KBIMAGE、0个KBFORMULA；751个唯一对象178630201字节。对象UUIDv5、MIME/字节数/SHA、751幅JPEG解码尺寸、SQLite ledger与资源清单全部一致；SDK重试0。JSON15521986字节，对比旧644324125字节下降97.59%。所有图片ocr_status为unavailable、CDATA为空，不代表未做文档级OCR，也不能宣称图片级文字已识别。

两轮请求JSON逐项一致；上次A10与本轮139个OCR输入（82整页、57区域）逐项一致，768张图按索引SHA一致，97个表格cells一致；新tables对象不再提供markdown字段，正文检测到95个Markdown表格分隔行，另2处定位缺口已报告。硬件与镜像同时变化，不能作为OSS改造的严格速度A/B。实际routing=legacy、旧阈值启用，页路由186 native/139 ocr，独立图片selected_images=0；image_selection_ms=0.004369仅是该分支目标选择，不是完整判页计时。

第11页目录309/310/315、第20/21页证书编号及标准、第24页重要表格关键值抽查保留；第19页9001:2015、第62页萧山城区仍未找到，未宣称逐字无漏。第19页已执行region OCR但有水印噪声和漏字；第62页native正文191字、图像覆盖65.14%，选择native而未保留图中文字。日志有46条mixed OCR舍弃、6条glyph_dropped；页OCR失败记录0，处理告警1（语言检查未执行）。能力缺口1个公式和2个表格正文定位，原正文/cells保留。抽查源页已渲染并人工核对，QA PNG及哈希随交付保存。

启动至请求结束完整服务日志57520字节，SHA256 e5396d247c06fefb99b9fbf237ae6f21034748e0d6da010b0059898934dc474d；不是tail API拼接。原始JSON、完整KB Markdown、带本地图片的阅读副本、逐页路由、表格/关键字对照、服务timings、CPU/GPU/cgroup CSV、对象回执和ledger均已导出。交付前扫描真实RAM密钥与签名URL，含临时URL的plan不进入交付。

实例ID/归属双查0；751个本次测试图片、临时输入和归档均HEAD404，源PDF SHA不变。图片已本地保存，原UUID只作本轮证据，不留业务资源关系。两个Ready镜像缓存保留。长期GPU仍disabled，未改业务Provider/Task/Worker、OCR核心、模型、App、Compose、数据库或迁移。本轮只跑一次性工具语法与真实云/文件完整性验证，未重跑无关业务全量测试。App两份参照源码SHA前后一致、GIT_UNBORN。

最终证据位于本轮run的verification.json、performance/summary.json、content-verification.json、additional-integrity.json、workload-comparison.json、final-audit.json、asset-cleanup.json与测试报告.md。归档文件清单及包内每个文件SHA单独核验。
