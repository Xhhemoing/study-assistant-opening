# V2-07 Plan — Teaching generation jobs + budget wiring

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Pipeline (executor / Grok Bot)  
**Branch tip:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`feat/opening-release`) — baseline `cccc392` (V2-05 / `0054`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · migration placeholder **`00xx`** (Integrator assigns; tip migrations end at **`0054`**)  
**Align:** `plan.md` §V2-07; `tasks.json` V2-07; Understand `v2-07-teaching-generation-jobs-understand.md`; `review-test-gates.md`  
**Source refs:** C04, P01, C01

## 1. Sequencing

```
Understand (this slice, done in docs)
    → Integrator Plan ACCEPT (independent; no self-ACCEPT)
        → PM may open Implement gate later
            → Implement (worker + thin enqueue + tests + 00xx migration)
                → Independent Implement ACCEPT
```

- This slice delivers **Understand + Plan + plan-stage evidence only**.
- **Do not** mark `tasks.json` verified; **do not** land product code under Plan ACCEPT alone.
- V2-08 (outline→activity compiler) **depends on** this job shell; V2-07 Implement may stub provider call behind budgeted-call with a test double until V2-08 lands real compile — but must still exercise ledger + write-back fences.

## 2. Smallest design

### 2.1 Recommendation: new job kind (confirmed)

| Decision | Choice | Rationale |
|---|---|---|
| Job kind name | **`compile-teaching-unit`** | Matches pack `proposed_paths`; clear vs tutor/parse/knowledge |
| Durable store | **`opening_jobs` + `opening_outbox`** | Same refresh/idempotency/dispatch path as knowledge rebuild |
| Modes | **One kind**, payload `mode: "generate" \| "repair"` | Shared budget/epoch/write-back; avoid CHECK churn for near-identical work |
| Cancel / unknown / failure | Job `state` + activity `generate_status` | Schema already allows both; wire writers |
| Not | Extend `opening_tutor_jobs` / overload `build-course-knowledge` | Wrong aggregate root (Understand §plug-in) |

### 2.2 Registration surface (Implement later)

| Layer | Change |
|---|---|
| DB CHECK | Migration **`00xx_opening_compile_teaching_unit_job.sql`**: drop/add `opening_jobs_kind_check` to include `'compile-teaching-unit'` (pattern of `0050` / `0051`) |
| `createQueues` | Append `"compile-teaching-unit"` to kinds array (`queue.ts`) |
| `createHandlers` | Add optional `"compile-teaching-unit"` handler key (`handlers.ts`) |
| Worker `index.ts` | Construct handler; pass into `createHandlers`; no special-case like tutor (use **`runJob`**) |
| Job module | **`apps/worker/src/jobs/compile-teaching-unit.ts`** (+ `.test.ts`) |
| Enqueue API | Thin repo/service method (prefer under teaching content or activities repo): mirror `enqueueRebuild` |

### 2.3 Payload shape (sketch — not implemented)

```ts
// opening_jobs.payload for kind compile-teaching-unit
{
  mode: "generate" | "repair",
  activityId: uuid,
  teachingUnitId?: uuid,          // required for repair; generate may create-or-bind per V2-05 rules at Implement
  expectedContentVersion: number, // CAS into publishActivitySpec / generate_status fence
  expectedUnitVersion?: number,   // optional unit metadata CAS
  sourceIds?: uuid[],             // snapshot; must be subset of activity / authorized
  clientKey: string,              // also embedded in job.key
  // never: API keys, signed URLs, raw answer keys for client echo
}
```

### 2.4 Idempotency keys

| Layer | Key | Behavior |
|---|---|---|
| Job row | `compile-teaching-unit:{activityId}:{mode}:{clientKey}` | `createOnce` / INSERT ON CONFLICT — refresh replays same job |
| Outbox → BullMQ | `opening-ws-{workspaceId}-job-{jobId}` | Dedupes redispatch |
| Budget ledger | `operationId = compile-teaching-unit:{job.id}` | Stable for life of job; **never** suffix attempt number on auto-retry |
| Soft publish | `publishActivitySpec` expectedVersion + sameSpecGraph | Second succeed after crash is soft-idempotent |

**User retry after failure/cancel:** new `clientKey` (or new mode-specific key) → new job → new operationId → new reserve (intentional).

## 3. Budget / operationId reuse strategy

### 3.1 Call path

1. Handler runs under `runJob` (epoch pre-check).
2. Claim already done; set activity `generate_status` → `generating` (fenced from `queued` / `generating` only).
3. `runBudgetedCall({ operationId, requestId: operationId, purpose: "compile-teaching-unit", …, beforeSend: assertCurrentEpoch })`.
4. On success: publish via V2-05 `publishActivitySpec` + set `generate_status` → `needs_check` or `ready` (product default: **`needs_check`** until V2-09; Plan default = `needs_check` for AI output, `ready` only for deterministic repair-without-model — Decide: **always `needs_check` after model generate; repair that only rewrites indexes without provider may set `ready`**).
5. Ledger settle / markUnknown / release per existing BC1 table.

### 3.2 Retries vs double-spend (must-hold)

| Prior ledger state | Auto BullMQ retry (same job.id) | Required behavior |
|---|---|---|
| Still `reserved` (unknown / crash mid-flight) | Same `operationId` | `reserve` replays row — **no second debit** |
| `released` (auth/rate-limit/beforeSend abort) | Same `operationId` | Ledger **CONFLICT**; handler treats as **non-retryable failure** for this job — **do not** mint `…:attemptN` |
| `completed` (settled) | Same `operationId` | CONFLICT; if job already succeeded soft-idempotent publish; if not, fail closed without new reserve |
| markUnknown held | Same `operationId` | Replay reserved; job may finish `outcome_unknown` without pretending exactly-once external billing (C04) |

**Bounded retries:** keep dispatch `attempts: 2` (existing). Do **not** increase attempts without PM. Tests must prove released balance is not re-consumed.

### 3.3 Purpose field

- Extend `BudgetedCallOptions` / `runBudgetedCall` to accept `purpose?: string` defaulting to `"tutor"` (back-compat for tutor-turn).
- Teaching passes `purpose: "compile-teaching-unit"`.
- Idempotent reserve compares purpose — changing purpose on retry with same requestId correctly CONFLICTS.

## 4. State machine: cancel / unknown / failure / write-back

### 4.1 Mapping

| Event | `opening_jobs.state` | Activity `generate_status` | Budget |
|---|---|---|---|
| Enqueue | `queued` | `queued` | — |
| Claim / start | `running` | `generating` | reserve on provider entry |
| Model success + publish CAS ok | `succeeded` | `needs_check` (generate) / `ready` (non-model repair) | settle (or markUnknown if usage missing) |
| Provider timeout/network | `outcome_unknown` | `unknown` | markUnknown (keep reserved) |
| Provider AUTH/RATE_LIMIT / validation / epoch mismatch pre-send | `failed` | `failed` or `stale` (epoch → `stale`) | release |
| User cancel while queued/running | `cancelled` | `cancelled` | if reserved & before/without known usage → release when safe; if unknown → leave reserved |
| Late result after cancel | no state change | no change | do not settle into cancelled job; discard write-back |
| Privacy epoch change (runJob fence) | `failed` | `stale` | release if beforeSend path; else markUnknown if request may have been sent |

### 4.2 Cancel implementation (new, mirror tutor)

- Add `cancelOpeningJob(scope, jobId)` (or repo method): workspace-first lock; set job `cancelled` only from `queued|running`; set activity `generate_status=cancelled` only if still `queued|generating` and owner matches.
- `canClaimJob` already rejects cancelled.
- Handler before publish: re-read job state; if `cancelled`, exit without publish (and release if appropriate).

### 4.3 Write-back checks (mandatory)

On success path, single transaction (or ordered checks matching V2-05):

1. **ownerUserId + workspaceId** — `assertOwnedActivity` / `lockLearningOwner` (existing).
2. **privacy epoch** — `job.privacyEpoch === workspace.privacy_epoch` (runJob + beforeSend + pre-publish).
3. **Activity content version** — `publishActivitySpec({ expectedVersion: payload.expectedContentVersion })`.
4. **Teaching unit / library revision** — pass `expectedRevisionNumber` when repair/generate pinned a revision; CONFLICT → job failed, no partial bump.
5. **Source / privacy exclusions** — drop excluded sourceIds; if all sources excluded → fail without publish (tutor pattern).
6. **generate_status fence** — update to terminal only from `generating` (or `queued`); if already `cancelled`/`stale` → no-op success discard.
7. **Job still `running`** — `finish(succeeded)` CAS; if cancel won the race, finish no-ops / returns false.

Failure path: extend pattern from `failOpeningJob` **or** dedicated teaching failure helper that updates `generate_status` with the same fences (do **not** overload parse source write-back). Prefer **teaching-specific finish helper** to avoid parse coupling.

## 5. Test plan

| ID | Layer | Intent | This turn |
|---|---|---|---|
| T1 | unit | `createQueues` / `handlerForKind` includes `compile-teaching-unit` | `not_run` (no Implement) |
| T2 | unit | `runBudgetedCall` accepts purpose; teaching purpose passed | `not_run` |
| T3 | unit | Same operationId replay while reserved — single reserve | `not_run` |
| T4 | unit | After release, same operationId → CONFLICT / job fails without second reserve | `not_run` |
| T5 | unit | markUnknown keeps reserved; job → outcome_unknown; activity → unknown | `not_run` |
| T6 | unit | Cancel then late publish discarded; generate_status stays cancelled | `not_run` |
| T7 | unit | Epoch mismatch before/after provider → stale/failed; no publish | `not_run` |
| T8 | unit | publishActivitySpec stale expectedVersion → job failed; no double bump | `not_run` |
| T9 | integration (OPENING_TEST_DB) | Enqueue → dispatch → succeed → unique ledger row + content_version +1 | `not_run` |
| T10 | integration | Worker restart mid-job: claim takeover / soft-idempotent publish | `not_run` |
| T11 | e2e / browser | Refresh while generating shows same job / honesty copy | `not_run` (user/Experience) |
| T12 | real model | Optional smoke with provider | `not_run` (V2-08+ / auth) |

Honest rule per `review-test-gates.md`: Implement evidence must list commands + results; every skipped check **`not_run`**. Plan ACCEPT does **not** require running product tests.

## 6. Migration needs

| Need | Placeholder | Notes |
|---|---|---|
| Extend `opening_jobs_kind_check` | **`00xx_opening_compile_teaching_unit_job.sql`** | Copy style of `0051_opening_extract_study_actions_job.sql` |
| New tables? | **None for M1** | Reuse `opening_jobs` / outbox / budget / V2-05 teaching tables |
| Activity generate_status writer | Code-only unless CHECK constraint missing | Column already exists (0053) |

**Integrator:** assign real number against live `schema_migrations` after Plan ACCEPT / at Implement gate. Tip at Plan time ends at **`0054`**. **Do not invent `0055` in docs as committed.**

## 7. Enqueue API (product surface sketch)

Prefer database/service (not raw route in worker):

```ts
enqueueCompileTeachingUnit(scope, {
  activityId, mode, clientKey,
  expectedContentVersion,
  teachingUnitId?, sourceIds?,
}) → { jobId, kind: "compile-teaching-unit", created: boolean }
```

- Snapshot privacy epoch into job.
- Flip activity `generate_status` to `queued` in same txn when created.
- HTTP route (later Implement or Experience): authz → enqueue → return jobId; GET activity/job for poll. Refresh = re-GET, not re-POST without same clientKey.

## 8. Open questions for PM / Integrator

**None blocking.** Defaults locked by this Plan:

1. Kind name `compile-teaching-unit` + modes on payload.  
2. Post-model generate_status = `needs_check` (V2-09 verifies).  
3. Purpose string `compile-teaching-unit`.  
4. Migration `00xx` only until Integrator assigns.  
5. V2-08 may replace stub provider body inside the same handler file.

Escalate only if Paula rejects new kind (wants tutor-path) or wants generate_status=`ready` immediately after model output without V2-09.

## 9. Rejected alternatives (brief)

| Alternative | Why rejected |
|---|---|
| Extend `opening_tutor_jobs` | Wrong aggregate; parallel cancel/complete; bypasses opening_jobs outbox refresh story for activities |
| Separate kinds per mode (`generate-teaching`, `repair-teaching`) | CHECK churn; duplicate handlers; mode is payload |
| New operationId per BullMQ attempt | **Re-consumes** after release / stacks reserves — violates V2-07 acceptance |
| Auto-release + retry on unknown | Violates C04 / pack text: unknown must stay accountable |
| Write teaching body into job.result only | Bypasses V2-05 library sole body + content_version CAS |
| Invent migration `0055` in this slice | Number assignment is Integrator-owned |

## 10. Rollback (from pack)

- Feature-flag / stop enqueue of new kind; leave historical job + budget rows.
- Already-sent provider calls reconcile via existing unknown→lazy complete path.
- Activities left `unknown`/`failed` stay honest; no mass rewrite of content_version.

## 11. Authorization boundary

- **This Plan:** docs only.  
- **Implement:** requires subsequent PM/Integrator Implement gate after Plan ACCEPT.  
- **No production change** from this slice.

## Ready for Plan ACCEPT?

**Yes.** Hand to Integrator for Plan ACCEPT against Understand + this Plan + plan-stage evidence. Pipeline does **not** self-ACCEPT.
