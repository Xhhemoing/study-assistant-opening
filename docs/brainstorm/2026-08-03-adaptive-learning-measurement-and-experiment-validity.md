---
title: 延迟学习成果的测量、实验与因果有效性
date: 2026-08-03
status: proposed
scope:
  - Assessment / Learn / Planner / Experiment / Worker
  - ConstructMap / MeasurementPlan / ProbeForm / PolicyBundleVersion / OutcomeObservation
  - 7/30 天独立完成、保持与迁移结果
related:
  - 2026-08-02-adaptive-learning-decision-governance.md
  - ../architecture/DATA_MODEL_AND_PREDICTION.md
  - ../product/UX_AND_AI_POLICY.md
  - ALGORITHM_MAP.md
promotion_target:
  - PRD 的学习结果定义和试点验收指标
  - Assessment / Experiment / LearningEvent 设计
  - ConstructMap / Probe / Outcome / Analysis Schema
  - 实验、金标和测量治理 ADR
---

# 延迟学习成果的测量、实验与因果有效性

> 本文是[自适应学习决策、记忆与持续校准系统](2026-08-02-adaptive-learning-decision-governance.md)的测量协议候选。它不批准任何线上实验，也不把 7/30 天指标预设为已经可测。

## 0. 提案结论

在建设模型路由、帕累托计划或策略学习之前，先运行一个不做自适应干预的纯测量试点，验证五件事：

1. `same-task / transfer / independent` 的构念定义是否能被专家和数据稳定区分；
2. 7/30 天独立探针是否有可接受的完成率、题目覆盖和测试反应性；
3. 缺失数据在何种假设下仍允许形成方向性结论；
4. 早期用户规模能检测的最小效应是多少，是否值得投入复杂策略；
5. 评估单元、实验单元和归因窗口能否把策略束影响与单次决策诊断分开。

若上述测量门不成立，后续治理系统只能稳定地优化噪声。Phase 0 的输出不是“哪个 AI 最好”，而是一份可复用、可审计、能说明效度边界的 `MeasurementPlan`。

## 1. 决策问题

主提案把“时间预算内的 7/30 天独立完成和迁移表现”设为一级目标。该目标要成为发布门，必须先回答：

- 系统实际上观察到的“独立”是什么；
- 如何避免自然复习、测量探针和干预相互污染；
- 不同实验组怎样使用可比较但不泄漏的题目；
- 高缺失、测试效应和多次决策共同作用时怎样分析；
- 在样本量有限的早期阶段，哪些结论可以说，哪些必须保持未知。

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 新目标测量、1 至 3 天代理探针、7/30 天独立验证、试点研究 |
| 产品入口/流程 | Learn 中的短探针、Assessment 状态、实验退出、结果说明 |
| 领域对象 | `ConstructMap`、`MeasurementPlan`、`ProbeForm`、`ProbeExposure`、`PolicyBundleVersion`、`OutcomeObservation`、`AnalysisPlan` |
| 代码边界 | `packages/contracts` 契约；`packages/domain` 测量资格；`apps/worker` 调度；`apps/web` 用户交互 |
| 计划任务 | 在自适应路由和策略优化前完成 Phase 0 测量试点 |
| 暂不包含 | 临床/人格诊断、隐蔽监考、把一次探针结果解释为长期能力真相 |

## 3. 不变量与效度边界

- 应用只能直接观测 `in_app_independent_completion`，无法知道用户是否在其他设备或应用中使用外部 AI、搜索或他人帮助；
- 不使用隐蔽监控、摄像头或未经同意的切屏追踪来制造“绝对独立”假象；
- 锁定式验证只允许在用户明确同意、无障碍兼容且目的清楚的受控试点中使用，结果仅作敏感性分析；
- 探针本身会产生 testing effect，因此探针曝光必须进入事件和分析模型；
- 自然复习题可以更新用户状态，但不能默认承担实验归因；
- 测量模型、构念映射、题目版本、提示资格、时间窗口和分析规则全部版本化；
- AI 评分和自动量规只能是经校准的评估器，不是无条件真值；
- 高缺失、低功效或构念不稳定时输出 `inconclusive`，不靠更复杂模型掩盖不可识别性。

