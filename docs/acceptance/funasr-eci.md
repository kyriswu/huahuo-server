# FunASR 单 T4 ECI（2026-11-12）

本轮按用户要求申请一台 ECI，部署用户提供的 `funasr-eci:gpu-20261112` 镜像。仅为独立开发实例，不推进 P07，也不接入正式 ASR Provider、Task 或 Worker。

| 项目 | 实际结果 |
| --- | --- |
| 实例 ID | `eci-2ze2499g6uixsafwn1sq` |
| 地域 / 可用区 | `cn-beijing` / `cn-beijing-h` |
| 规格 | `ecs.gn6i-c4g1.xlarge`，4 vCPU、15 GiB、1 张 T4 |
| 镜像标签 | `huahuo-docker-hub-registry.cn-beijing.cr.aliyuncs.com/ai_service/funasr-eci:gpu-20261112` |
| 实际拉取 | 同一 ACR 的 VPC 域名，固定 `sha256:1434d95d42806a9e748b7bd7dd2272740e8963d0d0823f0c089edea39bc68f60` |
| 启动 | 原镜像默认命令，UID/GID `10001:10001`；`DEVICE=cuda:0`；新建独立 API token |
| 网络 | 原 VPC / 安全组 / 三交换机；内网 `http://172.16.18.96:8000`，无 EIP |
| 计费 | `NoSpot` 按量；只读报价 `0.00323056 CNY/秒`，折合 `11.630016 CNY/小时`，不是账单 |
| 创建时间 | 2026-11-12 13:12:22（Asia/Shanghai） |
| 运行期限 | `ActiveDeadlineSeconds=3600`，预计 14:12:22 左右强制退出；不把期限视为已释放证据 |
| 持久化 | 未挂 NAS；`/data` 为实例内临时数据，不作为声纹持久化验收 |
| 当前验证 | 13:17:17 确认 Running / Ready，`/readyz` 返回 `{"status":"ready","device":"cuda:0"}`；保留运行 |

真实核验结果：

- 云端镜像拉取记录为 210.791 秒；13:16:21 容器开始运行，13:17:14.893 应用启动完成，13:17:17.107 本地确认就绪，创建到确认约 295.1 秒。
- `nvidia-smi`：`Tesla T4, 580.178.04, 15360 MiB`；启动日志：PyTorch `2.8.0+cu126` / CUDA `12.6`。独立 CUDA 张量运算 `torch.ones(4, device='cuda:0').sum()` 返回 `4.0`。
- 日志确认 ASR、VAD、标点和说话人四个模型从已校验的本地文件加载；原镜像离线开关保留。启动期探针连接拒绝的事件和日志仍保留，最终容器 `Ready=true`、重启次数 0。
- 实际进程 UID 为 10001，`/data` 可写。未挂 NAS，不把可写性当成跨实例持久化。
- `GET /v1/voiceprints`：无 token 为 401，使用新 token 为 200；`GET /docs` 为 200。实例 ID 和分配标签复核一致，标签查询仅 1 台。
- 初次部署验收只核验模型加载、GPU 和鉴权，未提交音频或注册声纹。随后用户要求获取解析结果，完整音频试验单列于下节。

在能访问该 VPC 的终端中，从仓库根目录加载本地连接配置后即可调用：

```bash
set -a
source .local/gpu-spot/funasr/funasr-1794460260527-4a58f23f-fbaa-46d5-90e8-dadcbe40e4d3/service.env
set +a
curl --fail-with-body "$BASE_URL/readyz"
```

交互文档为 `http://172.16.18.96:8000/docs`；本轮没有创建公网入口。

先沿用已有 `SpotAsPriceGo` / 四档 T4 优先级提交，返回明确的 `OperationDenied.NoStock`（Request ID `01A1CE2A-AB7A-5816-AF97-25BA93C345BE`）。后续四档只读库存查询均为 `Spot.NotMatched`，按量最小档在北京 H 显示 `WithStock`。确认原分配标签查询为 0 后，保留原失败和计划，使用新 ClientToken 改为最小档按量，只受理上述一台实例。按量创建 Request ID 为 `01A1CE2B-D7C2-5811-8551-89D0CF261D84`。

