# 会话鉴权与活跃记录解耦（2026-11-17，待发布）

## 问题与实现

原`IdentityService.authenticate()`每次成功鉴权都更新`user_sessions.last_seen_at`。同会话业务事务的`assertScope()`持有`FOR SHARE`，会让另一个请求在入口鉴权阶段等待；影响范围是同一登录会话，不是同用户的所有独立会话。此前真实PG复现的124ms包含人为持锁120ms，仅证明阻塞，不是生产延迟基准。

本轮只替换鉴权SQL：`admitted`在每次请求中读取账号和会话有效性；`activity`仅在距离上次活动记录至少60秒、且能立即取得会话行锁时更新`last_seen_at`。候选使用`FOR NO KEY UPDATE SKIP LOCKED`，内外更新条件都保留60秒门槛。最终返回`admitted`，跳过活跃更新不会把有效会话误判成失效。

一条SQL完成这两部分，仍只有一次鉴权数据库往返；没有额外后台Promise、连接池、定时器、Redis或进程内身份缓存。数据修改CTE即使最终SELECT不消费其输出，也会完成执行，见[PostgreSQL WITH说明](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-MODIFYING)。该语句仍需主库和原UPDATE权限，不能作为只读副本查询。

JWT签名/issuer/audience/kid/有效期校验，以及账号状态、删除状态、JTI、token摘要、撤销和两类会话有效期条件保留。业务`assertScope FOR SHARE`、登录、刷新、注销与现有HTTP/身份头契约未修改。

## 并发与精度边界

注销/封禁等变更提交后的新鉴权会拒绝。已经开始读取快照、撤销尚未提交的在途请求可以按旧的已提交有效状态通过；这不同于旧UPDATE等待撤销行锁后再检查的时序，已明确测试，不宣称全部并发交错与旧版完全相同。Server业务事务仍执行原有会话校验，其他项目未修改或验证。

`last_seen_at`仅作为近似活动记录，不参与当前鉴权有效期或闲置自动过期。普通鉴权最多每60秒更新一次，持续行锁忙时可能滞后更久，下一次请求再尝试；登录与刷新仍按原流程记录活动。本修复不延长token或session有效期。

`SKIP LOCKED`跳过的是该会话行锁，不能消除DDL表锁、数据库网络或连接池等待，见[PostgreSQL锁定说明](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)。少量到期活动更新仍会短暂持有自身行锁，不承诺所有路径永远无锁等待。

## 验证与证据

- 新增`tests/integration/session-activity.test.ts`共14项真实PG测试：近期活动不产生新行版本、到期更新且有效期不变、业务共享锁保持期间鉴权完成、两实例并行、8类失效状态、真实网关HTTP、未提交撤销及提交后拒绝。
- 近期活动通过`xmin/ctid/last_seen_at`保持不变验证未反复写行。锁等待用例一直保持业务事务，直到鉴权完成才释放；没有定时解锁或以人为等待值声称性能收益。
- 安全运行器创建独立临时PG/Redis，新增14项、身份回归31项、统一用户8项、资产20项，共73项通过；没有真实短信、模型或云调用。
- 单元/契约53项通过。首次命令意外匹配`.local`旧副本，且现有身份mock仍识别旧UPDATE，失败日志保留；随后排除`.local`、更新mock识别新SQL，最终仅8份当前测试文件通过。mock结果不计入真实依赖数量。
- 全仓类型检查、Lint、构建及diff检查通过。构建保留既有Admin bundle体积提示；未做线上吞吐、CPU或数据库存储压测。
- 证据位于`.local/session-activity/`：`integration.log`、`unit-contract.log`（首次失败）、`unit-contract-final.log`、`typecheck-final.log`、`lint.log`、`build.log`。

隔离运行器附带验证当前累计迁移3→5及重复执行为空；0004/0005属于此前候选，本轮未新增或修改SQL、ENV、依赖、公开API或发布脚本。现有累计清单和其他窗口的兼容声明保持，未重置为全部兼容。

App只读核对HEAD `bf23c1b14d847de5561c1ba66bd4192dc308b356`，工作树干净；`http_auth_repository.dart`的token/refresh字段和路径保持。`api_endpoints.dart`、`http_auth_repository.dart` SHA256分别为`17bfcbf28b18fb7aa7a23f6e51a9bf0cdcb4f1933eda29b45b61261f7d5606a1`、`d41d211a7febcb2b53c6603ece3b17c4c471cf638b8ff1669573fc181d10e6d5`。未修改或运行App，未写共享库、重启现有服务、提交或部署。
