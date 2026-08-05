---
title: 学习型笔记本的界面、智能编排、AI、分享与格式兼容
date: 2026-08-05
status: exploring
scope:
  - Library、Document Editor、AI、Learn、Review、Portability、Publishing
  - Document、Block、Revision、Relation、Property、LearningEdition、ShareGrant、ImportReport
  - apps/web、packages/contracts、packages/domain、packages/database、packages/ai、apps/worker
related:
  - ../product/PRD.md
  - ../product/UX_AND_AI_POLICY.md
  - ../plans/2026-07-21-lifelong-learning-design.md
  - ../plans/2026-07-21-lifelong-learning-implementation.md
  - ../plans/2026-08-02-frontend-core-loops-design.md
  - ALGORITHM_MAP.md
promotion_target:
  - 笔记本产品设计与分期实施计划
  - Document/Block/View/AI Context/Sharing/Portability 契约
  - 学习型教材与发布权限 ADR
---

# 学习型笔记本的界面、智能编排、AI、分享与格式兼容

## 1. 决策问题

如何把 AIstudy 的笔记本从“可保存的块编辑器”扩展为一个界面安静、编辑空间宽广、支持多种内容和布局、能被 AI 与工具可靠理解、可分享迁移，并能把笔记转化为学习闭环教材的工作台，同时不复制 Notion 的全部复杂度，也不破坏现有统一资产、版本历史、AI 候选审核和个人学习状态隔离原则？

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 自由记笔记；整理长文；从资料形成章节；将笔记转为练习与复习；发布只读教材；迁移到其他工具 |
| 产品入口/流程 | Library 编辑/阅读/学习；Explore 沉淀；Learn 练习与复习；全局分享、导入、导出 |
| 领域对象 | Document、Block、Revision、Relation、Property、SourceAnchor、Card、PracticeItem、Attempt、LearningEdition、ShareGrant、ExportJob |
| 代码边界 | `apps/web/src/features/editor`、`packages/database/src/schema/library.ts`、`packages/ai`、`packages/domain/src/portability`、Worker 导出/索引任务 |
| 计划任务 | 现有 Task 10/11/14/16/21–28；批准后新增编辑工作台、学习型教材和发布切片 |

## 3. 不变量与约束

- `Document/Block/Revision` 是正式内容事实源；布局、目录、搜索索引、AI 摘要、学习路径和发布产物必须可重建或明确版本化。
- 块具有稳定 ID；课程、教材、视图、卡片和练习通过引用复用块，不复制正文。
- AI 修改只能形成带 `baseRevision`、来源和 diff 的 proposal；不能静默覆盖正式笔记。
- 阅读、打开、摘要和 AI 代答不构成掌握证据；只有定义清楚的独立尝试、作品与反馈进入学习评价。
- 分享的内容状态与每位学习者的私有进度、作答、复习调度、AI 日志分离。
- 默认界面服务写作和阅读，不把属性、关系、AI、学习指标同时常驻在屏幕上。
- 移动端必须保留线性阅读顺序；桌面多栏不能成为内容语义的唯一载体。
- 内部原生格式必须无损；Markdown、HTML、PDF、DOCX、Anki 等投影必须明确报告损失。
- 当前 VM 与首期产品资源有限；先做规则、明确契约和可逆布局，不先引入复杂自动排版、图数据库或端到端生成教材。

## 4. 已验证事实（调研日期：2026-08-05）

### 4.1 项目现状

- 已批准设计把笔记定位为长期创作与知识组织核心，并规定统一 `Document/Block/Relation/Property/Revision` 根模型、AI revision proposal、Markdown/Anki/完整包导出和后续数据库/白板视图。
- 当前编辑页使用 BlockNote 0.52.1，主内容限制在 `max-w-6xl`，编辑器位于有边框和阴影的容器内；页面下方常驻属性与反向链接面板。编辑器顶部还显示返回、实现标签、标题、保存状态、撤销/重做、历史和保存。
- 当前数据库已保存稳定块 ID、通用块类型与 JSON 内容，并保留 revision；该结构可以承载自定义块和嵌套子块，但尚无正式 View、AccessScope、ShareGrant 或 Import/Export report。
- 当前 BlockNote 默认 schema 包含段落、标题、列表、待办、折叠、引用、代码、表格、分隔、图片、文件、音频和视频；公式、学习语义块、来源摘录、练习等仍需自定义 schema 或独立引用对象。
- 当前 Card 只记录 `sourceDocumentId`，没有 `sourceBlockId` 与内容 revision；若原文变化，卡片无法精确解释其来源版本。
- `/settings/export` 仍是占位页；当前仓库未实现公开分享、协作或原生备份恢复 UI。

