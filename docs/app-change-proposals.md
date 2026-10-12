# P02 App 数据层提案（未修改 App）

| 项目 | 真实现状 | 后端本阶段 | 最小后续适配 | 授权/验证 |
|---|---|---|---|---|
| 云问卷草稿 | OnboardingProgressRepository 将 mode/stepIndex/answers/deferredAt 保存在本机 preferences | 新增 GET/PATCH `/api/v1/workspaces/:workspaceId/onboarding-draft`，版本冲突和可稍后状态 | 保留本地离线草稿，账号/工作区绑定后按版本同步；不改 UI | PROPOSED，未授权 App 写入；后端 HTTP 已测 |
| 服务端退出 | 已有本地 session/token store；P02 未发现上列 AuthClient 有服务器 logout 方法 | 新增 `/auth/logout`、`/auth/logout-all`，明确当前设备/全部会话范围 | 在现有退出数据层调用服务端撤销并清本地缓存 | PROPOSED，未修改 App |
| 定位报告 | 现有引导会调用 agent 流程并恢复正式 workspace profile | P02 只保存填写内容，basicPositioningCompleted=false、空 conclusions | P09/P15 接真实生成/结果持久化，不能将 P02 标为完整引导跑通 | 未执行真实 AI/Flutter 流程 |
| 头像 | App 上传后提交 avatarResourceId | P02 非空资源引用返回 AVATAR_RESOURCE_NOT_VERIFIED | P05 建资源身份/归属后接入验证 | 明确阶段依赖，不接受任意资源 ID |

账号恢复、昵称、timezone、工作区 lifecycle、creative-positioning 保留现有字段，无需为 P02 修改 UI。以上提案均未实施到 App。

## P06 标签化补充修订：客户端接线缺口（本轮未修改）

- 当前 `KnowledgeLibraryController.updateEffectiveTags` 更新本地 repository；后续数据层需调用篇内标签 API，并用 tagEtag 处理冲突/应用建议，不能改成全局重命名。
- `MiroFishGraphMapper.fromContentNavigation` 只从 `items.path` 导出父子边，没有消费 API 的共同标签 `nodes/edges/evidence`。后端保留兼容 items；未来经授权的数据层接线应直接映射同一个标签投影，保留点击素材、主题局部查询和分页，不引入第二套图谱或 UI 重写。
- P15 对照当时 App 再核对上述契约。本轮后端完成不代表手机已能显示这些新增云端关联，未执行 Flutter 联调。