## 4. 已验证事实

- 用户已明确把 7/30 天独立完成与迁移置于计划完成率和满意度之前；
- 项目已有不可变 `LearningEvent`、能力切片和模型/策略/证据快照原则；
- 当前主提案已要求按用户和时间隔离数据、记录延迟结果缺失状态，并预注册主指标和停止条件；
- 当前主提案尚未完整定义独立测量层、构念版本对象、缺失敏感性分析和策略束级归因。

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| 用户会在 7/30 天完成短探针 | 结果缺失且 MNAR | 测量试点，报告组间响应率、响应模型和敏感性边界 |
| 平行题组测量同一构念 | 题组难度差导致伪效果 | 专家标注、锚题、等值分析和实证区分度 |
| 应用内独立能代表真实独立 | 外部工具不可见 | 自报、明确同意的受控模式和敏感性分析 |
| 探针负担足够低 | 提醒和测试本身改变学习 | 比较探针长度、频率、轮换和退出率 |
| 30 天结果能在早期产品中检测策略差异 | 样本量和等待时间过大 | 基线方差、流失率和 MDE/功效计算 |
| 用户内交叉能提升功效 | carryover 使周期不可比较 | 预设 washout、构念分区或改用 cluster/switchback |
| AI Judge 能可靠评分开放式迁移 | 长度、格式和模型族偏差 | 人工金标、一致性、反事实格式扰动和漂移探针 |

## 6. 候选测量方案

### 方案 A：自然复习即测量

直接使用策略推荐的复习题作为延迟结果。实现简单、用户负担低，但策略决定测什么，实验组之间题目不可比，容易教探针和产生选择偏差。

### 方案 B：政策层与独立测量层分离，推荐

- 政策相关层用于日常状态更新和个性化；
- 测量层从版本化构念空间独立抽样；
- 实验组使用经等值验证的平行题组；
- 稀疏调度、轮换和曝光记录控制测试效应；
- 策略束级实验结果与决策级诊断分开。

### 方案 C：外部标准化测验

定期使用独立标准化测试。可比性较强，但成本、授权、覆盖和用户负担高，且不一定贴合用户的实际目标和时间预算。适合作为少量外部效度校验，不适合作为默认闭环。

### 6.1 方案比较

| 维度 | A 自然复习 | B 双层测量 | C 外部测验 |
|---|---|---|---|
| 用户负担 | 低 | 低至中 | 高 |
| 因果可比性 | 低 | 中高 | 高 |
| 目标贴合 | 高但受策略污染 | 高 | 取决于测验 |
| 测试效应控制 | 弱 | 可显式控制 | 可控制但成本高 |
| 工程成本 | 低 | 中 | 中高 |
| 推荐用途 | 状态更新 | 主实验与产品校准 | 外部效度抽查 |

## 7. 核心版本对象

| 对象 | 作用 | 关键版本边界 |
|---|---|---|
| `ConstructMap` | 定义能力切片、先修关系和 same/near/far transfer | 专家规则、内容范围、版本生效窗 |
| `MeasurementPlan` | 固定目标、窗口、抽样、缺失和分析规则 | 每个试点/实验不可变 |
| `ProbeItemVersion` | 保存题目、量规、难度、模态和泄漏状态 | 内容变化即新版本 |
| `ProbeForm` | 组织平行题组、锚题和构念覆盖 | form 级等值报告 |
| `ProbeAssignment` | 决定何时给哪个 form | assignment seed、时区、窗口 |
| `ProbeExposure` | 记录看过、提示、答案、跳过和外部帮助自报 | 影响资格和测试效应 |
| `PolicyBundleVersion` | 作为实验处理的完整策略束 | 路由、计划、支架和 UI 组合 |
| `ExperimentAssignment` | 稳定分桶及随机化单元 | experiment salt、unit、arm |
| `OutcomeObservation` | 保存结果、资格、缺失和归因窗 | 观察事实 |
| `AnalysisPlan` | ITT、敏感性、序贯和多重比较规则 | 看数据前冻结 |
| `GoldenSetVersion` | 人工标注和评估器校准集 | 与训练/检索隔离 |

