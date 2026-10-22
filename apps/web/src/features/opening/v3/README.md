# UI v3（前端界面重构终稿）

本目录是终稿界面的视图层代码：壳层、页面模板、动效系统与组合原语。它与现有页面并存，按下面的步骤逐个路由切换，不需要一次性替换。

## 状态（三者互不替代）

| 项 | 状态 |
|---|---|
| 视图已实现 | 是：本目录全部组件，类型检查 / lint / 单元测试通过 |
| 真实服务已接入 | **否**：批改、帮助记录、复习安排、材料处理、保存都需在页面适配层接入既有服务；原型中的判分、回答、上传均为模拟 |
| 验证范围 | 独立原型的浏览器自检（Chromium，桌面/手机/320px，明暗、减少动效、axe）；**未**测真实 PDF、扫描件、真实模型与跨设备恢复；仓库内浏览器验收按 AGENTS.md 由用户负责 |

接入分层：既有业务服务 → 页面适配层（尝试身份、提交快照、上下文、恢复、业务状态转 UI 状态）→ v3 展示组件。前端不根据提示次数推断独立掌握，不决定复测日期，不把模型不确定改写成学生答错。

## 目录

| 目录 | 内容 |
|---|---|
| `motion/` | 动效系统：`TransitionLink` / `useTransitionRouter`（页面过渡）、`runViewTransition`（同页重排）、`Collapse`（高度展开）、`usePresence`（退场）、`useTween`（SVG 逐帧补间）、`motion` 类名配方 |
| `ui/` | 组合原语：`Sheet`（Radix Dialog）、`ListSection` / `ListRow`、`ProgressSteps`、`SaveButton`、`Segmented`、`Field`、`StatusToastProvider`。基础按钮和输入继续使用 `@aistudy/ui` 中的 `ui.*` 与 `Button` |
| `shell/` | `features.ts` 功能注册表（唯一路由来源）、`AppShell`、`PageHeader` / `LocationLine` / `ListPage`、图标映射、布局偏好 |
| `start/` `assistant/` | T2 开始页（首选行动 + 两条次要）、对话视图（只在接近底部时跟随、「新回答」提示、停止/重试、可移除上下文、回答渲染插槽）与对象卡 |
| `workspace/` `learning/` | T3/T4 学习工作区（窄屏辅助区顶部保留上下文摘要）、阶段操作条（五类结果 + 改评不默认判对 + 草稿/提交/批改分开表达）、尝试历史、帮助记录、拍照作答（缩略图/删除/排序）、识别核对、补充解释、提示、卡片草稿、T11 本次小结 |
| `review/` | T12 复习会话（回忆 → 揭示 → 自评 → 下一项 → 结束；评分写入既有复习服务） |
| `reader/` `canvas/` | PDF/照片阅读与选区提问（引用保留完整选段与页码）；交互画布（按秩区分点/线/面）与 `PredictPrompt`（先预测 → 操作 → 解释 → 验证） |
| `course/` `sprint/` `forms/` | T5 课程空间、T7 冲刺、T8 表单页、T9 设置、T10 无壳层页、上传区 |

## 外观层（参考 Gemini、Hark、bencho.dev；换样式只改这里）

AppShell 根节点：`data-ui="v3" data-skin data-density data-corner`，由 `tailwind.css` 的「UI v3：外观层」解释；只在 v3 根节点内生效，旧页面不变。

| 维度 | 取值 | 作用 |
|---|---|---|
| `data-skin` | `glass`（默认）/ `paper` | 玻璃：顶栏滚动后半透明、工具胶囊、操作条、辅助区、右侧面板、弹层、手机底栏为玻璃；纸面：同位置换实色。系统「降低透明度」时自动实色 |
| `data-density` | `compact`（默认，约小 15%，最小 12px）/ `comfortable` | 字号角色 `text-micro/cap/meta/ui/ui-lg/read/read-lg/title/display/hero`、控件高度 `--control-h`(36/44)、顶栏 `--topbar-h`(52/56)；触屏始终 44px |
| `data-corner` | `round`（默认）/ `crisp` | `rounded-ctl/tile/panel/sheet`：12/16/22/28 ↔ 8/10/14/18 |

- 控件样式统一在 `ui/controls.ts`（`ui.primary/secondary/quiet/icon/iconSm/chip/toolbar/toolbarButton/segment` 等），全部读外观层变量；新增皮肤只需加一个 `[data-skin="…"]` 变量块。
- 边框：v3 内线色透明度降低约 30%（`--color-line` .075、`--color-line-strong` .13）。
- 玻璃：`glass`（浮层）与 `glass-bar`（顶栏，滚动后出现）两个 utility；不支持 `backdrop-filter` 时退化为较实底色。
- 顶栏 `TopBar`：粘在滚动区（`data-scroll-root`）顶部；列表页大标题在内容里，滚出后顶栏淡入小标题；右侧工具放 `TopBarTools` 玻璃胶囊；进度贴底。
- 右侧打开 `SidePanel` + 对话页 `ConversationLayout`：回答里的题目/资料默认在右侧打开（400/560px 可切换并记住），面板内可进完整页面；窄屏为底部抽屉；Esc 关闭。

