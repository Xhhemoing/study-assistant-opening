# Q01-prep — Coverage inventory: Create-list vs existing tests

**Date:** 2026-10-10 ~01:04 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner:** QA  
**Plan source:** `08-delivery.md` §Q01  
**Gate:** Inventory only — **no** new test files this pass; **no** green/verified claim

## Summary counts

| Bucket | Count |
|---|---|
| Create-list paths required by §Q01 | **5** (4 Create + 1 Modify) |
| Create-list **exists** | **1** (`tests/integration/opening-backup-privacy.test.ts`) |
| Create-list **missing** | **4** |
| Related opening auth / concurrency / failure / backup tests found (partial, not Create-list) | **many** (see tables) — useful foundation, **not** Q01 gate satisfaction |

**Create-list score: 1 exists / 4 missing / 5 required.**

## Create-list matrix

| Path | Exists? | Covers which Q01 bullet(s) | Gaps |
|---|---|---|---|
| `tests/integration/handler/opening-loop.test.ts` | **no** | Intended: complete saved flow (upload→parse→tutor→observation→memory→plan→retest) + handler negatives in one loop | Entire Create file missing. Partial flow pieces live in other handler/integration tests (`opening-adaptive-loop`, tutor/memory/plans/retest handlers) but **no** cross-module Create-list loop gate. |
| `tests/integration/opening-concurrency.test.ts` | **no** | Intended: cross-module concurrency / race matrix for Q01 | Entire Create file missing. Related races exist elsewhere (task-acceptance concurrency, privacy writeback race, learning-consumer races, observation-revision races, review-retest race, source-actions race, worker-privacy race) — **not** consolidated under Create path. |
| `tests/integration/opening-failure-recovery.test.ts` | **no** | Intended: fault cases (lost reply, worker crash, stale plan, deletion during writeback, MIME spoof, prompt injection, unconfigured provider, budget exhaustion) | Entire Create file missing. Scattered: MIME spoof in `opening-sources-storage.test.ts`; parse failure retention in `opening-parse-failure-repository.test.ts`; budget ledger in `opening-budget.test.ts`; provider handler 503/vault cases in `opening-model-providers.test.ts`. No unified failure-recovery Create gate; prompt-injection / lost-reply / worker-crash matrix largely **gap**. |
| `tests/contract/opening-safety-boundaries.test.ts` | **no** | Intended: contract-level safety boundaries (auth/privacy/no unauthorized IO) | Entire Create file missing. Nearby contract: `opening-no-mock.test.ts` (no mock providers on Opening pages) — **different** concern. No `opening-safety-boundaries` contract. |
| `tests/integration/opening-backup-privacy.test.ts` (Modify) | **yes** | Q03 Create-list failing cases: deleted-memory exclusion, wrong source hash, unknown version, non-owner lineage — aligns with §Q01 “backup checks” **once Q03 completed** | Exists and carries Q03 privacy cases. Q01 **Modify** (extend/wire into Q01 gate) still pending. **Blocked for Q01 verified** while Q03 is `active` / not completed. Do not treat file presence as Q01 backup gate done. |

## Related tests (search) — path | exists | Q01 bullet | gaps

### Anonymous / session 401 and two-principal isolation (handler)

| Path | Exists? | Covers which Q01 bullet | Gaps |
|---|---|---|---|
| `tests/integration/opening-fixture.ts` | yes | Fixture: `requestAnonymous`, `otherScope` — interfaces §Q01 requires | Helper only; not a gate test |
| `tests/integration/handler/opening-memory.test.ts` | yes | Anonymous memory **401**; cross-workspace decision **404**; some 403 | Not Create-list; does not replace `opening-loop` / safety-boundaries |
| `tests/integration/handler/opening-memory-candidate.test.ts` | yes | 401 anonymous; 403 model/worker; foreign candidate 404 | Same |
| `tests/integration/handler/opening-tutor.test.ts` | yes | 401 without session; foreign conversation cases | Same |
| `tests/integration/handler/opening-plans.test.ts` | yes | 401 without session; clientKey isolation across owners | Same |
| `tests/integration/handler/opening-upload-desktop.test.ts` | yes | Sources list/upload **401** without session | Same |
| `tests/integration/handler/opening-source-content.test.ts` | yes | Auth required; foreign content not disclosed | Same |
| `tests/integration/handler/opening-learning-summary-read.test.ts` | yes | 401; foreign cookie 404 | Learning read only |
| `tests/integration/handler/opening-ephemeral.test.ts` | yes | 401; foreign source/owner refusal | Ephemeral path only |
| `tests/integration/handler/opening-reminders.test.ts` | yes | 401; foreign task hidden/404 | Reminders only |
| `tests/integration/handler/opening-connections.test.ts` | yes | 401; foreign workspace/owner reject | Connections only |
| `tests/integration/handler/opening-review.test.ts` | yes | Auth + foreign/excluded sources; refuse foreign discard | Review/retest list path |
| `tests/integration/handler/opening-access.test.ts` | yes | Registration **403** when opening release enabled; Origin policy | Access policy ≠ full negative matrix |
| `tests/integration/opening-conversation-resume.test.ts` | yes | Cross-owner continuity load rejects | Repository-level; not handler Create-list |
| `tests/integration/handler/opening-today-read.test.ts` | yes | Owner isolation; anonymous 401 | Today-read only |
| `tests/e2e/opening-auth.ts` | yes | E2E auth helper | Not Q01 integration Create-list |

**Gap (auth):** Per-route 401/foreign coverage is **partial and scattered**. §Q01 still wants Create-list loop + two-principal matrix + contract safety-boundaries as explicit gates — **missing**.

