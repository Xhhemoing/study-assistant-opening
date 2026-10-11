# V2-08 Understand — 提纲到当前教学活动的编排生成

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch tip:** `ae974983ce791894c2aa6d9459b06198d3152191` (`ae97498`, `feat/opening-release`) — matches required tip (includes V2-07 ACCEPT)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no product code, no migrations, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-08; `tasks.json` V2-08; PM assignment (Projects Manager); reuse V2-05/06/07; align `review-test-gates.md`  
**Dirty tree note:** Unrelated untracked evidence files present (`rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`); **not** touched. No stash/reset.

## PM constraints (verbatim)

From Projects Manager assignment + `plan.md` §V2-08 / `tasks.json` V2-08 `scope`:

> 先生成可改提纲，再编译当前活动；下一活动按需要预取，避免等待整门课生成。

> 模型提出目标/讲解/例子/检查点，程序限制可用活动类型与来源。

> 教学路径与planDay日历不同；前置建议可解释、可跳过，不用掌握百分比锁章节。

> 无当前页也生成有依据的教学；目标冲突、无基础、已会请求速览、仅主题输入。

> 同一材料的当前目标调整只修订后续活动，不重写已学习历史。

Additional PM assignment wording (this turn):

> Entry: `tutor-policy.ts`; proposed new `teaching-plan.ts` + `teaching-compiler.ts`; wire into V2-07 `compile-teaching-unit` stub

> Constraints: 先可改提纲再编译当前活动；路径 ≠ planDay；前置可解释可跳过；不重写已学历史

> Deliverables: understand doc + plan doc + implement-stage evidence for the Plan handoff (like V2-06 pattern)

## Restated outcome

When V2-08 is **done** (after later Implement + independent Accept — **not** this slice):

1. A **small-scope teaching outline (提纲)** can be proposed by the model and **edited** (goals / explain / examples / checkpoints order) **before** compiling the **current** activity body.
2. Compiling the current activity produces a **presentable** TeachingUnit / ActivitySpec graph (library blocks + `blockOrder` + `sourceRefs` + goals) via the existing V2-07 job `compile-teaching-unit`, replacing today’s stub provider / empty `blockOrder` path — not a static fixture dump and not an empty chat box (`tasks.json` acceptance).
3. At most a **budgeted prefetch** of the next activity candidate(s) may run; the system **never** waits for whole-course generation (`plan.md` L112 / scope).
4. **Teaching path** (pedagogical sequence + `pathVersion` on `opening_teaching_activities`) is **not** `planDay` calendar scheduling (`packages/domain/src/opening/day-planner.ts` `planDay`).
5. **Prerequisite suggestions** are explainable and **skippable**; chapter locks must **not** use mastery percentages (`assertNoMasteryPercentage` in `tutor-policy.ts`).
6. Adjusting the current goal on the **same materials** revises **subsequent** path candidates / uncompiled activities only — **does not rewrite** already-published / already-learned activity history (content versions, observations, drafts).

## Out of scope (OOS) for V2-08 Understand→Plan

- **No Implement** of `teaching-plan.ts` / `teaching-compiler.ts` or any `apps/` / `packages/` product code.
- No migrations / ALTER; no inventing DDL (V2-07 already landed `0055_opening_compile_teaching_unit_job.sql`).
- Full layered verification / publish gate (**V2-09**).
- Experience UI for outline editor / skip-prereq controls (**V2-10+** / Experience) — Plan may name attach points only.
- Adaptive training graphs, FSRS/BKT mastery, OpenMAIC classroom roles/TTS/arbitrary HTML (`plan.md` OpenMAIC boundary).
- Push / hermes / stash / reset / commit; `tasks.json` status changes.
- Self-ACCEPT / self-verify.

## Gap table — already present vs missing for outline→activity compile