### 4.2 官方产品与编辑器能力

- Notion 官方帮助说明其栏布局通过块拖放和可调栏宽实现；移动端会把右栏内容放到左栏内容下方。目录既可作为块，也可作为随页面滚动的右侧页面级目录。
- Notion 官方帮助说明 synced block 在多个位置共享同一内容，访问与编辑仍取决于原始块权限；解除同步后副本独立。
- Notion 官方帮助区分 PDF、HTML、Markdown/CSV 和整工作区导出，并明确导出物不能直接完整重建原工作区。
- BlockNote 官方文档建议以 `editor.document` JSON 作为无损持久化格式；标准 HTML 与 Markdown 导入导出均可能有损。
- BlockNote 官方文档支持自定义 block schema、属性、React 渲染、外部 HTML 转换与解析；也允许替换 block side menu。多栏可通过专用 column schema/扩展实现，但当前项目未安装该能力，需先做版本、许可、导出和移动端兼容 spike。

官方来源：

- https://www.notion.com/help/columns-headings-and-dividers
- https://www.notion.com/help/synced-blocks
- https://www.notion.com/help/export-your-content
- https://www.notion.com/help/import-data-into-notion
- https://www.blocknotejs.org/docs/foundations/supported-formats
- https://www.blocknotejs.org/docs/features/custom-schemas/custom-blocks
- https://www.blocknotejs.org/docs/react/components/side-menu

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| 用户更需要长时间专注编辑，而不是常驻属性面板 | 隐藏过深会降低知识组织效率 | 以三类真实任务比较当前布局、抽屉式检查器和常驻双栏的完成时间与误操作 |
| 2–3 栏和少量模板已能覆盖绝大多数排布需求 | 用户可能要求任意网格和自由画布 | 收集 30 篇真实笔记的布局需求，统计不能由线性/折叠/2–3 栏表达的比例 |
| “编辑/阅读/学习”三模式比在同一界面堆叠所有工具更易理解 | 模式切换可能造成上下文丢失 | 原型测试模式发现率、返回位置保持和完成学习闭环时间 |
| 块级语义与稳定引用足以支持教材生成 | 长文跨块论证和隐含先修关系可能识别不足 | 人工标注章节样本，评估结构、来源、先修和题目候选的准确率与修订率 |
| 只读发布优先于多人实时协作 | 用户可能首先需要共同编辑 | 访谈个人学习者、教师和学习小组，比较分享、评论、协作的首要任务频率 |
| Markdown/HTML/native backup 可以覆盖首期迁移需求 | DOCX、PDF、EPUB 的需求可能更高 | 统计用户导入样本与目标工具；对每类格式建立保真度 corpus 和 loss report |

## 6. 候选方案

### 6.1 方案 A：推荐的“安静画布 + 上下文抽屉 + 多视图”

#### 编辑界面

- 编辑路由默认进入专注工作台：顶部仅保留返回/面包屑、标题、保存状态、搜索、分享、AI 和更多操作；移除“服务端编辑器”“编辑笔记”和安全副本说明等实现型常驻文案。
- 文本正文默认使用约 760–880px 的舒适行宽；用户可切换 `舒适 / 宽 / 全宽`。表格、媒体、代码、多栏等块允许单块 `breakout` 到更宽轨道，而不是把所有正文永久拉满。
- 工作区全局导航可折叠；右侧只保留一个窄图标轨道，按需打开 `目录 / 关系 / 属性 / AI` 抽屉。抽屉支持覆盖画布或固定并排，默认不常驻。
- 版本、导出和页面设置进入“更多”菜单；撤销/重做保留图标与快捷键。移动端侧栏和检查器一律进入底部抽屉。
- 增加 `编辑 / 阅读 / 学习` 分段模式。三种模式投影同一份内容与同一滚动锚点，不复制文档。

桌面端建议骨架：

