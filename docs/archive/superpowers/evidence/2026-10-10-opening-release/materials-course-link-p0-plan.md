# Plan：材料入口 + 课程关联可用（P0）

**Date:** 2026-10-10 ~22:16 CST  
**Owner:** Experience  
**Status:** PLAN_ONLY — 待 Integrator AGREE → IMPLEMENT（PM 已授权 Plan→过审后 IMPLEMENT）  
**依据：** `materials-course-link-understand.md`  
**约束：** 复用现有 `POST/DELETE /api/courses/:id/memberships`；不自推；解析卡住另线  

## 目标

Paula 能方便找到材料库，并在课程页/材料行把资料挂到课程。

## 非目标

- 改 membership API / 角色模型（Data）  
- 解析失败根因（Pipeline 另线）  
- 恢复 explore/marketplace 等 R2 已删旁路  

## P0-1 侧栏/更多恢复「材料」

| 项 | 做法 |
|---|---|
| `navigation.ts` | `more` 组增加 `{ href: "/opening/library?tab=materials", label: "材料", icon: "library", group: "more" }`（或 `/opening/library` 默认 materials） |
| `opening-shell.tsx` | 已有 `library: Library` 图标映射，确认高亮：`navigationIsActive` 对 `/opening/library` 生效（现有 library 特例可复用/收紧为 opening/library） |
| 命令面板 | 加一条「材料」→ `/opening/library?tab=materials`（闭环内可发现） |
| EntryLinks / Today（可选同批） | Today 快捷增加「材料」链，避免只靠侧栏 |

**R2 兼容：** 材料属闭环支撑（连接材料），放 **more** 不进 core，避免再次堆满。

## P0-2 课程页「添加材料」

**文件：** `course-detail.tsx`（+ 小组件如 `course-add-materials.tsx` 若需要）

行为：

1. 「课程材料」标题旁增加 **「添加材料」**（主按钮或 secondary）。  
2. 打开轻量面板/抽屉：列出**尚未挂入本课**的 sources（`listSources` + 现有 assets 差集；仅 `uploadState===uploaded` 优先，pending 可标灰或仍可选）。  
3. 多选 → 用途（默认 `reference`）→ 确认 → 复用 `material-organization-client.addToCourse(courseId, ids, role)`（即现有 memberships POST）。  
4. 成功后刷新 assets 列表；部分失败展示与材料库批量一致的 succeeded/failed。  
5. 空态文案改为：「还没有挂接材料。点「添加材料」从知识库挂入，或去材料库整理。」并保留链到材料库。  

不新开 API。

## P0-3 材料行「归入课程」快捷（同批）

**文件：** `source-row.tsx` / `inbox-panel` 或 `material-library` 行旁

- 每行增加「归入课程」：弹出课程选择 + 用途 → 单 id `addToCourse`。  
- 保留现有批量条（多选仍可用）。  
- 已属当前 space 课程时，文案可为「调整用途/另归入…」或仅「归入其他课程」——最小实现：始终打开选择器。

## 测试 / 门禁

- navigation / palette 含材料入口  
- course-detail：添加面板调用 memberships（mock）  
- source-row / library：单行归入  
- `apps/web` tsc + 相关 vitest  

证据：`materials-course-link-p0-implement.md` → Integrator Accept。

## Review

请 Integrator AGREE/改点；过了 Experience 立刻 IMPLEMENT。
