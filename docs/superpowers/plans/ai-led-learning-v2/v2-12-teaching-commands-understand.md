# V2-12 Understand — 局部追问、改写、跳过和分支返回

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `3083809f7c29652f6a859a81bd402c486e5e66d1` (`feat/opening-release`) — matches required tip (V2-11 full merged)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no ALTER, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-12 (~L565+); `tasks.json` V2-12; gates `docs/superpowers/plans/opening-release/review-test-gates.md`; style refs `v2-11-intervention-prefs-*.md` / `v2-05-teaching-content-*.md`; attach V2-04/05/10/11

## Restated outcome

Ship **local teaching commands** so a learner can change route inside one activity without losing drafts, answer state, or body history — and without inventing a parallel chat product.

Concretely:

1. **Commands bind** `activityId` + `blockId` + `contentVersion`; support **`why` / `rephrase` / `expand` / `example` / `skip` / `branch` / `return`**.
2. **Local rewrite** (`rephrase` / `expand` / `example` / rewrite half of `why`) creates a **new library Revision** — **never** mutate the original revision body; preserve drafts + answer state across the bump.
3. **Branch** = same-activity recoverable path (stack in checkpoint), **not** an isolated chat thread.
4. Server checks **`clientKey` + `expectedVersion`** (activity `content_version` CAS); conflict → merge/reread required; **forbid last-write-wins**.
5. Nest into **TeachingWorkspace** / V2-05 clientInit / library CAS — **no parallel product**. Integrator assigns migration if needed (`00xx`; tip ends **0056**).
6. Data owns contracts + domain command semantics + repo/CAS seams + thin API route sketch; Experience owns UI affordances — Plan may preview; this slice does **not** implement UI or product code.

## Why this exists (gap after V2-05 / V2-10 / V2-11)

| Layer | Landed | Missing for V2-12 |
|---|---|---|
| Activity identity | V2-04 `opening_teaching_activities` + `content_version` / `path_version` / `checkpoint_json` / `client_key` | No command envelope; `path_version` unused for branch stack |
| Teaching body | V2-05 units/specs + library sole body; publish CAS `expectedVersion`; draft anchors on checkpoint | No local rewrite → new Revision path from learner command |
| Client init / workspace | V2-05 `getClientInit` + redact; V2-10 `TeachingWorkspace` / block-renderer / catalog | No command affordances; no POST commands route |
| Intervention prefs | V2-11 prefs + `decideIntervention` + checkpoint `interventionPrefs` / `interventionDecisions` | Commands are **user-initiated**; must not conflict with quiet/proactive prefs (user ask still allowed) |
| Plan §6.3 sketch | `POST …/commands` listed with next/skip/rephrase/expand/branch/return + clientKey/expectedVersion | Product files **absent**; `why`/`example` named in V2-12 scope |

## Inventory (paths cited)

### 1. Authority / task

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-12 — reuse `apps/web/src/features/opening/learning`; proposed `command-service.ts` + `…/commands/route.ts`; verify dual-edit conflict, redirect during generate, skip≠wrong-answer, return to original position, ask on different content versions; accept: change route without losing content; branch = recoverable same-activity path.
- `plan.md` §6.3 — interface sketch `POST /api/opening/teaching/activities/{id}/commands`.
- `tasks.json` V2-12 — depends_on V2-04, V2-05, V2-10, V2-11; goals G2/G3/G7; status `proposed`; evidence_status all `not_run` / pending_user.
- Gates: Implement ≠ Accept; plan-stage evidence lists reads/`not_run`; no self-ACCEPT.

### 2. V2-05 content / CAS / drafts (attach)

| Surface | Path | V2-12 use |
|---|---|---|
| Contracts | `packages/contracts/src/opening/teaching-content.ts` | `expectedVersion`, draft anchors, clientInit; extend with command request/response sketches |
| Publish CAS | `opening-teaching-content.ts` `publishActivitySpec` | Pattern for activity `content_version` bump; soft-idempotent graph |
| Library CAS | `packages/database/src/repositories/library.ts` `updateDocument({ expectedRevisionNumber })` | **Rewrite commands** append new revision; never in-place mutate old revision rows |
| Drafts | `saveDraftAnchors` + `teachingDraftAnchorSchema` | Preserve `checkpoint_json.drafts` across rewrite/content bump; conflict if blockIds lost |
| Client init | `getClientInit` / `redactBlocksForClientInit` | Post-command response should return refreshed clientInit (or instruct reread) without leaking answer keys |
| Spec pin | `opening_teaching_activity_specs.revision_number` | After rewrite, pin new revision + bump activity `content_version` in one transaction |

