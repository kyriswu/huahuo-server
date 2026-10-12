# App 本机持续参照与契约核对 · v3，贯穿 P01—P16

## 1. 固定来源与本机角色

源仓库：**https://github.com/kyriswu/huahuo-app**

```text
Code/
├─ huahuo-app/                  # 已有、本轮只读，含本地未提交内容
└─ huahuo-server/               # 独立后端，唯一业务写入根
   ├─ specs/backend-plan/
   ├─ config/app-reference.local.json
   ├─ src/
   ├─ compose.yaml
   └─ docs/
```

**先读 `../huahuo-app`，不再默认clone，也不新建参考目录。** 来源URL用于识别仓库和以后经授权的远端核对。当前App真实绝对路径由Codex解析；同机目录不意味着两个仓库合并。

本包不包含App源代码，也没有访问用户Mac。不得把历史回复的commit写成本轮本机事实。

## 2. P01定位，每阶段只读核对

P01生成不提交的 `config/app-reference.local.json`，参照可提交example：repoUrl、localPath=`../huahuo-app`、pathBase=`backend-root`、sourceMode=`local-first`、readOnly=true、checkRemoteAtStageStart=false。**相对路径基准是Server根，不是config目录，也不是Docker的/app。** 宿主编码工具使用，运行时不能依赖该配置。

已有Git时先确认 `git rev-parse --show-toplevel` 等于App真实路径，再记录HEAD、分支、dirty；可使用 `git --no-optional-locks -C ...` 防止不必要的Git元数据写入。不输出带凭据的完整remote URL。纯源码副本没有Git仍可参照，记SOURCE_COPY_NO_GIT及实际读取文件哈希，不强制clone来补.git。

每阶段：
1. 验证Server和App路径未被交换/嵌套/重定向，App仍可读取。
2. 检查本机源码和上阶段记录有何变化；不自动fetch/pull/reset/checkout/stash/clean。
3. 按本阶段业务读取页面动作→Controller/Repository/Port→API Client→DTO/解析与相关测试，不反复产出全仓文档镜像。
4. 保存实际阅读文件的相对路径/行号/符号、SHA-256和对应本地commit或无Git状态。只记必要文件，不扫描秘密/私密素材。
5. 阶段末复核这些文件；变化需重新评估受影响契约，不自动还原。阶段内基线来自所读内容快照，不只来自HEAD。

本机读取被权限拦截时，先请求精确读取权限。App确实缺失时报告实际路径与尝试，标UNVERIFIED_APP；继续独立骨架，不假称兼容。只有用户另行授权后才从GitHub在单独位置取副本；远端不可达不影响已有本机源码使用。

## 3. 发现入口（只是定位线索）

- `Flutter/src/lib/app/navigation/`：路由、入口参数、快捷入口与恢复。
- `Flutter/src/lib/app/bootstrap/`：依赖注入、Base URL、账号及工作区范围。
- `Flutter/src/lib/features/`（包括ui_v3）：页面事件、controller、repository/port、本地状态。
- `Flutter/packages/huahuo_api/lib/src/api/`：endpoint catalog、contract manifest、envelope、幂等策略与领域客户端。
- 各领域 DTO、共享模型、对应测试、原生录音卡及支付桥接。

目录不存在时搜索当前替代位置。UI文档、注释、Mock和wiredMobile/contractReady不是线上证明。手机SQLite DatabaseWorker不是服务器Worker。

## 4. 每个端点要有证据链

```text
页面/操作 → Controller/Repository → API Client
→ method/path/header/body → 响应解析/状态使用
→ 后端route/schema/serializer → contract fixture和测试
```

记录：本机commit/工作树哈希、字段/必填/可空/默认/枚举/单位、身份范围、分页、错误包装、幂等别名、ETag/revision、SSE游标和成功条件。严格解析器是否接受未知字段必须查，不臆测“多返回字段总没问题”。

CODE（读过源码）、USER（需求）、PROPOSED（设计默认）、UNVERIFIED_APP/BLOCKED分别登记。固定SKU或credit政策只作兼容输入，不直接成为新后端永久商业规则。仅声明未被移动端消费的接口单列，不滥造云API。

## 5. 写入与运行边界

- 后端优先adapter/serializer兼容；App数据层确需修改时写 `docs/app-change-proposals.md`，说明原因、最小范围、测试、回退、授权状态；不直接编辑App。
- 不运行会向App写文件的Flutter包管理、构建、格式化或生成器。真实Flutter测试另行批准或在隔离验证位置执行，和JSON fixture验证分开记。
- 后端build、tests和CI可用已审查脱敏fixture；不依赖App工作区存在才能启动，不复制或挂载App到业务容器。
- 每阶段更新progress、app-reference、contract-compatibility、provider-status、container-status；P15汇总，不是首次核对。

## 6. 需要在P01实现的工具

`pnpm app:reference`：默认只读检查 `../huahuo-app`，报告路径/HEAD或NO_GIT/dirty及所读文件哈希，在Server内保存基线。路径解析与权限失败要有测试；不自动clone、不联网、不改App。

`pnpm app:reference:diff`：对比上次本机基线与当前文件；不是自动检查GitHub main。不输出完整秘密diff，不覆盖用户编辑。

`pnpm local:preflight`：检查两个目录与本地Docker，复用11规范辅助脚本；环境缺失如实显示。

私有绝对路径保存在被.gitignore/.dockerignore排除的local配置/记录中。命令未实现时可先用等价只读命令，不在README里假装脚本存在。

## 7. 验收

每份Pxx与机器索引都包含源URL、本地路径和Server根。参照源码、后端schema匹配、实际Dart解析、真机走通是不同证据。没有本机读取证据的端点不能标兼容通过。
