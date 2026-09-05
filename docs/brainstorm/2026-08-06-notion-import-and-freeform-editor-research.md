---
title: Notion 导入兼容、自由笔记编辑与简洁界面调研
date: 2026-08-06
status: exploring
scope:
  - Library、Document Editor、Import/Export、View、Publishing
  - Document、Block、Revision、Property、Relation、ImportReport、Attachment
  - apps/web、packages/domain/src/portability、packages/database、apps/worker
related:
  - 2026-08-05-learning-notebook-interface-and-capability-design.md
  - ../product/PRD.md
  - ../product/UX_AND_AI_POLICY.md
  - ../plans/2026-07-21-lifelong-learning-implementation.md
  - ../architecture/DATA_MODEL_AND_PREDICTION.md
promotion_target:
  - 笔记本产品设计与实施计划（导入/自由编辑/界面切片）
  - Portability 契约（Notion 导入器、ImportReport、附件与链接解析）
  - 编辑工作台设计（块树、列、画布投影、元数据展示）
---

# Notion 导入兼容、自由笔记编辑与简洁界面调研

## 1. 决策问题

用户要求：①深度调研 Notion 的页面功能与 Obsidian 的综合文件处理能力；②AIstudy 笔记本要能直接兼容 Notion 导入；③笔记编辑尽可能自由；④界面尽可能美观简洁。本笔记回答：导入 Notion 的哪几种导出格式、按什么映射规则进入 `Document/Block/Revision` 模型且不破坏现有不变量；自由编辑做到哪一层（列、折叠、画布）才符合当前资源约束；界面吸收哪些已证实可用的范式。

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 从 Notion 迁移旧笔记；自由组织长文与多栏；专注写作；把笔记转成学习闭环；迁移到其他工具 |
| 产品入口/流程 | Library 导入入口、编辑工作台、阅读/学习视图、导出与分享 |
| 领域对象 | Document、Block、Revision、Property、Relation、Attachment、ImportReport |
| 代码边界 | `packages/domain/src/portability`（新）、`apps/web/src/features/editor`、`packages/database/src/schema/library.ts`、`apps/worker` |
| 计划任务 | 现有 Task 10/11/16/21–28；批准后新增 Notion 导入器、自由布局切片、导入报告 UI |

## 3. 不变量与约束

- `Document/Block/Revision` 仍是正式内容事实源；导入产物是**新建的 Document 与块**，绝不改写既有笔记，导入过程可被 revision 追溯。
- 块 ID 稳定；学习语义块（概念、来源摘录、练习）在导入后需要人工或 AI 候选确认，不自动生成正式语义。
- 导入必须产出 `ImportReport`：逐页、逐块报告“保真 / 降级 / 丢失”，并保留原始导出文件作为证据（类似 SourceAnchor）。
- 内部原生格式必须无损；Markdown/HTML 是导入输入而非内部存储，内部存储仍用块 JSON。
- 默认界面服务写作与阅读；属性、AI、学习指标不常驻屏幕（延续 2026-08-05 方案 A）。
- 移动端保持线性阅读顺序；桌面多栏不得成为内容语义唯一载体。
- 当前 VM 资源有限：先做确定性、可测试的导入管道与规则布局，不先引入图数据库、任意自由画布或实时协作。

## 4. 已验证事实（调研日期：2026-08-06）

### 4.1 Notion 页面功能（官方）