### 7.1 ConstructMap

```json
{
  "construct_map_version": "algebra-transfer@0.1.0",
  "constructs": [
    {
      "construct_id": "linear-equation-procedure",
      "ability_slices": ["procedural_execution", "transfer"],
      "prerequisites": ["symbolic-equivalence"],
      "transfer_levels": {
        "same": "new coefficients and surface form",
        "near": "new representation or word-problem context",
        "far": "combined with a distinct concept or tool"
      }
    }
  ],
  "expert_review_version": "panel@1",
  "effective_from": "timestamp"
}
```

构念图不是知识图谱的同义词。它只表达本次测量要区分的能力、任务和迁移级别，并需要独立效度研究。

### 7.2 MeasurementPlan

```json
{
  "measurement_plan_id": "uuid",
  "construct_map_version": "algebra-transfer@0.1.0",
  "primary_estimand": "policy_bundle_effect_on_30d_in_app_transfer",
  "windows": {
    "7d": {"target_hours": 168, "tolerance_hours": 24},
    "30d": {"target_hours": 720, "tolerance_hours": 72},
    "timezone_policy": "timezone_at_assignment"
  },
  "sampling": "construct-stratified-parallel-form",
  "missing_data_plan": "ipw_plus_pattern_mixture_and_manski_bounds",
  "analysis_plan_version": "analysis@0.1.0",
  "frozen_at": "timestamp"
}
```

## 8. 政策层与测量层分离

### 8.1 政策相关层

- 题目由当前计划、遗忘风险和能力状态选择；
- 结果用于更新用户状态和改善当次计划；
- 可以频繁、个性化和自适应；
- 不直接作为策略间无偏比较的主结果。

### 8.2 独立测量层

- 从 `ConstructMap` 覆盖空间按预注册方案抽样；
- 分配不读取当前实验臂的策略内部评分；
- 各组使用经等值验证的平行题组和共享锚题；
- 在保证覆盖的前提下稀疏化，控制用户负担和测试效应；
- 允许用户退出，退出和未响应进入结果分析。

### 8.3 探针反应性控制

- 同一题目版本不重复承担基线和结果测量；
- 记录所有曝光、提示、答案揭示和相似题接触；
- 轮换 item bank，并限制单构念测量频率；
- 对测量组与低频测量组做小规模比较，估计 testing effect；
- 探针完成后产生的学习收益归入后续窗口，不回写为该探针之前策略的效果。

## 9. 独立完成与迁移的资格

### 9.1 应用内独立

```text
in_app_independent =
  no_answer_reveal
  and hint_level <= plan.allowed_hint_level
  and no_in_app_ai_assistance_above_threshold
  and rubric_pass
  and exposure_rules_pass
```

该定义不声称观测到所有外部帮助。对外部 AI/搜索只能通过可选自报和明确同意的受控验证估计敏感性。

### 9.2 迁移等级

- `same`：同一构念、未见过样本、表面参数变化；
- `near_transfer`：表示、情境或步骤组合发生变化；
- `far_transfer`：需要在新情境中识别并组合多个构念；
- `out_of_scope`：专家和数据都无法确认构念对应，不进入主结果。

迁移级别由 `ConstructMap` 和题目版本共同决定，不能由生成模型在评分时临时判断。

## 10. 测量模型族与可识别性

### 10.1 Phase 0 基线

在数据量有限时，使用可解释的分层 logistic/Rasch-like 基线：

```text
logit P(success) =
  user_construct_state
  - item_difficulty
  + hint_and_assistance_effect
  + time_and_fatigue_covariates
  + form_and_version_effect
```

模型目标是拆分用户状态、题目难度和帮助效应，不是输出一个全局掌握度。若锚题不足或参数不可识别，保持规则分档和宽不确定区间。

