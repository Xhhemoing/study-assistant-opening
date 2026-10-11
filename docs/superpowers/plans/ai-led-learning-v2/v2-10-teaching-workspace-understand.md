# V2-10 Understand — 交付AI主讲教学工作区与受控基础渲染

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch tip:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`, `feat/opening-release`) — matches required tip (V2-08 merged)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no product code, no migrations, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-10 (L525–543); `tasks.json` V2-10; PM assignment (Projects Manager); UX `docs/product/UX_AND_AI_POLICY.md`; reuse V2-03 / V2-05 / CT-03  
**Dirty tree note:** Unrelated untracked evidence files may be present (`rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`); **not** touched. No stash/reset. AI is writing V2-09 Plan in parallel — **this slice does not edit product/app/package source trees**.

## PM constraints (verbatim / must appear)

From Projects Manager assignment + `plan.md` §V2-10 / `tasks.json` V2-10 `scope`:

> 主区为当前AI教学；提纲、原材料、草稿按需展开，首页主操作为继续/开始学习。

> 组件目录含text/math/step/example/question/draft/evidence；布局用既有Tailwind约束。

> 模型仅选择组件与参数，客户端动作仍经服务端授权；禁止任意HTML/JS和预加载隐藏答案。

Additional PM assignment wording (this turn):

> Main pane = current teaching; Continue/start = primary CTA (reuse CT-03)

> No arbitrary HTML/JS; Do not preload hidden answers

> Wire to CT-03 activity panel + V2-05 clientInit

> Proposed new paths: `teaching-workspace.tsx`, `block-renderer.tsx`, `component-catalog.ts` under `apps/web/src/features/opening/teaching/`

> Catalog: text/math/step/example/question/draft/evidence; Tailwind only

> Model picks components+params; client actions still server-authorized

## Restated outcome

When V2-10 is **done** (after later Implement + independent Accept — **not** this slice):

1. **Main pane** of Today is the **current AI teaching workspace** (not free-chat embed, not a second shell). Outline / raw materials / drafts open **on demand**; they do not displace the teaching main pane by default.
2. Homepage **primary CTA** remains **继续学习 / 开始学习** from CT-03 (`todayActivityCtaLabel` + `runPrimaryCta` in `today-dashboard.tsx`) — V2-10 **reuses** that entry; does not invent a parallel “start lecture” button.
3. Learner can **begin learning without opening the original MediaReader / course library viewer** first (`plan.md` acceptance: 无需打开原阅读器也能开始学习).
4. Teaching body renders from **V2-05 `ActivitySpecClientInit`** via an allowlisted **component catalog** (`text` / `math` / `step` / `example` / `question` / `draft` / `evidence`) with **Tailwind-only** layout tokens from existing `design/ui`.
5. Model (upstream V2-07/08 compile) only **selects components + params**; the client **never** executes arbitrary HTML/JS and **never** preloads hidden `answer_key` plaintext (`answerRef.revealState === "hidden"` → `content: null` already enforced by contracts + `redactBlocksForClientInit`).
6. Interactive client actions (reveal, submit draft, follow-up, open cite drawer) remain **server-authorized**; unknown schema / invalid component / illegal link **fail-soft** (partial render + honest status), not crash the shell.
7. **Citations are inspectable in-context** (evidence / sourceRefs); follow-up questions stay in the teaching workspace — learner does not leave current teaching context to chase a cite (`plan.md` acceptance: 引用可查，追问不离开当前教学上下文).

## Out of scope (OOS) for V2-10 Understand→Plan

- **No Implement** of `teaching-workspace.tsx` / `block-renderer.tsx` / `component-catalog.ts` or any other `apps/` / `packages/` product code in this slice.
- No migrations / ALTER / DDL (UI-only; ActivitySpec + library body already landed in V2-05 `0054`).
- **V2-09** layered verification / publish gate (AI writing Plan in parallel — do not own or block).
- **V2-11** intervention preferences / quiet-mode controls (`preference-controls.tsx`).
- **V2-12** local commands / command palette teaching actions.
- Arbitrary HTML/JS renderers, iframe sandboxes for model HTML, Markdown→raw `dangerouslySetInnerHTML` of untrusted model strings.
- Full **MediaReader seek** integration as primary teaching surface (CT-03 ACCEPT already: no MediaReader seek scope-creep; V2-10 may **cite** `sourceRefs` / open a secondary drawer or link — not replace workspace with MediaReader).
- OpenMAIC classroom roles / TTS / adaptive mastery graphs / FSRS-BKT chapter locks.
- Outline editor UX owned by later Experience slices that consume V2-08 outline APIs (V2-10 may show a **read-only / expandable outline strip** if clientInit carries enough metadata — full edit is OOS unless PM expands).
- Push / hermes / stash / reset / commit; `tasks.json` status changes; self-ACCEPT / self-verify.

## Explicit non-goals (checklist)

| Non-goal | Why |
|---|---|
| V2-11 prefs | Separate task; intervention policy not this surface |
| V2-12 local commands | Separate task |
| Arbitrary HTML/JS | `plan.md` / PM forbid; catalog allowlist only |
| Preload hidden answers | V2-05 `activitySpecClientInitSchema` + `redactBlocksForClientInit` already ban; UI must not invent a second channel |
| MediaReader as main teaching pane | Acceptance is learn **without** opening original reader; seek is OOS |
| Second teaching shell / route | Stay inside `/opening/today` + existing Opening shell (CT-03) |
| Invent DDL / migration number | UI-only; no new tables |
| Fake AI lecture from static fixtures when `generateStatus` not ready | Honesty copy from `teachingActivityContentHonesty` remains |
| Client-only authorize reveal / grade | Server must authorize; client displays |

## Gap table — already present vs missing for teaching workspace

| Layer | Already does (tip `f5dae08`) | Missing for V2-10 |
|---|---|---|
| Today primary CTA (CT-03 ACCEPT) | `today-dashboard.tsx`: `data-today-primary-cta` → `runPrimaryCta`; empty pane `TeachingActivityEmpty`「开始学习」; label via `todayActivityCtaLabel` | CTA still only selects/creates activity; **does not load clientInit blocks** into main pane |
| Activity panel (CT-03) | `activity-panel.tsx`: intentSummary + status/generate badges + honesty + quiet assistant link | **No block render**; honesty still says full AI 主讲 may not be on this page |
| Activity helpers | `today-activity.ts`: pick current, CTA label, honesty, `buildStartLearningCreateInput` | No mapping from `ActivitySpecClientInit.blocks` → catalog components |
| V2-05 contracts | `packages/contracts/src/opening/teaching-content.ts`: `activitySpecClientInitSchema`, `activitySpecClientBlockSchema`, `teachingAnswerRefSchema`, `teachingSourceRefSchema`, roles `teach\|prompt\|example\|answer_key\|meta` | Experience catalog names (`math`/`step`/`question`/…) need **normalize map** from library `blockType` strings |
| V2-05 redact | `packages/database/.../opening-teaching-content.ts` `redactBlocksForClientInit` / `sanitizeCheckpointForRestore`; service `getClientInit` | **No HTTP route** under `apps/web/src/app/api/opening/` for clientInit yet; **OpeningApi** has activity CRUD only — no `getTeachingClientInit` |
| Teaching content service | `teaching-content-service.ts` exposes `getClientInit` (server-side) | Not wired to browser client |
| Design tokens | `apps/web/src/features/opening/design/ui.tsx` — `ui.primary` / `ui.quiet` / `ui.badge` + Tailwind zinc/emerald patterns | Workspace / block renderer not present (`teaching-workspace.tsx` **absent**) |
| Cite / evidence patterns | `knowledge-evidence.tsx` `evidenceTargetsForNode` (material/video/problem links); `media-reader.tsx` for course media; `inbox/source-viewer.tsx` | Teaching workspace needs **in-pane evidence** from `sourceRefs` — cite without leaving teaching context (drawer / expandable panel), not navigate-away as only option |
| Feature flag precedent | `OPENING_RELEASE` is product-wide registration/UI gate — **not** per-capability teaching flag | Need a **teaching-workspace** capability flag (env or existing settings pattern) for rollback per `plan.md` |

## Inventory (paths Read; behaviors cited)

### 1. `plan.md` §V2-10 (L525–543) + `tasks.json` V2-10

- Owner role **前端/交互** (Experience); depends **V2-03, V2-05**; goals G1 / G3 / G5.
- Existing: `apps/web/src/features/opening`; `docs/product/UX_AND_AI_POLICY.md`.
- Proposed: `teaching-workspace.tsx`, `block-renderer.tsx`, `component-catalog.ts` under `apps/web/src/features/opening/teaching/`.
- Verification: invalid component, illegal link/action, unknown schema version, partial render fail, keyboard + text alternative; responsive/device = **user** acceptance (`pending_user`); no agent screenshots.
- Acceptance: learn without opening original reader; cites checkable; follow-ups stay in teaching context.
- Rollback: feature flag → old entry; new content **read-only**; never disguise static samples as AI-generated.
- Source refs: E03, E04, C01, C14.

### 2. CT-03 Today → activity panel (ACCEPT attach)

- `apps/web/src/features/opening/planning/today-dashboard.tsx`
  - Loads `api.listTeachingActivities()`; `currentActivity = selectedActivity ?? pickCurrentTeachingActivity(activities)`.
  - Primary CTA `data-today-primary-cta` → `runPrimaryCta` (continue existing `active`/`paused` or `createTeachingActivity`).
  - Main column: `TeachingActivityPanel` **or** `TeachingActivityEmpty` (L206–220).
- `apps/web/src/features/opening/teaching/activity-panel.tsx`
  - Metadata panel + honesty; empty state primary「开始学习」reuses parent `onStart`.
  - Free chat = `ui.quiet` secondary only.
- `apps/web/src/features/opening/teaching/today-activity.ts`
  - `todayActivityCtaLabel`, `teachingActivityContentHonesty`, `buildStartLearningCreateInput`.
- Evidence: `docs/superpowers/evidence/2026-10-11-opening-release/ct-03-today-activity-accept.md` — ACCEPT; no MediaReader seek.

**V2-10 attach rule:** replace/extend the **main pane body** that currently mounts `TeachingActivityPanel` with `TeachingWorkspace` when flag on + clientInit available; keep CTA / empty / honesty paths; do not re-embed `AssistantView`.

### 3. V2-05 teaching content / clientInit / redact

| Symbol | Path | Role for V2-10 |
|---|---|---|
| `activitySpecClientInitSchema` | `packages/contracts/src/opening/teaching-content.ts` | Client-safe projection: blocks + contentVersion + optional checkpointJson |
| `activitySpecClientBlockSchema` | same | `blockId`, `position`, `blockType`, `role`, `content` nullable, optional `answerRef` |
| `teachingAnswerRefSchema` | same | `revealState: hidden \| revealed`; hidden forbids plaintext (superRefine) |
| `teachingSourceRefSchema` | same | `sourceId`, optional version / chunkId / page — cite targets |
| `teachingBlockRoleSchema` | same | `teach \| prompt \| example \| answer_key \| meta` |
| `redactBlocksForClientInit` | `packages/database/src/repositories/opening-teaching-content.ts` | Server strips answer_key body → `content: null` + `answerRef.hidden` |
| `getClientInit` | repo + `teaching-content-service.ts` | Owned activity → redacted init |
| Contracts test | `packages/contracts/src/opening/teaching-content.test.ts` | Asserts clientInit forbids hidden answer plaintext |

**Gap:** browser cannot call `getClientInit` yet — Plan must include thin **HTTP + OpeningApi** wire (Experience Implement later; still no DDL).

### 4. UX policy (`docs/product/UX_AND_AI_POLICY.md`)

Relevant to workspace UX (not inventing new policy):

- §1 Layer 1 default: status + next action + expandable detail — matches “提纲/原材料/草稿按需展开”.
- §2 Homepage budget: one primary action — matches CT-03 single CTA.
- §5 防止 AI 代学: attempt before full answer; user may choose to see answer but that is not high-quality mastery evidence — aligns with no preload hidden answers + server-gated reveal.
- §7 A11y: not color-only; keyboard for drawers/tasks; model failure → honest degrade, task still continuable.

### 5. Cite-without-leaving-context patterns (existing)

- `apps/web/src/features/opening/knowledge/knowledge-evidence.tsx` — pure `evidenceTargetsForNode`; links to course materials / media / library; honest “暂不能自动定位” when seek unknown.
- `apps/web/src/features/opening/sources/media-reader.tsx` — MediaReader for selected source; **not** Today main pane (CT-01 mounts after select on course detail).
- `apps/web/src/features/opening/inbox/source-viewer.tsx` — inbox source viewing.

**V2-10 cite stance:** primary teaching stays in workspace; evidence component renders `sourceRefs` with expandable cite panel / quiet link. Full MediaReader seek remains **secondary / OOS as main flow**.

### 6. Proposed paths (absent at tip — `proposed_new`)

| Path | Status at `f5dae08` |
|---|---|
| `apps/web/src/features/opening/teaching/teaching-workspace.tsx` | **absent** (`proposed_new`) |
| `apps/web/src/features/opening/teaching/block-renderer.tsx` | **absent** (`proposed_new`) |
| `apps/web/src/features/opening/teaching/component-catalog.ts` | **absent** (`proposed_new`) |

### 7. Dependencies status

| Dep | Status | Note |
|---|---|---|
| V2-03 | in (plan dependency) | Activity compatibility ADR path |
| V2-05 | in | TeachingUnit / ActivitySpec / clientInit / redact |
| CT-03 | ACCEPT | Today → activity panel + primary CTA |
| V2-08 | tip `f5dae08` merged | Compiler may supply richer blocks; UI must still honesty-fail when not ready |
| V2-09 | Plan in parallel (AI) | Workspace must not claim “verified” authority; display verificationStatus honestly |

## Open decisions for PM only

Defaults proposed below (also listed in Plan § default design decisions). Escalate if disagree:

1. **Main-pane swap:** when flag on and `generateStatus` allows readable content (`ready` or product-agreed subset) **and** clientInit returns blocks, mount `TeachingWorkspace`; else keep CT-03 `TeachingActivityPanel` / Empty honesty — never fake lecture.
2. **Catalog ↔ library `blockType` map:** Experience catalog ids = `text|math|step|example|question|draft|evidence`; normalize known library types (`formula`→`math`, `steps`→`step`, `prompt`→`question`, `answer_key`→gated, etc.); **unknown → fail-soft placeholder**, never raw HTML.
3. **Cite UX:** in-pane expandable evidence from `sourceRefs` first; deep-link to course/MediaReader is quiet secondary — do not require MediaReader open to start.
4. **HTTP surface:** add thin Opening route + `OpeningApi.getTeachingClientInit(activityId)` wrapping existing service (Implement later) — no new Data package ownership transfer.
5. **Feature flag name (proposed):** `OPENING_TEACHING_WORKSPACE=1` (or equivalent capability flag) — off → CT-03 panel; on → workspace when data ready; rollback keeps content readable read-only.

## Ready for Plan?

**Yes.** Tip `f5dae08` confirmed; CT-03 / V2-05 attach points and gaps (no clientInit HTTP, no catalog/renderer) verified; PM constraints restated without inventing goals. Stop until Plan is written; **no Implement**.
