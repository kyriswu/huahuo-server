# 文档解析机按需运行

入口是 `src/lib/document-parser-machine/index.ts` 的 `withDocumentParser`，已由现有文件 Worker/FILE_UPLOAD 的 ManagedDocumentExtractor 调用 Xberg 客户端；完整接线见[文档提取手册](document-extraction.md)。地址、认证、并发和供电策略来自配置，运行库本身不绑定引擎路径。原生文本不经过这台机器，没有恢复 MinerU 或公开机器管理 API。

## 当前配置与两种模式

| 配置 | 当前 ECS 方案 | 长期在线 API |
| --- | --- | --- |
| `DOCUMENT_PARSER_MODE` | `ecs` | `always-on` |
| `DOCUMENT_PARSER_BASE_URL` | `http://172.18.102.101:8000` | 运营方配置的 HTTPS API 地址，可包含路径前缀 |
| `DOCUMENT_PARSER_HEALTH_PATH` | `/health`（待实际服务核对） | 服务的健康路径；没有健康接口时显式留空 |
| `DOCUMENT_PARSER_API_TOKEN` | 如有 Bearer 鉴权则设置 | 如有 Bearer 鉴权则设置 |
| 云凭据和实例参数 | 必须；仅使用指定实例 | 不需要，不调用 ECS |
| Redis 去重、排队和并发 | 共用 | 共用 |
| 空闲停机 | 默认 60 秒 | 无开停机操作 |

样本见根目录 `.env.document-parser.example`，已提供 ECS + async 的 VPC 测试配置。实际 `.env` 未修改，应用默认 `disabled`。只有 worker、scheduler 装载机器控制配置，提取配置另外共享给 API/worker。内网基址为 `172.18.102.101:8000`，健康路径 `/health`；协议和任务接线已经本地模拟服务/真实隔离依赖验证，本轮按用户要求不请求该内网服务。此文的 callback 示例解释底层接口，正式业务已使用 ManagedDocumentExtractor。

ECS 目标由环境变量指定，代码中没有固定实例 ID：

```dotenv
DOCUMENT_PARSER_MODE=ecs
DOCUMENT_PARSER_ECS_REGION_ID=cn-beijing
DOCUMENT_PARSER_ECS_INSTANCE_ID=i-2zegwjwejyvpxoluhyx8
DOCUMENT_PARSER_ECS_PRIVATE_IP=172.18.102.101
DOCUMENT_PARSER_BASE_URL=http://172.18.102.101:8000
DOCUMENT_PARSER_HEALTH_PATH=/health
DOCUMENT_PARSER_IDLE_SECONDS=60
DOCUMENT_PARSER_CONCURRENCY=1
```

ECS 模式的地址必须匹配指定私网 IP，避免实例身份和请求目标错位。长期 API 模式允许配置其他 HTTPS 地址或私网 HTTP 地址；地址只来自可信部署配置，不接受文档请求传入控制目标。认证 token 通过 callback 的 `headers` 提供，健康检查也使用同一认证；健康检查拒绝重定向。健康接口的 200 只表示可以提交请求，OCR/正文质量仍由具体客户端校验。

## 在解析任务中使用

每个长期运行的 worker 创建一个模块并复用连接，关闭角色时断开连接。不要每个请求创建一个 Redis 客户端。`loadConfig('worker')` 已有 `documentParserMachine` 字段，也可以独立加载此模块的配置。

```ts
import {
  createDocumentParserMachine,
  loadDocumentParserMachineConfig,
} from './lib/document-parser-machine/index.js';

const parser = createDocumentParserMachine(
  loadDocumentParserMachineConfig(),
  config.redisQueueUrl,
  config.queuePrefix,
);
if (!parser) throw new Error('DOCUMENT_PARSER_DISABLED');
await parser.connect();

// 既有 Task/Service 已完成用户、工作区、文件归属及执行租约校验。
// 同一任务重投递使用同一 requestId；fingerprint 是正文版本与全部解析选项的 SHA256。
const result = await parser.machine.withDocumentParser(
  { requestId: task.id, fingerprint, signal: taskSignal },
  async ({ baseUrl, headers, signal }) => {
    await repository.markExternalIntent(task); // 复用既有 PG 外部提交意图/对账边界。
    const result = await parserClient.parse(input, { baseUrl, headers, signal });
    // 必须等远端解析结束；异步提交接口还要在此等待其终态、收齐产物。
    // 先在既有 PG 事务内校验 task attempt/lease 并保存结果，再返回。
    await repository.commitTaskResult(task, result);
    return result;
  },
);
// 角色优雅关闭并等待请求结束后：await parser.close()
```

