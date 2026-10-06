# Lab 双 Agent 具体方案（供 Heidi 审阅）· 2026-10-05

**状态：** 设计草案，未授权开票/改 K02。  
**依据：** `docs/quality/2026-10-05-lab-agent-duo-research.md` @ e067d3c；K02a tip `a33b824`；DeepTutor `2e0816b0`；OpenMAIC `7230053`。  
**前提：** 完整 K02 仍等 K01；本方案默认 **K02 PASS 后** 解锁 LAB-A01→B01→U01。

---

## 0. 一句话怎么做

在 Opening **现有单一 tutor 通道**上，加一层可配置的 **策略模板 + 两个逻辑角色**：

- **Agent A（讲解）**：按页/段讲、提示/例题；写回合与暴露（hinted/revealed）。
- **Agent B（监督闭环）**：**只推荐**下一步动作（变式/重测/微问/澄清），不自动开课、不改掌握度%。

算法是 **可审计的规则机 + LLM 生成文案**，不是写死「讲→题→下一题」循环，也不是 OpenMAIC 多智能体课堂。

---

## 1. 设计是否合适（审阅结论）

| 判断 | 说明 |
|---|---|
| **总体合适** | 与 Opening 证据规则（三判定、无 mastery%、hinted/revealed 不可洗成独立观察）一致；复用 K02a 动作面，增量可控。 |
| **合适：规则优先于黑盒** | B 的 Decide 用曝光/对错/到期做确定性分支；LLM 只填讲解文案与微问题干，避免「神秘自适应」。 |
| **合适：单角色 + 策略服务** | A=既有 tutor-turn；B=policy/recommend 服务。避免导演图/名册/白板/TTS 的复杂度与预算爆炸。 |
| **需盯：depth 误用** | `depth` 只能调讲解粒度，**禁止**映射成掌握度或通过线。 |
| **需盯：微问落地** | 必须强制材料锚定（证据句在当前页/chunk）；否则会发明事实。 |
| **需盯：B 不可自动 accept** | 推荐 → UI 确认 → 才进 T03 mode / L02 accept；禁止静默建 P02 任务。 |
| **刻意不做** | GraphRAG、Partners、Mastery%~0.9、OpenMAIC classroom/whiteboard/TTS/一键开课。 |

**建议 Heidi 拍板的三点：**  
① 接受「规则机 + 策略模板」而非深度学习自适应/FSRS；  
② 接受「双角色、单 LLM 通道」而非真双进程 agent；  
③ Lab UX（分段进度条等）是否进 U01，还是 U01 仅策略选择器 + 现有 chips。

---

## 2. 系统结构（对接现有程序）

```
[UI] 策略模板选择 / mode chips / 页选择
        │
        ▼
[B · Supervisor]  recommend(strategy, observations) → ThinTutorAction[]
        │ 用户点选
        ▼
[A · Tutor turn]  T03 makeTutorInstruction + tutor-turn
        │ 写暴露 L01、引用校验 T02/K02a
        ▼
[L02/L03]  retest 候选 / 三判定摘要
        │
        └──► 下一轮再进 B.Observe
```

**复用：** T02 选上下文；T03 tutor；K02a `tutor-policy`/`tutor-actions`；L01 暴露；L02 延迟重测；L03 摘要。  
**新增：** `strategy_templates`（或等价配置）+ B 的 recommend 包装层 + 可选 session 运行时态（微问剩余预算、当前 segment 游标）。

---

## 3. Agent A · 讲解 — 算法与状态机

### 3.1 归一化

```
modeIn ∈ {hint, guided, explain, worked_example}
→ K02a：guided→hint 路径；worked_example→explain 路径
→ exposure：hint/guided → hinted；explain/worked_example → revealed
```

### 3.2 状态机（会话内）

```
Idle → SelectPage → SegmentReady
  → Teach(segment)
       ├─ hint|guided  → Hinted
       └─ explain|worked_example → Revealed
  Hinted + (用户要更深 | strategy.depth 允许) → Revealed | NextSegment
  Revealed → 向 B 发 handoff 信号（建议 independent_variant）
  缺页/目标不清 → Clarify
  预算/隐私拒绝 → Terminal
```

**禁止：** 固定题环（讲完必出 3 题再下一页）。跳转由 **strategy + 用户动作 + B 推荐** 驱动。

### 3.3 分段（segmentPolicy）

| 值 | 行为 |
|---|---|
| `page` | 一页一段（默认，对齐现有 `currentPage`） |
| `outline` | 按大纲块（需 K01/大纲可用时再强开） |
| `fixedChars` | 按字符窗（仅兜底；优先 page） |

游标：`segmentIndex` 存 session runtime；NextSegment = index+1，越界则 PathSuggestionOnly。

### 3.4 生成约束（程序侧，非 prompt 自觉）

