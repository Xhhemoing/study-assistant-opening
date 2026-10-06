# Lab 双 Agent 方案 · 最终版（供 Heidi 审阅）· 2026-10-06

> **实施状态（2026-10-06）：** LAB-A01/B01 已实现并本地验证（evidence：`../superpowers/evidence/2026-10-06-opening-release/lab-a01-b01-rp-evidence.md`）；LAB-U01（策略选择器 UI）与 LAB-B02（微问，预挂）未实现。其余决议状态不变。

**状态：** 最终方案草案 v2，取代 `2026-10-05-lab-duo-design-for-heidi-review.md`；未授权开票/改 K02。
**产生方式：** 草案经四条独立只读子线核查后修订——事实核查（8 项声明逐条对码）、独立设计审查（Critical/Warning 分级）、基线验证（K02a 聚焦单测实跑）、微问与存储专项。子线模型按 `docs/operations/codex-team.md` 2026-10-02 路由（`opening-sol-worker` / `opening-sol-reviewer` @ `tokenfree-sol/gpt-6.1-sol`）。
**依据：** `2026-10-05-lab-agent-duo-research.md` @ `e067d3c`；K02a tip `a33b824`（tasks.json `verified`，evidence 已登记）；DeepTutor `2e0816b0`；OpenMAIC `7230053`；ADR-014。

---

## 0. 一句话怎么做（不变）

在 Opening 现有单一 tutor 通道上加一层**可配置策略模板 + 两个逻辑角色**：

- **Agent A（讲解）**：按页/段讲、提示/例题；写回合与暴露（hinted/revealed）。
- **Agent B（监督闭环）**：只推荐下一步动作，不自动开课、不改掌握度。

算法是**可审计的规则机 + LLM 生成文案**。B 不是独立进程，是**纯函数 + 薄路由处理器**。

---

## 1. 草案问题 → 最终决定（核心修订表）

