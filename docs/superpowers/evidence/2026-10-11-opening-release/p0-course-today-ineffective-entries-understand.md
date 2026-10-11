# P0 — 课程 / Today 无效入口缺口清单（Understand）

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience  
**Branch tip:** `8ae3353`（`feat/opening-release`；含 Data `lastTurnPreview` clip ACCEPT）  
**Trigger:** Paula — 课程 UI 复杂但无效；学习闭环不清  
**Scope:** 只读审计 + 缺口表。**不**实现 V2-04 Today wiring。不 push / hermes / stash / reset。未改 Data 脏树（`packages/database`、`packages/domain` backup/learning、`teaching-activity*`、`apps/web/.../teaching/`）。

## Paula embed 备注（不实现）

章程 / PM #5：AI 主讲应演进 Today「继续学习 / 开始学习」+ activity stream，嵌现有 Opening shell。  
现状：`today-dashboard.tsx` 主区仍是嵌入 `AssistantView`（自由对话）；`today-resume-view.tsx`「继续学习」→ `/opening/assistant?conversation=…`。Data 侧 teaching-activity 已有，**Experience Today 接线 deferred**（本清单只记缺口，不落地）。

## 审计范围（已读）

| 表面 | 路径 |
|---|---|
| 课程详情 Opening | `apps/web/src/features/courses/course-detail.tsx` |
| 课程详情 Legacy | `apps/web/src/features/courses/legacy-course-detail.tsx` |
| 课程列表 / CTA / 设置 / 加材料 | `course-list.tsx` · `course-study-actions.tsx` · `course-settings-panel.tsx` · `course-add-materials.tsx` |
| 学习 / 练习 / 知识 / 媒体 | `opening/learning/course-view.tsx` · `attempt-form.tsx` · `knowledge/course-knowledge.tsx` · `knowledge-evidence.tsx` · `sources/media-reader.tsx` |
| Today | `planning/today-dashboard.tsx` · `today-overview.tsx` · `today-view.tsx` · `today-resume-view.tsx` |
| 导航 / 命令面板 | `shell/navigation.ts` · `search/command-palette-model.ts` |
| 知识库笔记入口 | `opening/library/library-view.tsx` |

## 缺口表

