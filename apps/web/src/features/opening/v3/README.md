# UI v3（前端界面重构终稿）

本目录是终稿界面的生产代码：壳层、页面模板、动效系统与组合原语。它与现有页面并存，按下面的步骤逐个路由切换，不需要一次性替换。

## 目录

| 目录 | 内容 |
|---|---|
| `motion/` | 动效系统：`TransitionLink` / `useTransitionRouter`（页面过渡）、`runViewTransition`（同页重排）、`Collapse`（高度展开）、`usePresence`（退场）、`useTween`（SVG 逐帧补间）、`motion` 类名配方 |
| `ui/` | 组合原语：`Sheet`（Radix Dialog）、`ListSection` / `ListRow`、`ProgressSteps`、`SaveButton`、`Segmented`、`Field`、`StatusToastProvider`。基础按钮和输入继续使用 `@aistudy/ui` 中的 `ui.*` 与 `Button` |
| `shell/` | `features.ts` 功能注册表（唯一路由来源）、`AppShell`、`PageHeader` / `LocationLine` / `ListPage`、图标映射、布局偏好 |
| `start/` `assistant/` | T2 开始页、对话视图与对象卡 |
| `workspace/` `learning/` | T3/T4 学习工作区、辅助区、阶段操作条、补充解释、提示、卡片草稿 |
| `reader/` `canvas/` | PDF/照片阅读与选区提问；交互画布（矩阵/张成） |
| `course/` `sprint/` `forms/` | T5 课程空间、T7 冲刺、T8 表单页、T9 设置、T10 无壳层页、上传区 |

## 动效规范

- 时长只用 `--duration-micro / state / panel / scene`（120 / 220 / 320 / 600ms），曲线只用 `--ease-standard / out-expo / in / spring`。
- 只对 transform 和 opacity 做动画。例外只有四处：导航宽度、辅助区宽度、`Collapse` 的行高、阅读器缩放宽度。
- 页面切换使用 View Transitions，只有 `app-main` 参与：
  - 进入更深一层：`forward`，横向推入；
  - 返回上一层：`back`；
  - 同级切换：`swap`，淡入并上浮 8px。
  方向由注册表里各页面的 `depth` 推导。导航激活底色、手机底栏指示条、课程分区下划线、设置子导航都带有 `view-transition-name`，会在各项之间滑动。
- 共享元素：列表行和对象卡点击后，标题会过渡到目标页的 h1（`[view-transition-name:object-title]`）。开始页的输入框会过渡到对话页底部的输入框（`composer`）。
- 浏览器后退和前进不加过渡；不支持 View Transitions 的浏览器直接切换，功能不受影响。
- 以下情况不播放庆祝或强调动画：恢复状态、刷新页面、重新进入页面。答对时的勾号描边和轻触觉，只在本次会话中由「处理中」变为「答对」时出现。保存成功只在服务端确认之后才显示。
- 减少动效：系统设置或 `html[data-motion=reduce]` 生效时，所有动画降为瞬时，且不启动页面过渡（`tailwind.css` 和 `interactionMotionReduced()` 已统一处理）。

## 仓库约束（已满足）

- 只使用 Tailwind 工具类，不新增 CSS 文件，不使用 `style` 属性。动态几何改用以下方式实现：
  - SVG 属性；
  - 离散宽度档位；
  - `<progress>`；
  - 分段进度条。
- 图标使用 `lucide-react@0.468`，名称集中在 `shell/icons.ts` 中映射。
- 点击目标最小 44px，沿用 `@aistudy/ui` 的 `ui.primary / quiet / icon`。
- 检查结果：`apps/web` 中 `tsc --noEmit` 通过；`eslint apps/web/src/features/opening/v3` 通过；`vitest --project unit` 中 `shell/features.test.ts` 与 `app/tailwind.test.ts` 通过。

## 全局样式变更（apps/web/src/app/tailwind.css）

1. 新增语义角色：
   - `on-accent`、`danger-soft`、`popover`、`reader-mat`、`focus-ring`、`selection`，均有对应的深色值；
   - 布局变量 `--layout-*`；
   - 关键帧，以及对应的 `--animate-*`：fade、pop-out、sheet、slide、settle、draw、toast、vt-*。
