# 通用文档解析 ECS 目标替换 · 2026-11-15

按用户要求，将按量ECS控制目标从旧GPU实例 `i-2zegwjwejyvpxoluhyx8` 替换为通用文档解析CPU实例 `i-2zejbbo2svjieb44tqy8`。电源运行库继续配置驱动，不在源码硬编码实例，不改业务Schema或解析核心。

## 当前目标与改动

| 配置 | 当前值 |
| --- | --- |
| 地域 / 实例 | cn-beijing / i-2zejbbo2svjieb44tqy8 |
| 机型 / 资源 | ecs.c8y.16xlarge / 64 vCPU、128 GiB |
| 付费 / 网络 | PostPaid、NoSpot、VPC |
| 私网IP / 配置服务地址 | 172.18.102.103 / http://172.18.102.103:8000 |
| VPC / 交换机 | vpc-2zervqxqgm7a38ryqkzm9 / vsw-2zesh4yhhyi6rryjcwxo8 |

本机`.env`原来没有解析机目标配置，本轮只写入regionId、instanceId、privateIp、baseUrl四项；其他值和文件权限逐项确认不变。实际机器控制/文档提取模式仍为原来的默认disabled，未自动启用或重启业务角色。`.env.document-parser.example`与当前使用手册同步目标，历史GPU测试记录和mock地址保留。

当前CPU目标不满足A10专用回退条件，ECI回退保持false。现有`kbxml-request.json`明确指定CUDA，是之前GPU基线；本轮不猜测CPU镜像/模型/完整参数，示例的提取模式先设disabled，提供CPU完整配置后再启用async。服务端口8000和`/health`沿用现有配置，没有声称已验证新服务HTTP或文件解析。

## 核验

- 使用共享RAM凭据，仅执行DescribeInstances。首次北京时间04:08查询为Stopped+StopCharging；04:11通过正式ECS适配器再次核对ID、地域、私网IP时已为Running，本轮未发Start/Stop，未干预其他流程启动的实例。
- 真实元数据显示PostPaid/NoSpot/VPC、本地盘报告数量/容量0、操作锁为空，已知节省停机资格检查通过；Running状态下不冒称已完成停机或StopCharging验收。
- 配置加载器分别读取本机目标与示例，核对四项一致；实际disabled不变、两者均无ECI回退。仅在验证进程临时构造ecs模式做只读身份校验，没有写回开启模式。
- Compose静态展开确认worker/scheduler均接收新ID/IP/地址和disabled模式；只读解析配置，不启动或重建容器。
- 既有29项配置/ECS RPC单元测试通过，均为mock云；无新增测试，无真实Start/Stop、HTTP解析、数据库迁移或依赖集成测试。本轮为低影响配置替换。

本机证据位于`.local/ecs-parser-switch/`：target-inspection.json、env-update-audit.json、validation.json、compose-validation.json、unit.log。真实密钥未打印或写到示例，其他凭据/数据卷/开发数据不变。不推进Pxx，停在配置验收点。

## App参照

只读核对`../huahuo-ai/lib/core/network/api_endpoints.dart`（SHA256 `17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`）与`lib/features/auth/data/http_auth_repository.dart`（`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`）。内部目标切换不改变App契约；未写App或运行Flutter。
