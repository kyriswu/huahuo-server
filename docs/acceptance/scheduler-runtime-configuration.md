# Scheduler运行时配置修复（2026-11-17）

## 问题与修复边界

原Scheduler入口直接执行过期上传清理及任务扫描，没有进入现有`RuntimeSettings.run()`。因此其新建维护/清理任务使用数据库默认3次，投递Redis失败后的退避也回退默认参数；HTTP业务及Worker已经接入的配置上下文不属于这个遗漏。

本轮将每次`expireUploads + scheduler.tick`放入同一份经过校验的配置快照。轮次中途修改配置只影响下一轮；读取失败或配置无效时整轮不执行，不刷新`lastScan`，仍按原间隔重试。下一轮从数据库读取恢复后的配置，不要求重启。不新增缓存、监听服务或定时器，也不改变扫描间隔、租约、队列并发或计费规则。

原`enqueueIntent`既负责投递，也会更新`version=1、attempt_no=0`任务的执行上限，导致接入配置后补投旧任务可能改写预算。本轮将上限放到全部11处任务INSERT，通过`newTaskMaxAttempts()`读取创建时配置；投递函数只写Outbox。新建任务省去原先补写上限的UPDATE，旧任务的补投、回调唤醒和自动恢复保留原值。人工retry继续沿用已有追加执行机会规则。

Admin手动启动节点也会创建任务，原路由没有配置上下文；仅为该已鉴权、已校验CSRF的handler接入已有`RuntimeSettings.run()`，不修改权限、路由参数或云调用逻辑。

## 开销与部署

每个Scheduler实例每轮新增一次单行配置SELECT；主循环仍串行，上一轮完成后等待原间隔再启动下一轮，不增加查询并发。稳定空闲时主循环由6条数据查询变为7条，包含4组BEGIN/COMMIT则由14条SQL变为15条；健康检查、节点监控和有任务时的SQL另计。这是代码路径计数，不是目标数据库压测。

本轮没有新SQL迁移、字段、配置键或外部依赖，沿用四角色部署。当前累计候选内已有0004/0005及其他窗口的兼容声明全部保留；本轮不放宽发布门禁，也不修改已有任务数据。尚未提交、部署或重启现有服务。

## 验证记录

新增`tests/integration/scheduler-configuration.test.ts`共7项，使用运行器创建的独立真实PostgreSQL/Redis，关闭付费和云调用。覆盖新建维护/清理任务配置、API新任务与未领取旧任务补投、失败投递的基础退避/封顶/抖动、轮内配置修改隔离、无效配置拒绝、真实Scheduler入口无效配置后的恢复、Admin节点启动仅排队时的配置。

最终全仓类型检查、构建及本次改动文件Lint通过；990项unit/contract通过。最初全仓Lint通过，收尾时另一窗口新增的`tests/unit/kb-images.test.ts:102`有两处`no-useless-escape`错误，因此最终全仓Lint未通过；本轮未修改该文件。首轮全量集成中既有338项及新增5项通过，4项跳过；新增两项fixture错误分别为不合理的1900年时间戳导致积压统计整数溢出、节点样例缺少冻结Schema要求的enabled字段，均已修正，未据此改变业务实现。之后一次专项复测因并行窗口尚未补齐`kb-images.ts`在收集阶段停止，没有执行测试；不归为Scheduler业务失败。

并行文件补齐后，最终直接以当前源码重跑7项专项全部通过（约1.1秒测试执行时间）。实际Scheduler入口子进程先以无效配置启动，验证live=200、ready=503且不建计划任务；运行中修正配置后，同一进程下一轮创建的任务采用新上限8，无需重启。此前保留的编译快照没有用于替代最终源码验证。既有338项与新增7项合计345项真实依赖用例分两轮通过，4项Milvus相关跳过，不宣称真实云/模型测试。

证据位于`.local/scheduler-runtime-config/`；`integration.log`保留首轮结果，`integration-targeted.log`保留模块收集阶段失败，`integration-targeted-final.log`为7项源码验证通过记录。`typecheck-final.log`、`lint-scoped.log`、`build-final.log`为最终通过的静态复核，`lint-final.log`保留上述全仓Lint错误。隔离运行器另外验证当前累计迁移3→5、重复应用为空；该迁移属于此前候选，本次未新增SQL。所有运行器均只清理本轮自有临时依赖和凭据，不访问共享库或现有数据卷。

App仅只读核对，工作树干净；`api_endpoints.dart`、`http_auth_repository.dart`的SHA256仍分别为`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。公开API/事件载荷不变，未运行App，不将后端测试称为移动端联调。