| Layer | Already does (tip `ae97498`) | Missing for V2-08 |
|---|---|---|
| Durable job + budget | `apps/worker/src/jobs/compile-teaching-unit.ts` — `createCompileTeachingUnitHandler`; `operationId = compile-teaching-unit:{job.id}`; purpose `compile-teaching-unit`; cancel/publish fences; `generate_status` → `needs_check` after model | Provider path is **stub** (`index.ts` L118–129 returns `{ stub: true }`); `defaultStubPublish` uses **empty** `blockOrder` + `generationConfig.extras.stub` |
| Hook for real compile | Optional `deps.buildPublishInput(scope, payload, providerOutput)` | No real builder that turns outline + evidence → `ActivitySpecPublishInput` + library blocks |
| Evidence / coverage | V2-06 `assembleTeachingEvidencePack` / `buildCoverageTable` / `classifyClaimSupport` landed | Compiler must **call** pack; not fork chunk loader |
| Teaching body | V2-05 library sole body + `publishActivitySpec` CAS; `teachingBlockRoleSchema`; `teachingGoalSchema` | No outline schema; no allowlisted activity/block-type gate; no “current vs subsequent” revision rule helper |
| Tutor policy | `tutor-policy.ts`: modes, soft page cites, `assertNoMasteryPercentage`, thin `recommendTutorAction` | No teaching-path outline types; no prereq-skip policy; path ≠ calendar not encoded |
| Calendar planning | `planDay` in `day-planner.ts` schedules `TaskItem` into time slots | Must stay **orthogonal** — teaching compiler must not call `planDay` or write `PlannedBlock` as teaching path |
| Activity row | `pathVersion`, `contentVersion`, `generateStatus`, `intentKind` (`teaching-activity.ts`) | No outline persistence convention; no “learned history frozen” rule when path bumps |
| Fixtures | V2-02 `lecture/activity-outline.json` sequence + `blockTypes` / `goalIds` / `sourceIds` | Product modules that validate/compile from that shape (or mapped UUID product ids) |

## Inventory (paths Read; behaviors cited)

### 1. `plan.md` §V2-08 (L485–503) + `tasks.json` V2-08

- Owner role **AI/领域**; depends **V2-05, V2-06, V2-07**; goals G1/G2/G3.
- Existing entry: `packages/domain/src/opening/tutor-policy.ts`.
- Proposed: `packages/domain/src/opening/teaching-plan.ts`; `packages/ai/src/opening/teaching-compiler.ts`.
- Acceptance: real model produces a presentable teaching unit (not static sample / blank chat).
- Rollback: turn off new orchestration; keep already-generated activities readable; no auto provider switch.

### 2. V2-07 stub — `apps/worker/src/jobs/compile-teaching-unit.ts`

- Payload: `mode: generate|repair`, `activityId`, optional `teachingUnitId`, `expectedContentVersion`, optional `sourceIds`, `clientKey` (L22–30).
- Stub instruction L181: `"Compile a teaching unit from authorized sources (stub until V2-08)."`.
- `defaultStubPublish` L108–126: empty `blockOrder`, `verificationStatus: "unchecked"`, `extras: { stub: true }`.
- Extension points already present (no new job kind needed):
  - `buildPublishInput?` (L65–69) — **primary V2-08 wire**.
  - `ensureTeachingUnitId?` (L70–74) — already used in `index.ts`.
  - Provider via `runBudgetedCall` — replace stub `complete` with real compile-oriented provider calls **or** multi-step compile inside `buildPublishInput` that itself uses a budgeted provider (Plan picks one; prefer keeping budgeted path on handler and putting structure in compiler).
- Wired in `apps/worker/src/index.ts` L118–152 with stub provider; kind registered; migration **`0055`** already allows `'compile-teaching-unit'`.

### 3. `packages/domain/src/opening/tutor-policy.ts` (reuse entry)

- `makeTutorInstruction` / deepen modes — tone for explain/hint; **not** teaching outline schema.
- `preferCitationsForPage` / soft `assertCitationsForPage` — aligns “无当前页也生成有依据的教学” (empty page OK; materials still via evidence pack).
- **`assertNoMasteryPercentage`** (L229–242) — **must** be applied to outline / path / prereq payloads (forbidden keys: `mastery`, `masteryPercent`, `masteryPercentage`, `mastery_pct`).
- `recommendTutorAction` — session deepen recommendations; **orthogonal** to teaching path compile (do not overload as chapter lock).

### 4. V2-06 evidence (landed)

