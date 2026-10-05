# K02 · DeepTutor fold-in vs do-not-do (Opening Researcher, 2026-10-05)

**Scope:** research only — no product code, no PRs, no `tasks.json` edits.  
**Repo tip (ledger):** `Xhhemoing/AIstudy` `feat/opening-release` @ `f90d3e4939f8f7c4f96b51b72b33c1e2f36db6ed`.  
**DeepTutor pin (plan):** `HKUDS/DeepTutor` @ `2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6` (tag `v1.6.7`, Apache-2.0).  
**DeepTutor main tip observed (shallow):** `f07029cfcf2c8dfccdb671cdfc343db8334f5741` (tag `v1.6.13`). Intervening 1.6.8–1.6.13 diffs **not** fully walked (shallow fetch) — cite pin paths below.

---

## 1. Verdict

K02 should **deepen the existing material-anchored T03 conversation** with finer actions (`hint` / `explain` / `worked_example` / `guided`) plus a **variant → independent attempt → L02 delayed retest** loop — borrowing DeepTutor’s **page-locator citation + side-reader** and **next-step guidance vs full answer** *patterns*, not its GraphRAG/LightRAG stack, multi-agent Partners/subagents, or Mastery Path % gates. A **thin slice (`K02a`) can depend only on verified `L02`+`T03`** if the integrator accepts optional/`skillLabel`/page-keyed action recommendation (no required `nodeId`), keeps privacy/source boundaries identical to T03/L01, and leaves **skill-node linkage + migration `0029` SkillEvidence** gated on **K01** (and thus C01). Prefer **pattern reuse** over copying prompts/code (Apache-2.0 NOTICE/attribution if any substantial copy occurs).

---

## 2. Fold-in table

