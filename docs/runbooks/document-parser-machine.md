# 处理节点按需运行

2026-11-15 起，正式配置入口为 PostgreSQL + Admin「运行配置」。节点登记、业务参数、ENV 边界、API 与部署验收点以 [运行配置手册](runtime-configuration.md) 为准。旧 DOCUMENT_PARSER 环境项不再控制生产目标。

每个 Worker 复用一个 `ProcessingNodes(pool, config)`，按节点复用 Redis 连接；Scheduler 在同一角色内为各登记节点维护事件监听，约 30 秒刷新登记列表，不增加新容器。示意：

```ts
const nodes = new ProcessingNodes(pool, config);
const result = await nodes.withNode('document', {requestId, fingerprint}, async context => {
  // 所属 Service 已完成用户/工作区归属、任务执行租约校验。
  // 保存提交意图、等待远端终态、收齐输出，在持久事务 fencing 成功后返回。
  return parseAndCommit(context);
});
// 优雅退出、等待业务任务结束后：await nodes.close()
```

正式文档业务已经通过 ManagedDocumentExtractor 接入，不应以示例替代其 bound/intent/job 恢复协议。`withNode('audio',...)` 是通用占用边界，具体音频协议需另行实现。

## 机器级协调与安全停机

同一 ECS 只登记一次；其全部能力共享 UUID 对应的 Redis hash slot、FIFO、并发、过渡锁与未知任务占用。PG 保存请求到节点的不可变绑定。默认整机并发 1、等待容量 128、空闲 60 秒、启动 600 秒、排队 3600 秒。容量/时限在 Admin，部署协调租约默认 30 秒、回执保留 24 小时；多副本必须使用相同 Redis 前缀与协调配置。

请求先分配节点、登记及领取名额，再核对实例/健康；Running 复用，Starting 等待，Stopped 才按持久意图发一次启动。地址必须匹配 ECS 私网 IP，禁止 URL 内凭据/重定向。健康 200 不代表 OCR 质量通过。

每台 ECS 事件驱动空闲定时；正常忙碌/过渡状态保留原一分钟兜底，确认 StopCharging 后休眠等事件。停机前同时要求 PG 无未结算分配、Redis 无排队/活动/未知任务，并在查询云后原子重检到达的新请求。停止固定 `StoppedMode=StopCharging`、`ForceStop=false`，启动固定 `InitLocalDisk=false`。只在读取 Stopped 且 StopCharging 后报告成功，其他停机状态阻断。

远端提交/停止结果不明时保存过渡状态并核实，不盲重发。租约过期不移除已执行任务；模糊结果、Redis 丢失、状态不一致和 DB 故障均不当作空闲。已知成功持久结果可由内部 `acknowledgeSettled` 对账。CLI 只读状态，不提供人为清锁/改签名旁路。人工核实前保留占用，可能继续计费；不能把清空协调状态当恢复流程。

## A10 ECS 缺货回退 ECI

GPU 文档 ECS 节点可在 Admin 的可选 `eciFallback` 填入完整参数：

```json
{
  "vpcId":"vpc-…",
  "securityGroupId":"sg-…",
  "vSwitchIds":["vsw-…"],
  "instanceTypes":["ecs.gn7i-c8g1.2xlarge","ecs.gn7i-c16g1.4xlarge","ecs.gn7i-c32g1.8xlarge","ecs.gn7i-c48g1.12xlarge"],
  "image":"huahuo-docker-hub-registry-vpc.cn-beijing.cr.aliyuncs.com/ai_service/xberg@sha256:152b65be33a26cfbe0a0dc24f2aea399965bf85b98bd97b2016aced02131a6c7",
  "acrInstanceId":"cri-…",
  "extraStorageGiB":40,
  "bucket":"huahuo-ai-assets-test",
  "keyPrefix":"huahuo"
}
```

上例网络/ACR ID 是占位，须替换；CPU 节点留空。保留原资格检查与精确缺货触发，不新增 ECS 分配器，不因权限/余额/超时/健康失败创建 ECI。回退 NoSpot 单 A10、配置顺序多规格、一次创建传多交换机、8000/TCP、1GiB shm、内网镜像、自动缓存；图片前缀是 `<keyPrefix>/resources`。RAM 在 SDK 边界由唯一 AK 环境变量注入，不进入 DB/Redis 配置。实际库存/费用以云请求为准，本轮未作云实测。

ECI checkpoint/归属核对、模糊创建/删除阻断、空闲删除确认及下一轮优先 ECS 沿用既有实现。有 ECI 归属时禁止修改节点配置。回退代码和过往独立实测见 [回退验收](../acceptance/document-parser-eci-fallback.md)、[prod-callback 验收](../acceptance/xberg-a10-prod-callback.md)，它们不代表当前 CPU 或本轮多节点已上云验收。