```text
┌ 返回/面包屑 ─ 标题 ─ 已保存 ─ 搜索 ─ 分享 ─ AI ─ 更多 ┐
├──────────────────────────────────────────────────────┤
│ [可折叠导航]       760–880px 正文画布       [窄工具轨] │
│                   表格/媒体可局部全宽        目录      │
│                   / 插入，拖拽，块操作        关系      │
│                                                属性      │
│                                                AI        │
└──────────────────────────────────────────────────────┘
```

窄工具轨打开的是同一上下文位的互斥抽屉，不产生四个并排面板。进入专注模式后导航和工具轨均收起，只保留标题、保存状态和正文。

#### 块与布局

按三层管理 slash menu，避免几十种块平铺：

1. **内容块：**段落、H1–H6、项目/编号/待办、折叠、引用、提示框、代码、公式、表格、分隔、图片、文件、音频、视频、链接预览、目录。
2. **学习块：**来源摘录、定义/概念、例题、反例、开放问题、回忆提示、练习、提示、答案/解析、错因、检查点、学习目标。卡片、练习和任务仍是独立资产，学习块只引用其 ID 或发起创建候选。
3. **结构/视图块：**2–3 栏、同步块/块引用、查询视图、章节导航。数据库、看板、白板后置为对现有对象的 View，不建立新内容根模型。

布局分两类保存：

- **规范结构：**标题层级、折叠、局部 2–3 栏、表格等影响阅读顺序的内容结构，进入 Document revision；移动端按稳定线性顺序折叠。
- **替代视图：**教材、复习单、比较表、演示等不改正文的排布，保存为版本化 `ViewDefinition`，只引用稳定 block ID。删除视图不删除内容。

“智能排布”先采用可解释规则与模板：根据块语义、内容长度、相邻标题和 viewport 提议 2–3 个方案，预览 diff 后由用户确认。用户手动调整会产生 `pinnedLayout` 覆盖，AI 不再反复改动。首期不做任意瀑布流、自动绝对定位或自由画布。

#### AI 与工具理解文档

AI 不是读取一段拼接后的全文，而是接收版本化 `DocumentContextPack`：

```text
documentId + revision
selectedBlockIds / currentSectionId
ancestor headings + nearby blocks
block types + semantic roles
properties + explicit relations
source anchors + citation support state
optional course/goal/learning state scope
permission snapshot + token budget
```

用户调用 AI 时明确选择作用域：`选中内容 / 本节 / 全文 / 相关知识 / 课程资料`。界面显示实际纳入的来源和 revision，可移除来源。检索先用权限过滤后的标题/全文/关系基线；embedding 与重排只是后续可重建投影。

“理解文档”拆成三层，避免把某次模型总结误当成事实：

1. **确定性结构层：**块树、标题层级、属性、关系、来源锚点、revision 和权限；这是 AI 每次读取的事实边界。
2. **可重建语义层：**术语、主张、问题、例子、先修和章节摘要候选，全部带生成版本、支持块和置信/审核状态。
3. **任务上下文层：**针对当前指令从前两层组装限额 ContextPack；任务结束后可丢弃，需要保留的结果必须提升为 candidate/proposal。

工具分级：

- 只读自动：检索、术语解释、结构扫描、引用核对、格式转换、计算和文件解析。
- 建议后确认：改写、补例子、生成大纲、卡片、题目、关系、学习路径和版式。
- 必须手工：接受事实修改、发布、删除、共享权限变化、正式作答。

任何写入都生成 `RevisionProposal` 或独立资产 candidate，记录 `baseRevision`、选中块、来源、工具调用、provider/model/prompt policy、支持状态和 diff。导入内容按不可信数据处理，不能把文档中的指令当系统指令。

每个工具还需要统一 `ToolCapability` 契约：`toolId/version`、输入/输出 schema、可读数据范围、外部发送范围、所需权限、是否可逆、成本/超时、幂等键和审计字段。AI 可以提出调用计划，但服务端必须重新校验用户权限与参数。工具结果先成为临时 `ToolResult`；只有用户确认或符合低风险自动化策略时，才能转为来源、块、属性或 proposal，不能把命令输出直接写进正式正文。

#### 分享和导出

严格分开五种用户意图：

