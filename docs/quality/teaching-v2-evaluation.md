# Teaching v2 评价与验收依据（V2-02）

**Date:** 2026-10-11（Asia/Shanghai）  
**Task:** V2-02 — 建立真实教学单元与评测样本  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`（`feat/opening-release`）  
**Plans:** `docs/plans/2026-10-11-ai-led-learning-v2.md` · `docs/superpowers/plans/ai-led-learning-v2/plan.md`（§5.1–5.3、V2-02）  
**Owners:** AI（教学样本 / 题库 / 答案键）· Experience（UI·交互验收线索）

## Purpose

为本波次 AI 主讲学习空间提供**独立于模型即时生成内容**的可回查评价与验收依据：

1. **教学样本与评测题**（AI）：首单元「秩与零空间」的目标、原材料、正确/典型错误例、未曝光评测隔离。
2. **UI / 交互验收线索**（Experience）：对照 G1–G8 与 §5.1–5.3，记录可检查的界面与交互期望，供 M1 实现与 Paula 浏览器验收对照；含 Paula 2026-10-11「嵌入现有程序 / 非旁路」约束（EX）。

本文件**不是**已实现 UI 的宣称，也不是学习效果已证实的声明。工程通过 ≠ 真实模型通过 ≠ 用户浏览器验收 ≠ 学习效果已知（见章程证据分层）。

## Evidence layers（勿折叠）

| 层 | 含义 | 本文件角色 |
|---|---|---|
| 工程 / fixtures | 样本、清单、隔离约定可人工核查 | M0 可验收的文档与目录约定 |
| 真实模型 | 生成教学是否按样本目标与核验规则 | AI 样本供后续 V2-08/09 对照 |
| 用户浏览器 | Paula 按清单操作桌面/移动 | Experience 线索标为「验收线索 / 后续实现对照」 |
| 学习效果 | 是否真正学会 | **unknown**；不在本文件宣称 |

## 标记约定

| 标记 | 含义 |
|---|---|
| `M0-sample` | 当前可用 fixtures / 本文档核查；不要求 UI 已上线 |
| `M1-ui` | 需后续 Experience（及依赖任务）实现后，再按本线索对照验收 |

---

## Experience / UI·交互验收

> **性质：验收线索 / 后续实现对照。**  
> M0 多数教学主讲 UI 尚未落地；下列条目用于约束 M1（尤其 V2-10/12/14/15/16）实现与 Paula 日后浏览器步骤。  
> **勿把本节省成「界面已存在」的证据。**


### EX. 嵌入现有程序 / 非旁路（Paula 约束 · 2026-10-11）

> Paula 补充（M0 文档与后续 M1 实现均按此勾选）：AI 主讲是**现有 Opening 主区演进**，不是旁路新 App；复用 Today / 助手 / 资料 / 证据账本与导航；新接口与组件接进现有契约与 Tailwind/lucide 样式；**不**平行造第二套事实或评分。

| ID | 可勾选线索 | 标记 | 对照 |
|---|---|---|---|
| EX.1 | AI 主讲落在**现有 Opening shell** 主区演进（今日 / 助手 / 资料等同一产品壳），不另起独立域名、独立安装包或「第二客户端」旁路 | `M0-sample`（文档禁止旁路）+ `M1-ui`（实现核对导航壳） | Paula-1；G8 |
| EX.2 | 导航仍走现有 Today / 助手 / 资料（及既有证据入口）信息架构；主讲入口是上述流内的「继续学习 / 开始学习」或活动主区，**不是**孤立营销页或强制新问卷向导 | `M0-sample` + `M1-ui` | Paula-3；E0；G1/G3 |
| EX.3 | 学习事实继续写入现有 Observation / Attempt / Exposure（及既定资格判定）；UI **不**展示第二套「AI 掌握分 / 平行进度条」冒充账本 | `M0-sample`（章程+本条）+ `M1-ui` | Paula-2；G6/G8；E5.2 |
| EX.4 | 新教学组件 / API 客户端接现有 contracts 与 Opening 样式约定（Tailwind 工具类 + lucide-react），不引入无关样式系统或平行 SDK 包装同一事实 | `M0-sample`（约定）+ `M1-ui` | Paula-2；plan §8；G8 |
| EX.5 | 材料选择、引用展开、证据详情复用既有资料库 / 助手选源 / 证据只读能力的入口语义，避免「主讲专用另一套材料箱」导致用户搬运上下文 | `M1-ui` | Paula-1；G2 |
| EX.6 | Feature flag / 内部试用开关落在现有发布与配置路径；关闭 flag 后用户仍能通过原导航使用非主讲能力，主讲数据可恢复/导出而非锁死旁路 | `M1-ui` | Paula-1；V2-16 回退精神 |

**M0 可立刻勾选（文档层）：** EX.1–EX.4 的「禁止旁路 / 禁止平行评分 / 入口落在现有首页与活动流」已写入本清单与章程对照；实现前无新壳代码可点。  
**M1 实现后勾选：** EX.1–EX.6 在桌面/移动上核对同一 shell、同一账本、无第二套掌握 UI。

### E0. 入口与主区布局（G1 · plan §5.1）

| ID | 线索（可检查） | 标记 | 对照 |
|---|---|---|---|
| E0.1 | 用户可从「开始一次学习 / 继续上次」进入 AI 主讲，**不必**先打开阅读器、先选页码或先翻材料选段 | `M1-ui` | G1 反例：必须先翻页选段才得到教学 |
| E0.2 | 支持以材料、主题、问题或目标进入；首屏不以填完问卷 / 先建课程为开讲前提 | `M1-ui` | G3；§5.1 |
| E0.3 | 桌面主区展示**当前教学活动**；小范围提纲、追问/换解释/自己试试在活动附近；原材料与依据按需展开 | `M1-ui` | §5.1 |
| E0.4 | 移动端保持同一活动语义，不把桌面三列简单缩窄堆叠；首页优先继续/开始，计划提醒为辅助 | `M1-ui` | §5.1 |
| E0.5 | 首屏不要求用户理解 KnowledgeNode、workspace graph、模型参数、评估权重等内部概念 | `M1-ui` | §5.1 |

**M0 文档核验（`M0-sample`）：** 章程与 plan §5.1 已写明「阅读器先行」不可作为本版本交付；本清单将入口期望固化为 Experience 对照项。实现前无产品 UI 可点。入口须同时满足 **EX**（嵌入现有 Today/助手/活动流，非旁路新 App）。

### E1. 首单元样例流程线索：秩与零空间（G1、G2、G5 · §5.3）

样例变换：\(T(x,y)=(x+y,0)\)。下列为**交互路径线索**，教学内容正文与答案键由 AI 样本提供。

| ID | 流程步骤 / 用户动作线索 | 标记 | 说明 |
|---|---|---|---|
| E1.1 | 引入：展示 \(T(x,y)=(x+y,0)\)，引出「二维输入为何只剩一个输出方向」 | `M1-ui` + 内容依赖 AI `M0-sample` | 开讲即问题驱动，非先读长讲义 |
| E1.2 | 观察：输入与变换结果（互动或静态等价）→ 再讲零空间与像的关系 | `M1-ui` | 观察先于形式定义 |
| E1.3 | 呈现正式定义 + 计算示范 | `M1-ui` | 定义与计算可回看 |
| E1.4 | 用户可请求：**更直观** / **更多证明** / **完整讲解** / **用英文术语** / **跳过**某活动 | `M1-ui` | 局部改表达，不整节重生成整课（G5） |
| E1.5 | 追问、换解释、「自己试试」控件在当前教学块附近，不强制离开当前活动上下文 | `M1-ui` | V2-10 验收精神 |

**M0（`M0-sample`）：** AI 应在 fixtures / 本文件 AI 区提供与上述步骤对齐的目标、符号约定与例题；Experience 不代写题库。流程顺序作为 UI 故事板依据写入本表即可。

### E2. 图文参数一致（G5 · §5.3、V2-15）

| ID | 线索 | 标记 |
|---|---|---|
| E2.1 | 矩阵变换互动中：矩阵、输入向量、输出向量与**文字结论**读**同一参数模型**；改一处参数，图与文同步 | `M1-ui` |
| E2.2 | 图示与公式不由模型分别独立编造两套数值；无法正确渲染时回退静态表达并保留用户状态 | `M1-ui` |
| E2.3 | 低动效 / 键盘步进 / 文字替代可用；不只靠颜色编码传达关键结论 | `M1-ui` |

**M0（`M0-sample`）：** 在 AI 样本或本文件注明样例参数（如 \(T\) 的矩阵形式与一组输入向量）作为日后一致性对照金标准；实现前可用纸面/表格核对「同一参数」。

### E3. 引用与依据诚实展示（G6 · §5.2、V2-06/09）

| ID | 线索 | 标记 |
|---|---|---|
| E3.1 | 材料性主张旁有可打开的来源锚点（sourceId+version+chunk / 页或时间）；点击可回查，无死链、无占位假引用 | `M1-ui` |
| E3.2 | UI **区分**「材料依据支持」与「一般知识讲解/补充」徽章或等价文案；无材料时不伪造参考文献 | `M1-ui` |
| E3.3 | 核验状态可见：结构通过 ≠ 事实已核验；未核验内容不伪装成权威讲解或正式评分依据 | `M1-ui` |
| E3.4 | 来源撤回或隐私排除后，界面不继续展示为有效引用，也不从缓存「回流」已删材料片段 | `M1-ui` |

**M0（`M0-sample`）：** 评价标准写明：有引用 ID ≠ 事实正确；Experience 验收以「能否打开真实锚点 + 徽章语义」为准，不以「页面上出现引用样式」为准。

### E4. 未曝光评测题隔离（G6 · V2-02 验收硬约束）

| ID | 线索 | 标记 |
|---|---|---|
| E4.1 | 标记为未曝光 / hold-out 的评测题**不得**出现在：教学生成检索上下文、聊天「选材料」列表、主讲活动默认素材包 | `M0-sample`（目录/约定）+ `M1-ui`（运行时 picker） |
| E4.2 | 教学素材夹与评测夹在 fixtures 分目录或等价 manifest 字段隔离；README / AI 区写明哪些 id 禁止进入 teaching retrieval | `M0-sample` |
| E4.3 | 浏览器侧：材料选择器与「插入教学依据」若列出评测题 → **失败**；独立测验入口可另开，但不回灌主讲检索 | `M1-ui` |

### E5. 暂停与恢复（G7 · §5.3、V2-14）

| ID | 线索 | 标记 |
|---|---|---|
| E5.1 | 暂停后恢复：同一活动、当前块/互动参数、**用户草稿**、**已提供的具体帮助**、**尚未核验的能力/未决问题** | `M1-ui` |
| E5.2 | 恢复界面**禁止**展示伪造掌握百分比（如「你已掌握 90%」）或把完成活动自动升为掌握 | `M1-ui` |
| E5.3 | 恢复不只是聊天窗滚动位置；可立即继续的动作（追问 / 再试 / 跳过）仍可用 | `M1-ui` |
| E5.4 | 另一设备继续时语义与桌面一致（同活动权威在服务端） | `M1-ui` |

### E6. 自主跳过 / 无强制先测（G3）

| ID | 线索 | 标记 |
|---|---|---|
| E6.1 | **无**「先完成测验才允许阅读/听讲」门禁 | `M1-ui` |
| E6.2 | 任意活动可跳过或退出；跳过不丢已写草稿与已发生教学记录 | `M1-ui` |
| E6.3 | 「本次直接讲，不要考我」类偏好立即生效于当前范围 | `M1-ui` |

### E7. 生成失败与草稿保全（G7）

| ID | 线索 | 标记 |
|---|---|---|
| E7.1 | 生成失败 / 超时 / unknown **不得静默丢弃**用户草稿与断点；有明确错误态与可重试 | `M1-ui` |
| E7.2 | 生成中刷新：通过已持久任务恢复，不因刷新重复扣账或清空输入中草稿 | `M1-ui` |
| E7.3 | 版本冲突时显式提示并列保留，不静默覆盖本地未发送草稿 | `M1-ui` |

### E8. Paula 浏览器验收笔记（诚实边界）

> 按 AGENTS：浏览器验收由用户执行。下列为**建议日后步骤**，不是本轮已执行结果。

**桌面（建议 Chrome/Edge ≥1024px，如 1440×900）— 待 M1 主讲入口可用后：**

0. 从**现有** Opening 今日/助手入口点「继续学习 / 开始学习」→ 仍在同一 shell，无跳到旁路新 App；导航仍见资料/证据入口（EX）。
1. 不打开原阅读器，从「开始一次学习」进入秩与零空间样例 → 是否直接出现教学活动（E0、E1）。
2. 点「更直观 / 更多证明 / 跳过」→ 是否局部更新且不整页跳位（E1.4）。
3. 改互动参数 → 矩阵/向量/文字是否一致（E2）。
4. 打开引用 → 能否落到真实材料位置；无材料讲解是否带「一般说明」而非假文献（E3）。
5. 确认材料选择器中**看不到** hold-out 评测题（E4）。
6. 写一段草稿 → 暂停 → 刷新或换端继续 → 草稿与帮助记录在，且无假掌握条（E5）。
7. 跳过检查点 / 选择不要测验 → 仍可听讲与退出（E6）。
8. 断网或触发失败生成 → 草稿仍在，有错误提示（E7）。

**移动端：** 同活动可继续；控件可点可读；不依赖悬停才露出「追问/跳过」。

**M0 现状（诚实）：** 多数上述表面尚未实现 → 本轮只交付线索与样本边界；`user_browser` 保持 `pending_user`，不得改为 verified。

### E9. 与 G1–G8 速查

| Goal | 本文件主要线索 |
|---|---|
| G1 AI 主讲 | EX、E0、E1 |
| G2 完整陪伴 | EX.5、E1 流程、E5 恢复连续 |
| G3 用户自主 | EX.2、E0.2、E6 |
| G4 可靠个性化 | E6.3（显式偏好）；推测性适应不在 M0 UI 范围 |
| G5 合适表达 | E1.4、E2、EX.4（样式约定） |
| G6 证据诚实 | EX.3、E3、E4 |
| G7 连续恢复 | E5、E7 |
| G8 增量可靠 | EX 全组；本文件不改生产代码；不平行事实/评分 UI |

---

## AI：教学样本 / 题库 / 答案键

> **Experience 不填充本区。** 下列由 **AIstudy AI**（V2-02）写入。  
> Experience UI 节（上文 EX、E0–E9）**保留不删**。夹具根路径：`tests/fixtures/opening/teaching/unit-rank-nullspace/`。

### 1. 元信息

| 项 | 值 |
|---|---|
| Task | V2-02 |
| Baseline tip | `1a4cf465c86da7f08b6fda3044f9b0f932b80824`（`feat/opening-release`） |
| 单元 | `rank-nullspace-v1`（秩与零空间 / Rank and Nullspace） |
| Fixtures | `tests/fixtures/opening/teaching/`（见该目录 README） |
| 本文件 | `docs/quality/teaching-v2-evaluation.md` |
| Owners | **内容/评测标准** = AIstudy AI；**UI/交互验收线索** = AIstudy Experience（上文已落盘，AI 不代写/不覆盖） |
| Charter | G1、G2、G5、G6 |
| 依据源 | R01、R02、R04、R05、C11 |
| 生产代码 | **无改动**（本任务仅 fixtures + 本文档 AI 区） |

### 2. 内容标准

1. **符号约定：** 以 `unit-rank-nullspace/symbols.md` 为准（$A\in\mathbb{R}^{m\times n}$，$N(A)$，$\mathrm{Col}(A)/\mathrm{Im}(A)$，$\mathrm{rank}$，$\mathrm{nullity}$，rank-nullity $=n$ 列数；向量列写；RREF；左零空间仅显式需要时）。
2. **目标覆盖：** `goals/teaching-goals.json` 中 G-RN-01…06 覆盖几何洞察、定义、$N$/rank 计算、rank-nullity 陈述/应用、维数关系解释、帮助 vs 独立。
3. **可回查主张：** 讲解用材料性主张须带 `sourceId` + `page` + `chunkId`（见 `materials/sources-index.json`）；无锚点则标为一般说明，不伪造文献。
4. **Lecture vs held-out 隔离：** `lecture/retrieval-allowlist.json` 仅含 SRC-RN-* 与 EX-RN-*；`eval-heldout/` 全部 problemId 在 `retrieval-denylist.json`；对照上文 **E4**。硬规则见 `eval-heldout/ISOLATION.md`。
5. **禁止伪造掌握率：** 恢复/反馈不得展示无核验「掌握 xx%」（对照 E5.2、ERR-RN-09、AN-RN-08）。
6. **帮助 vs 独立：** 受助正确 ≠ 独立掌握（G-RN-06、EX-RN-11）。
7. **citation ID ≠ 已核验真理**（ERR-RN-06、AN-RN-06）。
8. **换数 ≠ 迁移**（ERR-RN-04、AN-RN-07）；独立迁移题只在 held-out。

样例弧（plan §5.3）：$T(x,y)=(x+y,0)$ → 观察 → 联系 $N$ 与像 → 定义 → 计算示范 → 可选自测（仅 lecture 暴露例）。活动提纲：`lecture/activity-outline.json`。

### 3. 评测标准（独立于生成内容）

评分金标准住在 fixtures，**不**由模型自我打分作为唯一依据。

| 维度 | 如何判 | 金标准位置 |
|---|---|---|
| concept | 定义/判断与 `symbols.md` 一致；能区分 $N$ 与 $\mathrm{Col}$ | held-out / lecture examples 的 gold + rubric |
| compute | 主元/自由变量计数正确；基可差非零倍数；rank+nullity=$n$ 自洽 | 同上 |
| explain | 因果/几何解释完整；不只默写公式 | rubricZh |
| transfer | 新矩阵结构或新情境；禁止 ID 替换与 trivial number-swap | held-out `dimension: transfer` |
| delayed | 延迟窗口合格后再评；**分母规则见 plan §9.1** | `HO-RN-14` 等 |

**§9.1 延迟效果口径（摘要，勿选对再进分母）：**

- 先定义合格观察条件（题目/版本适用、延迟窗口、帮助状态可解释、结果已适当核验）；**条件不得包括「做对了」**。
- 条件正确率 = 合格观察中正确次数 /（合格中正确+错误）。
- 同时报告邀请/到期、参与、缺失、受助、版本失效、过早、无法核验；空分母为 **unknown**，不是 0% 或 100%。

**工程样本集 pass/fail（本任务）：**

- JSON 可解析；held-out 均在 denylist；held-out id 不在 allowlist；examples/goals 的 sourceId 均存在于 sources-index。
- 人工可勾目标覆盖、符号一致、答案抽查、隔离、异常案例存在。
- **不**宣称学习效果；**不**发明浏览器/CI 通过结果。

**未能核验项：** 见下文「人工核查记录」；有则诚实列出。

### 4. 样本清单

| 文件 | 内容 | 数量 |
|---|---|---|
| `materials/SRC-RN-01…05-*.md` | 可授权讲解原材料 | 5 sources |
| `materials/sources-index.json` | 源索引 + chunkHints | 14 chunks |
| `goals/teaching-goals.json` | 教学目标 | 6 |
| `examples/correct-examples.json` | 讲解正例 | 12 |
| `examples/typical-errors.json` | 典型错误 | 10 |
| `lecture/activity-outline.json` | §5.3 活动序 | 7 activities |
| `lecture/retrieval-allowlist.json` | 教学检索白名单 | 5 sources + 12 examples |
| `eval-heldout/heldout-problems.json` | 未曝光题 | 15 |
| `eval-heldout/retrieval-denylist.json` | 检索黑名单 | 15 problemIds |
| `eval-heldout/ISOLATION.md` | 隔离硬规则 | — |
| `anomaly-cases/cases.json` | 异常夹具 | 9 |
| `manifest.json` / `symbols.md` | 元数据与符号 | — |

**countableSamples** = chunks + correctExamples + typicalErrors + heldoutProblems + anomalyCases = **14+12+10+15+9 = 60**（工程建议区间 30–60）。

### 5. 人工核查记录

| 检查项 | 结果 | 备注 |
|---|---|---|
| 目标 G-RN-01…06 覆盖几何/定义/计算/定理/解释/帮助独立 | Y | 见 teaching-goals.json |
| 符号与 symbols.md 一致 | Y | 讲解与金标准统一 $N(A)$ / Col / rank-nullity |
| 讲解例与 held-out 计算题抽查（含钩子、$B$、$C$、HO-03/04/10/13/15） | Y | 用 SVD/秩核验；基允许差倍数 |
| held-out 与 lecture allowlist 隔离 | Y | 见 sanity 脚本；ISOLATION.md |
| 异常类别覆盖（同页跨源、错公式、缺页、重命名、仅音轨、citation、换数当迁移、假掌握率） | Y | cases.json |
| 无真实学生数据 | Y | 合成夹具 |
| UI/浏览器验收 | — | **Experience 域**；上文 E8 为线索，非本轮已测结果 |
| 学习效果 | — | **unknown**；不宣称 |

#### 未能核验项

- 无（本轮 AI 对夹具内矩阵秩/零空间金标准已本地数值抽查；未做真实模型教学生成评测，亦未做用户浏览器验收——后者属 Experience / Paula）。
- 延迟效果正式试验设计与缺失处理不在本任务范围；仅固化 §9.1 口径指针。

### 6. UI/交互验收线索（Experience）

> **本节正文见上文「Experience / UI·交互验收」（EX + E0–E9）。**  
> AI **不**覆盖、不删改该节。合交时以 Experience 落盘内容为准。

### 7. 合交 Integrator

- 本任务交付：**fixtures + 本文档 AI 区**；**无生产代码**。
- 与 Experience **联合 Accept**（Experience UX 节已落盘；AI 样本与隔离已落盘）。
- **勿 self-Accept** 为「UI 已上线」或「学习效果已知」。
- 勿改 `docs/superpowers/plans/**/tasks.json` 账本状态（除非 Integrator 另授）。
- 回退：移除试验样本即可；不删除用户材料。


## Coordination notes

| 角色 | 写入 | 不写入 |
|---|---|---|
| Experience（本半） | 上文 Experience / UI·交互验收（含 EX 嵌入非旁路）；fixtures README 边界说明；本骨架 | 题库、答案键、生产 React；旁路新 App |
| AI | 上文 AI 区与 `tests/fixtures/opening/teaching/` 内容样本 | 勿删 Experience 节；勿把 hold-out 题放进 teaching retrieval 包 |
| Integrator | Accept 工程文档半；不改 opening-release 已 verified 账本 | 勿将本文件当作 UI 已上线证据 |

**姊妹文档：** 本轮优先单文件。若 AI 样本极长导致难读，可另拆 `docs/quality/teaching-v2-ui-acceptance.md` 并与本文件双向链接；当前**未拆**。

## Change log

| 日期 | 作者 | 变更 |
|---|---|---|
| 2026-10-11 | Experience | 创建全文骨架 + Experience UI·交互验收线索（V2-02 Experience half）；AI 区占位 |
| 2026-10-11 | Experience | 增补 EX「嵌入现有程序 / 非旁路」（Paula 约束）；更新 E0/E8/E9 交叉引用 |
| 2026-10-11 | AI | 填入 AI 区（内容/评测标准/样本清单/核查）；落盘 unit-rank-nullspace fixtures；README 追加 inventory（保留 Experience 边界） |
