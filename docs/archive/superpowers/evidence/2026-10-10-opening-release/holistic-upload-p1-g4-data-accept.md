# ACCEPT：upload/materials P1 G4 — Data half (pending TTL sweeper)

**Date:** 2026-10-10 ~23:42 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `3af5c01` (working tree dirty for G4 Data + unrelated P1 WIP)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-upload-p1-g4-data-implement.md`  
**Plan:** `holistic-upload-materials-audit-p0-plan.md` § P1 backlog G4; gap inventory `holistic-upload-materials-audit-understand.md` § G4

---

## Verdict

**ACCEPT** Data half of upload/materials P1 **G4**: pending upload TTL sweeper that marks expired `upload_state='pending'` rows as `rejected` with `UPLOAD_TTL_EXPIRED` error jsonb and returns swept `{ id, workspaceId }` for optional notify.

No product edits by this Accept turn, no commit/push. Pipeline cron/worker wiring and Experience UI are **out of scope** for this Data half (dirty tree may contain other P1 work; not reviewed here).

---

## Gates (re-run 2026-10-10 ~23:42 CST)

```bash
cd /workspace/study-assistant-opening
npx vitest run packages/database/src/repositories/opening-sources.test.ts
# → Test Files  1 passed (1)
# → Tests       10 passed (10)

npx tsc -p packages/database/tsconfig.json --noEmit
# → exit 0
```

| Gate | Result |
|---|---|
| Vitest `opening-sources.test.ts` (**10**) | **Pass** (4 prior upload-boundary + 6 G4) |
| `packages/database` tsc -p tsconfig.json --noEmit | **Pass** (exit 0) |

---

## Spot-checks (claim / plan acceptance hooks)

| Hook | Result |
|---|---|
| G4 Data sketch: Pending TTL sweeper → `rejected` + optional notify | **Pass** — `sweepExpiredPendingUploads` / `All` + return list |
| Primary expiry: `upload_url_expires_at < now` | **Pass** (SQL + test asserts) |
| Null-lease fallback: `upload_url_expires_at IS NULL` AND `created_at < now - 900_000` | **Pass** — `PENDING_UPLOAD_TTL_FALLBACK_MS = 900_000` aligns with `STAGING_UPLOAD_LEASE_MS` / delete cleanup |
| SET: `upload_state='rejected'`; **parse_state unchanged** | **Pass** — SET only `upload_state`, `error`, `updated_at` |
| `error` = `UPLOAD_TTL_EXPIRED` (`code`/`message`/`retryable`) matches `apiFailureSchema` | **Pass** |
| Idempotent: SQL requires `upload_state='pending'` in subquery + outer UPDATE | **Pass** |
| Exports: scoped + All + repo method + constants; re-export via `export * from "./repositories/opening-sources"` | **Pass** |
| Optional notify = return `SweptPendingUpload[]`; no Slack/email invent | **Pass** (Data-only) |
| No UI / AI / worker job scope creep **in claimed Data files** | **Pass** — vs tip `3af5c01`, only `opening-sources.ts` + `.test.ts` under `packages/database/` |

### Stronger review (tests must not pass while missing G4 Data behavior)

| Risk | Assessment |
|---|---|
| Mock SQL only checks string shape | Acceptable for this repo’s unit style; first G4 test asserts both expiry OR branches, rejected SET, pending filters, error payload, fallback cutoff, workspace id, limit |
| “null-lease” it() only asserts constants | Mitigated: primary it() already requires `upload_url_expires_at IS NULL` + `created_at < ?` + fallback cutoff value in the same UPDATE |
| parse_state regression | Code review: SET omits `parse_state`; no test would green-wash a `parse_state='failed'` add without a new intentional change |
| Missing worker cron | **Out of scope** for Data half; claim correctly defers to Pipeline |

**Blockers:** none for Data half.

---

## Files in scope (Data half)

| Path | Role |
|---|---|
| `packages/database/src/repositories/opening-sources.ts` | constants, query helper, scoped + All exports, repo method |
| `packages/database/src/repositories/opening-sources.test.ts` | +6 G4 unit tests (file total **10**) |
| `docs/superpowers/evidence/2026-10-10-opening-release/holistic-upload-p1-g4-data-implement.md` | implement claim (read-only for Accept) |

## Explicitly not accepted here

- Pipeline: cron / BullMQ repeatable calling `sweepExpiredPendingUploadsAll` + notify delivery
- Experience: G5 queue cancel, badges, filters
- Other dirty-tree P1 work (AI readiness, worker G12/G8/G9/G19, etc.)
- commit / push / stash / reset

---

## Notes

- Plan P1 backlog lists G4 as one-line sketch (“Pending TTL sweeper → rejected + optional notify”); detailed expiry rules come from implement claim + understand §G4. Accept maps those rules to code/tests above.
- Tip remains `3af5c01`; G4 Data is uncommitted (as claim stated). Integrator did not commit or push.
