# Xberg 同镜像 A10 全文复测（2026-11-13，已完成）

**单A10已取得，325页完整请求成功。** ecs.gn7i-c48g1.12xlarge、北京I、48核/310GiB、A10 24GB档（nvidia-smi 23028 MiB），NoSpot、参考17.943984元/小时，新存储另计。完整HTTP **351.726934秒**，约1.082秒/页。GPU已释放，全部临时OSS对象已按明确清单删除。

用户要求必须使用A10，本轮工具限定A10按8/16/32/48核顺序，按量/市场价抢占可轮换。第一轮按量即获48核档，未创建其他GPU。四个交换机和VPC、安全组保持，无公网入口、EIP或SG变更。

镜像仍是cuda-a10-native-first-oss-kbxml-v1，digest c8ad143dd5da72b922937afd83554db3c8d79e8a188002b381bce8b3a3783e25，build xberg-kbxml-v1-20261113-r4。PP-OCRv5 server/ONNX CUDA/batch6/150DPI/JPEG85/native-first旧阈值80；不传force_ocr_pages，cache=false、API16、上传16/队列128。

主对照是同镜像T4 run kbxml-1794576290275-5d574d7b-5f88-4c2d-9dd8-c6bc0368caf1。镜像摘要、完整请求JSON、PDF SHA逐项核对相同。原PDF325页/81249929字节，SHA256 d9c063dfe3f9b8107e7d78c9e27574ac8b23d9dd21096f84e32d9c31b07ac59f。**CPU与宿主平台不同：A10为48核/310GiB，T4为8核/31GiB，不是严格只换GPU的实验。** 此前342.025秒是16核A10旧镜像，仅作历史参考。

## 同镜像结果

| 指标 | T4 | A10 |
| --- | ---: | ---: |
| 完整HTTP秒 | 1411.127336 | 351.726934 |
| 核心提取秒 | 1401.431093 | 345.975984 |
| OSS上传墙钟秒 | 4.292279 | 2.368393 |
| 输出适配秒 | 9.157052 | 5.363842 |
| GPU平均% | 5.263242 | 4.428896 |
| 容器CPU均值核 | 1.350568 | 1.496297 |
| 末尾GPU零活动窗口秒 | 206.706725 | 136.557442 |

观测速度约4.012倍、时间减少75.075%。HTTP含文件给服务、OCR/原生提取、图片生成及OSS、正文适配与完整JSON接收；不含独立下载、申请和取证归档。输出适配包含OSS，不重复相加。对象生成/编码未独立计时，不能把末尾GPU零活动的136.557秒全部归为JSON或OSS。

创建RPC至ID1.113秒、首次Running41.575秒、首次健康49.822秒；缓存命中，容器开始至健康9.481秒。补充采样脚本请求前启动；测试控制传输和本机OSS输入上传均与HTTP分开。下载PDF内网0.524958秒。详细阶段均在stages.csv。

GPU驱动580.178.04；GPU采样均值4.429%，显存峰值4424MiB；主进程均值1.483448核，cgroup均值1.496297核（48核的3.117%），内存采样峰值7523.520MiB。GPU200ms、CPU1秒，完整CSV；包含测试工具开销，未做函数/算子级profile。

HTTP200、errors=0、325页均非空、336117字符含XML、97表格、768 KBIMAGE、0 KBFORMULA。751个去重对象178630201字节，UUIDv5/MIME/长度/SHA、JPEG解码尺寸、SQLite ledger均逐项核对，上传重试0。JSON15486320字节。图片级OCR均unavailable，空CDATA不得当已识别图中文字。

与T4的139个OCR输入（82整页/57区域）和325页路由逐项一致，768图SHA、97表格cells一致。忽略批次块ID/UUID并对应图片SHA后，251页正文完全一致，其余74页差异已导出，未承诺逐字等质量。17个关键字抽查无新增丢失，但19页9001:2015和62页萧山城区仍漏。源PDF对照PNG沿用同SHA的只读渲染，未更改OCR输入。

实际routing=legacy，186页native/139页ocr，独立图片selected_images=0。47条mixed OCR舍弃和6条glyph_dropped；OCR页失败记录0、告警1（语言检查未执行）。1个公式、2个表格正文定位能力缺口保留；tables[].markdown不再返回，正文95个Markdown表格分隔行，cells仍在JSON。HTTP成功不等于质量全部通过。

连续启动至请求结束服务日志58954字节，SHA256 e2c34f6f9abbedac20004017244ac31fd26559d46cda5bfc03ebfbfbf75b5317，不是tail拼接。完整KB Markdown、带本地图片的副本、JSON、逐页路由/OCR输入、差异页、CPU/GPU/cgroup、SDK回执及ledger均打包。GPU实例eci-2ze43u66fcaz7scrs7nt按ID/归属双查0，751测试图和临时输入/归档HEAD404；原PDF未改，两个Ready缓存保留。

仅独立测试工具和docs变化；未改业务Provider/Task/Worker、镜像/模型/算法、App、Compose或数据库/迁移。长期GPU_SPOT_PROVIDER仍disabled。App两份只读参照文件SHA前后一致，Git GIT_UNBORN；没有运行Flutter。一次性脚本语法、真实云及文件完整性验证单列，不冒充业务全量或Mock测试。

本轮run kbxml-1794580310049-d7592e26-bf7f-4204-81b1-e78b191662d2；会话resume-1794580309221-7752bb43-0068-4a80-b063-526c0abc0dc6。证据在.local/gpu-spot/xberg-a10-kbxml/kbxml-1794580310049-d7592e26-bf7f-4204-81b1-e78b191662d2，plan含签名URL不交付。报告和归档逐文件SHA验证；交付扫描实际RAM密钥和签名URL。
