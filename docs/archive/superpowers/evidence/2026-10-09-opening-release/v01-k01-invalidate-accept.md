# V01→K01 invalidate follow-up accept — correction marks knowledge needs_check

**Date:** 2026-10-09 ~18:09 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **PIPELINE** V01→K01 invalidate follow-up against `docs/superpowers/plans/opening-release/10-media-knowledge.md` § V01 (and K01 needs_check expectation: 资料纠错仅使相关推断 `needs_check`).  
**Prior V01 accepts (cited, not re-litigated):**  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-accept.md`  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-followup-accept.md`  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-copy-jobid-accept.md`  
**Verdict:** **ACCEPT** (agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**Real classroom footage:** **not run** (plan live accept path — human verify).  
**tasks.json:** **not edited**. V01 remains `planned`. **verified:** **not marked**.  
**Commit/push:** **not done**.  
**P04 / 0052:** **not touched**.

## Recommendation

**WAIT** — leave V01 `planned`. Unlike C02 (integration 5/5 gate) / DL10 (plan bar = document missing), V01 still has no agent-green live/integration gate; plan names authorized classroom accept + whisper path. Invalidate closes the last deferred structural gap, but agent-owned `verified` should wait for PM promote or a defined live gate.

*(If PM wants DL10-style agent-owned verify now: unit green across prior accepts + this slice, with browser / classroom / whisper noted as gaps — that would be VERIFY_NOW; this accepter did not apply it.)*

## Claimed this round (vs prior deferred gap)

| Claim | Result | Notes |
|---|---|---|
| After correction CAS bump + object copy commit, call `markNeedsCheckForSources(scope, [sourceId])` | **PASS** | Post-commit; injectable `deps.knowledge` |
| Mark failure surfaces error; source version not rolled back | **PASS** | Unit: bump then mark throw; `createOnce` not called |
| Injectable knowledge deps | **PASS** | `OpeningMediaSegmentsServiceDeps.knowledge` + `commitCorrectionBump` test seam |
| Vitest unit **4 files / 20 passed** | **PASS (actual)** | Re-run matches claim exactly |
| Gaps: source-level needs_check only; no auto `enqueueRebuild`; browser not run | **CONFIRMED** | Honest; matches K01 API (no time-range invalidate) |

## Files reviewed (this delta)

- `apps/web/src/features/opening/media/media-segments-service.ts` — after bump commit: `await knowledge.markNeedsCheckForSources(scope, [source.id])`; comments document source-level scope and no auto-rebuild; mark failure leaves bumped version consistent  
- `apps/web/src/features/opening/media/media-segments-service.test.ts` — mark-after-bump ordering; mark-fail does not write job receipt  
- K01 helper (read-only cite): `packages/database/src/repositories/opening-knowledge.ts` `markNeedsCheckForSources` — courses whose `source_versions` list the id get whole snapshot nodes/edges → `needs_check`

## Plan checklist (this slice only)

| Criterion | Result | Notes |
|---|---|---|
| § V01: 用户纠错 → 新 source 版本并使旧转写派生节点失效 | **PASS (wiring)** | Prior accepts: CAS bump + object copy + `{jobId}` receipt; **this slice:** K01 `markNeedsCheckForSources` |
| § K01: 资料纠错仅使相关推断 `needs_check` | **PASS (source-level)** | Whole snapshot graph for courses listing the source; **not** time-range scoped (K01 has no such API) |
| Auto rebuild / enqueueRebuild | **OUT OF SCOPE (intentional)** | Not auto-fired; callers can use K01 rebuild |
| Browser / classroom / whisper live | **NOT RUN** | Do not mark verified |

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/storage/opening-s3.test.ts \
  apps/web/src/features/opening/media/media-segments-service.test.ts \
  apps/worker/src/jobs/parse-media.test.ts \
  apps/worker/src/parsers/media-segments.test.ts
# → Test Files  4 passed (4)
# → Tests  20 passed (20)
# Breakdown: opening-s3 3 + media-segments-service 7 + parse-media 7 + media-segments 3 = 20
# New vs copy-jobid accept (18): +2 markNeedsCheck tests
```

## Known gaps (do not treat as verified)

1. **Source-level needs_check only** — no time-range-scoped invalidate API on K01; corrected interval alone is not marked.  
2. **No auto `enqueueRebuild`** — intentional; full rebuild not time-scoped.  
3. **True async apply job kind** — still thin sync `{jobId}` receipt (prior accept).  
4. **faster-whisper not installed** — live transcription still optional / `CONFIGURATION`.  
5. **Browser + authorized real classroom footage** — not run; plan live path remains human.  
6. **No media integration suite** analogous to C02 IMAP 5/5 — unit-only gate for this invalidate slice.

## Ledger

- **ACCEPT** this invalidate follow-up.  
- **tasks.json** V01 left `planned` / evidence array untouched.  
- **No commit / no push.**