`parserClient`、`repository` 是调用方注入的具体业务实现，示例不假设它们已经接入当前导入流程。库只存请求身份的哈希、owner、阶段和租约，不把文档、解析正文、凭据放入 Redis。PostgreSQL 中的任务和结果仍是持久权威；Redis 回执不替代 PG 幂等和权限校验。

## Redis 协调规则

- 同一 `requestId`、同一 fingerprint：已排队、执行中、待核实或已完成时返回 `DOCUMENT_PARSER_DUPLICATE` 与 `requestState`，不再调用解析客户端。调用方从既有 PG 任务读取进度或结果。同一 ID 的 fingerprint 不同则返回 `DOCUMENT_PARSER_CONFLICT`。
- 去重回执默认保留 24 小时（`DOCUMENT_PARSER_DEDUP_TTL_SECONDS`）；超过窗口仍须由 PG 任务身份防止重复业务执行。只有尚未提交远端的 `cancelled` 回执允许同 ID 安全重试。
- 默认全局并发 1，由 Lua 原子领取名额，不随 worker 副本数增加。`DOCUMENT_PARSER_CONCURRENCY` 可调整至 1–16；容量需另做真实解析压测。等待队列 FIFO，默认最多 128 个等待者，超出明确拒绝。默认排队上限 3600 秒，启动/就绪等待上限 600 秒，两者独立。
- 排队和执行租约默认 30 秒，每 10 秒续期。过期排队请求尚未调用解析服务，可以回收；执行中租约过期只会变成 `unknown`，继续占名额，阻止新请求和停机。不会通过自动删锁掩盖仍在远端执行的任务。
- HTTP 超时、进程退出、AbortSignal 中断都不能证明服务端停止计算。普通 callback 异常默认记 `unknown`；只有客户端已确认远端结束或从未提交时，才使用 `ParserExecutionError(code, 'settled')`。收到明确成功结果才释放执行名额。
- 外部任务查询或人工核实完成后，内部补偿代码可调用 `acknowledgeSettled({requestId,fingerprint})` 清理对应未知请求。此方法不暴露为 HTTP 工具，不自动重试原解析，不把未知请求变成解析成功。
- Redis 不可用、配置信息不一致、机器元数据或活动索引部分丢失时拒绝动作，不降级成进程内计数。不同进程共用 `REDIS_QUEUE_URL`、`REDIS_KEY_PREFIX` 和解析配置；键位于同一 Redis Cluster hash slot。队列 Redis 继续要求 AOF、持久卷、`noeviction`。

Redis 全量数据丢失后无法仅凭空 key 判断远端是否仍有任务，应先停止接单，按 PG/解析侧任务核实并恢复协调状态，再恢复流量。本库不承诺在外部服务和 Redis/PG 之间提供跨系统 exactly-once；持久任务的外部提交/结果对账仍由所属业务 Service 负责。

## 开停机与一分钟空闲

请求先登记、再领取名额。ECS 实际为 `Running` 时复用；`Starting` 时等待，不重复开机；`Stopped` 才发一次 `StartInstance`。开机后还需健康检查通过才执行 callback。

scheduler 订阅 Redis 状态事件，由 Node 事件循环等待通知。最后一个请求结束后，按 Redis 时钟安排一次 60 秒空闲定时器；新请求到来时取消或重设它。没有每 5 秒的解析机扫描，也不阻塞原来的 PG Task/Outbox 调度。只有已经被请求接管的机器，且无排队、执行或待核实请求，距最近请求到达/完成至少 60 秒，才申请停机锁。

