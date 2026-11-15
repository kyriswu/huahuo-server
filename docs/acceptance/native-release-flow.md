# 原生测试自动发布与 main 准备

候选：GitHub 原生 Auto-merge → test push CI → main 的 workflow_run → 原五阶段。保留 main owner 合并、production owner 审批和 Skill/CODEOWNERS 归属规则；移除临时自定义合并/轮询/dispatch 总控脚本和单测。手动 test dispatch 保留作恢复入口。

自动发布仅针对已合并到 test 的准确候选：复核 CI 运行ID、事件、仓库、分支、SHA及最新双头，读取整个合并PR文件清单。release plan 更新表示需要发布；白名单内文档/Skill/已知控制变更跳过，其他变更缺计划则失败，重命名原路径和截断清单不得绕过。不会执行test控制脚本或CI产物。

main CI后自动准备摘要，生产未接入且基准未初始化。可选production审批演练 deployment:false，无部署记录或服务器操作。本次无增量迁移、ENV实际值或付费资源；声明新发布计划20261115-native-flow，基于测试实际成功版本5b844ba复用配置及既有只读DB断言。main合入后同步test，将自动真实更新测试容器以验证workflow_run/OIDC/五阶段，不接正式生产。无合并冲突。

本地验证和真实GitHub事件验证分开记录；候选尚未合入/运行，不宣称原生链路已上线。

本地：Typecheck、Lint、802项单元/契约通过（含62项原生来源/事件/意图/main准备检查）；Skill与差异检查通过。原生云端事件与五阶段实测待合入后记录，不能用替身结果代替。
