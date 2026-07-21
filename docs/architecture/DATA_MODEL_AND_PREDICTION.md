# 核心数据模型与预测系统

## 1. 数据设计原则

1. 共享内容、个人状态和班级状态物理或逻辑分表；
2. 原始学习事件不可变，派生结果可删除和重算；
3. 所有派生结果带模型、策略和证据快照版本；
4. 默认UI消费精简摘要，不直接消费原始模型输出；
5. 不构建万能知识本体，按任务类型记录必要结构；
6. 内容更新通过新版本完成，不篡改历史引用；
7. 可导出原始数据、关系和事件，并明确外部投影损失。

## 2. 核心实体

### 身份与目标

- `User`
- `Workspace`
- `StudyGoal`
- `Subject`
- `StrategyPreset`
- `StrategyVersion`
- `UserStrategyOverride`

### 共享内容

- `ResourcePackage`
- `ResourcePackageVersion`
- `Source`
- `SourceSnapshot`
- `Anchor`
- `SyllabusNode`
- `ContentItem`
- `ContentItemVersion`
- `ConceptRef`
- `Rubric`

`ContentItem.kind` 可为：

- fact;
- concept;
- flashcard;
- question;
- worked_example;
- procedure;
- essay_prompt;
- project_task;
- mock_exam;
- explanation.

这避免把所有内容强制建模成概念或卡片。

### 个人状态

- `Enrollment`：用户采用某资源包及固定/跟随策略；
- `LearningEvent`：不可变事件信封；
- `Attempt`：作答详情；
- `HintUsage`；
- `ErrorAttribution`；
- `PersonalNote`；
- `ReviewSchedule`；
- `TaskQueueItem`；
- `ArchiveDecision`；
- `AbilitySliceSnapshot`；
- `SummaryStatusSnapshot`。

### AI 与证据

- `AIJob`
- `AIArtifactCandidate`
- `ProvenanceRecord`
- `SupportCheck`
- `HumanReview`

### 协作

- `Classroom`
- `ClassAssignment`
- `ClassMembership`
- `SharedAnnotation`
- `AggregatedClassMetric`

班级层不得直接复用个人私有状态表作为公开内容。

## 3. 学习事件信封

所有行为先写成统一事件：

```json
{
  "event_id": "uuid",
  "event_type": "attempt.submitted",
  "user_id": "uuid",
  "goal_id": "uuid",
  "content_item_version_id": "uuid",
  "occurred_at": "timestamp",
  "context": {
    "activity_type": "transfer_problem",
    "timed": true,
    "available_seconds": 900,
    "device_mode": "web"
  },
  "payload": {
    "correctness": 0.5,
    "duration_seconds": 720,
    "confidence": 4,
    "hint_count": 1,
    "error_codes": ["case_split_missing"]
  },
  "schema_version": 1
}
```

重要字段应结构化；低频和实验字段可以进入经过 Schema 校验的 JSONB。禁止把全部领域数据塞进无法约束的单个 JSON。

## 4. 能力切片

不存单一 `mastery=0.95`。每个考点或内容范围可以有：

- recognition;
- unaided_recall;
- procedural_execution;
- transfer;
- expression;
- timed_stability;
- retention.

每个切片内部可包含：

```text
score_internal       内部排序值，默认不展示
band                 stable / usable / weak / untested
evidence_count       有效证据数
last_evidence_at     最近有效证据
uncertainty          内部不确定性
reason_codes         最主要原因
model_version        推导模型版本
strategy_version     策略版本
evidence_snapshot    输入证据快照
```

默认UI只显示 `band`、最多两个摘要数据和一个行动。

## 5. 预测系统分层

### Stage A：规则与证据计分，MVP

无需训练数据。规则示例：

- 看答案后答对不计为无提示回忆成功；
- 变式题证据不能被基础识别题完全替代；
- 限时证据影响 `timed_stability`；
- 高信心错误提升稳定误解风险；
- 同一错误重复出现提高干预优先级；
- 长时间无新证据会增加不确定性，但不会篡改历史事实；
- 用户标记题目有误时暂停该题对状态的影响。

规则必须：

- 配置化；
- 版本化；
- 有单元测试；
- 能对单个结果生成 reason codes；
- 能在开发者设置中模拟参数变化。

### Stage B：概率校准

有足够行为数据后，为具体预测任务建立模型，例如：

- 7天内相似基础题成功；
- 下一道迁移题独立完成；
- 限时整卷中完成该题型；
- 给定干预后减少同类错误。