| # | 草案问题（子线核实结论） | 最终决定 |
|---|---|---|
| 1 | **解锁门禁自相矛盾**：头部/§6 标题写"完整 K02 PASS 后"，§6 正文写"K02a PASS + push"，§8 又列为待决。事实：K02a 已 `verified`，K02 等 K01（等 C01），严格按草案 Lab 无限搁置 | **解锁门禁 = K02a（已满足）**，仅解锁 Thin 范围。outline 分段、SkillEvidence、nodeId 必填路径仍等 K01/完整 K02。"push"单列为交付条件，不能由 verified 推定 |
| 2 | **两套决策表**：§4.2 声称"包装 K02a"却又"原样实现新优先级表"，与 `recommendTutorAction`（`tutor-policy.ts:136`）在至少 7 种输入组合下结果不同（如：无页+到期→现 `delayed_retest` vs 草案 `clarify`；仅 hinted→现 `worked_example` vs 草案 `guided`） | **单一规则所有者：以现有 `recommendTutorAction` 顺序为基座，B 做分层扩展，不改既有分支顺序**（K02a 已验证测试保持绿）。`hinted→worked_example` 不收紧（stuckAfterHint 仅用于文案与弱点标记）。与草案 §4.2 的偏差在此显式记录为有意决策 |
| 3 | **B 的输入是客户端自报**：thin 路径 `assistedSuccess`/`retestDue`/`sessionExposures` 全来自 query 参数（`tutor-actions.ts:18`），`_sql` 未使用，路由未校验课程归属 | **B 的观察输入全部服务端推导**：交付曝光（`opening-learning-help`）、有效观察头（`opening-learning-read`，含撤回/隐私排除语义）、真实到期判定（`opening-retest-activities.listDue`，含 accepted 状态/snooze/notBefore）。客户端只传选择与身份。**曝光用"曾达最高级"聚合，不用字面 lastExposure**（revealed→hinted 不得遮蔽已看答案历史）。`lastExposure` 一词从规格中废弃 |
| 4 | **require_page 是纸面保护**：`assertCitationsForPage` 生产链路零调用（worker 只调 `resolveCitations`，允许空引用），且 Citation 类型无 `page` 字段不能直接套用 | **LAB-A01 落地为生成后、交付前的程序校验**：按授权 source/version/chunk 回查物理页；空引用/错页 → 拒答，**拒答不得落为成功讲解回合**。v1 模板 `citationPolicy` 仅开放 `require_page` 一种值；`prefer_page`/`general_ok` 从 schema 暂除（防"切模板降级成无锚定回答"） |
| 5 | **微问无落票、不入闭环**：§4.4 无票承接；candidates 契约只收 memory/task 不收结构化题干；结果不写 L01 observation；"单次 T01 预约"与生成调用关系未定义 | **v1 微问预算默认 0，不实现**；§4.4 全部移入预挂票 **LAB-B02**（定义联合生成 vs 第二次预约、题目结构 schema、证据短语校验、`verdictSource`、答案揭示时机、T01 成本），**Heidi 拍板后才开**。B02 未落地时 §4.2 微问分支降级为 guided |
| 6 | **`path_suggestion_only` 不在契约**：`ThinTutorActionKind` 仅五种 | **不新增 kind**；用现有动作的 `reason` 文案或独立展示字段表达"仅路径建议" |
| 7 | **`assertNoMasteryPercentage` 只查顶层 4 键**：`{weakLabels:[{masteryPercent:80}]}` 可绕过；文案内"掌握80%"不查 | **不做递归通用扫描**（避免假想框架）；新增输出结构走**严格 Zod schema**（weakLabels 只允许定义键+证据引用），补**嵌套拒绝用例**；三判定文案由程序按证据产生，生成文案不得自行宣称 `LEARNING_EFFECT_OBSERVED` |
| 8 | **TurnInput 无 strategyTemplateId**（strict 契约），策略从 UI 到 worker 的通路断裂 | **LAB-A01 定义通路**：`TurnInput` 增可选 `strategyTemplateId`（严格校验、向后兼容，跨包契约变更在票面声明）；worker 按注册表解析；未知 ID → 回退默认模板并在响应标注（不用静默替换）；排队中的回合按入队时模板执行 |
| 9 | **变式只是字符串改名**：`variantProblemRef` 生成 `:variant` 后缀，不登记真实新题/attempt，不能单独证明变式进闭环 | **v1 `independent_variant` 维持推荐语义**（与 K02a 一致）；真实新题登记/attempt 创建归 **K02**（其计划已含此职责）。U01 变式 chip 引导用户经 composer 无协助作答，不伪造题目身份 |
| 10 | **U01 进度条分母未定义**（page 模式 N 无来源）、chips 点击语义未定义、"换策略改变推荐"验收不可判定 | **进度条剔除**；**chips 点击语义逐 kind 定义**（见 §4）；U01 验收改为"固定 fixture 下，仅已定义策略维度改变推荐/文案" |
| 11 | **weakLabels 若落库成第二事实源**，与 L01/L02 可漂移 | **weakLabels = L01/L02 投影，纯推导，不新增表**；`segmentIndex`/`microQUsed` 是会话内导航/计数状态（非学习事实），所有权在 A01/B02 票内定义；ephemeral 会话不持久化任何运行时态 |
| 12 | **子 Agent 核查新发现**：到期不是"观察+2天"布尔；同题曝光跨 session 关联（`evidence-eligibility-timing` 的 `prior_answer_exposure`）；`problemRef` 字符串≠学习事实 problemId（UUID+版本） | 到期判定**复用 `listDue` 真实语义，禁止重造布尔截止日**；B 推导输入保留题目关联与时序；弱点评定区分自报错误/参考核验错误，纠正/撤回后重算（复用 `evidence-eligibility` 身份要求） |

---

## 2. 决策清单答复（草案 §8 五问 + 子线新增一问）

1. **算法（§4.2 优先级表）**：接受表驱动思想，**但顺序改为现有 K02a 实现**（retestDue → assistedSuccess&&problemRef → 曾 revealed → 曾 hinted → 无页 → guided），B 只做附加层（微问预算、策略次级排序）。"同优先级平局"取消——分支互斥后无平局；`pathSuggestion` 只影响返回列表次级项排序与文案，不改主判定。
2. **形态**：接受"单 tutor + B 为策略函数 + 薄 handler"。禁止实现者造 FSM 引擎/导演模块/独立 LLM 进程。
3. **U01**：只要策略选择器 + chips + 逐 kind 点击语义。进度条剔除（不是永久禁止，等分母定义后另行评估；任何浏览进度不得呈现为掌握语义）。
4. **微问**：预算 3 合理但 **v1 = 0**；强制 `require_page`；拆 LAB-B02 独立票并定 `verdictSource` 契约后再开。注意：同一次 provider 调用联合生成微问不必然违反单预约，但另开生成调用不能复用同一次预约；"证据短语在 chunk 中出现"不证明答案正确。
5. **解锁时机**：K02a PASS 即解锁 LAB-A01→B01→U01（tasks.json 已 verified）；完整 K02 PASS 后 B 再升级 nodeId 路径（`ThinTutorAction.nodeId` 本为 nullable，前向兼容）。
6. **（新增）闭环最弱环节**：子线审查确认最弱处不是讲解生成，而是**"回答→合格观察→弱点更新"**。B01 验收必须包含该链路的可追踪证据（见 §4 B01）；重测错误完成可关闭 due 活动，但不得等同学习效果或弱点解除。

