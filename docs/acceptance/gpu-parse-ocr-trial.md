# 新OCR标签镜像 HTTP 对照试验（2026-11-11，已完成）

用户提供镜像 `t4-fp16-ocr-20261111T111715Z`，选择同一《电子标书.pdf》的前10页做速度/结果对照。沿用已授权按量、单T4、北京、四档优先级、原VPC/交换机/安全组；不重跑325页，不变更业务角色/数据库/App。

## 输入及镜像核对

- ACR真实GetRepoTag成功，预检digest `sha256:926020ab523ecd200c1c5e18dbf6343db1ba90f3cd5139d9aa795cce74ce160e`。ECI拉取VPC域名的同标签，默认命令留空，采用镜像 `python -m app.main`。
- 对比镜像应用层：新增 `light_ocr.py`；main/parsing/vision/rendering/Transformers等现有HTTP VLM模块与上一版逐字节一致。本轮测试HTTP VLM，不将其称为轻量OCR性能测试。
- 本地pypdf抽取原文件第1—10页，496,562字节，SHA-256 `e02f06e1c1cbee663e06ed7d948523045b0c6f75adbd1f71ab62880d29fab1e0`。PyMuPDF逐页渲染对比均像素一致，抽检1/7/10页图像；原81,249,929字节/325页PDF未改。
- 样本上传唯一 `gpu-parse-test/<runId>/input-first10.pdf` 临时对象并读回核对SHA；ECI使用OSS北京内网签名链接，测完删除，原文件不删。签名URL、RAM仅保存在忽略提交的0600文件。

## 内网适配与观测

新main.py哈希仍为 `10fadb3473568a902ebb51e82a88acf5e791a8e07568f89b0af9f13d8e73c1ee`，仍拒绝内网。单个小ConfigFileVolume挂载sitecustomize，通过默认Python加载器仅适配这个精确app.main源文件：复用此前已验证的精确Bucket HTTPS/443及100.64/10例外，显式拒绝100.100.100.200，其他DNS/对端/TLS校验保持。加文件日志和下载/解析墙钟计时，推理模块/精度/batch保持。原镜像不改不发布，Command/Args为空，无sleep或第二个模型服务。

Telemetry在Running后、解析前启动，逐秒采集GPU/CPU/内存/cgroup，补采CPU型号、NVIDIA驱动/最大CUDA支持、Torch编译CUDA及各Python环境依赖版本。原始指标、日志和硬件信息与响应一起归档，哈希取回后释放；健康检查还需确认请求完成后模型Worker及HTTP服务仍存活。

## 当前实例与比较边界

11:51:54.449Z创建RPC，11:51:55.956Z得ID `eci-2ze6g3pxvbahg0bffi6y`；本次再次北京H/第三档16vCPU/62GiB/单T4，与上一轮一致，NoSpot。11:52:19Z开始拉取约7.9GiB新镜像，11:57:24Z容器按默认命令启动，11:57:49.032Z首次模型健康；11:57:52.089Z提交10页HTTP，12:00:21.232Z收到响应。

上一轮前10页5个两页批次为10.948/17.949/2.519/110.224/7.438秒，合计149.078秒。旧请求输入325页，新请求是无损10页子集；批次推理耗时可对照，HTTP总耗时的下载/整篇重建范围不同，不能把二者总耗时直接当作模型提速比例。仅一次冷请求，不宣称统计显著。

原始证据位于 `.local/gpu-spot/huahuo-parse-ocr/`，当前唯一运行目录 `huahuo-parse-1794397893031-67d06d1d-487e-4786-8e1d-b2c2269d55d9/`。本次已验证10页完整HTTP解析、请求后服务常驻健康与精确清理；不代表轻量OCR独立入口或325页长稳通过。长期GPU配置仍disabled，未新增Task/Worker入口。

## 最终结果

HTTP200、complete、10/10页、0 issues/warnings，Markdown7184字符/12055字节，1个图片。原始响应33013字节；返回Markdown逐字节一致，图片SHA-256核对、相对引用解析、归档防穿越解包均通过。请求后health仍为CUDA/Transformers/float16/cuda:0、Worker alive，证明常驻服务未随请求结束。原325页文件哈希不变。

| 来源页 | 旧版批次秒 | 新版批次秒 |
| --- | ---: | ---: |
| 1—2 | 10.948 | 10.763 |
| 3—4 | 17.949 | 17.589 |
| 5—6 | 2.519 | 2.517 |
| 7—8 | 110.224 | 109.333 |
| 9—10 | 7.438 | 7.181 |
| 合计 | 149.078 | 147.383 |

新版批次总耗时减少1.695秒（1.137%），单次冷请求下未见明显提速，不做统计显著性结论。HTTP总耗时149.143秒，独立download函数计时0.113893秒、parse函数149.021991秒；首批前的渲染/布局/准备及最终重建未细分为算子级。新增light_ocr未接入本次HTTP路径，现有HTTP模块哈希与旧版一致。

去除document_id路径差异后8/10页Markdown逐字相同；第3页两处标题由5级变4级、第5页由5级变3级，除此之外正文一致。规范化标题层级后10/10页相同；这是与旧输出对照，不是源PDF人工准确率。

## 完整资源与环境证据

逐秒采样在解析前启动，覆盖本次整个请求；报告按during_parse筛选解析窗口。GPU平均利用率59.534%，显存峰值3545MiB（约3.46GiB）。完整GPU/CPU/cgroup/内存/时钟/功耗/温度与每批延迟存于CSV，原始JSONL随结果归档。

实际CPU为Intel Xeon Platinum8163@2.50GHz，可见16vCPU；NVIDIA驱动580.178.04，驱动支持的最高CUDA13.0。主Python3.12.12、paddlepaddle-gpu3.2.2、PaddleOCR3.7.0、PaddleX3.7.2；VLM环境Torch2.7.1+cu118、Transformers5.0.0、PaddleX3.7.2。Torch包cu118标识和驱动最大CUDA支持分开记录，不混作同一个版本。实际PID1为python -m app.main。

## 取回与清理

结果归档144171字节，SHA-256 `c1b6cb3659e0c8b14cc0b46d157f297d09af4cbfa2ba5a01c45c79b9221be91a`；包含原始JSON、Markdown、图片、完整日志、逐秒指标及硬件/软件版本。取回核对后，12:00:43.665Z删除受理，12:00:46.869Z ID/唯一标签双查均0，随后独立复查仍0。临时10页样本和结果两个OSS对象HEAD均404。按受理到删除的全部时长估算实例与40GiB盘费用上限约2.42元，非实际账单。

本地完整交付目录为上述唯一运行目录下：`results/电子标书_前10页.md`、`results/response.json`及图片，`performance/性能对照报告.md`、阶段/批次/资源/逐页对照CSV和summary.json，`新镜像_前10页解析结果.tar.gz`、`性能对照原始数据.tar.gz`。压缩包排除创建计划、签名URL与密钥。最终记录含final-audit.json和export-manifest.json。

本轮仅增加本地一次性测试脚本、样本和docs；未改生产源码/迁移/运行角色，不重复运行无关全量测试。脚本语法、加载器编译/源码哈希、10页144DPI像素一致、真实健康/HTTP/归档校验/清理与git diff检查通过。App HEAD及两个Task文件哈希与上一轮一致，未运行Flutter或写App。