- 块分类（官方 “Types of content blocks”）：基础块 `page / to-do / headings / bulleted list / numbered list / toggle list / quote / divider / callout`；数据库视图 `table / board / calendar / gallery / list`；媒体 `image / web bookmark / video / audio / code / files`；高级块 `math equation / template button / breadcrumbs / table of contents`；500+ 应用 embed。
- 块操作：拖拽重排、删除、复制、**转换为其他块类型**、移动到其他页面、评论、改块颜色。
- 页面结构：`icon`（emoji / custom_emoji / native icon / external / file，顶层字段）与 `cover` 不是 properties；properties 类型包括 `title / rich_text / number / select / multi_select / status / date / people / files / checkbox / url / email / phone / formula / relation / rollup / created_time / created_by / last_edited_time / last_edited_by / unique_id / verification`。
- 导出三格式：**Markdown & CSV**（页面→.md，数据库→.csv，文件名带 32 位 UUID 后缀）、**HTML**（更保真，保留 callout 结构与 toggle 包裹、内部链接）、**PDF**。
- 官方明确：导出物不能完整重建原工作区；Markdown 导出对无对应块的类型静默降级。
- **Enhanced Markdown（Notion-flavored）**：Notion API 的 markdown 端点（`GET/POST/PATCH /v1/pages/:id/markdown`）使用扩展格式，用 XML 标签与属性表示 callout/toggle/columns/mentions/块颜色，例如 `<callout icon="emoji" color="Color">…</callout>`、`<details><summary>…</summary>…</details>`、`# Heading {toggle="true"}`。该格式可作为内部无损中间表示的参考。

来源：https://www.notion.com/help/guides/types-of-content-blocks 、https://developers.notion.com/reference/page-property-values 、https://developers.notion.com/guides/data-apis/enhanced-markdown 、https://www.notion.com/help/export-your-content

### 4.2 Notion 导出的实际损失（社区实测）

- Toggle 在 Markdown 导出中**展平**：标题变普通段落，内容同缩进输出，折叠结构丢失。
- Callout 在 Markdown 导出中变成 blockquote + 前置 emoji（颜色与 callout 语义丢失），或保留为内联 HTML。
- 文件名全部带 UUID 后缀；页面间链接需按 UUID 重写；数据库页面关系需要跨 CSV 解析。
- Markdown 导出保真较好的类型：标题、列表、链接、表格、代码块、加粗/斜体。

来源：https://formatarc.com/en/blog/notion-export-to-markdown/ 、https://mdstill.com/blog/notion-markdown-export-quirks

### 4.3 Obsidian 的 Notion 导入实现（可复用的工程事实）

- **Obsidian Importer 明确拒绝 Markdown 导出**（“Please export Notion data to HTML instead”），只用 **HTML 导出 ZIP**：递归解压嵌套 ZIP（区分“用户附加的 zip 附件”与“根级导出 zip”）；跳过 `index.html` 汇总文件与 CSV 数据库文件；按文件名 UUID 建立 `idsToFileInfo` 映射；页面从 HTML 的 `div.page-body` 取正文；**页面属性从 HTML 内嵌 table 提取**并序列化为 frontmatter/YAML；图片与附件落到配置的附件目录并重写相对链接；保留原始 `ctime/mtime`。
- Obsidian 数据模型：Vault = 本地文件夹 + Markdown 文件 + 附件目录；`getMarkdownFiles()` 枚举；双链 `[[…]]`、标签、反向链接；Canvas 文件是 JSON（nodes/edges，节点类型 file/text/link/group，支持颜色与连线）。
- 这意味着“HTML 导出 → 结构化转换 → 属性/附件/链接解析”是一条已被成熟产品验证过的路径。

来源：https://github.com/obsidianmd/obsidian-importer （`src/formats/notion.ts`、`src/formats/notion/convert-to-md.ts`）、https://obsidian.md/help/import/notion 、https://github.com/obsidianmd/obsidian-api/blob/HEAD/canvas.d.ts

### 4.4 界面范式对比（Craft / Bear / Logseq / AFFiNE / SiYuan）