1. **发布/只读分享：**分享指定 revision 或“跟随最新已发布版本”；支持私有、指定用户、带链接、公开和有效期。首期先做只读，不承诺实时协作。
2. **协作：**评论、建议、共同编辑，是独立的权限和并发能力，后置实现。
3. **模板/教材包：**接收方 Fork 内容形成自己的资产；发布者内容版本与接收方私有学习状态分离。
4. **可读导出：**Markdown、HTML、PDF、DOCX 等面向阅读或后续编辑的投影。
5. **原生备份：**带 schema manifest、checksums、附件、关系、revision 和可选个人事件的可恢复包。

公开内容默认排除个人作答、复习状态、计划、私有属性、AI 原始日志和无权限来源。发布前显示“将公开什么”的预览和引用/附件权限检查。

分享面板不暴露内部权限表，而是让用户依次配置：

- **对象：**整篇文档、LearningEdition、集合或教材包；
- **版本：**固定 revision、每次手工发布的新版本，或跟随“最新已发布版”，不直接跟随编辑草稿；
- **受众：**指定用户/小组、私密链接、公开；
- **能力：**查看、复制、下载、Fork；评论/建议/编辑在对应协作能力上线前不显示；
- **限制：**有效期、是否允许搜索引擎、附件是否包含、是否展示来源、是否允许 AI 使用共享内容；
- **撤销与审计：**一键停用链接，显示最近访问和版本变更，但不把读者的私人学习行为泄露给作者。

#### 笔记变成学习闭环教材

新增 `LearningEdition`，它不是文档副本，而是对 document/block/source/practice/card 的版本化组织：

```text
LearningEdition
├── contentRevision / selectedBlockIds
├── chapter outline + prerequisites
├── learning objectives + glossary
├── explanation / example / counterexample references
├── recall prompts / practice / transfer tasks
├── review policy + completion rules
└── edition version + publication scope
```

手动或 AI 辅助流程：

1. 用户标注或 AI 候选识别章节、概念、来源、先修、例子与开放问题。
2. 运行“教材体检”，只报告缺失来源、概念未定义、缺例子/反例、只有讲解没有检索练习等可行动缺口。
3. AI 提议补充块、回忆题、练习和迁移任务；用户逐项接受、编辑或拒绝。
4. 学习模式按 `目标 → 预检 → 讲解/例子 → 无提示回忆 → 练习 → 反馈 → 变式迁移 → 间隔复习` 运行，但每个环节可关闭或手工选择。
5. Attempt/Review/Artifact 形成追加写证据；教材正文不被学习状态污染。失败可回链到精确 source block/revision，修改内容后相关卡片显示“来源已更新，待复核”。
6. 默认只显示本节状态、一个下一步和待复习数量；原因、证据和策略进入展开层。

不强迫所有笔记教材化，也不强迫所有内容卡片化。可提供 `快速理解 / 深度学习 / 考试复习 / 长期保持` 策略模板，但模板只调整任务组合，不改写内容。

#### 多格式兼容

内部采用版本化原生 Block JSON/AST；所有格式通过 adapter 进入统一流程：

```text
原文件保留
→ 探测格式与安全检查
→ 解析为候选 Document/Source/Attachment
→ 导入预览 + loss report
→ 用户确认
→ 新 revision/新资产
```

导出从固定 revision 生成，附 `ExportReport`。未知块不得静默丢弃：可保留原始 payload 为 `unsupported` 占位块，或导出为带说明的 HTML/附件。

| 格式 | 首期定位 | 保真度与边界 |
|---|---|---|
| 原生 `.aistudy.zip` | 完整备份/恢复 | 目标无损；含 manifest、schema、checksums、附件与关系 |
| Block JSON | 单文档机器交换/调试 | 对受支持 schema 无损；不等于完整 workspace 备份 |
| Markdown + assets + sidecar | 可迁移文本 | 有损；栏、复杂属性、学习块、评论等写入 sidecar 或 loss report |
| 标准 HTML + assets | 可读发布/迁移 | 视觉与结构较强，应用语义可能有损；自定义块用稳定 `data-*` 标记 |
| PDF | 固定版阅读/打印 | 只导出，不作为可编辑往返格式 |
| DOCX/ODT | 办公编辑交接 | 后置、有损；需要独立 exporter 与回归语料 |
| CSV | 表格/查询视图 | 只导出结构化行，不代表文档 |
| Anki | 卡片与媒体投影 | 明确有损；保留 source link/revision，不能承诺完整调度历史迁移 |
| PDF/EPUB 输入 | 首先作为 Source 深读 | 保留原文件与锚点；解析内容是候选，不默认假装无损转成笔记 |
| DOCX/HTML/Markdown 输入 | 可编辑导入 | 保留原文件，预览结构变化，用户确认后创建文档 |