1. `citationPolicy=require_page` 时：无合法页引用 → 拒答/Clarify（K02a `assertCitationsForPage`）。  
2. 禁止把 Docling FORMULA `orig` 当讲解正文。  
3. `languageLevel` / `depth` 注入 T03 instruction；depth 只影响展开长度与步骤数，不改暴露语义。  
4. 单次 T01 预约（与现网一致）。

---

## 4. Agent B · 监督闭环 — 算法（核心）

### 4.1 输入特征（可观测、可测）

- `hasPage`, `lastExposure` ∈ {none, hinted, revealed}  
- `assistedSuccess`（有帮助后答对）  
- `retestDue`（L02）  
- `microQRemaining`  
- `stuckAfterHint`（hinted 后仍追问/错）  
- `weakLabels[]`（页/skillLabel 键，**非 %**）

### 4.2 Decide 优先级（确定性，建议原样实现以便单测）

```
1. !hasPage                         → clarify
2. retestDue                        → delayed_retest
3. assistedSuccess || last==revealed → independent_variant
4. stuckAfterHint                   → worked_example
5. microQRemaining > 0              → guided + 可选 micro_question
6. else                             → guided | path_suggestion_only
```

并列时：**数字越小优先**。同优先级用 strategy 打破平局（例如 `pathSuggestion=prefer_retest`）。

### 4.3 weakPointRules（示例默认，可配置）

- `revealed` 且当轮独立作答错误 → 标 weak(page|skillLabel)  
- 连续 2 次 `hinted` 未前进 → 标 weak  
- L02 重测失败 → 标 weak，并建议 `retestCadence` 缩短一档（仍无 %）

### 4.4 微问

- 预算：`microQuestionBudget`（默认 3/会话，对齐 DeepTutor「少量锚定题」思路）  
- 每题必须能在当前授权 chunk 找到证据短语（程序校验；失败则丢弃该题）  
- 题型：先 MCQ/短答二选一；**不**开 OpenMAIC PBL 场景  

### 4.5 输出

仅 `ThinTutorAction[]` + 文案用三判定用语；**每条 payload `assertNoMasteryPercentage`**。

---

## 5. 策略模板 Schema（草案）

```ts
type StrategyTemplate = {
  id: string;
  name: string;
  // Agent A
  languageLevel: 'zh-CN-plain' | 'zh-CN-term' | 'en-US-plain' | 'en-US-technical';
  depth: 'shallow' | 'standard' | 'deep';
  segmentPolicy: 'page' | 'outline' | 'fixedChars';
  modes: Array<'hint'|'guided'|'explain'|'worked_example'>;
  citationPolicy: 'require_page' | 'prefer_page' | 'general_ok';
  // Agent B
  weakPointRules: 'default' | 'strict';
  microQuestionBudget: number; // 0..10
  retestCadenceDays: number;   // default 2; NOT FSRS
  pathSuggestion: 'balanced' | 'prefer_retest' | 'prefer_forward';
};
```

运行时态（session）：`segmentIndex`, `microQUsed`, `lastHandoffAt`, `weakLabels[]`。

---

## 6. 落地切片（预挂，K02 PASS 后 unlock）

| 票 | 内容 | 验收 |
|---|---|---|
| **LAB-A01** | Strategy schema + 默认模板 + 注入 T03 instruction（language/depth/segment）；不改 K02a 暴露语义 | Zod/单测；tsc；hint/explain 仍正确写 L01 |
| **LAB-B01** | Supervisor recommend 包装 K02a actions；实现 §4.2 优先级；无 mastery%；无 auto-accept | 表驱动单测覆盖 1–6 分支；handler 集成 |
| **LAB-U01** | UI：策略选择 + 展示 B 推荐 chips（复用现有 composer）；可选简易 segment 进度（0/N） | 人工 UAT：换策略改变推荐，不出现 % |

**依赖：** K02a PASS + push；完整 K02/K01 未齐时，B 不用 `nodeId` 硬依赖（继续 Thin 路径）。

---

## 7. 明确不做（写进票 Anti）

- OpenMAIC director-graph / agent-roster / whiteboard / TTS / `generate-classroom`  
- DeepTutor GraphRAG / Partners / QUANTITATIVE_GATE≈0.9  
- 把 depth 或进度条做成「掌握度」  
- 在 K02a tip 上继续塞 Lab  

---

## 8. 请你审阅的决策清单

请直接回复编号选择或修改：

1. **算法：** 接受 §4.2 固定优先级表？还是要改顺序（例如 revealed 后优先微问而非变式）？  
2. **形态：** 接受「单 tutor + B 为推荐服务」？还是坚持两个独立 LLM agent 进程？  
3. **U01：** 只要 chips+策略，还是必须带 Lab 式分段进度条？  
4. **微问：** 默认预算 3 是否合适？是否强制 `require_page`？  
5. **解锁时机：** 严格等完整 K02 PASS，还是 K02a PASS 后即可开 LAB-A01？

---

*本文件供 Heidi 审阅；通过后由 Opening PM 按决议改预挂票再 unlock。*