---

## 3. 系统结构（修订后）

```
[UI] 策略选择器 + 动作 chips（逐 kind 点击语义见 §4）
        │  客户端只传：session/page/strategyTemplateId/目标选择
        ▼
[B · Supervisor handler]  服务端推导观察（L01 交付曝光、L03/L01 有效观察头、L02 listDue）
        │  recommendTutorAction 基座 + 附加层（微问预算、策略排序）→ ThinTutorAction[]
        │  推荐 = 纯读，零写入（不建 P02、不写 L01、不 accept）
        ▼ 用户点选 chips
[A · Tutor turn]  T03 worker：makeTutorInstruction(mode) + 策略后缀（注册表解析）
        │  require_page 交付前校验；L01 暴露照旧写入
        ▼
[L01/L02/L03]  暴露/重测候选/三判定摘要
        └──► 下一轮 B.Observe（服务端推导，含 prior_answer_exposure 跨 session 语义）
```

复用：T02 选上下文；T03 tutor（单次 T01 预约不变）；K02a `tutor-policy`/`tutor-actions`；L01 暴露；L02 到期/accept；L03 摘要。
新增：`strategy` 注册表（domain，ADR-014 内存注册表模式，无 DB 表）+ B 推导层 + require_page 校验 + TurnInput 可选字段。

---

## 4. 落地票面（最终版，K02a 已满足即解锁 A01/B01/U01）

### LAB-A01 · 策略注册表 + 注入 + require_page 校验
**范围：** `packages/domain/src/opening/strategy-registry.ts`（ADR-014 模式：Zod schema + 默认模板 + get/list，未知 ID 显式处理）；`TurnInput` 可选 `strategyTemplateId`（跨包契约变更声明）；worker instruction 注入（在 `instructionWithMemories(makeTutorInstruction(mode))` 结果上追加策略后缀，**不改 `makeTutorInstruction` 返回值**——别名相等断言依赖它）；require_page 生成后交付前校验（按 chunk 物理页回查）。
**验收（可证伪）：**
- 同一输入在不同 language/depth 下产生确定配置结果（快照单测）；
- `makeTutorInstruction` 别名断言不破坏（`tutor-policy.test.ts` 全绿，基线见 §6）；
- 空引用/错页 → 拒答，**不产生成功讲解回合、不写 revealed**（worker 单测）；
- 实际完成回合的 hinted/revealed 落库不回归；失败重试不重复写暴露；
- v1 schema 无 `prefer_page`/`general_ok`，无 mastery 相关键。

### LAB-B01 · Supervisor 推荐包装（服务端推导 + 分层扩展）
**范围：** B 推导层（曝光最高级聚合、有效观察头、`listDue` 到期）+ `recommendTutorAction` 之上的附加层 + 路由补课程/session 归属校验。**禁止第二张优先级表；禁止任何写入。**
**验收（可证伪）：**
- 表驱动单测：与 K02a 基线顺序在全部交叉输入组合一致（含无页+到期→`delayed_retest`、曾 revealed→`independent_variant`）；
- 伪造 query（自报 assistedSuccess/retestDue/exposures）**不改变**服务端推导结果（伪造面关闭测试）；
- 跨课程/session 越权 → 拒绝；
- snooze/终态/未 accept 的到期项不推荐 `delayed_retest`；
- 推荐前后无 P02 任务、无 L01 写入（零写入断言）；
- 闭环追踪：assisted success → 推荐 variant → 用户无协助作答 → 观察入 L01 → B 下轮输入变化，端到端 handler 用例各步骤可断言。

### LAB-U01 · 策略选择器 + 动作 chips
**范围：** 复用 composer；首个 `tutor-actions` UI 消费方（learning client 扩展）。**无进度条。**
**chips 点击语义表（票面固定）：**