- **Craft**：块编辑器（卡片、折叠、嵌入、callout），文件夹+嵌套页面，发布文档带自定义样式，实时协作与 AI；适合“给人看的文档”。
- **Bear**：Markdown 写作工具，嵌套标签即组织模型，专注模式（隐藏除文字外的一切），20+ 主题与精排排版；刻意不做数据库/看板/协作——“缺失的功能本身就是功能”。长文写作体验优于 Craft。
- **Logseq**：大纲式（outliner），块级双向链接，本地 Markdown 文件。
- **AFFiNE / BlockSuite**：文档 = block tree（root block + leaf blocks）；白板（edgeless）里的元素存在 `surface block` 中；**page 模式与 edgeless 模式是同一文档的两种投影**；扩展系统分 Inline / Block / Gfx / Widget / Fragment 五类。
- **SiYuan（思源）**：隐私优先、自托管开源；块级引用与双向链接、自定义属性、SQL 查询嵌入、块缩放（zoom-in）、Markdown WYSIWYG；数据 = 每文档一个 `.sy` JSON 文件 + `assets/` 资源目录（与 AIstudy 的 Document+附件设计同构）；API 覆盖 block/attr/outline/ref/export/import；导出标准 Markdown + assets、PDF/Word/HTML。

来源：https://fabric.so/comparison/craft-vs-bear 、https://docs.affine.pro/blocksuite-wip/architecture 、https://blocksuite.io/components/editors/edgeless-data-structure 、https://github.com/siyuan-note/siyuan

### 4.5 与本项目现状的对照

- 现有 `library_documents / library_blocks / library_revisions / library_properties / library_relations` 可承载导入产物与自定义块；尚无 `ImportReport`、附件表、视图投影表。
- BlockNote 0.52.1 默认 schema（段落/标题/列表/待办/折叠/引用/代码/表格/分隔/图片/文件/音频/视频）可映射 Notion 大部分基础块；callout/equation/columns/mention 需自定义 schema 或降级为自定义块。
- 当前预览版（`6eca7e0`）已验证“单行顶栏 + 居中文档 + 按需菜单”的简洁工作台，与 Bear/Craft 的“写作优先、chrome 收敛”方向一致。

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| 用户导入数据以 HTML 导出为主 | 用户手头只有 Markdown&CSV 导出 | 导入器同时支持两条路径：HTML ZIP 保真主路径 + MD/CSV 有损备路径 |
| 2–3 列 + 折叠 + 表格可覆盖绝大多数自由排布需求 | 用户期望 Notion 数据库/任意画布 | 收集真实导入样本统计布局类型；画布投影列为远期 spike |
| 导入器按确定性规则转换即可，不需要 AI 参与 | 复杂块（database、synced block、embed）转换质量差 | ImportReport 逐块标级；AI 只做 proposal 级补全 |
| 简洁界面 = 隐藏低频操作而非删除功能 | 隐藏过深导致功能不可发现 | 原型任务完成率测试（复用 2026-08-05 验证计划） |

## 6. 候选方案

### 方案 A（推荐）：Notion HTML ZIP 主导入路径 + MD/CSV 备路径

1. **导入入口**：Library 的“导入”按钮，选择 Notion 导出 ZIP（可多选、可拖拽）；上传即创建导入任务并写 `ImportReport`。
2. **HTML 路径（保真主路径）**：
   - 递归解压（根级 zip 才递归，用户附加 zip 视为附件）；跳过 `index.html` 与 CSV。
   - 按文件名 UUID 建索引 → 页面顺序、父子关系、附件归属。
   - 每个页面 HTML：`page-body` → BlockNote 块树；内嵌属性 table → `library_properties`（映射 Notion 属性类型到本项目 property 类型白名单，未知类型进 `raw` 字段并标 “降级”）；图片/文件 → 附件表 + 链接重写；页面间链接 → UUID → `library_relations` 的引用关系；保留原始时间戳。
   - 数据库（CSV/board/calendar/gallery）→ 首期转为“表格块 + 属性行”，不建数据库视图引擎；`ImportReport` 标记“数据库视图降级为表格”。
