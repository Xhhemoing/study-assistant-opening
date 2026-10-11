# V2-07 Understand — 把教学生成接入现有持久任务与预算

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Pipeline (executor / Grok Bot)  
**Branch tip:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`feat/opening-release`) — matches required baseline `cccc392` (includes V2-05 / migration `0054`)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no ALTER, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-07; `tasks.json` V2-07; `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Dirty tree note:** Unrelated untracked evidence files present; no reset/stash. Did **not** edit AI’s parallel V2-06 Plan tree (none present under `v2-06*` at observation time).

## Restated outcome

Wire **teaching generation** into the **existing** durable job + budget stack so that:

1. Generate / repair / cancel / unknown / failure are **distinct** durable states (job + activity `generate_status`).
2. Provider calls reuse **operationId**, ledger **reserve / release / settle / markUnknown**, and **privacy epoch** (same family as tutor-turn + `runBudgetedCall`).
3. Bounded BullMQ retries **must not** re-consume balance already **released** or held as **unknown**.
4. Successful write-back checks **owner**, **source/privacy**, **activity content version** (and teaching-content unit revision where applicable), and **epoch**.
5. Refresh recovers via the **already-persisted** job — no duplicate content / duplicate internal debit from reload.

## Current durable job model (inventory)

### Two parallel durable paths today

| Path | Table | Dispatch | Worker entry | Notes |
|---|---|---|---|---|
| **Opening jobs** | `opening_jobs` + `opening_outbox` | `dispatchPending` → BullMQ `opening-{kind}` | `runJob` → `handlerForKind` | Kinds registered in `createQueues` / `createHandlers` |
| **Tutor turns** | `opening_tutor_jobs` | `dispatchTutorTurns` → queue `tutor` | `createTutorTurnHandler` **bypasses** `runJob` | Separate claim/complete/cancel/markUnknown |

Teaching generation should follow the **opening_jobs + outbox** path (like `build-course-knowledge` / `parse-media` / `extract-study-actions`), **not** the tutor-turn table — tutor is conversation-turn scoped and already owns the `tutor` queue name.

### `opening_jobs` / outbox / states

- Schema: `packages/database/src/schema/opening-jobs.ts` — `id`, `workspaceId`, `ownerUserId`, `key` (unique per workspace), `kind`, `payload`, `result`, `state`, `privacyEpoch`.
- Migration `0018_opening_jobs_outbox_budget.sql` L12: job states  
  `queued | running | succeeded | failed | cancelled | outcome_unknown`.
- Idempotent enqueue: `createOnce(scope, { key, kind, payload, privacyEpoch })` — same key + same payload replays; different payload → `CONFLICT` (`opening-jobs.ts` L46–L101).
- Outbox: `opening_outbox` pending → `dispatchPending` enqueues BullMQ with deterministic `jobId` = `opening-ws-{workspaceId}-job-{jobId}` (`queue.ts` L7–L8; `dispatch.ts` L27–L35). Attempts: **2**, exponential backoff 1s.
- Claim / finish: `claim` CAS from `queued` or stale `running` (>5 min); `finish(succeeded|failed|outcome_unknown)`; `failed` routes through `failOpeningJob` (parse / parse-media source write-back with owner + version + epoch fences).
- `canClaimJob`: only `queued` / `running` — **`cancelled` is not claimable** (`run-job.ts` L14–L16; test asserts).

### BullMQ kinds already in `createQueues` + `createHandlers`

From `apps/worker/src/runtime/queue.ts` L18–L19 and `handlers.ts` L4–L23:

| Kind | Handler wiring (index.ts) | Kind CHECK migration |
|---|---|---|
| `parse` | parse-source | 0018 / later alters |
| `tutor` | **special** tutor-turn (not via handlers map for execution) | historical; tutor jobs table |
| `retest` | retest handlers | … |
| `remind` | remind | … |
| `build-course-knowledge` | build-course-knowledge | … |
| `parse-media` | parse-media | `0050_opening_parse_media_job.sql` |
| `extract-study-actions` | extract-study-actions | `0051_opening_extract_study_actions_job.sql` |

**Absent today:** any teaching / compile-teaching job kind. DB CHECK tip (0051) ends at `extract-study-actions`; later migrations 0052–0054 did **not** add a teaching job kind.

### Enqueue template to mirror

`opening-knowledge.ts` `enqueueRebuild` (L263–L308):

1. Assert ownership.
2. Snapshot `workspaces.privacy_epoch` into the job row.
3. `INSERT opening_jobs` with idempotency `key = kind:…:clientKey`.
4. On insert, write `opening_outbox` topic `opening.job.enqueue` payload `{ jobId, kind, … }`.

## Budgeted-call / tutor-turn: operationId, reserve/settle, privacy epoch

### `runBudgetedCall` (`apps/worker/src/runtime/budgeted-call.ts`)

| Fact | Lines | Meaning for V2-07 |
|---|---|---|
| `operationId?` | L40–L47, L119–L126 | When set, used as ledger `requestId` so retries reuse one reservation |
| Hardcoded `purpose: "tutor"` | L122 | Teaching must **not** silently share tutor purpose forever — Plan: make `purpose` injectable (default `"tutor"` for back-compat) |
| `beforeSend` then release on throw | L127–L132 | Cancel / epoch fail **before** provider → `release` (no usage) |
| Provider error → release vs markUnknown | L69–L88, L137–L147 | AUTH / RATE_LIMIT / MEDIA_UNSUPPORTED → release; timeout/network/default → markUnknown |
| Missing usage tokens → markUnknown | L150–L152 | Never settle as zero |
| Settle caps to reserved + optional overage audit | L92–L106, L154–L165 | No unpolicied over-booking |

### Ledger idempotency (`opening-budget.ts`)

- `reserve` is idempotent by `request_id` **only while** existing row is still `state = 'reserved'` with same workspace/purpose/amount/snapshot (L188–L194).  
  Otherwise → `CONFLICT` (“request already consumed or changed”).
- `release` / `complete` / `settle` transition `reserved` → terminal.
- `markUnknown` **keeps** the row `reserved` (cap space retained until lazy reconcile ages it to `completed`) (L52–L56, L242–L246).

**Implication (critical gap vs V2-07 wording):**

- Retry with **same** `operationId` while still `reserved` (unknown / in-flight) → **no second debit** (desired).
- Retry with **same** `operationId` after **`released`** → ledger **CONFLICT**, does **not** re-reserve (desired “do not re-consume released”). Caller must treat that as terminal for that job attempt — **must not** mint a new operationId on automatic BullMQ retry after release.
- Fresh user-initiated generate → **new** job row / new idempotency key / new operationId (new debit OK).

### Tutor-turn pattern to reuse (`tutor-turn.ts`)

- Claim CAS; scope = workspace + owner (L91–L97).
- Privacy: snapshot epoch at start; filter excluded sources; `beforeSend` + pre-complete `assertCurrentEpoch` (L107–L116, L184–L186, L202–L205).
- `operationId = tutor:${claimed.id}` passed as both `requestId` and `operationId` (L171–L181).
- On catch: `PROVIDER_TIMEOUT` / `PROVIDER_NETWORK` → `markUnknown` on tutor job; else `fail` (L233–L242).

### Generic job epoch fence (`run-job.ts`)

- Before handler and before succeed write-back: `workspacePrivacyEpoch` must equal `job.privacyEpoch` or finish `failed` with privacy message (L28–L49).
- Catch: `outcome_unknown` vs `failed` via `isUnknownOutcome` (L18–L20, L52–L54).

## Where teaching generation plugs in

### Recommendation (Understand → Plan): **new job kind**, do not extend tutor

| Option | Verdict | Rationale |
|---|---|---|
| **A. New kind `compile-teaching-unit`** on `opening_jobs` | **Recommend** | Matches `plan.md` / `tasks.json` proposed path `apps/worker/src/jobs/compile-teaching-unit.ts`; same outbox/dispatch/runJob/privacyEpoch stack as knowledge/parse-media; activity write-back fits `failOpeningJob`-style extension |
| B. Extend `tutor` / `opening_tutor_jobs` | Reject | Tutor is turn/conversation scoped; separate cancel/complete APIs; teaching publish is activity + library + content_version, not assistant turns |
| C. Overload `build-course-knowledge` | Reject | Course graph rebuild ≠ TeachingUnit/ActivitySpec compile; different CAS targets and UX |
| D. Ephemeral web-only generate | Reject | Violates G7 persistence / refresh recovery / budget ledger (C04) |

**Modes on one kind (not separate kinds):** payload `mode: "generate" | "repair"` — repair reuses same budget/epoch/write-back machinery with different expectedVersion / patch semantics. Cancel / unknown / failure are **job states** (+ activity `generate_status`), not kinds.

## Gaps vs V2-07 requirements

| Requirement | Today | Gap |
|---|---|---|
| Register teaching task in worker/runtime | Kinds list fixed; no teaching handler | New kind + queue + handler + CHECK migration `00xx` |
| Reuse operationId / budget / epoch | Tutor + runJob patterns exist | Handler must pass operationId; purpose should become injectable; enqueue must stamp privacyEpoch |
| Distinguish generate / repair / cancel / unknown / failure | Job states include cancelled/outcome_unknown/failed; activity `generateStatus` enum already has queued/generating/ready/failed/unknown/cancelled/stale/needs_check | **No** teaching enqueue; **no** `setGenerateStatus` writer on activity repo (create defaults `ready`); **no** `cancel` API on `opening_jobs` (schema allows `cancelled`; tutor has `cancel`) |
| Bounded retries without re-consuming released/unknown | Ledger CONFLICT after release; unknown keeps reserved | Handler + tests must **forbid** attempt-scoped new operationId on auto-retry after release; document BullMQ attempts=2 semantics |
| Write-back: owner / source / activity version / epoch | `publishActivitySpec` CAS on `content_version`; `assertOwnedActivity`; runJob epoch; parse failure version fence | Teaching finish path must: (1) re-check epoch, (2) owner scope, (3) optional source exclusion/readiness, (4) `expectedVersion` into `publishActivitySpec`, (5) fence `generate_status` so cancel/stale discard late results |
| Refresh via persisted job | createOnce + outbox exist | Need enqueue API + client poll by job id / activity generateStatus |

## Interactions with V2-04 / V2-05 (read-only)

### V2-04 activities

- `opening_teaching_activities` has `generate_status`, `content_version`, owner/workspace, `source_ids` (migration `0053`).
- Contracts: `teachingActivityGenerateStatusSchema` includes all statuses V2-07 needs (`teaching-activity.ts` L20–L28).
- UI honesty already branches on generateStatus (`today-activity.ts` / `activity-panel.tsx`) — generation job must drive real transitions; Experience is consumer only.

### V2-05 teaching content (landed on tip `cccc392` / `0054`)

- `publishActivitySpec(scope, { activityId, teachingUnitId, expectedVersion, revisionNumber, blockOrder, … })` — soft-idempotent CAS (`opening-teaching-content.ts` L263–L392).
- Sole body remains library documents/revisions; job writes **metadata + publish**, does not invent a second body store.
- V2-05 OOS explicitly deferred pipeline / `compile-teaching-unit` to **V2-07** — this Understand closes that handoff.
- Do **not** change V2-05 schemas/contracts in this slice; Implement (later) only **calls** publish APIs and may add a thin `setGenerateStatus` / cancel helper if missing.

### V2-06 (parallel)

- Coverage / evidence positioning may later feed `sourceRefs` into compile payload.
- This turn: **read-only** awareness; no edits to V2-06 Plan trees or product code.

## Explicit non-goals (this turn)

- **No Implement** of product/worker/database code.
- **No** inventing migration numbers (placeholder **`00xx`** only; Integrator assigns against live tip — migrations currently through **`0054`**).
- **No** push / hermes / stash / reset / commit.
- **No** self-ACCEPT / `tasks.json` → verified.
- **No** V2-08 compiler / model orchestration beyond naming the job that will host it.
- **No** Experience UI beyond noting generateStatus consumers.
- **No** stealing / rewriting AI V2-06 docs.

## Open items for Plan (non-blocking defaults)

1. **Job kind string:** `compile-teaching-unit` (align pack proposed path).  
2. **Budget purpose:** injectable `purpose: "compile-teaching-unit"` (not hardcoded tutor).  
3. **Cancel:** add `opening_jobs` cancel helper (mirror tutor cancel + activity generate_status → cancelled); late provider results must no-op write-back.  
4. **Repair vs generate:** same kind, payload.mode; repair requires `expectedVersion` matching current content_version.

## Ready for Plan?

**Yes.** Durable model, budget/epoch facts, plug-in recommendation, and gaps are closed enough for a Plan ACCEPT gate. Stop here until Plan is written; **no Implement**.