| kind | 点击行为 | 写入边界 |
|---|---|---|
| clarify | 聚焦页/材料选择控件 | 无 |
| guided / worked_example | 预填 composer 对应 mode，用户确认后发送 | 走既有 T03 流程 |
| independent_variant | 预填变式引导语，明示"请勿先要提示"；作答经既有观察入口 | 走既有 L01 |
| delayed_retest | 深链既有 L02 accept 流程；已 accept 的到期活动 → 打开而非重复 accept | 用户显式 accept 才建任务 |

**验收（可证伪）：** 固定 fixture 下仅已定义策略维度改变推荐/文案；每种 chip 请求/写入结果符合上表；拒绝/未确认不建任务；UI 不出现掌握百分比（浏览进度类文案不受误伤）。

### LAB-B02 · 微问闭环（预挂，Heidi 拍板后开）
**必须先定义：** 联合生成 vs 第二次 T01 预约；微问结构 schema（题型/选项/答案键/证据短语）；程序判分的 `verdictSource` 归类（现契约仅 self_report/reference_checked/model_suggestion/unknown，程序持答案键自动判分是否新增枚举值 = 契约决策）；首次回答保存与揭示时机；预算状态所有者。未定义前不实现。

---

## 5. 证据规则护栏（写进每张票 Anti）

- hinted/revealed 永不洗成 `observed_independent`；同题曝光跨 session 关联语义保留（`prior_answer_exposure`）。
- B 推荐 = 纯读；accept 永远用户显式确认；禁静默建 P02。
- depth 只调讲解粒度/步骤数，禁止映射掌握度或通过线；weakLabels 键只允许 page/skillLabel + 证据引用。
- 三判定依证据产生；生成文案不得自行宣称判定结果。
- 引用锚定物理页；FORMULA `orig` 永不作讲解正文；拒答不是成功回合。
- 明确不做（沿草案 §7）：OpenMAIC director-graph/roster/whiteboard/TTS/一键开课；DeepTutor GraphRAG/Partners/~0.9 门；把 depth/进度做成掌握度；在 K02a tip 上继续塞 Lab（新切片新提交，不 reopen）。

---

## 6. 验证基线与残余风险（2026-10-06 实测）

| 检查 | 结果 |
|---|---|
| `vitest --project unit packages/domain/src/opening/tutor-policy.test.ts` | **6/6 绿** |
| `vitest --project unit apps/web/src/features/opening/learning/tutor-actions.test.ts` | **2/2 绿** |
| `npm run typecheck -w @aistudy/domain` | **通过** |
| `tests/integration/handler/opening-tutor-actions.test.ts`（3 项） | **跳过**：需隔离 DB guard（`OPENING_TEST_DB=1` + `aistudy_opening_test`）；取得测试槽后补跑 |

**残余风险：** handler/真实 DB 链路本轮未跑；K02a PASS 以账本与 evidence 记录为准复用，未独立复演；push/hosted CI/浏览器验收均未验证，不据此宣称产品级通过。

---

## 7. 来源

- 草案与研究：`2026-10-05-lab-duo-design-for-heidi-review.md`、`2026-10-05-lab-agent-duo-research.md`、`2026-10-05-k02-deeptutor-fold-in.md`
- 代码：`packages/domain/src/opening/tutor-policy.ts`（`:7` 枚举、`:87` 页断言、`:136` 决策顺序、`:185` mastery 断言）、`apps/web/src/features/opening/learning/tutor-actions.ts`（`:18` 自报 query、`:110` 未用 `_sql`）、`apps/worker/src/jobs/tutor-turn.ts`（`:123` 注入点、`:140` 单预约、`:153` 仅 resolveCitations）、`packages/database/src/repositories/opening-retest-activities.ts`（`:197` listDue）、`packages/domain/src/planning/scenario-presets.ts`（ADR-014 先例）
- 计划：`tasks.json`（K02a:419 verified；K02:432 等 K01）、`10-media-knowledge.md` K02a/K02 节、`03-tutor.md` T03 节
- 子线运行：事实核查 `muvenh8p`、独立审查 `muvgrbnz`、基线验证 `muvfqxat`（模型 `tokenfree-sol/gpt-6.1-sol`，全部只读）

---

*本文件供 Heidi 审阅。通过决议后由 Opening PM 修改预挂票（A01/B01/U01/B02）并按 §2.5 unlock；§1 表中任何一条被否决则回到该条重新决策，不影响其余条目。*