| DeepTutor capability | Evidence (pin permalink) | Maps onto Opening K02/T03 | Borrow? |
|---|---|---|---|
| **Page-level citations + side-reading** — reader panel beside chat; cite `[p.N]`; `reader_goto` scrolls/highlights; client sends only `material_id`/`revision`/`locators`, server re-resolves text | [reading.yaml L10–L33](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/reading/prompts/en/reading.yaml#L10-L33); [references.py L1–L7](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/reading/references.py#L1-L7); [reading-citations.ts L3–L14](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/web/lib/reading-citations.ts#L3-L14); [ReadingWorkspace.tsx](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/web/components/reading/workspace/ReadingWorkspace.tsx) (split reader+companion) | Extend T02 citations + U02/U03 source viewer sticky with `TurnInput.currentPage` / `chunkId` (`page-selection.ts`); optional clickable page chips → existing download/viewer | **Pattern yes** (locator cite + jump). Not DeepTutor’s reading store/tools wholesale. |
| **Next-step hint vs full explanation** — study guidance returns 3 learner *moves*, “Do not give the final answer”; Solve is full worked path | [study_guidance.py L20–L33, L61–L97](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/reading/study_guidance.py#L20-L33); [solve prompts](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/solve/prompts/en/system.md) | Already sketched in T03: `makeTutorInstruction('hint')` ⊃「下一步提示」; `explain` = full + L01 reveal (`03-tutor.md`); `exposureLevelForMode` in `tutor-service.ts` | **Pattern yes** — tighten mode prompts + wire `TutorAction.kind` `guided`↔`hint`, `worked_example`/`clarify`↔explain-family. |
| **Worked example / question gen / variants** — Ask Questions clarification card; Question/mimic pipeline generates from topic or exam paper | [ask_questions system.md](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/ask_questions/prompts/en/system.md); [mimic_source.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/agents/question/mimic_source.py) | `TutorAction` `worked_example` / `independent_variant`; L02 `retest-candidate` + `retest-service.ts` accept→P02 task | **Thin pattern yes** for one material-grounded variant (T01 budget). **Not** full mimic/exam-paper multi-agent pipeline. |
| **Quiz / retest-ish loop** — reading quiz: 3 MCQs, evidence must appear in unit text; Mastery Path `mastery_quiz`/`mastery_grade` | [reading/quiz.py L20–L78](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/reading/quiz.py#L20-L78); mastery tools (do-not-fold) | L02 delayed retest + new-item independent attempt (AC06/AC10); K02 closes due after retest | **Borrow grounding check idea** for generated stems. **Not** Mastery Path graded bank/% gate. |
| GraphRAG / LightRAG / RAG-Anything / multi-engine KB | README multi-engine section; `deeptutor/services/rag/pipelines/{graphrag,lightrag}/` | T02: “exact/keyword… not GraphRAG” (`03-tutor.md`) | **No** |
| Multi-agent Partners / `consult_subagent` | [subagent/capability.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/subagent/capability.py) | Single tutor role + T01 budget | **No** |
| Mastery Path modes + ~0.9 mastery gates | [mastery/mode.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/mastery/mode.py); [learning/policy.py L33–L37, L73–L89](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/learning/policy.py#L33-L37) | Opening: no mastery % (`05-learning.md`, CAP05) | **No** |

**License:** pin `LICENSE` = Apache-2.0. Copying prompts/code ⇒ retain NOTICE/attribution; **recommend pattern reuse** (already stated in `opening-capability-reuse-research.md` + capability expansion spec).

---

## 3. Do-not-do (one line each)

| Item | Reason |
|---|---|
| **GraphRAG / LightRAG / RAG-Anything** | T02 forbids GraphRAG as first-release retrieval; adds foreign index/privacy surface Opening already rejected. |
| **Multi-agent classroom / Partners / subagents** | Out of CAP05; explodes auth/budget/UX; conflicts with single tutor adapter. |
| **Mastery Path + mastery % gates (~0.9)** | Opening forbids fake mastery percentages; three verdicts stay separate (`FLOW_VERIFIED` / `LEARNING_EFFECT_OBSERVED` / `MASTERY_NOT_ESTABLISHED`). |
| **OpenMAIC multi-agent classroom** | Explicit non-goal ([THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)). |
| **Whiteboard + TTS** | OpenMAIC/DeepTutor media surface; not K02 material-anchored chat. |
| **One-click classroom generation** | OpenMAIC product claim; bypasses Opening’s upload→page→tutor acceptance. |

---

## 4. Evidence-rule guardrails (tie to repo rules)

| New action / behavior | Guardrail | Already in Opening |
|---|---|---|
| `hint` / `guided` | Persist exposure `hinted`; **never** `observed_independent` | L01 `resolveAssistance`; `exposureLevelForMode('hint')`; cited findings table (hint → No) |
| `explain` / `worked_example` | Exposure `revealed`; assisted; cannot wash same item | T03 “explain… reveal intent for L01”; findings: worked example / full explain → No |
| `independent_variant` / retest | **New item** (variant), answered **without** assistance; first response before feedback | L02 “hinting one exercise cannot make a skill stable”; AC06/AC10; learning-flow T02 quote |
| Delayed retest | New L02 session; **no inherited exposure** | L01 “new retest sessions do not inherit exposure”; `05-learning.md` global constraint |
| Mastery UI | **No mastery percentage**; copy “observed attempts” only | CAP05 “无虚假掌握百分比”; three verdicts in `learning-flow-t01-t02.md` |
| Citations | Physical `page_no` (+ optional slideLabel); **never** Docling FORMULA `orig` as tutor text | RU-03 / `page-selection.ts` (“never treat PPTX slideLabel as page”); cited findings FORMULA/`orig` rule; PPTX `page_no = slide_index + 1` |

---

## 5. Plan-edit list (recommendation for integrator/PM — not applied)

### `03-tutor.md` (T03 mode bullets ~L61–L72)
**Current (quote):**  
`expect(makeTutorInstruction('hint')).toContain('下一步提示');` … `Mode hint focuses first unresolved step; explain allows full answer and records reveal intent for L01;`

**Propose:** Add explicit K02a note under T03 Modify/Interfaces: modes may also emit structured `TutorAction`-aligned intents (`guided`/`worked_example`) **without** requiring `KnowledgeNode`; page-sticky citations may surface clickable `currentPage` jumps. Keep GraphRAG ban in T02 unchanged.

### `10-media-knowledge.md` · `### K02` (L130–L148)
**Current (quote):**  
`**Depends:** K01,L02,T03.` … ``recommendTutorAction({nodeId,hasCheckedIndependent,hasAssistance,retestDue})`` … `0029追加SkillEvidence关联`

**Propose:** Split narrative into **K02a (material-anchored tutoring deepen)** vs **K02b (skill-linked evidence)**:
- K02a Create/Modify: `tutor-policy` page/skillLabel path, `tutor-actions` API may return actions without `nodeId`, T03 worker/mode prompts, optional side-read UX; **Depends: L02,T03**.
- K02b: SkillEvidence repo + migration `0029`, `recommendTutorAction` **with** `nodeId`, adaptive-loop tied to K01 snapshot; **Depends: K01,L02,T03** (or `K02a,K01`).
- Keep gate sentence: 保留K02/K01的集成门禁；拆分仅在契约/隐私/来源边界独立证明后由集成者改任务图.

### `tasks.json` · K02 row (L569–L578)
**Current (quote):**  
`"id": "K02", "dependsOn": ["K01","L02","T03"], "status": "planned"`

**Recommend (integrator decides):**
```json
{ "id": "K02a", "owner": "EXPERIENCE+AI", "dependsOn": ["L02","T03"], "plan": "10-media-knowledge.md", "status": "planned" }
{ "id": "K02", "owner": "EXPERIENCE+AI+DATA", "dependsOn": ["K01","K02a","L02","T03"], "plan": "10-media-knowledge.md", "status": "planned" }
```
Downstream `P04`/`U04` that list `K02` keep waiting on full K02 **or** temporarily accept `K02a` only for thin UX — PM call.

### Thin-slice independence proof (required before changing the graph)

| Boundary | Independent of K01? | Argument |
|---|---|---|
| **Contract** | Yes for chat actions | `TutorMode` hint/explain, `TurnInput.currentPage`, L01 assistance, L02 retest already exist without `KnowledgeNode`. `TutorAction.nodeId` / `recommendTutorAction(nodeId)` stay **K01-shaped** → thin slice must use optional nodeId or `skillLabel`+`sourceIds`+`currentPage` key. |
| **Privacy** | Yes | Reuse conversation/learning session owner+workspace; no new IMAP/DingTalk/external KB; generated variants stay in opening_jobs/candidates. |
| **Source** | Yes | Authorized chunks + physical page membership (T02/RU-03); side-read jumps only to validated pages. No graph edges. |
| **Still gated on K01** | — | Skill-node linkage, migration **0029** SkillEvidence, node-required `recommendTutorAction`, CAP04→CAP05 skill graph adaptive loop, cross-node transfer claims. |

### `opening-real-use-audit.md` §5 AC table
**Extend:**
- **AC06 / AC10** — assert finer modes: hint vs explain exposure labels; worked_example cannot upgrade independence; new variant retest path.
- **Add AC13 (proposed):** upload deck → select material+physical page → invoke at least (`hint` **or** `guided`) **and** (`worked_example` **or** independent variant/retest) with page citation; no mastery %.

---

## 6. Thin-slice acceptance tests (implementer)

1. **Mode policy unit:** `makeTutorInstruction('hint')` contains next-step language and forbids full final answer; `'explain'` / worked_example path allows full solution and marks reveal.
2. **Exposure wash:** after delivered hint/explain on session S, client `assistance:'independent'` → server `hinted`/`revealed`; new retest session has empty exposure.
3. **Page citation:** turn with `currentPage=N` returns citations whose chunk.page = N; inventing page throws (`page_not_in_sources`).
4. **Variant identity:** assisted success on item A recommends `independent_variant` with **different** problemRef/prompt; answering A again after reveal cannot become `observed_independent`.
5. **Retest close:** accept L02 candidate → complete unassisted → due cleared; no mastery percentage field in API/UI.
6. **No K01 required:** with empty knowledge snapshot / no SkillEvidence rows, K02a tutor-actions still returns clarify|guided|worked_example|independent_variant from page/skillLabel observations alone.

---

## 7. Sources + UNRUN

**Opened / used**
- Local extracts under `/workspace/opening-research/repo-extract/k02-extract{,2,3}.txt` (plans, contracts, tutor/retest code).
- Prior research: `2026-09-13-f02-i02-t01-t02-cited-findings.md`, `learning-flow-t01-t02.md`, `multimodal-and-page-slide.md`.
- DeepTutor clone @ `2e0816b0` (files cited above); README; LICENSE; THIRD_PARTY_NOTICES.md (header).
- OpenMAIC non-goal: https://github.com/THU-MAIC/OpenMAIC
- Shallow `origin/main` tip `f07029cf` / tag `v1.6.13` noted for drift awareness.

**UNRUN**
- Did **not** run DeepTutor app, quizzes, or any provider/LLM calls.
- Did **not** install DeepTutor extras (GraphRAG/LightRAG/MinerU) or execute its tests.
- Did **not** fully enumerate commits between `v1.6.7` and `v1.6.13` (shallow fetch).
- Did **not** modify Opening `tasks.json` / plans / product code.
- Did **not** open OpenMAIC source beyond primary GitHub/README landing.