2. 新增 `@utility`：`content-grid`、`col-wide`、`col-full`、`prose-reading`、`stagger`。
3. **全局变化**：
   - `::selection` 由墨底反白改为浅蓝底、保留原文字颜色；
   - `:focus-visible` 描边改为 `--color-focus-ring`。
   以上为终稿决定，会影响所有旧页面，属于预期变化。
4. 新增 View Transitions 规则，只作用于命名的过渡组。

## 路由迁移表

| 路由 | 现有实现 | v3 模板 | 迁移时要接入的数据 |
|---|---|---|---|
| `/opening/today` | `planning/today-dashboard` | `StartComposer` | `loadTodayResumeState` → suggestions（继续位置、到期数、考期，最多 3 条）；草稿沿用现有机制 |
| `/opening/assistant` | `assistant/assistant-entry` | `ThreadView` | 现有对话流；对象卡由回答中的引用生成 |
| `/opening/courses` | courses/page | `ListPage` + `ListRow` | 课程列表 |
| `/opening/courses/new` | `courses/course-create` | `FormPage` + `Field` | 创建课程接口 |
| `/opening/courses/[id]` | `courses/course-detail` | `CourseSpace` | 各分区数据；`?section=` 需按现有课程路由调整 |
| `/opening/courses/[id]/exam` | `exam-sprint/course-exam-view` | `FormPage` | `getCourseExamService` |
| `/opening/courses/[id]/study` | `opening/study/*` | `StudyWorkspace` + `StageActionBar` + `InlineExplain` + `HintList` + `CardDraftSheet` | 作答与批改响应映射为 `AttemptStage`；草稿与请求 id 持久化；笔记和卡片写入接口 |
| `…/study/span`、`…/study/matrix` | `teaching/span/span-lesson-session`、`courses/course-matrix-lesson` | `StudyWorkspace` + `LinearMapCanvas` | 教学序列与互动状态 |
| `/opening/review` | `review/review-hub` | `ListPage` + `ListRow` | `readReviewTab` |
| `/opening/library` | library/page | `ListPage` | 资料列表 |
| `/opening/library/new` | `editor/new-document` | `FormPage` + `UploadDropzone` | 上传与解析状态（ready / processing / failed，与 `STATUS_LABEL` 一致） |
| `/opening/library/[id]` | `editor/document-editor` | 原生文档：`StudyWorkspace`（grid）；PDF/照片：`useDocumentReader` | 页码用 replace 写入 URL；选区提问写入对话 |
| `/opening/sprint` | `exam-sprint/sprint-course-chooser` | `SprintBoard` | 当前计划、候选方案、应用接口。应用成功后用 `runViewTransition` 替换数据，并传入 `freshTaskIds` |
| `/opening/cards` | `review-route` 的 `legacyCardsHref` | `ListPage` | 卡组 |
| `/opening/search` | `search/search-workspace` | `ListPage` + `ListRow` | 搜索接口 |
| `/opening/settings/*` | settings、connections、export、measurement 等 | `SettingsLayout` + `SettingsGroup` / `SettingsRow` | 各设置服务。新增子页只需在 `features.ts` 中加一行 |
| `/login` `/register` `/onboarding` | auth、onboarding | `AuthLayout` | 认证与初始设置 |

## 切换步骤

1. 将 `(opening)/opening/layout.tsx` 中的 `OpeningShell` 换成 `AppShell`，并在其外层包一层 `StatusToastProvider`；`counts` 传复习到期数，`recent` 传最近对话。
2. 把站内 `Link` 逐步替换为 `TransitionLink`（API 相同，另有 `direction` 和 `vtSource`）。
3. 按迁移表逐个路由替换页面外壳，保留各 feature 的数据加载、校验与错误处理逻辑。
4. 迁移完成后删除 `OpeningShell`、`shell-nav-link`、旧的 `navigation.ts`，以及与其对应的旧测试。

## 回滚

本次改动只新增 `features/opening/v3/`，并在 `tailwind.css` 中追加内容。回滚步骤：

- 删除 `features/opening/v3/` 目录；
- 还原 `tailwind.css` 中的两行全局规则（`::selection`、`:focus-visible`），并删除追加的内容块。

不涉及数据库或接口改动。
