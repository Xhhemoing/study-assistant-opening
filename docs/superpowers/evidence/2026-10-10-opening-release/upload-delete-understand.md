# Understand：错误上传能否删除（只读，未改代码）

**Date:** 2026-10-10 ~12:23 CST  
**Owner:** Experience  
**Status:** LIST_ONLY — 未 IMPLEMENT；未碰 R2 脏树业务逻辑以外的提交  
**Paula 原话：**「错误上传不能删除」等小问题  
**HEAD:** `697d1d6`（工作区另有 R2/AI 未推改动）

## 结论（一句话）

- **已落库的失败材料**（解析失败 / 上传拒绝）：后端与「管理材料」删除能力**已有**，但入口偏深，闭环侧栏/命令面板几乎找不到材料库。  
- **上传队列里的失败项**（客户端队列、未完成或失败）：**只有「重试」，没有清除/丢弃**；队列也无 `remove` API。

## 表面清单

| 表面 | 失败态可见？ | 删除入口 | 调用 API | 缺口 |
|---|---|---|---|---|
| 助理 `UploadStrip` | 是（队列 failed） | **无**；仅「重试」 | 无（本地队列） | 缺「清除/丢弃」按钮；`upload-queue` 无 remove |
| Inbox 上传队列（材料库内） | 是 | **无**；仅「重试」 | 无 | 同上 |
| 材料库 `InboxPanel` / `SourceRow`（`/opening/library?tab=materials`） | 是（attention=parse failed / rejected） | **有**：「管理材料」→「删除材料」→「确认删除材料」 | `GET /api/opening/sources/:id/impact`；`POST /api/opening/sources/:id/actions` body `{ action: "delete", expectedVersion, expectedMembershipIds }` | 发现性差（见下） |
| 助理页材料区 | 列表选页，链到材料库 | 无内联删除；有「管理 / 上传材料」链到 library | — | 依赖用户点进材料库再点管理 |
| 课程 media-reader | 解析失败文案「原件已保存」 | **无**删除 | — | 缺管理入口 |
| 材料库批量「移除」 | 整理失败提示 | 「确认移除引用」= 从课程摘引用，**不是删材料** | material-organization remove | 易与「删除」混淆，但不能清错误上传本身 |

## 已有删除链路（可复用）

- UI：`source-actions-panel.tsx`（`SourceActionsPanel`）  
- Client：`source-actions-client.ts` → `/api/opening/sources/:id/impact` + `.../actions`  
- 服务：`source-service` delete/exclude（后端保留）  
- 清理回执：`/api/opening/sources/deletions` + `SourceCleanupPanel`

## 发现性（与 R2 相关，只读观察）

- 侧栏 / 命令面板 **无**「材料库 / library」入口（R2 已删 legacy palette）。  
- 助理底栏仍有链：`/opening/library?tab=materials#upload`。  
- 用户若只在 Today/助理上传，失败队列无清除；若不知道进材料库点「管理材料」，会感觉「错误上传不能删除」。

## 建议 IMPLEMENT（待 PM 授权，本轮不做）

1. **P0** 上传队列 failed：加「清除」并实现 `upload-queue.remove/dismiss`（纯前端）。  
2. **P0** 失败态 `SourceRow` 旁增加显式「删除」快捷（仍走现有 actions API），或失败时默认展开管理。  
3. **P1** 助理/课程失败态旁链到管理或内嵌 `SourceActionsPanel`。  
4. **P1** 闭环内恢复「材料」入口（侧栏 more 或 Today 快捷），避免只能靠助理小链。  

不删后端；不与 R2 push 抢 commit，除非 PM 授权同批。
