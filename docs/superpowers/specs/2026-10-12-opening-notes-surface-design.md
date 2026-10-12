# Opening 笔记一等入口设计

日期：2026-10-12 · 状态：已批准，待写实现计划

## 背景

笔记是产品 hub，但 Opening 壳中没有笔记导航项，也没有 Opening 内的笔记编辑路由。新建、打开、反链、关系和助理“保存片段 → 打开笔记”都硬编码 `/library/*`，会离开 Opening 壳进入 `(workspace)` 布局。编辑器（`DocumentEditor`、`NewDocument`）的可达模块不引用 mock provider，可直接挂到 `(opening)` 下而不违反 `tests/contract/opening-no-mock.test.ts`。

## 目标

- 从 Opening 内新建、打开、跳转笔记全程停留在 Opening 壳。
- 笔记进入核心导航。
- 旧 `/library/*` 页面行为不变。

非目标：Today 入口改版、教学活动内记笔记（V2-20）、旧 `/library` 重定向或删除。

## 方案

沿用 `LibraryView` 已有的 `basePath: "/library" | "/opening/library"` 模式，以 prop 逐层传递笔记基础路径。未采用 React context（隐式、仓库无先例）和中间件重定向（会破坏旧工作区页面）。

### 路由

- 新增 `apps/web/src/app/(opening)/opening/library/new/page.tsx` → `<NewDocument basePath="/opening/library" />`。
- 新增 `apps/web/src/app/(opening)/opening/library/[id]/page.tsx` → `<DocumentEditor documentId={id} basePath="/opening/library" />`。
- 两者由 `(opening)/opening/layout.tsx` 提供 `AuthGate` 与 `OpeningShell`。

### 链接传递

共享类型 `LibraryBasePath = "/library" | "/opening/library"`，各组件 `basePath` 默认 `"/library"`：

| 组件 | 改动 |
| --- | --- |
| `features/editor/document-editor.tsx` | 返回链接用 `basePath`；向两个面板下传 |
| `features/editor/new-document.tsx` | 创建后 `router.replace(\`${basePath}/${id}\`)` |
| `features/editor/backlinks-panel.tsx` | 来源文档链接用 `basePath` |
| `features/editor/relation-authoring-panel.tsx` | 关系目标链接用 `basePath` |
| `features/workspace/library-document-list.tsx` | 列表项与空状态“创建第一篇笔记”用 `basePath` |
| `features/opening/library/library-view.tsx` | 向列表下传 `basePath`；“新建笔记”指向 `${basePath}/new` |
| `features/opening/assistant/save-snippet-dialog.tsx` | “打开笔记”指向 `/opening/library/{id}` |

### 导航

`features/opening/shell/navigation.ts`：将 more 组的“材料”（`/opening/library?tab=materials`）替换为 core 组的“笔记”（`/opening/library`，图标 `library`）。`LibraryView` 默认笔记标签，材料仍在同页标签内。只保留一项，因为 `navigationIsActive` 忽略查询串，两项同路径会同时高亮。

## 错误处理与数据

无新信任边界、API、迁移或权限变化。编辑器沿用现有加载、错误、版本冲突与校验逻辑；`documentId` 仍由现有 API 校验。

## 测试

- `navigation.test.ts`：核心组包含笔记项，且 `/opening/library/{id}` 时该项高亮。
- `tests/contract/opening-no-mock.test.ts`：可达文件包含 `features/editor/document-editor.tsx` 与 `new-document.tsx`，仍不含 mock provider。
- 链接构造至少一处单元覆盖（如列表项或新建后跳转使用 `basePath`）。
- `tsc -p apps/web/tsconfig.json --noEmit`。
- 待用户浏览器验收：在 `/opening/library` 新建笔记 → 打开 → 点反链/关系 → 返回；助理保存片段 → 打开笔记；均保持在 Opening 壳；旧 `/library/*` 不受影响。

## 回滚

纯前端改动，回退该提交即可。
