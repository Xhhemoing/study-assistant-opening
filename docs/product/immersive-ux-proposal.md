# AIstudy 沉浸式学习：前端精简方案（2026-10-25）

依据：线上实测 `work/browser-findings.md`（测试账号 QA测试，https://23.251.32.22:18443）、`work/study-ux-code-walkthrough.md`、`work/contract-audit-report.md`；代码只读：`/workspace/work/sao` 分支 `hark/contract-audit`；产品约束：`docs/product/UX_AND_AI_POLICY.md`（§1 三层信息、§2 首屏只允许“一个主要操作”）、`docs/product/PRD.md`（成功标准：注册后 15 分钟内开始首个有效任务）。

五条原则：① 1 次点击进入下一步学习动作；② 每屏一个主操作；③ 系统状态不阻塞就不出现；④ 工具按需出现（选中/悬停/快捷键），不常驻；⑤ 设置离开学习面。

---

## 1. 现状摩擦（开始学习前可见控件数）

“控件”= 可点击/可输入元素；左侧导航常驻约 12 个（收起导航、⌘K 搜索、8 个导航项、更多、拖拽柄），下表单独列出。

| 页面 | 导航外控件 | +导航 | 主要摩擦（实测 / 代码） |
|---|---|---|---|
| 首启 `/onboarding` | ~9（展开“跳过设置”再 +5） | — | 3 必填 + 4 种替代入口；提示语“AI 不可用时仍保留…”提前暴露系统状态 |
| 开始 `/opening/today` | ~6：继续 / 自由对话 / 回到关联课程 / 问 AI / 复习·0 项 / 学习安排 | ~18 | 3 张并列行动卡，主操作不唯一；“问 AI”抽屉另有 ~10 个控件 |
| 课程详情 `/opening/courses/[id]` | ~14：6 子标签 + 继续/全部课程 + 4 按钮 + 管理材料/添加材料 + 全部单元 | ~26 | 进入单元前要先选“学习/练习/复习/资料/笔记/进展” |
| **课程学习** `…/study?task=` | ~19 | **~31** | 见下 |
| 助理 `/opening/agent` | ~20 | ~32 | 默认打开最近一次**失败**对话；右侧“待你确认”表单 + “AI 记忆/模型建议不是事实”常驻 |
| 资料 `/opening/library`（空） | ~16 | ~28 | 空库仍显示 刷新状态/筛选与排序/批量管理/分页 |
| 复习 `/opening/review` | ~8 | ~20 | 6 个子标签；尚可 |
| 冲刺 `?mode=sprint` | 30+（含 14 个“尚未关联”下拉） | 40+ | 写死题包对所有课程显示（`packages/domain/src/opening/exam-sprint/source-catalog.ts`） |
| 设置 `/opening/settings` | 40+ | — | 外观与“AI 快速配置（供应商/模型/接口/密钥）”同屏 |

课程学习页拆解（`courses/course-study-workspace.tsx` + `teaching/teaching-workspace.tsx`）：
- 顶栏 8：返回课程、自学/串讲/挑战、`SplitControls` 3 预设（只看内容/内容+对话/三栏）+ 3 栏开关（对话/笔记/资料）。
- 单元栏 3：状态词（“需要核查/正在准备”，看似可点但无交互）、专注、“已恢复学习位置·知道了”。
- 两条横幅：恢复提示 + “主讲内容需要核查：内容已发布，来源校验尚未完成，可先学习。”
- `StudyToolsPanel` 子标签 对话/目录/笔记 3 个，与顶栏 对话/笔记/资料 **重复**；“目录”里又嵌 资料与引用、学习设置（内含 `PreferenceControls scope="session"`：安静模式、主动程度、深度上限、介入节点、证据不足开关、保存/清除，以及“本课临时>课程>全局”生效层说明）。
- 正文后：补充解释、保存这段讲解、进入练习、本次学习与小结、其他学习方式/讲解准备好之前…（3 个备选）。
- `block-commands.tsx` 8 个块命令（这里没看懂/为什么/换种说法/展开/举例/跳过/分支/返回），外加“分支栈为空”“服务端版本”等技术文案。

