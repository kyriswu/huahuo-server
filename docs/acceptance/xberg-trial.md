# Xberg 1.3.9 前20页真实测试（2026-11-11）

按用户要求，以同一《电子标书.pdf》第1—20页测试 ACR `ai_service/xberg:latest`。实际 `/version` 为1.3.9，创建前ACR digest为 `69c7a152010a30f7e8e5a7fd0b62bc4dc7fab1785492a4b971a98a4421211595`。镜像走北京VPC内网拉取，PDF走北京OSS内网；使用CPU构建，不为此镜像申请T4。

本轮实例 `eci-2zeilmbghi0hpychn7kx`：北京H、AMD64、4vCPU/16GiB、0GPU，NoSpot按量，默认临时盘，无EIP或安全组变更，TTL1800秒。创建请求至ID0.754秒、流程至首次HTTP健康47.614秒、拉镜像32.964秒。启动使用镜像ENTRYPOINT并传 `serve --host 0.0.0.0 --port 8000`，没有业务管理端。

## 实际结果

| 路径 | 请求耗时 | 验证与局限 |
| --- | ---: | --- |
| 默认Markdown | 0.147775秒 | HTTP200、20页、2表格，`ocr_used=false`；证书图片文字缺失，不能作为完整OCR耗时 |
| 原始缓存的中文OCR | 等待195.067秒后人工取消curl | CPU近乎空闲，空响应、exit143；保留失败和归档证据，不作为成功解析 |
| 修正缓存后首次中文OCR | 41.763232秒 | HTTP200、20页、每页paddle-ocr，summary.errors=0 |
| 同进程第二次中文OCR | 41.103916秒 | HTTP200；正文及表格与首次一致，10,870字符、2表格 |

请求配置为 `{"output_format":"markdown","force_ocr":true,"ocr":{"backend":"paddle-ocr","language":["ch"]}}`。`GET /health`、`/version`、`/info`、`/formats`、`/openapi.json` 和 `POST /detect` 也通过。本轮未测异步任务、并发或长期稳定性，未新增Server/App端点或接入持久Task/Worker。

20页有输出不代表准确无漏。目视对照第20页，OCR补出了注册号 `0350221E20166R1M`、公司名及14001:2015，但ISO有IS0误识别，水印和网站等仍有噪声。第11页目录309/310/315在默认文本层正确，在强制OCR中均缺失。`quality_score=1`不是人工准确率；未计算CER/WER，不认定可直接替换旧VLM。响应counts.images=8，仅统计，未导出8个图片文件。

## 缓存故障及本次运行修正

预热Paddle模型约447MiB存放在 `/app/.xberg/models--xberg-io--paddleocr-onnx-models`，运行时 `HF_HOME=/app/.xberg/huggingface` 则查找其 `hub/`，只有锁文件。原始中文OCR未完成初始化；HTTP健康200仅代表服务/插件注册，不表示模型可计算。

保留原8000服务，在同容器localhost:8001启动相同二进制，设置 `HF_HUB_CACHE=/app/.xberg`，并令 `HF_HOME=/tmp/xberg-hf-fixed` 的hub软链接到 `/app/.xberg`。没有下载/替换权重；随后两次中文OCR成功。首次挂起的服务CPU仍空闲，清理时随整台ECI终止。本次成功包含这项运行时修正，不声称原始Docker命令开箱通过中文OCR；镜像构建的预热/运行路径应先统一。

## 指标、费用与对照边界

首次/第二次Xberg进程四核折算CPU均值86.65%/86.81%，按约1秒 `/proc` ticks与实际间隔加权，仅覆盖采样区间；RSS采样峰值1222.0/1334.9MiB，进程累计VmHWM1480.4MiB。CPU为Intel Xeon Platinum，环境未暴露SKU；亲和性0—3，Debian13.7，PaddleOCR ONNX CPU。Tesseract5.5.0虽安装但未选择，没有GPU/显存指标。

cgroup根目录报告无限quota/内存，不用作真实容器限额；保留原始数据。默认0.148秒短于采样间隔，不给其有效CPU均值；没有引擎内trace，41秒不能再拆成模型加载、渲染、检测、识别或逐页延迟。HTTP首字节统计是响应头时间，不等于Markdown首次可用。

旧VLM同源前20页10批合计204.522秒，但旧环境16vCPU/62GiB+T4、输入325页，布局与质量不同，不能声称等质量加速倍数。创建前CPU/内存报价1.058688元/小时，创建至释放接受694.206秒简单乘算约0.204元，非账单，不含OSS/流量；包含人工诊断等待。

优化依据：统一模型缓存并以真实中文OCR预热；保留可靠文本层，对图片区域/扫描页补OCR；水印使“有文字即无需OCR”的判断失效。全页强制OCR又损失原页码，不宜未经质量验收直接作为默认。以上仅记录证据，未新增业务合并路径。

## 导出、清理及验证

原始325页文件保留；20页样本1,130,038字节、SHA256 `7d2311502a9dba012ad9a23033d100e5c2520bd5766f3a79bc61ef9b4bc4398b`，144DPI逐页与原文件像素一致。四个结果/诊断归档均核对远端SHA/大小，中文正文、分页面MD、JSON/表格、HTTP阶段CSV、CPU/RSS逐秒CSV、抽查、日志、环境和清理证据均导出。

结果取回后归属/VPC核验释放，实际删除接受 **2026-11-11T14:59:19.206Z（北京时间22:59:19）**，独立ID、当前标签、退役标签三查0，7个本轮/退役临时OSS对象HEAD404，源文件哈希不变。此前小写 `CpuArchitecture=amd64` 的503保留，真实DryRun确认应为 `AMD64`；失败标签没有实例。一次只读控制面TLS重置亦保留，不归为容量或引擎延迟。

本轮仅新增本仓库 `.local/gpu-spot/xberg/` 一次性材料与docs。脚本语法、远程分块传输替身、样本像素、真实HTTP、归档校验、清理和diff检查通过；没有重新跑无关全量测试，历史306项不算本次执行。App HEAD与两个Task文件SHA再次只读复核一致；未写App、改业务源码/Compose角色、操作数据库或卷，长期GPU仍disabled。

证据目录：`.local/gpu-spot/xberg/xberg-1794408456103-5bcb65de-20ea-4b15-9d23-b6a1ed31a738/`，其中 `performance/性能与质量报告.md`、`performance/summary.json`、`final-audit.json` 为主要入口。原始控制计划/签名URL/密钥不进入导出包。

官方依据：[Xberg Docker](https://docs.xberg.io/guides/docker/)、[OCR](https://docs.xberg.io/guides/ocr/)、[ECI CreateContainerGroup](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-createcontainergroup)。功能与版本以本次实际响应为准。