## 动效规范（参考 transitions.dev 的用途刻度）

| 用途 | 时长 | 曲线 | 位移 / 模糊 |
|---|---|---|---|
| 页面前进/后退 | 进 250ms、出 150ms | out-expo / in | 8px + 3px 模糊 |
| 同级切换 | 进 250ms、出 150ms | 同上 | 仅淡入 + 2px 模糊 |
| 弹层（桌面） | 开 320ms pop、关 150ms | spring / in | scale .96 |
| 底部抽屉、辅助区 | 开 320ms、关 150ms | out-expo | 宽度或 100% 位移 |
| 展开收起（Collapse） | 开 320ms、关 150ms | out-expo | grid-rows |
| 原地换字（状态/计数） | 250ms | out-expo | 4px + 2px 模糊 |
| 成功勾号 | 500ms + 80ms 描边延迟 | bounce | 旋转 + 6px 模糊 |
| 错误抖动 | 400ms | 专用曲线 | 8→6→4→2px |
| 指示条滑动（标签、分段、导航） | 250ms | out-expo | View Transition 命名元素 |
| AI 进行中 | 循环 | linear | 文字流光，不显示假进度 |

组件：`TextSwap`、`ThinkingLine`、`SuccessCheck`、`DisclosureChevron`、`useReplay`（重播抖动）、`runIndicatorTransition`（滑动指示条，无需测量、无内联样式）。

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
| `/opening/assistant` | `assistant/assistant-entry` | `ThreadView` | 现有对话流；`renderAnswer` 传入仓库 `LearningProse` + `StreamText`（原型已如此接入）；`thinking` 用服务端阶段；对象卡由回答中的引用生成 |
| `/opening/courses` | courses/page | `ListPage` + `ListRow` | 课程列表 |
| `/opening/courses/new` | `courses/course-create` | `FormPage` + `Field` | 创建课程接口 |
| `/opening/courses/[id]` | `courses/course-detail` | `CourseSpace` | 各分区数据；`?section=` 需按现有课程路由调整 |
| `/opening/courses/[id]/exam` | `exam-sprint/course-exam-view` | `FormPage` | `getCourseExamService` |
| `/opening/courses/[id]/study` | `opening/study/*` | `StudyWorkspace` + `StageActionBar` + `AttemptHistory` + `AssistanceNote` + `PhotoAttachments` + `RecognitionCheck` + `InlineExplain` + `HintList` + `CardDraftSheet` | 批改响应映射为 `AttemptStage`/`Verdict`（含评价来源）；每次提交一个尝试 id 与答案快照；所有帮助入口写帮助事件；改评走复核接口；草稿本机/同步状态 |
| `…/study/span`、`…/study/matrix` | `teaching/span/span-lesson-session`、`courses/course-matrix-lesson` | `StudyWorkspace` + `LinearMapCanvas` | 教学序列与互动状态 |
| `/opening/courses/[id]/study/summary`（新增） | — | `SessionSummary` | 学习会话汇总（独立/提示后/要再练/尚需验证）与复习服务给出的下一步 |
| `/opening/review/session`（新增） | `cards/card-review-view` 的评分接口 | `ReviewSession` | 复习队列（卡片、原题重做、未见变式）与评分写入 |
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

## v3.3 生产切换（2026-10-22）

- `(opening)/opening/layout.tsx` 改用 `shell/opening-shell-v3.tsx`：v3 AppShell + StatusToastProvider，保留复习计数、账户菜单（专注/退出）、⌘K 命令面板、⌘J 学习助手抽屉（右侧浮动玻璃面板）、引用阅读器、连接/能力提示。专注改为用户主动进入，学习页不再自动隐藏导航。旧 `opening-shell.tsx` 暂留作回滚：layout 改回 `OpeningShell` 即可。
- 页头：`PageHeader` 标题直接放进顶栏左上（text-title，贴近顶部与左缘），不再单独占大标题区；旧 `design/ui.tsx` 的 `PageHeading` 委托给它（≤36 字的说明在标题旁一行显示，更长的在顶栏下方一行小字），所有用 PageHeading 的旧页面同时生效。今日、课程学习台、对话、考前练习、AI 记忆页的手写页头已改。
- 旧组件迁移层：`[data-ui="v3"]` 内覆盖 Tailwind `--text-sm…3xl`、`--radius-sm…2xl/card`（约 -15%，最小 12px；圆角放大）；`@aistudy/ui` 控件高度读 `--control-h`（缺省 44px），按钮胶囊化；外观属性同时写到 `<html>`，body 下的 Radix 弹层/抽屉也读得到外观层变量。`glass` 在外观层之外回退为实色表面。
- 主区 `<main>` 成为滚动根（`data-scroll-root`），旧页面的粘顶页头与 v3 页面自带滚动区都可用。
- 设置 → 外观与阅读：新增材质 / 密度 / 圆角（水合后显示）。
