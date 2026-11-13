# Xberg cuda-t4 选择性OCR实测（2026-11-12）

用户指定最新`ai_service/xberg:cuda-t4`，沿用同源前20页和原5页清单3/4/15/19/20。原默认配置三次均失败；仅通过官方`ocr.paddle_ocr_settings.rec_batch_num=1`完成配置复核，三次返回20页。没有修改Xberg核心、模型、推理库或服务入口；没有实施前述80%/30%/50%的自动判页/区域OCR方案。

## 请求结果

| 配置 | 首次请求 | 随后第1次 | 随后第2次 | 业务结果 |
| --- | ---: | ---: | ---: | --- |
| 默认识别批次6 | 9.152秒 | 7.930秒 | 7.880秒 | HTTP200，summary.errors=1、results=[]，无正文 |
| 官方配置批次1 | 19.297秒 | 18.633秒 | 18.634秒 | HTTP200，summary.errors=0，20页/10,375字符/2表格 |

批次1后两次均值18.633084秒，比历史8核CPU的10.476519秒慢77.86%。历史CPU为8核/16GiB、旧CPU镜像、识别批次6；本轮16核/62GiB、CUDA新构建、批次1，不是仅换GPU的严格对照，不能将差异归因于单一硬件。批次1是兼容性绕行，默认配置仍未验收通过。

默认失败为OCR代码1002，Conv.2节点`CUDNN_FE failure 8: HEURISTIC_QUERY_FAILED`，日志记录cuDNN backend9.8.0、frontend11200、GPU sm750、示例输入[6,24,24,141]。主要CUDA/cuDNN库与子库的ldd未见not found；实际CUDA已执行，不能据此直接归为驱动版本错误。改批次后绕过触发条件，根因尚未定位，没有更换运行库/模型或打补丁。

## 镜像、机器与调用配置

实际镜像固定内网digest `e2334822ecd0495b818563fd4576c18a113a5e6158d30bf23d36f076aba062ea`，标签cuda-t4、linux/amd64、Xberg1.3.9，构建ID `fdb16150ed0bf8578d68e20ec32301bc2caa8fd1-cuda-t4-ort1.24.2`。镜像CUDA12.8、ORT1.24.2、cuDNN9.8.0；压缩约4.5GB。镜像tag在清理审计时未变化。

按原四档优先级的一次申请实际分配北京H `ecs.gn6i-c16g1.4xlarge`，16vCPU/62GiB、1×Tesla T4、NoSpot、TTL2700秒。CPU Intel Xeon Platinum8163@2.50GHz，可见显存15360MiB；驱动580.178.04，nvidia-smi报告CUDA支持上限13.0，该上限与镜像CUDA12.8区分记录。无新增EIP/NAT/安全组规则/持久卷。

默认启动命令及API并发上限16保持；实际环境核实XBERG_ORT_EP=cuda、HF_HUB_OFFLINE=1、HF_HUB_CACHE=/app/.xberg。请求config整体替换默认，因此先读取并校验镜像原TOML SHA，再保留acceleration.provider=cuda/device_id=0、ocr.backend=paddle-ocr/language=[chi_sim]，叠加output_format=markdown、use_cache=false、force_ocr=false及force_ocr_pages。批次1另加官方paddle_ocr_settings；超时为180秒/客户端200秒。未额外下载模型。

## 资源与阶段延迟

批次1正式两次CPU平均3.366/3.396核，占分配16核的21.04%/21.23%，RSS采样峰值2172.0/2185.7MiB。GPU均值均8.33%、峰值49%/55%，显存峰值969MiB。GPU约200ms采样、CPU/RSS约1秒且只含xberg进程；NVML利用率本身有采样窗口。进程CUDA EP/cuDNN映射及实际GPU计算采样保留，未误作纯CPU回退；GPU没有拉满。

创建RPC至ID1.082秒，至首次健康153.530秒；容器startTime至健康1.918秒。拉取开始至容器启动136秒为拉取/解压/启动的合并观测，云端未返回Pulled精确耗时，不能细拆。控制脚本传输9.509秒；两轮PDF内网下载0.063/0.080秒，成功轮归档内网上传0.054秒。完整创建至释放接受433.026秒，包含默认失败、诊断等待、配置复核，不是单份文档处理时间。

服务未暴露渲染、模型加载、检测、识别、表格和图片处理的独立trace，未从HTTP总耗时反推。首次批次1请求发生在默认配置失败之后，模型/库已经加载过，不应当作全新进程的真正冷启动；后两次为同进程热请求且结果缓存关闭。

## 质量与契约

批次1三份Markdown逐字相同，15个未选页与历史CPU逐字一致，5个OCR页存在差异。目录第11页309/310/315、第20页证书注册号0350221E20166R1M、公司名称与14001:2015、第19页9001:2015均保留；页18/19的两个表格单元格、Markdown、坐标与历史CPU一致。

目视核对原第20页证书，注册地址邮编310000被本轮识别为31000，历史CPU为310000，存在明确漏字；第15页证件有效期标点也有变化，水印/错字仍在。未计算CER/WER，不作为等质量通过或零关键内容丢失结论。差异、逐页CSV与原始响应已导出。

mixed响应缺逐页backend/confidence，实际method=mixed、ocr_used=true。仍有语言检查未能执行的issue1709警告，不能当质量检查通过。调用方必须校验summary.errors/results，HTTP200或health healthy均不能单独代表OCR成功。图片未配置数据导出/持久保存，本轮不报告图片已保存或区域OCR验收；没有单独启用版面/表格GPU模型、16并发或长稳测试。

## 费用、清理和材料

实际规格只读报价16.409988元/小时，生命周期简单乘算约1.974元；不是账单，未含计费粒度、OSS/流量。实例`eci-2ze9suuzrqrcx8armkbq`在两份归档取回并核验SHA/响应后释放，独立ID/归属标签查询均0；输入及两份结果共3个临时OSS对象HEAD404。原325页及20页样本哈希保持，长期GPU仍disabled。

本轮目录`.local/gpu-spot/xberg-cuda/cuda-1794417026086-866fd583-2554-4276-86ba-2c0a98053f9d/`，入口`performance/CUDA测试报告.md`、`performance/summary.json`、`outputs/`。原始默认失败、批次1成功、请求配置、HTTP、GPU/CPU/RSS、驱动XML、运行库/进程映射、质量差异与清理证据保留；导出不含签名URL、控制计划或密钥。

只增加本地一次性测试材料和docs；脚本语法、真实HTTP业务结果、归档SHA、抽查、清理及diff检查作为本轮证据，未重复无关业务全量测试。没有业务Provider/Task/Worker/App/数据库或Compose运行角色变更。App只读HEAD仍20f61b78887f9288d1fd3227f326e6374d516f27，两个Task参照文件SHA仍与前轮一致，未执行Flutter。

官方依据：[识别批次配置](https://docs.xberg.io/reference/configuration/#paddleocrconfig)、[指定页OCR](https://docs.xberg.io/guides/ocr/#force-ocr-on-specific-pages)、[ORT CUDA EP](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)、[ORT1.24.2卷积实现](https://github.com/microsoft/onnxruntime/blob/v1.24.2/onnxruntime/core/providers/cuda/nn/conv.cc)。未调用公开配置之外的provider补丁。停在本轮独立镜像验收，默认CUDA配置失败和质量问题保留。