### 10.2 升级路径

- 题量和样本充分后比较 Rasch、2PL/partial-credit 和分层 logistic；
- 序列变化可比较 BKT-lite、显式衰减或状态空间模型；
- 只在跨时间预测和校准显著改善时引入更复杂模型；
- 每个模型必须在新 item、用户和未来时间切片上验证。

### 10.3 时长模型

计划可行性依赖 `estimated_minutes`，需要独立校准：

- 使用 log-normal、quantile regression 或分桶经验分布做基线；
- 特征区分任务类型、模态、设备、帮助层级和用户历史；
- 报告 MAE、pinball loss、P50/P90 coverage 和系统性高估/低估；
- 预算约束使用保守分位数，不只使用平均时长。

## 11. 缺失数据计划

7/30 天缺失很可能是 MNAR，记录 `missing_reason` 只是第一步。

### 11.1 必报结果

- 每组分配、送达、打开、开始、完成和有效探针人数；
- 各阶段响应率差异及置信区间；
- 退出、目标变化、提醒关闭、技术失败和过期分别统计；
- 缺失与基线状态、此前结果和实验臂的关系。

### 11.2 主分析与敏感性分析

```text
主分析: ITT on observed outcome with prespecified response adjustment
辅助: inverse probability weighting, if overlap and response model are credible
敏感性: pattern-mixture scenarios
边界: Manski-style best/worst plausible bounds
```

IPW 不能自动解决 MNAR。最终报告必须说明：在多差的未观测用户结果假设下，结论会反转。

### 11.3 熔断讨论

以下情况不继续解释效果大小：

- 实验组与对照组响应率差异超过预注册伤害边界；
- 响应模型缺乏重叠，权重极端不稳定；
- 敏感性分析在合理假设下频繁改变结论方向；
- 探针负担本身显著提高退出或焦虑信号。

## 12. 统计功效与评估单元

### 12.1 先做现实检验

Phase 0 先估计：

- 基线成功率和用户间/构念间方差；
- 7/30 天响应率及其衰减；
- 平行题组可靠性和 item variance；
- 期望最小有意义效应；
- 可用用户数、实验周期和运营成本。

基于这些量计算 MDE 或达到目标功效需要的样本量。若 30 天 5 个百分点差异需要远超产品可达规模，应降低实验频率、先验证更大策略差异或使用更高效设计，而不是假装短期代理已经足够。

### 12.2 评估单元

发布决策的处理对象默认是 `PolicyBundleVersion`，不是单个 `decision_id`：

```text
PolicyBundle =
  route policy
  + assistance policy
  + plan policy
  + retrieval policy
  + relevant UI behavior
```

单次决策到结果的关联用于诊断、异质性和信用分配，不直接声称一次建议造成了 30 天效果。

### 12.3 高效实验设计

- 默认并行组，避免学习干预 carryover；
- 目标和内容可分区时，可考虑用户内 crossover，并预设 washout；
- 排程或周期性策略可用 switchback，但必须处理时间趋势；
- 班级、共享内容或社交传播明显时按 cluster 随机化；
- 使用贝叶斯序贯或 alpha-spending 边界，禁止反复窥视后随意停止。

## 13. 用户在环的两层 propensity

用户从帕累托候选中做选择时，处理机制包含两层：

1. `set_propensity`：系统生成和展示某个候选集合的概率；
2. `choice_probability`：在给定集合、顺序和默认项下，用户选择某项的条件概率。

决策账本至少记录：

```text
eligible_universe
generated_set
shown_set and order
default_highlight
set_propensity
user_choice
selection_actor
ruleset/action_space_version
```

受控随机化优先作用于系统可控的集合构成或顺序层，不强迫用户选择。OPE 只在 ruleset、行动空间和 propensity 支持可比的窗口内进行。

## 14. 干扰、污染与归因窗口

### 14.1 干扰假设

交错练习、共享题目和同伴传播会违反 SUTVA。每个实验必须声明：