### 6.2 方案 B：Notion 功能面优先

尽快加入大量块、任意多栏、数据库、看板、公开页面和协作。优点是短期功能列表完整；缺点是当前数据契约、导出、移动阅读顺序、权限、学习语义和资源条件不足，极易形成表面相似但无法可靠迁移或学习的编辑器。暂不推荐。

### 6.3 方案 C：教材流程优先的强结构编辑器

所有笔记必须选择章节、目标、概念、例题和练习模板。学习闭环更容易计算，但破坏自由笔记与终身知识库入口，会让临时记录和创作变重。只适合作为可选 `LearningEdition` 模式，不适合作为 Document 的唯一形态。

## 7. 评估

| 维度 | A：安静画布+多视图 | B：Notion 功能面优先 | C：强教材结构 |
|---|---|---|---|
| 目标效果 | 同时服务写作、组织和学习 | 通用编辑能力强 | 结构化学习强 |
| 数据需求 | 低；规则和用户确认可起步 | 中高；大量对象与权限 | 中；需课程/构念数据 |
| 实现成本 | 中，可纵向分期 | 很高 | 中高 |
| 可解释性 | 高，内容/视图/学习状态分离 | 易因功能互相耦合下降 | 高但自由度低 |
| 隐私与安全 | 分享范围和学习状态边界明确 | 协作与公开面扩大攻击面 | 学习数据使用较多 |
| 可迁移/回滚 | 原生无损、投影有 loss report | 复杂块越多越难迁移 | 教材语义易锁定产品 |
| 扩展性 | 可从 ViewDefinition 扩到数据库/白板 | 早期扩展快，长期维护重 | 易扩学习，不易扩自由创作 |
| 失败降级 | 回到线性文档和手工学习 | 大量局部降级 | 回到普通文档需额外转换 |

## 8. 推荐结论

- 推荐方案：方案 A。
- 产品定位：不是“再做一个 Notion”，而是“内容一次编写，可按编辑、阅读、学习和发布多种方式使用的学习型笔记本”。
- 适用边界：个人知识工作台和只读教材分享优先；实时多人协作、任意网格、数据库和白板后置。
- 暂不采用：自动重排正式内容、无限块菜单、所有笔记强制教材化、AI 直接写正文、把 PDF/Markdown 宣称为无损往返。
- 升级触发条件：真实笔记样本证明 2–3 栏/模板不足；公开分享有持续使用；查询规模证明 ViewDefinition 和关系表不足；AI 候选在人工集上达到可接受支持率和修订率。
- 回退方案：所有新能力必须能退回线性文档、固定 revision、手工排版、手工卡片/练习和原生备份。

## 9. 建议分期

### P0：先补“好写、可理解、可恢复”

- **P0a 编辑工作台：**专注界面、宽度切换、目录/关系/属性/AI 抽屉；补齐公式、提示框、来源摘录、回忆提示和练习引用的最小块集。
- **P0b 内容身份：**块引用/同步语义、稳定 source block/revision 锚点；卡片和练习改为精确回链，并在来源变化时提示复核。
- **P0c AI 上下文：**`DocumentContextPack`、AI scope selector、`ToolCapability/ToolResult` 与 proposal diff 审核。
- **P0d 可携带性：**Markdown/HTML 导入导出预览与 loss report；原生完整备份恢复。

### P1：形成“笔记到教材”的真实闭环

- `LearningEdition`、编辑/阅读/学习模式。
- 教材体检、学习目标、例子/反例、题目和迁移任务候选。
- 卡片/练习与精确来源 revision 联动；内容变更复核。
- 只读版本化分享、模板/Fork、个人学习状态隔离。
- PDF/EPUB 深读与来源锚点。

### P2：在证据后扩展排布与生态