**首题路径（实测）**：首启提交 → 停在“正在准备讲解” → 继续学习/重新读取无效 → 返回课程 → 全部单元 → 首次学习 → 进入练习 = **提交后 ≥5 次点击 + 无上限等待**。另：文案扫描 `scripts/check-learner-copy.mjs` 当前 80 条系统术语。

---

## 2. 目标信息架构

**主导航 3 项 + 头像菜单**（`shell/navigation.ts`）：

| 导航 | 路由 | 吸收 |
|---|---|---|
| 学习 | `/opening/today` | 开始 + 课程列表（“全部课程”为页内次级链接）+ 问 AI 输入框 |
| 复习 | `/opening/review` | 卡组、待复测、补强、易错点 |
| 资料 | `/opening/library` | 材料 + 笔记 |
| 头像菜单 | — | 对话记录（`/opening/agent`）、学习安排、设置、外观（主题）、导出、退出 |

工具入口：搜索/跳转 → **⌘K 命令面板**（已有 `search/command-palette`）；助理 → **⌘J 抽屉** + 学习页输入框；冲刺 → 课程内模式（课程设有考试日期时，课程“…”菜单出现“考前冲刺”）。

**删除 / 合并 / 重定向**（重定向统一放 `next.config` `redirects()`，permanent 308，保留查询参数；删除对应 page.tsx 与仅被其引用的 feature 代码）：

| 现路由 | 处理 | 目标 |
|---|---|---|
| `/opening/cards` | 去掉导航项，保留重定向 | `/opening/review?tab=cards` |
| `/opening/sprint` | 去掉导航项 | `/opening/courses/[id]?mode=sprint`（无课程 → `/opening/today`） |
| `/opening/suggestions` | 合并 | `/opening/settings/planning#suggestions`（today-dashboard planning 模式已内嵌“待确认建议”） |
| `/opening/search` | 去掉导航项；保留为⌘K“查看全部结果”页 | — |
| `/opening/assistant`（无参数时的历史列表） | 合并 | `/opening/agent`（带 conversation/courseId 等参数的入口保持） |
| `(workspace)/library`、`/library/[id]`、`/library/new`、`/search`、`/settings`、`/settings/advanced`、`/settings/export` | 删 page.tsx（现已是 redirect 页） | 同名 `/opening/*` |
| `(workspace)/learn`、`/learn/review`、`/learn/goals`、`/learn/goals/[id]`、`/learn/goals/new`、`/learn/practice/[itemId]`、`/learn/practice/[itemId]/result`、`/learn/exams`、`/learn/marketplace` | 删（生产已被 middleware 拦/notFound，开发仍渲染 mock） | `/opening/today`；`/learn/review` → `/opening/review` |
| `(workspace)/learn/courses`、`/learn/courses/[id]`、`/learn/courses/new` | 删（需产品确认：`access-middleware.test.ts` 断言其可达） | `/opening/courses…`；同时改 `search-results-model.ts:43`、`course-model.ts:34`、`course-detail.tsx:209` |
| `(workspace)/explore`、`/explore/[id]`、`/explore/[id]/promotions` | 删 | `/opening/today` |
| `preview/notebook`、`preview/notion-import` | 删 | `/opening/today` |
| `ui-preview`、`ui-preview/opening` | 删（**注意：middleware 只拦 `/preview`，`/ui-preview` 生产可达**） | `/opening/today` |

保留：`/opening/courses/[id]/study{,/span,/matrix}`、`/exam`、`/opening/practice`（拍题）、`/opening/settings/*`。

---

## 3. 课程学习页规格（默认“专注”）