- 同一用户不同任务间允许何种干扰；
- 班级、课程或共享 workspace 是否可能互相影响；
- 是否需要 `user x goal episode`、班级或时间段作为随机化单元；
- 结果解释适用于哪个干扰假设。

### 14.2 稳定分桶

```text
assignment = hash(experiment_id, experiment_salt, randomization_unit_id)
```

`User ID` 单独哈希不足以防止班级或内容网络效应。跨设备一致性由稳定随机化单元保证，实验 salt 和分桶算法进入配置快照。

### 14.3 平行题组与泄漏

- 实验组和对照组使用不同但经锚题等值的平行 forms；
- 高敏感题目不进入普通检索、语义缓存、提示示例或模型训练上下文；
- 监控异常相似答案、公开传播和曝光激增；
- 无法证明等值时，把 form 作为模型效应并报告不确定性。

### 14.4 归因窗口

每个 Outcome 关联：

```text
exposure_start / exposure_end
eligible_policy_bundle_versions
decision_ids_for_diagnostics
credit_rule_version
```

首版可使用策略束 ITT，不给单次决策分配因果收益。确需诊断性信用时，使用预注册的等权或时间衰减规则，并明确它只是分析约定。

## 15. 实验分析规范

- 主分析默认 ITT，用户中途改目标、覆盖计划或退出仍按原分配报告；
- per-protocol 和 as-treated 只能作为辅助，并说明选择偏差；
- 在 `AnalysisPlan` 中预注册排除、删失、异常值和目标变化规则；
- 序贯监控使用 alpha-spending、always-valid inference 或贝叶斯停止边界；
- 大量能力/用户/版本切片使用分层报警和 FDR 控制，安全告警不受 FDR 延迟；
- 探索性切片必须标记为假设生成，不能追认成主结果。

## 16. 公平性审计路径

不收集敏感属性会限制公平审计，收集又增加风险。候选路径是：

### 路径 A：自愿审计属性

- 仅为审计目的自愿填报；
- 与产品状态、路由和计划数据分库存储；
- 默认不向模型和业务查询开放；
- 小样本不出统计，用户可撤回；
- 需要单独同意、保留和访问审计。

### 路径 B：非敏感切片和外部审计

- 监控设备、语言、内容可达性、帮助条件和缺失等非敏感切片；
- 定期用招募的独立样本或外部审计评估关键群体；
- 明确无法覆盖的公平风险。

推荐先采用 B，待适用法域、同意流程和安全隔离成熟后再决定是否增加 A。审计属性不得用于个性化能力先验。

## 17. Golden Set 与 LLM Judge

### 17.1 Golden Set 治理

- `GoldenSetVersion` 记录来源、构念、题目、量规、标注者和仲裁结果；
- 金标题目从普通检索、语义缓存、Prompt few-shot 和训练集中隔离；
- 保留未公开的轮换集，防止对固定金标过拟合；
- 预算覆盖持续抽样、双人标注、仲裁和版本更新；
- 构念或量规变化时旧金标不能静默复用。

### 17.2 人机一致性

- 分类结果报告 Cohen's Kappa 或多标注者 Kappa；
- 有序/连续评分使用 weighted Kappa、ICC 或 Krippendorff's alpha；
- 同时报原始一致率、混淆矩阵和关键切片，而不是只报一个系数；
- 标注者一致性不足时先修量规，不用 LLM 替代分歧。

### 17.3 Judge 偏差与漂移

- TaskSpec 固定 rubric、few-shot、输出 Schema 和 abstain 规则；
- 随机化答案顺序，加入长度相等、格式变化和风格对照；
- 检查长度偏好、格式偏好、自家模型偏好和模型族共错；
- 定期运行不可见 golden probes；
- 供应商同名模型输出分布漂移时冻结 Judge，并重新估计其质量后验。

Judge 分数不能成为开放式回答的唯一高影响证据。

## 18. Phase 0 纯测量试点

### 18.1 最小试点

