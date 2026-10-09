# Q01-prep — Red skeleton (proposed failing cases — docs only)

**Date:** 2026-10-10 ~01:04 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner:** QA  
**Sources:** `08-delivery.md` §Q01 example; `q01-prep-plan.md`; `q01-prep-coverage.md`  
**Status:** **Proposed / WIP documentation** — **no green claim**, **no Create-list files created this pass**, **no CI change**

## Intent

Capture the first failing acceptance cases Q01 should encode when IMPLEMENT is authorized. Copied/adapted from plan examples. Safer first pass: keep them in markdown. Later: `it.skip` / gated path only if files are added without breaking default CI.

## Proposed Create-list targets (still missing except backup privacy)

1. `tests/integration/handler/opening-loop.test.ts` — **missing**
2. `tests/integration/opening-concurrency.test.ts` — **missing**
3. `tests/integration/opening-failure-recovery.test.ts` — **missing**
4. `tests/contract/opening-safety-boundaries.test.ts` — **missing**
5. `tests/integration/opening-backup-privacy.test.ts` — **exists** (Q03); Q01 Modify later

## Example 1 — Anonymous memory 401 (from §Q01)

Proposed home: `opening-loop.test.ts` and/or `opening-safety-boundaries.test.ts`.

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOpeningFixture, type OpeningFixture } from '../opening-fixture';

let f: OpeningFixture;
beforeAll(async () => {
  f = await createOpeningFixture();
});
afterAll(async () => {
  await f?.close();
});

it('does not permit anonymous access to memory', async () => {
  const r = await f.requestAnonymous('/api/opening/memory');
  expect(r.status).toBe(401);
});
```

Notes from plan: `requestAnonymous` builds an ordinary request **without** cookie; do **not** add test headers that can change production auth behavior.

**Observed today (related, not Create-list):** `tests/integration/handler/opening-memory.test.ts` already has “returns 401 without a session”. Create-list still needs the Q01 gate file(s); do not treat related coverage as Q01 red/green done.

## Example 2 — Two-principal isolation (sources / conversations / memory / learning / plans)

Proposed home: `opening-loop.test.ts` (+ concurrency file for race variants).

```ts
it('does not let principal B read principal A memory or sources', async () => {
  // seed under f.scope (A); request with B session / f.otherScope cookie
  // expect 401/403/404 per route contract — never 200 with A payloads
});

it('isolates conversations and plans across owners', async () => {
  // create under A; B list/get/accept must not see or mutate A rows
});

it('isolates learning reads and decisions across owners', async () => {
  // foreign course/candidate → 404 (or documented deny); zero unauthorized writes
});
```

Related partials today: plans clientKey isolation; memory cross-workspace 404; source-content foreign deny; learning-summary foreign 404; conversation-resume cross-owner reject. **Gap:** single Create-list matrix asserting **zero unauthorized reads/writes** across all five domains.

## Example 3 — Complete saved flow (DB rows + versions)

Proposed home: `opening-loop.test.ts`.

```ts
it('persists upload→parse→tutor→observation→memory confirm→plan accept→retest with real rows', async () => {
  // exercise guarded fixture + isolated services (DL10)
  // assert DB row ids/versions and returned versions — not only HTTP 200
  // plan→retest path depends on DL3 (verified); observation verdict on DL6 (verified)
});
```

**No green claim.** Adaptive-loop / retest / memory handlers are partial only.

## Example 4 — Concurrency / stale accept

Proposed home: `opening-concurrency.test.ts`.

```ts
it('rejects or coordinates stale plan accept under concurrent writers', async () => {
  // two principals or two clients; expectedVersion mismatch → documented conflict
});

it('survives deletion overlapping writeback without leaking excluded memory', async () => {
  // align with privacy-writeback-race intent; Create-list owns the Q01 gate copy/wiring
});
```

## Example 5 — Fault recovery matrix (first cuts)

Proposed home: `opening-failure-recovery.test.ts`.

| Case | Proposed assertion sketch | Related today |
|---|---|---|
| MIME spoof | reject by magic bytes; source stays pending / not treated as trusted parse | `opening-sources-storage.test.ts` |
| Unconfigured provider | readiness/handler denies paid path honestly (DL7) | readiness tooling + model-providers partial |
| Budget exhaustion | reserve/deny at effective daily cap; no silent paid call | `opening-budget.test.ts` ledger |
| Stale plan accept | conflict / 409-class; no double apply | plans handler partial |
| Deletion during writeback | epoch drift → rollback; no unauthorized persist | `opening-privacy-writeback-race.test.ts` |
| Lost reply after commit | durable state matches commit; client can recover without duplicate paid work | **gap** as Create-list |
| Worker crash before/after model | job/state machine leaves safe cancelled/retry; no secret leak | **gap** as Create-list |
| Source prompt injection | untrusted source text cannot escalate auth or exfiltrate other tenants | **gap** |

## Example 6 — Backup privacy (Modify — blocked on completed Q03)

Proposed home: existing `opening-backup-privacy.test.ts` (extend later).

Already present under Q03 Create-list intent: deleted-memory exclusion, wrong hash, unknown version, non-owner lineage. Q01 verified still requires **completed Q03**. Until then: document only; optional later `it.skip('Q01 backup gate pending Q03 verified')` — **not added this pass**.

## Contract safety-boundaries sketch

Proposed home: `tests/contract/opening-safety-boundaries.test.ts` (**missing**).

```ts
it('Opening safety boundaries reject anonymous memory and foreign-owner resource access', async () => {
  // contract-level: stable status codes / error shapes; no body leakage of foreign ids
});
```

Distinct from `opening-no-mock.test.ts` (mock-import scan).

## What this pass did **not** do

- Did not create any of the four missing Create-list `.test.ts` files.
- Did not mark tests skipped in the repo.
- Did not run red and claim failure evidence as Q01 progress toward verified.
- Did not claim green.
- Did not edit `tasks.json` or Q03 ledger.

## Next step after PM accepts prep

1. Optionally add skipped/WIP Create-list stubs under gated path.
2. IMPLEMENT red→green when authorized and Q03 completion unblocks backup-bound verification.
3. Record observed evidence; only then consider ledger status change (Integrator/PM process).