| ID | Surface | Entry/control | Symptom（复杂但无效） | Why no closed loop | Sev | Suggested Experience fix（诚实） |
|---|---|---|---|---|---|---|
| **CT-01** | Course detail Opening | 页内堆叠：`CourseStudyActions` → `CourseKnowledge` → `CourseLearningView`（练习+证据摘要）→ 材料 → **每个 source 一个 `MediaReader`** → `CourseSettingsPanel` →「返回今日」 | 一门课一屏塞满「看起来都能点」的块；主路径不清晰，用户不知先做什么 | 无单一主 CTA 导向「开始/继续一次学习」；设置与媒体阅读与练习同级竞争注意力 | **P0** | 重排信息架构：顶栏只留 1 个主行动（练习或回 Today 继续）+ 材料折叠；设置进 details/次级；媒体默认折叠或按选中材料打开。不碰 Data。 |
| **CT-02** | Course study actions | Primary「开始独立练习」→ `#course-practice` | CTA 像「开始学习」，实则落到 ~450 行自报练习表单（主题/材料/作答/帮助等级/参考核对/嵌套助理） | 不是 AI 主讲闭环；也不是「一题一反馈」引导流；空课仍可点进空白练习态 | **P0** | 缩短首屏练习：默认「选主题 → 作答 → 保存」三步；辅导折叠到底。长期：主 CTA 改为 Today/主讲 continue（**needs V2-04 Experience wiring**，本轮不做）。 |
| **CT-03** | Today dashboard / resume | 主区嵌入 `AssistantView`；「继续学习」→ `/opening/assistant?conversation=` | 今日主区=自由聊天/继续旧对话，不是 AI 主讲活动流 | Paula embed / PM #5 要求 Today 继续/开始 → teaching activity；Data activity-service 已有，UI 未接 | **P0** | **Deferred（本轮明确不做）**：接 `activity-service` + Today continue/start。证据记缺口即可。needs-Data 仅当 API/契约不足；当前主要为 Experience。 |
| **CT-04** | Course knowledge evidence | `evidenceTargetsForNode`：`#evidence-${chunkId}`；视频链到 `/opening/library?tab=materials`（无 startMs / 无片段定位） | 「依据 xxx…」「视频时间定位」可点，但课程页 **无** `id="evidence-…"` 锚点；视频进材料库列表而非定位 | 死锚 / 弱跳转；知识→材料→练习闭环在 UI 上断 | **P0** | Experience：去掉或改写无效 `#evidence-*` 链接；视频改为课程媒体区选中 source + seek（若有 segments）或明示「仅打开材料库，暂不能定位」。chunk 深链 **needs-Data** 若缺稳定 fragment API。 |
| **CT-05** | Course knowledge | 「下一步：」仅 `nextStepCopy(actions)` 纯文案；章节按钮只打开关系图/证据面板 | 有「下一步」语义但无按钮执行练习/主讲/材料阅读 | 建议不驱动行动；用户停在浏览图 | **P0** | 把第一条 tutor action 做成可点 CTA（跳 `#course-practice` 预填 skill，或打开材料）。若 action 依赖未落地 SkillEvidence：**needs-Data/AI**（`tutor-actions.ts` 仍有 empty stub 注释）。 |
| **CT-06** | Course study actions | 「写一篇笔记」Opening → `/opening/library?tab=notes` | 只打开笔记列表 Tab，不创建；列表页「新建笔记」仍链 **`/library/new`**（legacy） | 课程→笔记闭环半截；Opening 用户可能掉出 Opening 壳 | **P1** | Experience：CTA 直达 Opening 新建笔记路由（若无则先加 `/opening/library/.../new` 或复用现有新建并改 href）；与 `library-view.tsx` 主按钮对齐。 |
| **CT-07** | Today learning context | 「优先行动」→ `#action-digest` | digest 在左侧队列 `TodayPlanView` 内；移动端队列默认收起 / focus 模式 queue hidden 时，页内 hash 无可见目标 | 快捷入口看起来有用，小屏/专注模式下无效滚动 | **P1** | Experience：digest 摘要条提到 Today 顶栏可见区，或点「优先行动」时强制 `setQueueOpen(true)` 再 scroll；focus 模式提供替代入口。 |
| **CT-08** | Course detail media | `assets.filter(source).map` → 每个挂一个 `MediaReader`（且常 `source={null}`） | N 个并行加载的媒体面板堆在练习/材料下方；失败态重复 | 复杂展示≠学习下一步；拖慢课程页 | **P1** | Experience：默认列表只显示材料名+状态；点选后再 mount 单个 `MediaReader`；传入真实 `source` 避免假 mime 路径。 |
| **CT-09** | Course settings | 课程页底部完整「自动评价 / 补测建议 / 提醒」+ 归档 | 设置与学习主路径同页同级；新用户易被「关闭自动行为」文案吓到或分心 | 非学习闭环必需；增加「复杂感」 | **P1** | Experience：默认 `<details>` 折叠「课程设置」；归档确认保留。 |
| **CT-10** | Legacy course detail | `/learn/courses/[id]` 仍挂 `LegacyCourseDetail`：指导模式 + goals + `#course-practice`（依赖 Opening `CourseLearningView`） | 双壳并存；「返回今日」→ `/learn`；Opening 用户若被链到 legacy 会混导航 | Middleware 可能重定向，但组件与测试仍维护双路径，易出现无效/过时入口 | **P1** | Experience：确认 Opening 导航/palette 无链到 `/learn/courses`；legacy 页加「请使用 Opening 课程」横幅或只读。不删后端。 |
| **CT-11** | Course list footer | 「不限制自由探索」文案；无 explore 入口（nav 已无 explore） | 文案暗示探索产品，侧栏已收敛 | 期望落空（弱） | **P2** | 改文案为「可直接从今日或助理开始」，去掉 explore 暗示。 |
| **CT-12** | Command palette | `全局搜索` → `/search`；设置/高级仍在 | 非死链；但易把用户带出 Today/课程闭环（历史 R2 曾标需 Paula 确认） | 旁路感，非直接无效 | **P2** | 保持；若 Paula 要收敛再藏。本轮不改。 |
| **CT-13** | Course add materials | 「上传并归入本课」→ library `#upload` + `courseId` | 路径可用（材料挂接 P0 已做过）；空课仍靠离开课程页完成上传 | 闭环较长但有终点 | **P2** | 可选：课程内嵌上传条。非本 P0 优先。 |

## Top 5 P0（给 PM）

1. **CT-01** 课程详情信息过载、无单一学习主路径  
2. **CT-02** 「开始独立练习」落入过重自报表单，非主讲/简明练习闭环  
3. **CT-03** Today 主区仍是助理对话，未接 AI 主讲 activity（**deferred wiring**）  
4. **CT-04** 知识依据 `#evidence-*` / 视频定位死链或弱链  
5. **CT-05** 课程知识「下一步」不可执行  

## 明确非目标（本证据）

- 不实现 V2-04 Today / teaching-activity UI wiring  
- 不改 `packages/database` · `opening-conversations` · teaching-activity*  
- 不 push / hermes / stash / reset  

## Ready for PM?

**Understand 清单 ready for PM 审阅。**  
未改产品代码；Accept 门槛：PM 勾选要落地的 ID 后再开 Experience IMPLEMENT（CT-03 单独排期，勿与本 P0 hotfix 混做）。
