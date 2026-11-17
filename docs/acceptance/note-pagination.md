# 笔记列表分页与摘要（2026-11-17，待发布）

## 最终行为

用户确认每页固定20条、列表返回标题等元信息与短摘要。`GET /api/v1/workspaces/:workspaceId/notes`保留`items/nextCursor`包装，仅接受可选`cursor`；有后续记录才返回非空游标，最后一页返回null。

列表项为`noteId/workspaceId/folderId/title/state/noteRevisionId/etag/contentCursor/sourceKind/sourceRef/createdAt/updatedAt/preview`。`preview`从最新raw正文的前2048个数据库字符提取Markdown文本，压缩空白后最多200个Unicode码点；只含图片、HTML块或没有可读正文时可以为空，不调用摘要模型。列表不返回`parts/resourceRefs`，不签发图片链接。独立笔记详情和part详情继续提供完整正文，图片展示沿用当前详情实现。

排序为`updated_at DESC, note_id ASC`，查询21条、返回前20条。游标记录工作区、PostgreSQL原始微秒时间与noteId，不经过JavaScript毫秒日期截断；校验格式、长度、真实日历日期和工作区。会话/工作区授权仍独立执行，游标不是权限凭据。删除上一页末条笔记不影响续页。

这是实时列表，不跨HTTP请求保存数据库快照。翻页期间笔记被编辑、更新时间前移时，需要刷新首屏看到该变更；新增笔记同样从刷新后的首屏读取。不承诺并发改动下的静态全集快照。

## 查询与资源

原路径取50个ID后，每条再读Note、各part全文、资源引用和工作区cursor；此前真实PG记录为205次SQL（含事务）。当前一个列表SQL批量读取元信息、工作区cursor及最新raw的有界前缀，复用`notes_scope`与`note_parts_latest`索引。服务路径为BEGIN、会话校验、工作区校验、列表SELECT、COMMIT，共5条SQL，不随页长增长；专项验证1条与20条查询次数相同且不超过8条。

最多21条原文前缀传回进程，只为返回的20条生成预览；不加载outline/germination全文。`left(content_markdown,2048)`限制传回应用的数据量，不能据此保证PostgreSQL内部不会解压TOAST全文。本轮没有数据库内存、线上并发或深页吞吐压测，不把图谱既有100k测试当作笔记分页性能结果。

## 验证

- 独立临时PostgreSQL/Redis：新增分页9项、资产回归20项、图片回归13项，共42项通过。
- 同次运行的HTTP/OpenAPI契约11项通过，不计入真实依赖用例数量。
- 覆盖45条的20/20/5分页、空页与恰好20条、同时间戳、微秒边界、锚点删除、非法/跨工作区游标、用户隔离、查询次数、HTTP摘要及详情完整正文。
- 全仓类型检查、Lint、构建与diff检查通过；构建保留既有Admin bundle体积提示。首次类型检查发现新文件的MarkdownIt类型引用写法不正确，已修正后通过。
- 证据：`.local/note-pagination/integration.log`、`typecheck.log`、`lint.log`、`build.log`；首次类型失败保留于`/tmp/huahuo-note-page-typecheck.log`。运行器沿用现有隔离资源所有权校验与清理，仅改变执行的测试文件清单。
- 隔离运行器同时验证累计迁移3→5、重复执行为空；0004/0005属于此前候选，本项没有新增或修改SQL迁移。

## 契约、发布与App参照

删除列表全文属于API契约变化；已将现有候选`compatibility.api`设为false，保留其余窗口的累计清单。当前客户端未接线不等于所有外部调用方兼容，不能直接标为无损自动升级。部署前须确认调用方使用列表preview与独立详情接口；本项无需改表、回填、环境变量或服务器手动配置，也未引入旧全文兼容分支。

只读核对App HEAD `bf23c1b14d847de5561c1ba66bd4192dc308b356`，工作树干净。`home_page.dart:62`经`InspirationStore.load()`读取本地SQLite，当前Dart没有Server `/notes`、`listNotes`、`nextCursor`接线；卡片消费本地正文不能证明远程列表必须返回全文。旧契约文档中早期App提交的domain_clients/contract_models仅作历史记录，不作为当前依赖依据。

参照SHA256：`home_page.dart`为`3545a1717dd307358a6b512a7218acd7a029ab2d2568e2983a206318a845361c`；`inspiration_store.dart`为`f30eafb32c6ea6ac6c2472688cd67274fe1f88ce2d51b77e89c10875d2ed5065`。未修改或运行App，未调用真实云/模型/OSS，未写共享库、重启现有服务、提交或部署。