- `packages/ai/src/opening/teaching-evidence.ts`: `assembleTeachingEvidencePack`, `formatProviderContext`, `classifyClaimSupport`, `assertNoHeldOutLeak`.
- `packages/domain/src/opening/teaching-coverage.ts`: `SourceAnchor`, `CoverageRow`, `buildCoverageTable`, `ClaimEvidenceKind`.
- Compiler consumes pack; does not reimplement `chunksAtSnapshots` / `selectContext`.

### 5. V2-05 content contracts

- `packages/contracts/src/opening/teaching-content.ts`: `teachingUnitSchema`, `activitySpecSchema`, `activitySpecPublishInputSchema`, `teachingGoalSchema`, `teachingBlockRefSchema` (`blockType` string + `role`), `teachingSourceRefSchema`, `generationConfig.extras`.
- Library = sole body; publish CAS on `expectedVersion`.
- M1 note: no ActivitySpec history table — past body via library `revision_number`; path changes must **not** mutate prior revisions’ meaning for already-learned attempts.

### 6. Teaching activity + path vs calendar

- `packages/contracts/src/opening/teaching-activity.ts`: `pathVersion` (positive int), `contentVersion`, statuses `active|paused|completed|skipped`, generate statuses including `needs_check`.
- `packages/domain/src/opening/day-planner.ts` **`planDay(tasks, freeSlots, options?)`** → `{ blocks: PlannedBlock[]; unscheduledTaskIds }` — calendar proposal only; comment in tests: “planDay only proposes; inputs and task status are untouched”.
- **Invariant:** teaching outline / path candidate APIs must not import or call `planDay`.

### 7. V2-02 fixture outline (engineering sample)

- `tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/activity-outline.json`: ordered activities with `goalIds`, `blockTypes` (`text`, `formula`, `matrix-viz`, `prompt`, `example`, `steps`, …), `sourceIds`, `notesZh`.
- First sample for allowlist validation + outline→current activity compile tests (map fixture ids → product UUID shapes in tests only).

## Proposed module boundaries (Understand → Plan)

| Module | Package | Owns | Does not own |
|---|---|---|---|
| **`teaching-plan.ts`** | `packages/domain` | Outline / path types; allowed blockType+role allowlist; prereq suggestion + skip flags; “path ≠ planDay” guards; freeze-history revision rules; reuse `assertNoMasteryPercentage` | Provider I/O; chunk load; job/budget; UI |
| **`teaching-compiler.ts`** | `packages/ai` | Outline propose + current-activity compile (+ optional prefetch) using evidence pack + provider; emit publish graph / library block drafts | Job state machine; DDL; Experience render; V2-09 verification |
| **`compile-teaching-unit.ts`** | worker (V2-07, Pipeline) | Durable job, budget, fences | Outline semantics — only **calls** AI compiler via `buildPublishInput` / richer provider text |

**Ownership (roles):**

- **AI (this slice):** `teaching-plan` + `teaching-compiler` + wire design into V2-07 stub.
- **Pipeline:** job shell already landed (V2-07); may assist wiring `buildPublishInput` at Implement if shared — AI owns compiler contract.
- **Experience:** outline edit UI, skip-prereq affordances, presenting current activity (later).
- **Data/Integrator:** migration numbers only if something new appears — **V2-08 expects none**.

## Decisions only Paula / PM can make

Defaults proposed (escalate if disagree):

1. **Outline persistence (M1):** store editable outline JSON under `TeachingUnit.generationConfig.extras.outline` (and/or activity `checkpointJson.outline` for in-progress edits) — **no new DDL**.  
2. **Post-compile generate_status:** keep V2-07 default **`needs_check`** after model compile (V2-09 verifies).  
3. **Prereq skip:** skip records an explicit `skipped` / `prereqSkipped` reason on path candidate — **never** invents mastery % unlock.  
4. **History freeze:** published activities with user progress (`status` completed/skipped or observations present) are **immutable** for body; path bump only appends / revises **uncompiled subsequent** candidates.  
5. **Prefetch budget:** default prefetch **0 or 1** next activity skeleton under same job budget class — not whole course.

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Ready for Plan?

**Yes.** Tip `ae97498` confirmed; V2-07 stub extension points and V2-05/06 attach points verified; PM constraints restated without inventing goals. Stop here until Plan is written; **no Implement**.
