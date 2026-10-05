# Lab agent duo · Opening research (2026-10-05)

**Scope:** RESEARCH ONLY — no product code, no PRs, no tickets, no merge, **do not expand or reopen K02/K02a**.  
**Audience:** Opening PM / Ops / Implementer (staging note below).  
**K02a tip cited:** `a33b824` (parent `20bf9fc`; ledger later on `feat/opening-release`).  
**DeepTutor pin:** `HKUDS/DeepTutor` @ `2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6` (v1.6.7, Apache-2.0).  
**OpenMAIC observed tip (shallow clone):** `THU-MAIC/OpenMAIC` @ `7230053af019b89c83d22dcab0a94f38fe193856` (MIT).  
**Prior:** `docs/quality/2026-10-05-k02-deeptutor-fold-in.md` (box: `/workspace/opening-research/2026-10-05-k02-deeptutor-fold-in.md`).

> **Staging land path (Ops/Implementer/PM):** copy this file into the Opening repo as  
> `docs/quality/2026-10-05-lab-agent-duo-research.md` — this research agent does **not** commit/push.

---

## 1. Verdict

Dock a **讲解 agent (Agent A)** + **监督优化闭环 agent (Agent B)** *parallel to* (not inside) K02: reuse K02a’s material-anchored modes and `tutor-actions` recommend surface, plus L01 exposure / L02 retest, as **strategy templates + runtime state** rather than hardcoded problem loops. Borrow DeepTutor’s page-locator citation, hint-vs-full, and grounded micro-quiz *patterns*, and OpenMAIC’s **segmented lecture + progress snapshot** *ideas* — **without** transplanting OpenMAIC’s multi-agent classroom, whiteboard+TTS, or one-click classroom generation. Differentiated value = Opening’s evidence rules (three verdicts; no mastery %; hinted/revealed never → `observed_independent`) plus configurable strategy layer on a **single tutor role**, not a classroom suite clone.

---

## 2. Fold-in vs do-not-do