忙碌请求或云端过渡状态未结束时，保留每分钟一次的临时兜底：核对 Redis 租约/遗漏通知，必要时复核 ECS；执行中的正常请求不额外轮询云状态。确认 `Stopped + StopCharging` 后，将 `economicallyStopped=true` 持久写入 Redis，取消空闲和兜底定时器，完全等待下一次请求事件。scheduler 重启时读取该标记继续休眠；新请求登记或开始开机时清除标记。未知请求、明确阻断状态也停止无效兜底，等待核实事件。重连先等待 Redis 订阅确认，再读当前状态，避免重连窗口遗漏唤醒。

停机前在查询 ECS 后再次原子检查请求数：新请求在停机意图写入前到达会阻止停机；意图写入后到达则排队，等已停止后再启动。正常空闲定时器在约 60 秒时触发；实际停止完成另受 ECS 影响，后台确认按一分钟节奏，期间若有新请求则由请求方优先对账。没有接管记录的实例不会被自动停止。部署应仅运行一个解析机监视器；多个 scheduler 即使误并行也仍受 Redis 控制锁和过渡状态保护。

开停机先写持久的 Redis 过渡阶段，再执行一次云 RPC；SDK 自动重试关闭。RPC 超时或结果不明时保留过渡阶段，后续按一分钟兜底核对实际状态，不盲目重发。同一机器开停机共用 owner 锁，旧 owner 不删除新 owner 的锁。长期无法证实的过渡状态继续阻断，等待运维核实。

停机参数固定为 `StoppedMode=StopCharging`、`ForceStop=false`；只在云侧读到 **`Stopped` 且 `StoppedMode=StopCharging`** 后报告 `stop_confirmed`。普通计费停机或缺少模式字段会进入阻断状态，不能报告节省停机成功。启动固定 `InitLocalDisk=false`。

资格预检核对按量付费、VPC、已知本地盘/持久内存排除项及操作锁，并核对实例 ID、地域、私网 IP。最终计费模式仍必须复核，不能将预检当作所有规格的完整资格保证。磁盘与 EIP 等保留资源仍会计费，恢复计算资源也可能缺货。[阿里云节省停机文档](https://help.aliyun.com/zh/ecs/user-guide/economical-mode)、[StopInstance](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-stopinstance)、[StartInstance](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-startinstance)。

## 状态与以后切换 API

```bash
# 默认只读云状态；disabled 时不连接 Redis/ECS。
pnpm document-parser:machine status
```

ECS 模式复用共享 `ALIYUN_RAM_ACCESS_KEY_ID` / `ALIYUN_RAM_ACCESS_KEY_SECRET`，可附 `ALIYUN_RAM_SECURITY_TOKEN`。RAM 至少允许查询实例，以及仅对目标实例执行 StartInstance/StopInstance；不要为此使用任意实例管理能力。库按每次操作解析凭据，错误输出只有稳定错误码/供应商请求 ID。

切换长期 API 时，先排空请求、确认旧 ECS 已节省停机，再停止旧 worker/scheduler，修改两者部署配置：

```dotenv
DOCUMENT_PARSER_MODE=always-on
DOCUMENT_PARSER_BASE_URL=https://parser.example.com/api
DOCUMENT_PARSER_HEALTH_PATH=
DOCUMENT_PARSER_API_TOKEN=your-token
```

库会拒绝不同配置同时操作同一协调状态。用新配置执行 `pnpm document-parser:machine configure-idle`，原子更新空闲状态的配置签名，再启动新 worker/scheduler。此命令只改 Redis 配置签名，不调用开停机，也不删除去重回执；有排队、执行、未知请求、过渡状态或控制锁时拒绝切换。首次无协调状态时不需要此步。并发/空闲策略变更也使用相同排空步骤。示例域名仅是配置格式，未调用该服务。

实际验收与当前目标只读快照见 [验收记录](../acceptance/document-parser-machine.md)。