### Concurrency / races

| Path | Exists? | Covers which Q01 bullet | Gaps |
|---|---|---|---|
| `tests/integration/opening-task-acceptance-concurrency.test.ts` | yes | Concurrent accepts / row locks | Task-acceptance only; not Create `opening-concurrency.test.ts` |
| `tests/integration/opening-privacy-writeback-race.test.ts` | yes | Deletion vs writeback / epoch drift | Maps to “deletion during writeback” fault; wrong Create path |
| `tests/integration/opening-learning-consumer-races.test.ts` | yes | Stale evidence / privacy epoch in consumer txn | Learning consumer only |
| `tests/integration/opening-observation-revision-races.test.ts` | yes | Observation revision races | Narrow |
| `tests/integration/opening-review-retest-race.test.ts` | yes | Review/retest race | Narrow |
| `tests/integration/opening-source-actions-race.test.ts` | yes | Source actions race | Narrow |
| `tests/integration/opening-worker-privacy-race.test.ts` | yes | Worker privacy race | Narrow |
| `tests/integration/opening-learning-summary-races.test.ts` | yes | Summary projection races | Narrow |

**Gap (concurrency):** Create-list `opening-concurrency.test.ts` **missing**; existing races are module-local.

### Failure / recovery / faults

| Path | Exists? | Covers which Q01 bullet | Gaps |
|---|---|---|---|
| `tests/integration/opening-sources-storage.test.ts` | yes | MIME spoof by magic bytes → source stays pending | One fault; not Create failure-recovery file |
| `tests/integration/opening-parse-failure-repository.test.ts` | yes | Failed parse retains original; privacy epoch wait | Parse failure only |
| `tests/integration/opening-budget.test.ts` | yes | Budget reserve/settle/release/cap-ish ledger behavior | Not full “budget exhaustion” HTTP fault story for Q01 |
| `tests/integration/handler/opening-model-providers.test.ts` | yes | Session required; vault **503**; no key leak | Unconfigured-provider fault only partial |
| `tests/tooling/opening-readiness*.test.mjs` / readiness scripts | yes | Readiness probes (DL7-related) | Tooling ≠ integration failure-recovery Create-list |
| Source prompt injection dedicated test | **no** (no dedicated hit) | Fault bullet | **Gap** |
| Lost reply after commit / worker crash before|after model | **no** dedicated Create-list | Fault bullets | **Gap** (may be partial elsewhere; not Q01 Create gate) |
| Stale plan accept dedicated Create-list | **no** | Fault bullet | Partial isolation in plans handler; no Create failure-recovery file |

### Backup / privacy (Q03 → Q01 Modify)

| Path | Exists? | Covers which Q01 bullet | Gaps |
|---|---|---|---|
| `tests/integration/opening-backup-privacy.test.ts` | **yes** | Deleted memory / wrong hash / unknown version / non-owner | Q01 Modify + **completed Q03** still required for verified |
| `tests/integration/opening-memory-deletion-backup.test.ts` | yes | Memory deletion vs backup | Supporting |
| `tests/integration/opening-observation-revision-backup-privacy.test.ts` | yes | Observation revision backup privacy | Supporting |
| `tests/integration/opening-backup-restore-apply.test.ts` | yes | Restore apply (Q03 track) | Q03; not Q01 Create |
| `tests/integration/opening-backup-empty-namespace.test.ts` | yes | Empty-namespace restore preflight | Q03 |
| `packages/database/src/storage/opening-backup-*.test.ts` | yes | Archive/cipher/manifest/stage/reader unit | Lower layer |
| `packages/database/src/repositories/opening-backup-*.test.ts` | yes | Compose/prepare/apply/records unit | Lower layer |

### Contract / no-mock (adjacent, not Create-list)

| Path | Exists? | Covers which Q01 bullet | Gaps |
|---|---|---|---|
| `tests/contract/opening-no-mock.test.ts` | yes | No concealed mocks on Opening entry points | **Not** safety-boundaries Create path |
| `tests/contract/opening-safety-boundaries.test.ts` | **no** | Create-list | **Missing** |

## Mapping to §Q01 checklist bullets

| §Q01 bullet | Create-list file | Partial related coverage? | Ready for Q01 verified? |
|---|---|---|---|
| Failing acceptance (anonymous memory 401) | loop / safety-boundaries (missing) | yes — `opening-memory.test.ts` | **no** (Create-list missing; not gated as Q01) |
| Two-principal sources/conversations/memory/learning/plans | loop + concurrency (missing) | partial across handlers | **no** |
| Complete saved flow + DB assertions | `opening-loop.test.ts` (missing) | adaptive-loop / retest / memory pieces only | **no** |
| Fault cases matrix | `opening-failure-recovery.test.ts` (missing) | MIME/parse/budget/provider partial | **no** |
| Gates on isolated services | all Create + Modify | DL10 verified helps runner | **no** until files+green |
| Backup vs completed Q03 | Modify `opening-backup-privacy.test.ts` (exists) | yes under Q03 | **no** — Q03 **active** |

## Blockers affecting coverage claims

1. Q03 **active** → cannot claim backup portion of Q01 verified.
2. Docker / packaging green **not claimed** (Q03 evidence) → do not imply full release packaging supports Q01.
3. Four Create-list files **absent** → inventory ≠ implementation.

## Conclusion

Prep inventory complete. **1/5** Create-list paths present; **4/5** missing. Related tests provide useful partial coverage for auth, races, MIME, budget, and backup privacy, but **do not** satisfy §Q01 Create-list gates. Next authorized step after PM review: red skeleton (docs already) → skipped/gated files → IMPLEMENT when Q03 allows.