| Capability | DeepTutor evidence (pin) | OpenMAIC evidence (tip `7230053`) | Borrow for duo? |
|---|---|---|---|
| Page-locator citation + side-reader | [reading.yaml L10–L33](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/reading/prompts/en/reading.yaml#L10-L33); cite `[p.N]` / `reader_goto` | N/A (slide-scene product, not page-cite chat) | **Yes (pattern)** → T02/`TurnInput.currentPage` + K02a page chips |
| Hint / next-step vs full solve | [study_guidance.py L20–L33, L61–L97](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/reading/study_guidance.py#L20-L33) — 3 moves, “Do not give the final answer” | Segmented speech reveal in [stream-buffer.ts](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/lib/buffer/stream-buffer.ts) (segment seal / progress ratio) | **Yes** → Agent A modes `hint\|guided` vs `explain\|worked_example` (K02a already maps) |
| Worked example / clarify card | [ask_questions system.md](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/ask_questions/prompts/en/system.md) | Scene quiz/PBL (classroom suite) | **Thin yes** for one material-grounded worked example + variant; **not** full Ask/mimic pipeline or OpenMAIC quiz scenes |
| Micro-questions / grounding check | [quiz.py L20–L33](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/reading/quiz.py#L20-L33) — 3 MCQs, evidence phrase must appear in unit | Progress rails via [playback/types.ts `PlaybackSnapshot`](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/lib/playback/types.ts#L5-L10) + `onProgress` | **Yes (pattern)** → Agent B micro-questions + L02 retest; progress = observation summary, **not** classroom % |
| Language / depth knobs | [language.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/services/prompt/language.py) — output language directive (zh/en/…); **no** separate “depth enum” in pin | UI locales [locales.ts L16–L29](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/lib/i18n/locales.ts#L16-L29) (12 locales) — UI i18n, not pedagogy depth | **Borrow idea** as Opening **strategy fields** `languageLevel` + `depth` (new); do not copy OpenMAIC i18n stack |
| Segmented lecture structure | Reading units/outline (extract); study steps | [playback/engine.ts](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/lib/playback/engine.ts) state machine `idle→playing→paused→live`; scene/action cursor | **Yes (pattern)** → Agent A `segmentPolicy` over material pages/chunks; **not** PlaybackEngine/TTS |
| Multi-agent classroom / Partners | [subagent/capability.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/subagent/capability.py) | [director-graph.ts](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/lib/orchestration/director-graph.ts) LangGraph director→agent; [agent-roster.ts](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/lib/edit/agent-roster.ts) | **Do not** |
| Whiteboard + TTS | Out of K02 scope | [whiteboard-canvas.tsx](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/components/whiteboard/whiteboard-canvas.tsx); TTS slots in README/settings | **Do not** |
| One-click classroom generation | N/A | [generate-classroom/route.ts](https://github.com/THU-MAIC/OpenMAIC/blob/7230053af019b89c83d22dcab0a94f38fe193856/app/api/generate-classroom/route.ts) `POST {requirement, materialIds?}` | **Do not** |
| GraphRAG / Mastery Path % | RAG pipelines; [learning/policy.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/learning/policy.py) `QUANTITATIVE_GATE` ~0.9; [mastery/mode.py](https://github.com/HKUDS/DeepTutor/blob/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6/deeptutor/capabilities/mastery/mode.py) | Course completion UI (product claim) | **Do not** — Opening forbids mastery %; T02 bans GraphRAG |

**One-line do-nots:** no OpenMAIC multi-agent classroom; no whiteboard+TTS; no one-click classroom; no DeepTutor GraphRAG/Partners/Mastery %; no cloning OpenMAIC as Opening Lab suite.

---

## 3. Opening join map

| Duo capability | Existing join | Contract / module | Stays **new** |
|---|---|---|---|
| Material-anchored teach / hint / explain | T03 `makeTutorInstruction` + worker `tutor-turn.ts`; K02a `DeepenTutorMode` aliases `guided→hint`, `worked_example→explain` @ `a33b824` `tutor-policy.ts` | `TutorMode` = `hint\|explain\|listen\|think_together`; `TurnInput.currentPage` / `chunkId` (RU-03) | Strategy template binding (language/depth/segment) |
| Action recommendation | K02a `GET …/tutor-actions` + `recommendTutorAction` thin path (optional `nodeId`) @ `a33b824` | Full-K02 `TutorAction` requires `nodeId` (capability-interfaces); K02a `ThinTutorAction` does not | Supervisor policy that *selects among* K02a kinds via strategy — still recommend-only |
| Assistance / exposure | L01 `resolveAssistance`; worker helpExposure for hint/explain | hinted/revealed; never wash to `observed_independent` | Agent B weak-point rules reading exposures |
| Retest / path | L02 `suggestRetestAt` / retest-candidate accept→P02 | Delayed retest; fresh session empty exposure | `retestCadence`, `pathSuggestion` strategy fields (**no mastery %**) |
| Citations / page | T02 selectContext prefer page; K02a `assertCitationsForPage` | Physical `page_no` (+ optional slideLabel); never Docling FORMULA `orig` | Citation policy enum in strategy |
| Learning read | L03 summary API | Three verdicts: `FLOW_VERIFIED` / `LEARNING_EFFECT_OBSERVED` / `MASTERY_NOT_ESTABLISHED` | Supervisor runtime state store |
| Skill-node adaptive loop | **Full K02** (waits K01) | SkillEvidence / migration 0029 | Out of this duo’s min slice |

Plans: `03-tutor.md` (T03), `05-learning.md` (L01–L03), `10-media-knowledge.md` (K02a/K02). **Do not reopen K02a tip** — duo lands *alongside* as future optional slice after gates.

---

## 4. Agent A · 讲解 (Explain / teach)

### Inputs
- `conversationId`, `learningSessionId?`, `courseId`, `sourceIds[]`, `currentPage?`, `chunkId?`, `skillLabel?`
- `modeRequest`: `hint | explain | worked_example | guided` (aliases normalize via K02a)
- `strategyTemplateId` → resolved fields below
- User text + bounded history (T03); authorized chunks (T02)

### Outputs
- Assistant turn text + program-checked citations (page-sticky when `currentPage` set)
- Delivered exposure: `hinted` | `revealed` (L01) — never client-washable
- Optional pending candidates (T03) — still user-confirmed
- Emit `TutorAction`-aligned intent for UI chips (reuse K02a kinds)

### State machine (session-scoped)
```
Idle → SelectMaterial/Page → SegmentReady
  → Teach(segment) ──mode hint/guided──→ Hinted
                   ──mode explain/worked──→ Revealed
  Hinted → (user asks more | strategy allows deeper) → Revealed | NextSegment
  Revealed → handoff signal to Agent B (recommend independent_variant)
  Any → Clarify (missing page / ambiguous target)
  Terminal: session pause | privacy epoch bump | budget deny
```
Hardcoded problem loops **forbidden** — transitions driven by strategy + observations.

### Strategy-template fields (configurable)
| Field | Intent | Notes |
|---|---|---|
| `languageLevel` | Output language / register (e.g. `zh-CN-plain`, `en-US-technical`) | Pattern from DeepTutor `language_directive`; Opening-owned enum |
| `depth` | `shallow \| standard \| deep` | **New** — not present as enum in DeepTutor pin |
| `segmentPolicy` | How to chunk teach: by `page` \| `outline` \| `fixedChars` | Borrow OpenMAIC scene cursor *idea*, map to pages/chunks |
| `modes` | Allowed: `hint\|explain\|worked_example\|guided` | Must map to K02a exposure rules |
| `citationPolicy` | `require_page` \| `prefer_page` \| `general_ok` | Align T02; FORMULA `orig` never tutor text |

---

## 5. Agent B · 监督优化学习闭环 (Supervise / close loop)

### Inputs
- Same course/session ids; L01 observations + exposures; L02 due flags; last Agent A mode/exposure
- Optional `problemRef` / assistedSuccess (K02a query shape)
- `strategyTemplateId` (supervisor fields)

### Outputs (recommend-only)
- Ordered suggestions: `clarify | guided | worked_example | independent_variant | delayed_retest` (reuse K02a `ThinTutorAction`)
- Micro-question budget remaining; weak-point labels (skillLabel/page keyed — **not** mastery %)
- Path suggestion: next segment / accept L02 retest / pause
- Copy must use three verdicts; **`assertNoMasteryPercentage`** on every payload

### State machine
```
Observe → ClassifyWeakPoints → Decide
  Decide:
    retestDue → RecommendDelayedRetest
    assistedSuccess / revealed → RecommendIndependentVariant
    hinted & still stuck → RecommendWorkedExample
    no page → Clarify
    else → RecommendGuided / MicroQuestion (budget > 0)
  After user completes unassisted retest → CloseDue → Observe
  Budget exhausted → PathSuggestionOnly (no more micro-Qs this session)
```

### Strategy fields
| Field | Intent |
|---|---|
| `weakPointRules` | Deterministic rules over exposures/outcomes (e.g. revealed+incorrect → weak) |
| `microQuestionBudget` | Max grounded micro-Qs per session (DeepTutor quiz *count* idea; Opening grounding) |
| `retestCadence` | Days heuristic for L02 `suggestRetestAt` (default 2) — **not** FSRS/BKT |
| `pathSuggestion` | Policy for next step wording; **no mastery %** |

---

## 6. A↔B coordination (not OpenMAIC multi-agent)

| Pattern | Opening duo | Explicit anti-pattern |
|---|---|---|
| Roles | **One** Opening tutor adapter (Agent A = mode/instruction path); Agent B = **policy service** recommending actions | OpenMAIC director LangGraph + agent roster fan-out; DeepTutor Partners/`consult_subagent` |
| Shared ids | `conversationId` + `learningSessionId` + `courseId` + strategy ids | Separate “classroom stage” with multi-speaker agents |
| Handoff | A writes exposure/turn → B reads observations → returns K02a action kinds → UI/composer sets T03 `mode` | Agents debating on whiteboard / TTS roundtable |
| Budget | Single T01 reservation per tutor turn | Per-agent concurrent LLM fan-out |

---

## 7. Minimal landable slice (post-K02a; **does not expand K02a tip**)

**Proposed later slice (NOT an unlocked ticket):**

1. **Strategy-template schema** (Zod + optional DB table) with Agent A+B fields above; defaults only.
2. **Supervisor recommend-only endpoints** that wrap/extend K02a `listTutorActionsForCourse` / `recommendTutorAction` with strategy + observation inputs — still pure recommend, no auto-task.
3. Wire UI: strategy picker → mode chips already implied by K02a; no new classroom surface.

**Still waits on:**
- **K01** (+ thus full **K02**): `nodeId`-required SkillEvidence loop, migration 0029, cross-node claims.
- Full K02 PASS before any Lab/OpenMAIC-ish UX extras (per prior deferral).
- This research may *propose* slices; **must not claim tickets unlocked**.

**Out of min slice:** whiteboard, TTS, one-click classroom, multi-agent roster, GraphRAG, mastery %.

---

## 8. Risks + UNRUN + sources

### Risks
- Scope creep into OpenMAIC classroom suite or reopening K02a.
- Strategy “depth” abused as fake mastery; keep three verdicts + `assertNoMasteryPercentage`.
- Micro-questions without grounding → invent pages/facts (violate T02/RU-03).
- Supervisor auto-accepting P02 tasks (must stay confirm-gated).
- License: DeepTutor Apache-2.0 / OpenMAIC MIT — prefer **pattern reuse**; attribution if substantial copy.

### UNRUN (explicit)
- **UNRUN:** DeepTutor app, quizzes, provider/LLM calls.
- **UNRUN:** OpenMAIC app, generate-classroom job, TTS/whiteboard runtime, Playwright.
- **UNRUN:** Opening product tests / DB against K02a beyond reading `git show` extract @ `a33b824`.
- **UNRUN:** No tickets created; no merge; no K02a tip reopen; no `tasks.json` edits.

### Sources opened
- Box extract `/workspace/opening-research/repo-extract/lab-duo-extract.txt` (plans 03/05/10, K02 fold-in, K02a `a33b824` files).
- Prior: `2026-10-05-k02-deeptutor-fold-in.md`, `2026-09-13-f02-i02-t01-t02-cited-findings.md`, `learning-flow-t01-t02.md`.
- DeepTutor clone @ `2e0816b0`: study_guidance, reading.yaml, quiz.py, language.py, ask_questions system.md, mastery/mode.py, learning/policy.py, subagent.
- OpenMAIC shallow clone @ `7230053`: README, director-graph.ts, playback/engine.ts + types.ts, agent-roster.ts, generate-classroom/route.ts, whiteboard-canvas.tsx, stream-buffer.ts, i18n/locales.ts.

---

*End of research deliverable. Reminder: research only — no tickets; no K02a reopen; full K02 still waits on K01.*
