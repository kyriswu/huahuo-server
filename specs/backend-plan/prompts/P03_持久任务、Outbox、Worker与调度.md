# P03 · 持久任务、Outbox、Worker与调度

前置阶段：P01、P02。

## 本阶段固定部署与 App 参照

- App只读参考仓库：**https://github.com/kyriswu/huahuo-app**。本机后端根为 `huahuo-server`，App位于同级 `../huahuo-app` 且只读；禁止把服务写进App、复制Flutter作为运行依赖或擅自修改UI。
- 同一根目录Compose：`api-server`、`worker`、`admin`、`scheduler`独立容器；`postgres`（可切云）、`redis`、一次性`migrate`。本阶段涉及：scheduler调度/投递；worker执行；api-server受理/状态；admin受控运维入口。
- 先按 `07_App代码持续参照与契约核对.md` 核对本阶段：task/run、轮询/取消/重试、事件游标与结果确认消费者。路径/符号从当前checkout发现，不猜它们一定在旧目录；记录实际commit和本地改动。
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

先证明任务在API/Redis/Worker故障下不会丢失或重复落业务结果，再接入付费任务。

## 实施要求

1. 建task、task_attempt、outbox、必要事件/租约/版本字段。任务包含scope、kind、input reference、状态、结果引用、重试/取消信息；队列payload只放ID，不放完整私有正文。
2. 同PG事务创建受理记录+task+outbox。返回稳定taskId；HTTP重复同key同body返回相同身份，不同body冲突。API退出不丢已提交意图。
3. dispatcher只在scheduler入口运行，短租约领取outbox，事务外投递BullMQ；重复投递的job标识和PG结果唯一约束配合。建立投递失败重试和积压告警。
4. 定义内容/语音、AI、商业、通知维护队列及并发预算；worker独立容器中的一个角色进程可运行多个消费者，但不能同时启动api-server/admin/scheduler。允许通过WORKER_QUEUES选择队列和增加worker副本，受限子进程只用于任务本体。有限指数退避+jitter、不可重试错误、死信与受权限保护的重试入口。
5. Worker业务完成通过预期attempt/version做CAS，防止迟到旧worker覆盖；模拟一个真实PG写入结果的演示任务，不只setTimeout伪进度。
6. Scheduler是独立容器入口，默认一个副本、仍使用PG租约/唯一schedule+时间窗防重。只投递状态查询/补偿任务，付费provider调用交worker。使用所选BullMQ受支持调度或PG持久计划；稳定schedule ID与时间窗去重。实现待投递、失联任务、超过租约、Redis丢队列后的PG对账。
7. 明确queued、waiting_external、reconciling与终态；外部已提交/未知任务恢复只查询或转人工，不自动重做。支持cancel_requested，远端不可取消要明确。
8. 任务状态API及最小事件读取；为P08的SSE留有序事件接口，不对Redis Pub/Sub做永久历史假设。

## 必须验证

- API提交后、enqueue前重启：任务能执行。enqueue后、outbox确认前重启：结果只有一份。
- Worker执行过程中被杀：可重领，旧attempt无法覆盖。
- 测试环境清空/恢复Redis，PG未完成任务安全补投递；succeeded不会再次执行。
- 同一scope幂等键冲突、跨scope访问、取消与重试分别测试。
- SIGTERM优雅退出；Redis离线API不无限等待；缓存故障不放开费用型请求。
- 停worker后API/admin仍能受理合规请求并查queued；worker恢复后消费。停api-server后已入队任务继续，admin仍可查元信息。停scheduler后worker处理已有队列，新outbox停投递但不丢，恢复后安全补投。
- 意外启动两个scheduler不重复发周期权益/任务；增加worker副本不需要宿主端口或固定container_name。

## 不做或不得误报

不承诺外部供应商exactly-once，不自己编一套通用分布式任务平台。
