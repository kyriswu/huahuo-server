# Xberg prod-callback / 最低档 A10 实测 · 2026-11-14

用户提供新镜像及完整运行/提取配置后，使用同一份325页《电子标书.pdf》独立实测。原文件81,249,929字节，SHA256 `d9c063dfe3f9b8107e7d78c9e27574ac8b23d9dd21096f84e32d9c31b07ac59f`。本轮不是生产Worker/Redis自动开停机/回调入库闭环；云API真实执行，业务PG/Redis链路另由隔离测试验证。

## 云分配与镜像

现有 ECS `i-2zegwjwejyvpxoluhyx8` 启动明确返回 `OperationDenied.NoStock`（476.732ms），随后通过现有 ECI Provider/allocator 申请 NoSpot，受理1.680秒，取得 **ecs.gn7i-c8g1.2xlarge、8 vCPU / 30GiB / 1×A10**，北京I、新交换机 `vsw-2zejabzle8p9mbqjwqwp0`。实例 `eci-2zeg0m8zdkp9vfuhmk8s`，私网 `172.17.202.101`，无EIP；驱动580.178.04、显存报告23028MiB。

固定私网镜像 digest `sha256:152b65be33a26cfbe0a0dc24f2aea399965bf85b98bd97b2016aced02131a6c7`，ACR实时查询与用户 `cuda-a10-native-first-oss-kbxml-v1-prod-callback` 标签一致，压缩大小4,445,136,735字节。沿用默认supervisor与完整serve命令，仅将stdout/stderr连续记录到文件；额外40GiB临时盘、1GiB shm。模型与完整JSON保持 PP-OCRv5 server、CUDA、batch6、150DPI、JPEG85、legacy原生文字优先；OSS并发8/待处理32，API并发16。

独立测试差异：OSS写入本轮专属前缀；回调白名单仅127.0.0.1，接收器仅loopback；测试实例加7200秒兜底寿命并提前手动释放。没有调整OCR、路由、精度、线程数或Xberg核心。

## 结果及时间边界

| 指标 | 实测 |
| --- | ---: |
| ECI创建发起→首次健康 | 131.674秒，部分镜像缓存命中；5秒采样，非完整缓存热启动 |
| 镜像Pulling→Pulled事件 | 98秒，云事件秒级 |
| 内网下载源PDF | 见完整报告，独立计时且SHA验证 |
| 核心提取 | **353.849秒，55.108页/分钟** |
| 完整请求→结果字节落盘 | **361.897秒**，含上传/状态等待/领取，排除启动与源下载 |
| 再含解码/协议校验/正文保存 | 362.783秒 |
| 输出适配 / 其中OSS wall | 6.993秒 / 3.924秒，两者不可重复相加 |
| 返回 | 325页、97表、768图引用、751去重对象；文件级错误0 |
| 图片 | 178,630,201字节，751对象SHA/大小/实际解码全部通过 |
| JSON / 服务端JSON序列化 | 15,488,759字节 / 27.394ms |
| GPU平均 / 峰值 / 显存峰值 | 4.16% / 97% / 3400MiB |
| CPU平均 / 1秒峰值 | 1.709核（8核的21.36%）/ 7.949核 |
| 内存采样峰值 | 7.007GiB |
| 最后GPU无活动窗口 | 139.431秒，窗口CPU约0.993核 |

139份OCR输入：82整页+57区域，186页原生；额外配图OCR派发0。判页完整时长、纯OCR计算、图像生成/编码未独立打点，不用CPU尾段推算函数耗时；现有小步骤image_selection_ms不冒充全文判页。容器统计含采样进程，进程CSV另分角色。

与上次48核A10相比，规范化UUID后完整正文/全部325页完全一致，表格cells、图片SHA序列和OCR输入坐标一致。旧核心345.976秒与HTTP351.727秒仅作历史参考，CPU/镜像/上传并发不同，不宣称受控加速或准确率提升。本轮不是纯扫描件、16并发或完整大文档回调吞吐测试。

## 协议与调用侧修复

真实服务小TXT验证：GET状态无完整result；HEAD不消费；GET结果完整200后410；回调保存完整body并fsync后返回2xx，随后410；手动ack幂等。325页用GET结果领取，没有向业务API新增回调路由。

现有DocumentExtractionClient同步更新：GET状态→GET结果、202等待、410报已消费且不自动重跑、取消/失败终态ack。保持既有Task/UUID/Redis恢复，不新增旧接口兼容分支；ECS/ECI需同步升新镜像后部署。服务端发送完成不等于业务事务已提交，可靠业务回调接线仍待单独实施，不能保证已消费结果在客户端崩溃后无损恢复。

云核对暴露 `DescribeContainerGroups.Tag` 返回无关旧记录，原标签检查误报释放失败；没有误删。已改 [ListTagResources](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-listtagresources)，精确allocation过滤再校验VPC/manager，新增未匹配/多身份测试。RAM新增只读要求 `eci:ListTagResources`。该诊断间隔不当作云端真实释放耗时。

## 质量及测试工具问题

原PDF抽查物理7/18/19/62/152页：目录2/4页码保留、符合性表关键页码保留，但水印/碎行仍在。19页ISO9001:2015标准行、62页配图“萧山城区”仍漏；152页“潇湘综合服务中心”标题在该页误为“62设计务中心”。1条Unicode语言检查未运行告警，以及1个公式/2个表格能力缺口保留。没有标注集CER/WER、没有复测T4 Conv.2/cuDNN，不能用errors=0代替质量验收。

全文成功后，测试工具用系统python import oss2失败，导致原始runner记录failed。正文/完整JSON/消费验证均已保存；随后用本地既有OSS SDK取回751对象并核验SHA/大小/解码，未重跑OCR。原始error/timing保留，最终verification区分extraction_passed=true、image_integrity_passed=true与quality_passed=false，不篡改原始失败记录。

## 检查与清理

430项unit/contract、201项真实隔离PG/Redis integration通过（1项未启用Milvus而跳过），typecheck/lint/build退出0；云adapter测试中的替身不冒充实云业务闭环。新增6个提取协议与2个标签归属单元场景。隔离临时容器只清理本轮自有资源，无业务迁移或卷删除。

已确认本轮ECI实例ID为空、精确allocation标签为空；最终ECS仍Stopped+StopCharging。753个临时OSS Key逐项HEAD为404，原始PDF保留。未清除共享镜像缓存。真实.env、业务库、业务容器、App均未改；原有工作区其他变更保留，不推进Pxx。

可下载完整报告/Markdown/连续日志/图片/CSV的本机目录：`.local/gpu-spot/xberg-callback/callback-1794640404449-037b61c2-6eab-4d98-a268-9a4986c847a6/`，含 `测试报告.md` 与 `完整结果_日志_指标_图片.zip`；代码检查日志在 `.local/gpu-spot/xberg-callback/code-verification/`。导出51个文本文件检查不含共享凭据值，配置模板中的AK留空。

App只读参照 `../huahuo-ai` 仍GIT_UNBORN；api_endpoints.dart SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`，http_auth_repository.dart `d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5` 前后一致。没有改App契约或运行Flutter。