3. **MD/CSV 备路径（有损但可用）**：
   - 解析每个 `.md`（文件名 UUID）；把 callout（blockquote+emoji）识别为 callout 块、把“toggle 标题 + 同缩进内容”启发式还原为折叠块（在报告中标“启发式”）；链接按 UUID 重写。
   - 报告列出每页损失项（toggle 展平、颜色丢失、embed 失效等）。
4. **产物与报告**：每个导入 Document 生成 revision；`ImportReport` 记录页数、块数、附件数、各损失类型计数与样例路径；原始 ZIP 存为来源证据（SourceAnchor 语义），不删除。

### 方案 B：Enhanced Markdown（Notion-flavored）中间表示

- 用 Notion API markdown 端点的扩展标签作为**内部无损中间表示**（callout/toggle/columns/mentions 显式化），供 HTML 转换、MD 转换与导出共用。
- 收益：多格式输入统一到一种无损失 IR，未来导出 Markdown 时也可复用。
- 成本：需要维护自有 IR 规范与转换器；Enhanced Markdown 本身是 Notion 私有扩展，格式细节以官方 API 文档为准，需 spike 验证稳定性。

### 方案 C：自绘自由画布（edgeless）投影

- 参考 BlockSuite：同一 Document 的另一种投影（surface 元素），不复制正文。
- 首期不实现：任意画布会引入坐标、缩放、元素类型与移动端适配的大块复杂度，超出当前资源；作为远期 spike（触发条件：用户样本中确有 ≥5% 笔记需要画布）。

## 7. 方案评估

| 维度 | A（HTML 主 + MD 备） | B（Enhanced MD IR） | C（edgeless 画布） |
|---|---|---|---|
| 目标效果 | 直接兼容 Notion 导出，保真度高 | 无损中间表示，多格式统一 | 自由排布上限最高 |
| 数据需求 | 无（用户导出即数据） | 需维护 IR 规范与转换 | 需坐标/缩放/元素模型 |
| 延迟/吞吐 | 导入为后台任务，可接受 | 多一次转换，可接受 | 交互复杂 |
| 成本 | 中（ZIP/HTML/属性/链接解析） | 中高（双格式转换器 + IR 维护） | 高（画布引擎） |
| 可解释性 | 高（ImportReport 逐块标级） | 高 | 中 |
| 隐私与安全 | ZIP 内容全本地解析，可审计 | 同左 | 同左 |
| 可迁移/可回滚 | 高（原始 ZIP 留档，可重导） | 高 | 中 |
| 扩展性 | 高（新格式=新解析器） | 高 | 中 |
| 失败降级 | 每页独立失败，报告标级 | 同左 | 复杂度高 |

## 8. 推荐结论

- 推荐：**方案 A**——Notion HTML ZIP 为保真主路径，MD/CSV 为有损备路径，均输出 `ImportReport` 并保留原始导出为证据；BlockSuite 式“同文档双投影”与 SiYuan 式块引用作为学习版教材的远期参考。
- 适用边界：个人/学习笔记迁移；数据库视图首期降级为表格块；embed 仅保留链接与标题。
- 暂不采用：方案 C（任意自由画布）与 Notion 数据库视图引擎；Enhanced Markdown IR（方案 B）待导入器落地后按需引入。
- 升级触发条件：真实导入样本中数据库/画布占比高、或用户明确要求 Notion 数据库视图保真。
- 回退方案：任何格式转换均可按报告回滚（不落库或删导入 Document），原始 ZIP 永不删除。

## 9. 验证计划

- 构造 Notion 示例导出（HTML ZIP 与 MD/CSV 各一套，覆盖 callout/toggle/columns/表格/图片/嵌套页/链接/属性），建立回归 corpus。
- 导入器单测：ZIP 递归解压、UUID 索引、属性提取、链接重写、损失标级；e2e：真实 ZIP 导入后 Library 中打开页面并核对块树与报告。
- 界面：复用 2026-08-05 方案 A 的“安静画布 + 按需菜单”验收场景，增加“导入后首次打开”任务；移动端无横向溢出。