候选模型从简单开始：

- 分桶统计；
- Beta-Binomial/Bayesian 更新；
- Logistic Regression；
- Isotonic 或 Platt calibration。

使用 Brier Score、Log Loss、校准曲线和分场景切片评估。模型必须与“要预测的事件”一一对应，禁止训练一个含义模糊的全局掌握度。

### Stage C：领域模型

当数据证明需要时再引入：

- FSRS：记忆调度；
- IRT：题目难度和区分度；
- BKT：技能状态随练习变化；
- 序列模型：只有在简单模型明显不足且数据规模足够时考虑。

不同模型可以同时存在，但必须输出到统一的派生契约，而不是把模型内部参数暴露给默认UI。

### Stage D：策略优化

通过 A/B 测试或保守策略学习比较：

- 解释、例题、直接练习哪种干预更有效；
- 相同时间预算下如何分配任务；
- 何时停止低收益重复；
- 哪些资源对特定场景更有效。

不得仅以点击率或学习时长优化；主要结果应是延迟表现、迁移、计划完成和用户主动纠正率。

## 6. 精简结果对象

Assessment 模块对UI输出：

```json
{
  "status": "weak",
  "label": "薄弱",
  "summary_metrics": [
    {"label": "近期", "value": "2/5"},
    {"label": "预计", "value": "20分钟"}
  ],
  "primary_action": {
    "type": "start_intervention",
    "label": "补一次变式"
  },
  "reason_codes": [
    "repeated_case_split_error",
    "basic_items_already_stable"
  ],
  "recommended_actions": [
    "guided_procedure",
    "unaided_transfer"
  ],
  "evidence_snapshot_id": "uuid",
  "strategy_version": "gaokao-math@1.2.0",
  "model_version": "rule-engine@0.1.0"
}
```

UI 文案从受控 reason/action 字典生成，避免模型自由生成互相矛盾的解释。

## 7. 用户反馈闭环

用户可以：

- 纠正错因；
- 标记题目或答案有问题；
- 标记系统状态不准；
- 跳过某种干预；
- 修改科目优先级；
- 临时固定今日计划；
- 在开发者模式覆盖规则参数。

反馈追加为事件，不直接覆盖旧预测。重算后保留新旧版本，支持比较。

## 8. 数据收集与模型演进

首发云端允许从官方服务器收集产品运行所需数据，但仍按用途分区：

- 业务数据：提供产品功能；
- 质量遥测：解析失败、任务耗时、模型错误；
- 学习模型数据集：经过版本化抽取和质量检查的行为样本；
- 实验数据：明确实验ID、分组、起止时间和指标。

训练数据流水线：

```text
immutable events
→ quality filters
→ feature snapshot with version
→ train/validation/test split by time and user
→ model training
→ calibration
→ shadow evaluation
→ limited rollout
→ monitor drift and rollback
```

关键要求：

- 同一用户数据不能同时泄漏到训练与测试造成虚高结果；
- 按时间切分验证未来预测；
- 题目版本和策略版本进入特征；
- 发布模型前先影子运行；
- 保存特征、代码、模型和校准版本；
- 线上必须能回退到规则引擎。

## 9. 开发者设置

### 只读诊断，MVP

- 当前状态的输入事件；
- 有效/无效证据及原因；
- 场景模板继承链；
- 规则和模型版本；
- reason codes；
- 任务排序分解。

### 可调整，P1

- 证据最低数量；
- 时间衰减；
- 能力要求权重；
- 每日任务上限；
- 干预优先级；
- 状态阈值；
- AI自动化权限。

每次修改：

1. 创建用户策略新版本；
2. 展示受影响范围；
3. 支持预览重算；
4. 用户确认后生效；
5. 支持恢复场景默认值。

## 10. 锚点策略

锚点按可靠性分级：

- `exact_snapshot`：冻结文件版本、页码、坐标和内容哈希；
- `text_quote`：引文、上下文和文本指纹；
- `structural`：章节、标题和段落路径；
- `source_only`：只能回到来源。

默认UI只显示“可定位”“已降级”或“来源可用”。开发者设置显示具体算法和重定位日志。

MVP 优先受控 PDF 和网页快照，不承诺动态网页永久精确定位。

## 11. 导出层次

- **原生完整备份：**可在兼容版本恢复；
- **开放协议包：**Schema、事件、关系、文件和迁移清单；
- **外部投影：**Anki、CSV、Markdown 等；
- **损失报告：**明确哪些数据目标格式不能表达。

外部投影不得宣称无损。
