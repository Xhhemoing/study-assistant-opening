# 算法开发计划（工程版）

> **读者：** 算法与领域逻辑实现者、审查者。易懂版见 [OVERVIEW.md](OVERVIEW.md)，架构开发见 [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md)，证据原则见 [LEARNING_THEORY.md](../product/LEARNING_THEORY.md#8-帮助与证据本理论的核心)，测量口径见 [DECISIONS.md](../decisions/DECISIONS.md#测量口径原文保留)。
> **更新：** 2026-11-28，基线 `03e9b3de`。

## 0. 原则

1. **每个算法板块固定写四项：** 基线 → 候选 → 指标与晋升门 → 回退。
2. **评估路径：** 回放 / 金标 → 离线 → shadow → 小流量 → 全量；任何一步可回退。数据按用户与时间隔离，留出学习者评估。
3. **概率模型在校准前不面向用户**：`calibrated=false` 的输出只用于内部排序或 shadow；用户看到的是状态词与可执行的下一步。
4. **AI 只出候选，程序裁决证据资格**；未校准结论不累计也不重置连续计数（R1）。
5. **不删引擎，明确角色**（D14）：每个功能只有一条**权威路径**，其他实现标注为 shadow、离线工具或待接入，并在注册表中可查。
6. 线上模型不能自我修改；参数变更产生新版本，不改写历史结果。

## 1. 算法清单与成熟度

成熟度：A = 接运行时 + 离线评估；B = 接运行时 + 单测；C = 有实现 + 单测但无入口；D = 仅钩子。

| 组件 | 代码 | 运行时 | 评估 | 成熟度 |
|---|---|---|---|---|
| 帮助分级（只认已送达暴露） | `domain/opening/assistance.ts` | web attempt-service、observations | 单测 | B |
| 证据资格（独立、核验、版本、延迟） | `opening/evidence-eligibility*` | 16+ 仓储 | 7 测试 + fixtures | A- |
| 学习者状态（规则分档） | `learner-state`、`estimators/rules-estimator` | 状态卡、资产图 | 单测 | B |
| Shadow 预测（BKT/PFA/频率/FSRS 影子） | `learner-shadow-predictions`、`epistemic/shadow-v2` | learning-attempts（shadow） | 配对 Brier 描述 | B |
| FSRS 调度 + 恢复分流 | `srs/scheduler`、`srs/eligibility` | 卡片仓储、按时长复习 | 单测 | B |
| 测量插件 BKT（固定参数，48h/7d） | `opening/measurement` | `/settings/learning-test` | 511 序列穷举 | A（单人） |
| KST 诊断定位 | `diagnostic-placement` | 无 | 1 测试 | C |
| 自适应规划（提议、排序、局部重排） | `adaptive/*`、`next-learning-step` | adaptive-draft（开关关）；next-step 已接 tutor | 21 测试 | B/D |
| 决策账本 | `learning-decision` | learning-agenda | 单测 | B |
| 复测协议 | `retest-policy`、`retest-activity`、`retest-close-evidence` | worker retest、span 延迟复测 | 34 测试 | A- |
| 考试预测（运行版） | `exam-sprint/forecast` | 冲刺页 | 单测 | B |
| 考试预测（Split CQR、CRN ROI） | `exam-forecast/*` | 无 | 1 测试 | C |
| 元认知 / 认知信念（Brier、FIRe、72h Bellman） | `metacognition`、`epistemic` | 仅 shadow-v2 | 各 1 测试 | C |
| 符号等价（Sturm、子空间秩、408 C 解释器） | `symbolic-equivalence`、`symbolic-answer-bridge` | 待核（调研显示无运行时调用，STATUS 记为已接入教学判分） | 1 测试 | C/B 待核 |
| 证明反馈、精确有理数校验 | `opening/proof-feedback`、`span-verifier` | ai-grading、span 课程 | 单测 | B |
| 自动批改 + 量规校准 | `ai/answer-grading`、`rubric-calibration` | 批改已接 worker；校准钩子未注入 | 离线 grading-evaluation；未校准 | B/D |
| 知识图谱与技能身份 | `knowledge-graph`、`knowledge-node-identity`、`adaptive/skill-identity`、`course-shared-skill` | build-course-knowledge | 单测 | B |
| 检索（词法、混合 RRF、Sparse PPR、系统查询） | `ai/context`、`hybrid-retrieval`、`pedagogical-retrieval`、`system-query` | tutor 与编译 | 检索 fixtures、eval | A- |
| TutorGraph（Min-Entropy 预算、快速路径） | `ai/tutor-graph` | tutor-turn（有 anchorPurpose） | 1 测试 | B |
| 双时态错因记忆 | `v3-bitemporal-*` | tutor 只读 | 3 测试 | B（只读） |
| 教学编译（盲解、校验器） | `ai/teaching-compiler` | compile-teaching-unit | 60 样本 held-out | B+ |
| 卡带 SPI / IELTS / 408 / 讲回竞技场 | `opening/cartridges`、`ielts`、`teachback-arena` | 无入口 | 8+2+1 测试 | C |
| GEPA 编译器 / Stage-0 仿真器 | `ai/cartridge-compiler`、`stage0-simulator` | 离线工具 | 合成数据 | 内部工具 |
| 多模态（手写两阶段、语音计时） | `multimodal-evidence` | 钩子未注入 | 1 测试 | D |
| SenseWeave | `packages/senseweave` | assistant（shadow） | 遥测 | B |
| 商业韧性（三账本、漂移哨兵、租约） | `commercial-resilience` 等 | 无 | 各 1 测试 | 内部工具 |

## 2. 权威路径注册表（R0 建立）

| 功能 | 权威路径 | 其他实现的角色 |
|---|---|---|
| 证据资格 | `evidence-eligibility` | — |
| 学习者状态（面向用户） | `learner-state` 规则分档 | BKT/PFA/认知信念/测量 BKT/实验 BKT/KST：shadow 或离线 |
| 复习调度 | FSRS（`srs/scheduler`） | — |
| 下一步决策 | `nextLearningStep` | adaptive-draft（开关）、72h Bellman：shadow |
| 规划 | day-planner + learning-agenda + local-replan | long-term、adaptive、冲刺预算：按场景调用，须登记 |
| 判分 | 确定性判分器（答案键、有理数、证明结构；符号等价待核后纳入） | AI 批改：反馈，不计证据，直到校准 |
| 考试预测 | `exam-sprint/forecast` | Split CQR：shadow 对比 |
| 检索 | 混合检索（RRF + embedding）+ Sparse PPR | 词法 `selectContext`：降级路径 |

注册表落在代码中（单一模块导出各功能的权威实现与角色），并由测试保证面向用户的读取只走权威路径（L/H 视改动）。

## 3. 统一证据账本（R1–R2）

**问题：** 旧 `learning_events`/卡片、opening observations、测量插件三表、`exam_source_observations`、IELTS 回执、讲回记录各自成账；技能身份有“课程 + 要求 + 标签”与知识节点两套。

**方案：**
1. 不迁移历史数据；新增只读投影，把各来源映射到统一的“作答证据视图”（来源、帮助级别、判分类型、首答、版本、时间、技能身份）。
2. 新接线的卡带、讲回、拍照、录音一律写入 opening attempts + help_exposures 主链，不新开账。
3. 技能身份以 `course_requirements.stable_skill_id` 为准；知识节点通过显式链接映射；跨课共享维持只读投影，同名不自动合并。
4. 验收：跨入口回归（ARCHITECTURE_PLAN 5.1）+ 投影一致性测试（同一作答在今日、课程路线、资产图、复习中的证据级别一致）。

## 4. 分阶段算法工作

### R0
| 编号 | 工作 | 晋升门 / 验收 |
|---|---|---|
| G-1 | 自核进度：普通练习显示“已自核，可继续”，路线动作支持下一题/返回主线；掌握、复测、整课验收、北极星不变 | 现有自核集成测试 + 路线动作单测；独立已验证计数保持 0 |
| G-2 | 权威路径注册表（第 2 节） | 测试保证面向用户读取只走权威路径 |
| G-3 | 核实符号等价是否已接入教学判分；未接则列入 R1 | 调研记录 |
| G-4 | 跨入口证据回归（与架构 5.1 同一条） | 断言见架构计划 |

### R1
| 编号 | 工作 | 晋升门 / 验收 |
|---|---|---|
| G-5 | **批改校准计划**：收集所有者 10 道文字题金标与手写照片样本（D7）；注入量规校准钩子；输出按题型/模态/审核来源的 FP/FN、拒判、覆盖率与单侧 Clopper–Pearson 上界 | 误判上界达标前不计证据 |
| G-6 | **冷启动诊断**：KST 定位接入新课程首日，先 shadow（记录推荐与后续独立结果），再小流量 | 留出数据上推荐命中优于“从头开始”基线 |
| G-7 | **卡带证据门**：IELTS、408 接入后，作答写入主链；IELTS 写作口语为量规反馈 + 自核，不计掌握 | 卡带探针测试 + 投影一致性 |
| G-8 | **讲回竞技场**接入复述步骤：产出表达类证据（受助/独立按实际帮助） | 单测 + 集成测试 |
| G-9 | **多模态**：手写两阶段核验与语音计时钩子注入批改链；结果作为反馈，计证据须单独校准 | 校准报告 |
| G-10 | **FSRS 个性化核查**：确认 ts-fsrs 版本与 FSRS-6 的关系；评估是否在足够复习量后拟合个人参数 | 离线回放对比默认参数 |
| G-11 | **检索评测 harness**：Recall@k、MRR、引用命中、P95 延迟，对比三个基线；答案封存块不进入检索 | 指标不回退 |
| G-12 | **AI 输出跟随语言**：提示词与反馈的英文版本；英文资料上的编译与检索评测 | 英文 held-out 样本 |

### R2
| 编号 | 工作 | 晋升门 / 验收 |
|---|---|---|
| G-13 | 考试预测 shadow 对比：运行版 vs Split CQR，在有真实模考数据的人群上比较区间覆盖 | 覆盖率与区间宽度 |
| G-14 | 自适应规划在试用账号开启：L8 四指标（completionRate、suggestionAdoption、coachUndoRate、weakSkillLatencyDays） | 撤销率与采纳率不劣于手工 |
| G-15 | 元认知/认知信念 shadow 评估（Brier、空转检测） | 留出学习者上优于规则基线才晋升 |
| G-16 | 免费额度成本模型：按用途统计 token、缓存命中、重试；P50/P95 | 成本看板 |

### R3
| 编号 | 工作 | 晋升门 / 验收 |
|---|---|---|
| G-17 | M6 试验方案（被试内交叉，5–10 人起，只报可行性与效应量）；同意流程 | 所有者批准方案 |
| G-18 | 离线模型比较（D9）：多名真实用户后，用留出学习者比较规则 vs BKT/PFA/认知信念 | 预先声明指标；不达标输出 inconclusive |
| G-19 | 延迟独立与迁移结果数据集（7/30 天，经同意、去标识） | 数据集清单与删除级联 |

## 5. 评估资产

| 资产 | 现状 | 补充 |
|---|---|---|
| L0 评测集 | 76/76 | 随卡带扩充 |
| 批改金标 | 缺 | G-5 |
| 检索 fixtures | 有 | G-11 指标化 |
| 教学 held-out | 60 样本（秩/零空间） | 英文与其他学科 |
| 测量插件 | 单人 | beta 用户自愿参与 |
| 回放集（按用户/时间隔离） | 缺 | R2 起积累 |
| 7/30 天结果数据 | 缺 | G-19 |

## 6. 需保留的关键常数与规则

- 证据资格：首答固定；帮助后首答按真实提交顺序；只有独立且可判首答进入正确率分母。
- 复测：旧协议 ≥72 小时；候选间隔距目标日约 1/4，限 1–7 天（R4，待数据）；研究测验 7/30 天。
- 推进：现行连续 2 道首见题独立答对，候选 3 道（R3，待数据）。
- 题池：四池分开，每题族每人 ≥12 道未见题（R7）。
- 把握度：答前三档有序类别（R8）。
- 群体错步率：同课样本 ≥30 才计算；考点分析 Beta(1,1) 先验，少于 10 份标注“样本有限”。
- ADR-v3 内核常数：FIRe c ≤ ln1.2、72h Bellman、E ≥ 5 且 N−E ≥ 5、550ms 快速路径；Kerckhoffs 三法则（封存内容不进 PPR/导出、Respond 节点只拿公共能力、BYOK 不静默回退）。
- 错因 8 类中 material / ai / system 错误不计为学生能力问题。
- 不使用固定“学习风格”；不按响应时间硬判失误；不跨学科共享猜测/失误参数。

## 7. 已知风险

| 风险 | 对策 |
|---|---|
| 全部概率模型未校准 | 校准前不面向用户；shadow 积累 |
| 合成数据同源循环验证（仿真器、GEPA） | 仅作内部工具；晋升只看真实留出数据 |
| 引擎重叠导致不同页面结论矛盾 | 权威路径注册表 + 投影一致性测试 |
| 冷启动只能落到“未测” | G-6 KST shadow → 小流量 |
| 单人测量数据不足 | R2–R3 同意用户扩样；小样本只报效应量 |