### 3. V2-04 activity / clientKey

- `opening_teaching_activities`: `client_key` + `create_intent` idempotency on create; `content_version`; `path_version` (positive int, default 1); `checkpoint_json`; status includes `skipped` (activity-level — **not** the same as block `skip` command).
- Command idempotency Plan default: **`clientKey` scoped to command intent** (see Plan) checked against a small checkpoint command log / unique constraint — **not** reuse create `client_key` column for command replay.

### 4. V2-10 TeachingWorkspace

- `teaching-workspace.tsx` / `block-renderer.tsx` / `component-catalog.ts` — render clientInit; Experience will add command affordances later.
- Nest rule: commands act **inside** workspace on current activity blocks; no second shell / free-chat branch UI as the branch product.

### 5. V2-11 intervention prefs (do not conflict)

- Checkpoint keys already: `interventionPrefs`, `interventionDecisions`, `drafts`.
- V2-12 Plan keys must be **disjoint**: e.g. `branchStack`, `commandLog`, `currentBlockId`, `skippedBlockIds` — merge helpers must preserve intervention + drafts keys (same spirit as `mergeSessionInterventionPrefs` preserve drafts).
- Semantics: teaching commands are **`user_help_ask`-class** / explicit user actions — quiet mode / proactivity off **must not** block `why`/`rephrase`/`expand`/`example`/`skip`/`branch`/`return`. Intervention policy gates *system proactive*; it does not authorize or deny these commands.

### 6. Formal attempts / skip without wrong-answer

- Formal answers: `opening_learning_observations` / attempts (+ `activity_id`) — **do not** write `incorrect` (or any graded observation) solely because user **skipped** a block.
- Activity status `skipped` remains whole-activity progress; block skip is checkpoint path state only until a later V2-13/14 resume package needs richer semantics.
- Plan default: skip updates checkpoint (`skippedBlockIds` / cursor) + optional `path_version` bump; **no** observation insert.

### 7. Migrations tip

Live migrations under `packages/database/src/migrations/` end at **`0056_opening_intervention_settings.sql`**. Any new DDL uses placeholder **`00xx`**; Integrator assigns. Prefer **no new table** if branch stack fits in `checkpoint_json`.

### 8. Proposed / absent product files

- `apps/web/src/features/opening/teaching/command-service.ts` — **absent** (Data Implement)
- `apps/web/src/app/api/opening/teaching/activities/[id]/commands/route.ts` — **absent** (Data/Service Implement)
- Contracts domain helpers for commands — **absent**
- No existing V2-12 understand/plan docs before this slice

## Out of scope (OOS) for V2-12 Understand+Plan

- **No product Implement** / no UI / no ALTER / no migrate / no commit / push / hermes / stash / reset.
- Inventing migration numbers (keep `00xx`; tip ends **0056**).
- LWW overwrite; chat-as-branch; mutate original library revision; parallel command product outside TeachingWorkspace.
- Changing mastery / observation evidence semantics beyond “skip must not write wrong-answer” (full V2-13).
- Full resume package (V2-14) — only leave checkpoint shapes that resume can later consume.
- Moving `tasks.json` → verified / in_progress.
- Experience command chrome implement (preview only in Plan).

## Open decisions for PM / Paula

Only items that change product meaning (Plan defaults below; escalate if Paula disagrees):

1. **DDL:** Prefer **checkpoint_json only** (branch stack + command log ring) vs new `opening_teaching_commands` table. Plan default = **no new table**.
2. **Rewrite bump:** Local rewrite bumps **both** library revision **and** activity `content_version` (and pins spec `revision_number`) vs library-only bump. Plan default = **both in one txn** so clientInit CAS stays coherent.
3. **`why` semantics:** Explain-in-place via ephemeral assist (no body write) vs always create rewrite Revision. Plan default = **`why` = assist projection + optional recorded help exposure later; does not rewrite body**; `rephrase`/`expand`/`example` rewrite.
4. **Skip grade:** Confirm **no observation / no incorrect** on skip. Plan default = **confirm**.
5. **`path_version`:** Bump on branch/return/skip cursor moves vs leave unused. Plan default = **bump `path_version` on branch/return/skip** (content rewrite bumps `content_version`); clients may CAS either field via command envelope `expectedPathVersion` optional.

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Ready for Plan?

**Yes.** Inventory closed; CAS + draft + workspace + intervention non-conflict attach clear; stop here until Plan is written and Plan ACCEPT granted before any Implement.