**默认可见（目标 ≤6 个控件）**：
1. 顶部 2px 进度条（现有 `role=progressbar`，去掉“单元 1/7”文字，悬停才显示）。
2. 左上 返回（图标）；右上 “…”（1 个）。
3. 正文 + 当前题的作答框（`inline-attempt` / `attempt-form`）。
4. **唯一主操作**（右下）：按状态切换文案“继续 / 进入练习 / 提交 / 下一题 / 下一单元 / 完成”，`Enter` 触发。
5. “提示多 ↔ 少” 一个滑块（3 档，映射到 `PreferenceControls` 的 主动程度+深度上限，写本课临时层）——仅在作答区旁以小图标出现，点开才见滑块。

**移进按需层**：
- 8 个块命令 → **选中文字弹出菜单 3 项**：没看懂（=这里没看懂/为什么/换种说法，由 AI 判断）、举个例子、问 AI（发到侧抽屉）。“展开/跳过/分支/返回”进“…”菜单下“本段…”；`SelectionAsk` 已有选区弹层（问 AI/做卡片），在其上扩展；键盘 `?` 对当前块打开同一菜单。
- 对话/目录/笔记 双套标签 + 顶栏 3 预设 3 开关 → **一个右侧抽屉**，抽屉内 3 个标签（对话 / 目录 / 笔记）；资料与引用并入“目录”底部。快捷键 ⌘J 对话、⌘\ 目录。宽屏可“固定”抽屉（记住偏好），默认不固定。
- “自学/串讲/挑战”、保存这段讲解、本次学习与小结、其他学习方式、结束本次学习、回看上一单元 → “…”菜单。
- 介入偏好三层矩阵（`preference-controls.tsx` 全量）→ 设置 › 学习偏好；学习页不再渲染 `scope="session"` 全表。
- 诊断/技术信息/版本/活动标识 → 仅设置 › 高级 › 诊断模式开启时出现。

**横幅策略**：
- 只在**阻塞**时出横幅（无法作答、内容不可读、保存失败需操作）；一次最多 1 条，文案为学生语言 + 1 个动作。
- `needs_check` 不出横幅、不出状态词；在引用处加小号“来源核对中”角标（Layer 2）。
- “已恢复学习位置”改为 2 秒 toast，自动消失。
- 生成中（queued/generating）：显示骨架 + “大约还需 N 秒”，**同时把主操作换成“先做一道练习题”**（不让学生干等）；配合已加的指数退避轮询 + 90 秒超时 → “重新准备”。
- 批改中：“批改中…”行内状态；去掉“帮助情况未知”“尚未评分”“离开页面不会取消”。

---

## 4. 学习（原“开始”）页规格

- 一张主卡：**“继续 {单元/课程名}（约 N 分钟）”**，整卡可点，直达 `…/study?activity=` 的当前块（若是题，直接聚焦作答框）。N 取剩余单元估时，缺失则不显示。
- 一个芯片：**“复习 {n}”**（n=0 时隐藏），点击进入 `/opening/review` 连续复习。
- 一个问答框：“问点什么…”，提交即开 ⌘J 抽屉中的**新对话**。
- 次级文字链（一行，弱化）：全部课程 · 新课程。
- 删除：自由对话/回到关联课程两张卡、今天的进度区块（移至复习页或学习安排）、“学习安排”链接（进头像菜单）。
- 无课程时（`StartPage`）：保留“你好，今天想学什么？”+ 输入框 + 3 示例，提交即建课并**直接进入第一单元**。
- 首启 `/onboarding`：只留“想学什么”1 个必填 + “开始”；时长/时间默认值后置到学习安排；“跳过设置”4 个入口收成 1 个“先随便问问”。

---

## 5. 助理