1. 选择一个构念边界较清楚、题目供应充足的学习目标；
2. 建立 `ConstructMap v0`、锚题和至少两个平行 forms；
3. 不改变用户计划，不使用自适应干预；
4. 在基线、1 至 3 天、7 天和 30 天稀疏发送短探针；
5. 记录完成率、负担、曝光、外部帮助自报和 item 表现；
6. 估计可靠性、缺失机制、testing effect、MDE 和运营成本；
7. 形成是否进入自适应策略试点的 gate decision。

### 18.2 通过门的形式

数值阈值必须由试点前的最小有意义目标和试点结果共同确定，但至少要求：

- 构念和迁移等级达到可解释的专家一致性；
- 平行 forms 经锚题后不存在不可接受的系统难度差；
- 响应率支持目标功效，或存在现实可行的替代设计；
- 缺失敏感性分析不会在合理假设下任意翻转结论；
- 用户负担、退出和无障碍问题处于可接受范围；
- 时长模型能给出可用的保守分位数；
- 金标运营成本可以持续承担。

### 18.3 停止条件

- 30 天响应率低到无法在现实周期内识别有意义效应；
- same/near/far transfer 无法稳定区分；
- 探针测试效应大于待检测的策略效应；
- 平行 forms 难度差无法校准；
- 用户负担或退出显著增加；
- 只能依赖无法审计的 LLM Judge 形成主结果。

停止不等于放弃学习闭环，而是退回更近端、可验证的目标，重新设计测量。

## 19. 最小 Schema 草案

```text
ConstructMapVersion
  id, scope, constructs, transfer_rules, expert_review, effective_window

MeasurementPlan
  id, estimand, windows, timezone_policy, sampling, missing_plan, analysis_plan

ProbeFormVersion
  id, construct_map_version, item_versions, anchor_items, equivalence_report

ProbeAssignment
  id, user_id, goal_episode_id, form_id, due_window, assignment_seed

ProbeExposure
  assignment_id, opened_at, assistance_trace, reveal_trace, self_report, validity

PolicyBundleVersion
  id, route, retrieval, assistance, planner, ui, configuration_snapshot

OutcomeObservation
  id, assignment_id, policy_bundle_id, result, eligibility, missing_state

AnalysisPlan
  id, estimand, ITT_rules, missing_rules, sequential_rules, multiplicity_rules
```

这些字段只用于研究对齐。在完成 Phase 0 前，不应直接固化为最终数据库表。

## 20. 与主提案的接口

- 主提案的 `ConfigurationSnapshot` 增加 `construct_map_version`、`measurement_plan_version`、`policy_bundle_version` 和随机化策略版本；
- `DecisionLedger` 保存诊断性决策链，但发布效果由策略束和独立测量层判断；
- `OutcomeObservation` 区分政策相关结果和独立测量结果；
- 模型路由、检索和计划策略只有在测量门成立后才能用 7/30 天结果升级；
- 代理指标与北极星的关系按本协议滚动复核；
- 实验和金标内容默认从普通记忆、检索与缓存排除。

## 21. 正式化路径

获批后需要更新：

- [ ] PRD：`in_app_independent`、迁移等级、测量负担和试点成功条件
- [ ] Assessment 设计：ConstructMap、能力模型和时长模型
- [ ] Experiment ADR：随机化单元、ITT、序贯、FDR、干扰和缺失分析
- [ ] Contract/Schema：Probe、PolicyBundle、Outcome、AnalysisPlan
- [ ] 数据治理：审计属性、金标隔离、删除传播和实验退出
- [ ] Worker：时区、窗口、轮换、提醒和幂等调度
- [ ] 测试：平行题组、资格规则、缺失状态、随机种子和回放

## 22. 变更记录

| 日期 | 状态 | 变化 | 依据 |
|---|---|---|---|
| 2026-08-03 | proposed | 首次记录；将构念、独立探针、缺失、功效、用户在环 propensity、干扰、归因、金标和实验分析提升为独立测量系统 | 两轮架构与算法评审；现有自适应学习治理提案 |