运行期限、GPU 参数及驱动配置依据[创建 API](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-createcontainergroup)和[GPU 实例说明](https://help.aliyun.com/zh/eci/user-guide/create-an-instance-by-specifying-the-gpu-type)。报价为本轮 `DescribeContainerGroupPrice` 实际返回，不包括未发生的扩容、NAS 或公网资源。

本地证据位于忽略提交的 `.local/gpu-spot/funasr/`：镜像清单、脱敏配置、库存/报价、App 哈希，以及本轮目录 `funasr-1794460260527-4a58f23f-fbaa-46d5-90e8-dadcbe40e4d3/` 中的计划、原抢占失败、状态历史、云端快照和连接配置。`service.env` 权限为 0600；API token、RAM 凭据和用户提供的带签名音频 URL 不写入文档。

App 只读核对 HEAD `20f61b78887f9288d1fd3227f326e6374d516f27`，实际读取 `endpoint_catalog.dart:805` 和 `work_ai_task_api.dart:16` 的任务查询/重试契约，两个文件 SHA-256 与前轮一致。没有 App、数据库、迁移或四个 Compose 角色改动；根 `.env.gpu-spot` 继续 disabled。

本轮本地控制脚本 `node --check`、`git diff --check` 通过。云端实际就绪/鉴权/GPU 验证与本地语法检查分别记录，不用 Mock 测试宣称模型推理或完整音频转写通过。

## 完整音频转写（2026-11-12，已导出，质量未通过）

用户随后询问解析结果。本轮使用原实例和原镜像转写用户指定 OSS 原文件，未裁剪：119,018,157 字节，MP3、48 kHz、双声道，`ffprobe` 时长 7438.608 秒（2 小时 3 分 58.608 秒）；下载后 SHA-256 为 `a88c9bc20e6117ce2ef86dbd01f97d4452e6cf8bdd31f24e72e385cc0af74ada`。

实际时长超过镜像默认 7200 秒，先使用官方 `UpdateContainerGroup / IncrementalUpdate` 把本次实例的 `MAX_AUDIO_SECONDS` 改为 10800，保留 DEVICE 和原 token；更新 Request ID 为 `01A1CE35-A4F7-5691-85CE-E269349C1097`。同一 GPU 实例重启后重新 Ready，核对环境变量为 10800 后，提交一次完整 multipart `POST /v1/transcriptions`，自动说话人分段，未启用无注册样本的身份匹配。没有新增实例、修改模型/推理库或业务 Provider。

一次完整请求已完成：北京时间13:25:02提交，HTTP200、101.157秒返回；响应中的模型处理耗时85.536秒、解码时长7438.571秒，返回1523字符、218个分段、4个说话人聚类标签，原始JSON为75,352字节。FFprobe与解码时长相差约0.037秒，未截取输入。

**质量未通过**：1523个字符中有1277个“嗯”；去除标点后1305个字母/数字/汉字中，“嗯”占97.85%。例如开头为“嗯嗯，嗯对，嗯嗯嗯……”。结合文件名称为钢琴/海浪音频，这是高度可疑的非语音误识别；未人工听审或以真实字幕算WER/CER，不能把HTTP200、分段数和4个聚类标签当作准确转写或4位真实说话人的证据。未注册声纹、未执行身份匹配。

99个约1秒GPU样本覆盖请求全程，平均利用率17.47%、峰值97%、显存峰值2769MiB；包含上传/解码等时段，不作为纯GPU内核利用率。请求完成后同实例仍Running/Ready。

### CPU / GPU 资源补查（2026-11-12）

未重跑音频。通过官方[ECI实例监控API](https://help.aliyun.com/zh/eci/developer-reference/api-eci-2018-08-08-describecontainergroupmetric)补查历史CPU/内存，查询13:24:30—13:27:15、Period=15，返回11条，Request ID `01A1CE42-D8C6-57A5-92E3-FD55AD0E3DC8`。请求实际13:25:02.287—13:26:43.445，以下CPU统计取落在其中的6个实例级采样点，不能视为逐秒峰值：

| 指标 | 采样均值 | 采样峰值 |
| --- | --- | --- |
| CPU（4 vCPU为100%） | 1.441核 / 36.02% | 1.650核 / 41.26% |
| GPU计算利用率 | 17.47% | 97% |
| GPU显存 | 未作为本轮主要汇总项 | 2769MiB / 2.704GiB，占15360MiB的18.03% |
| 实例物理内存RSS | 未作为本轮主要汇总项 | 3.089GiB |
| 实例内存工作集 | 未作为本轮主要汇总项 | 3.103GiB |
| GPU板卡功率 | 31.82W | 64.34W |

CPU使用实例级 `UsageNanoCores / 1e9` 换算核数，再除以4得到占整台CPU比例。返回的containers列表有同名重复记录，没有相加，避免重复计算。相邻累积值的13:25:00—13:26:45包络窗口为105秒，`UsageCoreNanoSeconds`差分139.122核秒，窗口均值1.325核/33.12%；该口径与请求内6个采样点均值不同，不混用或作为精确任务CPU账单。

GPU为原请求内约1秒采样；CPU/内存为事后读取的15秒云监控。统计包含上传、解码、推理及当时监测开销，不能直接外推正常会议录音的负载。数据保存为本轮目录下 `cloud-metrics-15s.json`、`cpu-cloud-15s.csv`、`resource-summary.json`；原逐秒GPU数据仍在 `audio-results/results/gpu.csv`。

### 并发评估边界

再次核对同一摘要镜像中读取的源码和启动配置：默认Uvicorn `--workers 1`；`app/main.py:83`创建进程内推理互斥锁，117—126行非阻塞获取，忙时返回429；锁覆盖完整解码和推理。因此当前镜像只有1路推理，资源空闲不意味着直接增加HTTP请求就能并行。

按本次样本、独立模型进程粗略线性估算，总并发2时CPU约2.88核、RSS约6.18GiB、显存约5.41GiB；总并发3时CPU约4.32核、RSS约9.27GiB、显存约8.11GiB。以上不是并发实测或容量保证，GPU突发、解码、CPU线程竞争和模型复制都会影响结果；多worker通常各自持有模型内存，参见[FastAPI部署概念](https://fastapi.tiangolo.com/deployment/concepts/)。建议先以总并发2（增加1路）为压测目标，再用真实人声样本决定是否验证3路；当前4核机器不以GPU平均利用率倒推可承诺并发。本次仅核对/评估，未调整运行并发或重新执行转写。

初次结果归档向临时OSS上传返回403，发生于HTTP200响应已落盘之后；原始失败、请求日志和完整响应均保留，没有重复转写。改从已核验归属的ECI按块读取同一21,524字节归档，SHA-256核验为 `feb8618b8c7ec410d97bfaf75c4292499aa7269a1e8bab08fbe8481909cbd955`。临时输出对象最终HEAD404，源音频大小和ETag与初始一致；仅清理本轮输出键，未删除源文件或释放用户要求保留的实例。

本轮目录下的 `audio-results/results/` 已导出：

- `response.json`：原始HTTP响应，保留全文、全部毫秒时间戳、segments和speakers。
- `transcript.txt`、`segments.tsv`、`结果摘要.txt`：原始文字、分段表及明确标注质量未通过的说明。
- `http.json`、`input.json`、`ffprobe.json`、`gpu.csv`、`verification.json`、`events.jsonl`：耗时、原文件校验、音频元信息、GPU采样和导出校验。
- `failure.json`：原OSS导出403；不能将其混作ASR推理失败。

本轮仍无业务/App/数据库/Compose角色变更。现有本地控制脚本通过语法检查，真实云端HTTP完成、导出恢复和质量问题分别保留证据。