- `/opening/agent` 默认**新对话**：`assistant-view.tsx` `conversationForAssistant()` 在无 `initialConversationId` 时不再回落到 `eligible[0]`；历史在左侧列表（默认收起）。
- 失败轮次不作为入口展示；失败行文案“这次没答上来”+“重试”按钮（重发同一问题）。
- 右侧“待你确认 / AI 记忆”面板默认折叠为顶栏一个徽标“建议 {n}”（n=0 隐藏）；“模型建议不是事实”“先检查并修改建议…”移入面板内说明。
- 输入框只留 发送 + “＋”（拍题/上传/参考材料收进“＋”菜单）。

---

## 6. 实施待办（按优先级）

验收均在浏览器测量：**首题点击**=从“学习”页加载完成到首道可作答题目可见的点击数；**可见控件**=主区（不含导航）可交互元素数；**术语**=`check-learner-copy.mjs --strict` 在学习面命中数。

| # | 优先级 | 事项 | 主要文件 | 规模 | 验收 | 风险 |
|---|---|---|---|---|---|---|
| 1 | P0 | 学习页单卡“继续 X（约 N 分钟）”直达当前块 | `planning/today-dashboard.tsx`、`today-resume-view.tsx`、`teaching/resume-card.tsx` | M | 首题点击 ≤1；主区控件 ≤4（卡/复习芯片/输入框/全部课程） | 中：多种 continueItem 分支需收敛 |
| 2 | P0 | 课程学习默认专注：顶栏仅 返回+“…”，去 `SplitControls`/自学串讲挑战按钮 | `courses/course-study-workspace.tsx`、`v3/workspace/split-view.tsx`、`shell/workspace-layout-context.tsx` | M | 课程学习主区控件 ≤6；默认无分栏 | 中：已存 layout 偏好需迁移 |
| 3 | P0 | 唯一主操作按钮（继续/进入练习/提交/下一题/下一单元），Enter 触发 | `teaching/teaching-workspace.tsx`、`learning/stage-action-bar.tsx`、`teaching/inline-attempt.tsx` | M | 任一时刻 `data-primary-action` 恰好 1 个 | 中：作答与单元推进状态机 |
| 4 | P0 | 生成中不干等：骨架 + 主操作改“先做一道练习”+ 90s 超时“重新准备” | `teaching/resume-card.tsx`、`teaching/teaching-workspace.tsx`、`course-study-workspace.tsx` | S | 首启后 1 次点击内可作答（即使讲解未就绪）；无“正在准备讲解”永久态 | 低（轮询已加） |
| 5 | P0 | 横幅策略 + 学生文案：去 needs_check 横幅/假链接状态词、“帮助情况未知”、恢复提示改 toast | `teaching-workspace.tsx`、`resume-card.tsx`、`teaching/student-copy.ts`、`learning/attempt-form.tsx` | S | 学习面术语命中 0；非阻塞时横幅 0 | 低 |
| 6 | P0 | 导航改 学习/复习/资料 + 头像菜单；卡组/冲刺/搜索/建议出导航 | `shell/navigation.ts`、`opening-shell-v3.tsx`、`account-menu.tsx`、`mobile-navigation.tsx` | S | 导航项 3；⌘K 可达搜索；旧链接全部 308 | 低：`navigationIsActive` 测试需改 |
| 7 | P1 | 块命令 8→选区菜单 3（没看懂/举个例子/问 AI），其余进“…” | `teaching/block-commands.tsx`、`teaching/selection-ask.tsx`、`teaching-block-item.tsx`、`command-service.ts` | M | 正文区常驻块按钮 0；选中文字后 ≤3 项；`?` 键可唤出 | 中：服务端命令语义（skip/branch/return）需保留入口 |
| 8 | P1 | 双套 对话/目录/笔记 → 单一右抽屉（⌘J/⌘\） | `teaching-workspace.tsx`、`study-tools-panel.tsx`、`lesson-companion-workspace.tsx`、`conversation-companion-tabs.tsx` | M | DOM 中 role=tab“对话”仅 1 个；抽屉默认关闭 | 中：原对话恢复（originalConversationId）路径 |
| 9 | P1 | 偏好矩阵移出学习页；页内“提示多/少”3 档 | `teaching/preference-controls.tsx`、`settings/settings-view.tsx`、`teaching-workspace.tsx` | M | 学习页无“本课临时/课程/全局”字样；滑块写本课层并即时生效 | 中：三层合并语义要与后端一致 |
| 10 | P1 | 助理默认新对话、建议面板折叠、失败可重试 | `assistant/assistant-view.tsx`、`agent-workspace.tsx`、`turn-errors.ts`、`memory-panel.tsx` | S | 打开“对话记录”首屏无历史消息；失败行有“重试” | 低 |
| 11 | P1 | 首启只问“想学什么”，提交即进第一单元 | `features/workspace/onboarding.tsx`、`onboarding/onboarding-paths.ts` | S | 首启页控件 ≤3；提交后 0 额外点击到正文 | 低 |
| 12 | P1 | 设置拆分：外观 / 学习偏好 / 高级（AI 模型配置、诊断、学习测试、用量） | `settings/settings-view.tsx`、`settings/*` 路由 | M | 设置首屏控件 ≤12；无供应商/密钥字段 | 低 |
| 13 | P2 | 删除 legacy `(workspace)` 与 preview 路由，改 next.config 重定向；修 search/course-model 旧前缀 | 见 §2 表、`middleware.ts`、`search/search-results-model.ts`、`courses/course-model.ts` | M | 21+4 个 page.tsx 删除；旧 URL 均 308 到 `/opening/*`；`/ui-preview` 生产不可达 | 中：`/learn/courses` 产品决定、外部书签 |
| 14 | P2 | 冲刺降为课程内模式；题包未绑定不显示 integration-panel；导出改下载按钮 | `exam-sprint/sprint-view.tsx`、`integration-panel.tsx`、`packages/domain/src/opening/exam-sprint/source-catalog.ts` | M | 普通课程冲刺页无 Topic_* 行；无 `/api/` 链接 | 中：需产品定题包归属 |
| 15 | P2 | 资料空库只显示“上传”1 个操作；筛选/批量在有数据后出现 | `library/material-library.tsx`、`library-view.tsx` | S | 空库主区控件 ≤2 | 低 |
| 16 | P2 | 埋点（见 §7） | `client/learning-experience.ts`、`planning/use-next-step-metrics.ts` | S | 事件在 staging 可查 | 低 |