- 版本化 ViewDefinition、多栏模板、查询/表格/看板视图。
- DOCX/ODT 导出、更多导入适配器。
- 评论、建议和实时协作。
- 白板、脑图、插件 SDK 与第三方发布生态。

## 10. 验证计划

- **编辑空间：**1440px 桌面打开文档后，正文不被常驻面板挤压；用户在 1 次操作内切换目录/关系/属性/AI，在 2 次操作内进入专注模式。
- **真实任务：**完成“写长文”“整理资料成章节”“从笔记生成并完成一次复习”“发布只读教材”“导出后恢复”五条端到端场景。
- **布局：**至少 30 篇真实笔记回放；规则模板覆盖率、用户保持率和手动纠正次数可测。若多数建议被立即撤销，停止自动排布并只保留手动模板。
- **AI：**建立带 block/revision/source 金标的样本；衡量引用支持率、错误引用率、候选接受率、修订率和上下文泄漏。任何跨权限泄漏为发布阻断。
- **学习闭环：**衡量从内容到首次独立回忆、练习、迁移和后续复习的完成率；打开/阅读不能计入掌握。
- **格式：**为 Markdown、HTML、native、Anki 建立 round-trip corpus；原生恢复对象、关系、revision 和附件计数必须一致。所有有损格式必须产出非空 loss report 或明确“无已知损失”。
- **分享：**固定 revision 在原文继续编辑后保持不变；撤销权限后不可访问；公开包中个人事件与私有来源泄漏为零。

## 11. 风险与治理

- **内容漂移：**卡片、练习、AI 答案和教材引用必须指向 block + revision，并能提示来源变更。
- **提示注入：**外部文档、网页、PDF 和共享内容全部是不可信输入；工具权限由系统策略而非文档文本决定。
- **版权与附件：**导入不等于获得再发布权；分享前检查来源和附件发布范围。
- **公开与私有混淆：**内容包、模板和教材版本不得携带作者或学习者的私有学习状态。
- **格式夸大：**“可导入”不等于“无损”；UI 必须在确认前显示结构变化和无法表达项。
- **AI 代学：**教材生成不能替代学习者的无提示尝试；AI 辅助记录进入 assistance trace。
- **菜单膨胀：**块按任务分组并支持搜索/最近使用，不把所有实验块平铺。
- **供应商锁定：**BlockNote schema 是编辑层实现，不应成为唯一导出契约；原生包使用项目自有版本化 manifest。

## 12. 待用户确认的关键取舍

1. 是否批准“编辑 / 阅读 / 学习”三模式作为笔记本主交互，而不是把学习工具永久放进编辑页？
2. 是否批准“正文舒适宽度 + 特定块可突破到全宽”，而不是默认全文全宽？
3. 是否批准智能排布只生成可预览、可撤销的 View/布局提案，永不静默重排正式内容？
4. 是否批准分享首期只做版本化只读发布与 Fork，把评论/实时协作后置？
5. 是否批准 `LearningEdition` 引用原文块，不复制一份“教材正文”？
6. 首批学习块是否以 `来源摘录 / 概念 / 例题 / 反例 / 回忆提示 / 练习 / 解析 / 错因 / 学习目标` 为边界？

## 13. 正式化路径

获批后需要更新：

- [ ] PRD：笔记主模式、只读分享、LearningEdition 与格式能力边界
- [ ] UX 与 AI 权限政策：AI scope selector、proposal、内容变更复核与学习模式信息预算
- [ ] 新增笔记本产品设计和分期实施计划
- [ ] ADR：内容/视图/LearningEdition/发布快照的身份和版本边界
- [ ] Contract/Schema/API：ViewDefinition、DocumentContextPack、SourceAnchor、ShareGrant、LearningEdition、Import/ExportReport
- [ ] 测试与验收：编辑空间、移动线性顺序、AI 引用、分享隔离、格式 round-trip、学习闭环
- [ ] 监控与回滚：候选接受/撤销、格式损失、来源漂移、权限拒绝和导出恢复结果

## 14. 变更记录

| 日期 | 状态 | 变化 | 依据 |
|---|---|---|---|
| 2026-08-05 | exploring | 首次整理六个笔记本设计问题、现状证据和推荐分期 | 用户讨论、项目代码/计划、Notion 与 BlockNote 官方文档 |