---

## 7. 沉浸度指标

| 指标 | 定义 | 目标 | 采集 |
|---|---|---|---|
| 首题时间 TTFQ | 学习页可见 → 首道题作答框可见（中位数 / P90） | 中位 < 30 s，P90 < 90 s | 扩展现有 `recordLearningExperience`：`next_step_shown` 已有，新增 `first_question_visible` |
| 首题点击 | 同区间点击数 | ≤1（现 ≥5） | 客户端计数随上一事件上报 |
| 准备态流失率 | 进入“正在准备”后 60 s 内离开且未作答的会话占比 | < 10% | 新增 `teaching_waiting_shown` / `teaching_waiting_abandoned` |
| 专注会话占比 | 全程未打开抽屉/分栏的学习会话占比 | > 70%（抽屉为按需） | `workspace-layout-context` 抽屉开关事件 |
| 学习面系统术语 | `check-learner-copy.mjs --strict` 命中 | 0（现 80） | CI |
| 每屏可见控件 | 主区控件数（Playwright smoke 统计） | 学习 ≤4、课程学习 ≤6、助理 ≤5 | 每 PR smoke |
| 注册 → 首个有效任务 | PRD 既有指标 | 15 分钟内比例↑ | 已有 |

上线方式：P0 用特性开关 `immersive_lesson`（参照 `teaching-workspace-flag.ts`），对比开关内外 TTFQ 与准备态流失，一周后默认开启。
