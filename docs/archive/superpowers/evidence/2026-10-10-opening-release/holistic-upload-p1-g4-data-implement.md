# upload/materials P1 G4 — Data implement (pending TTL sweeper)

**Owner:** AIstudy Data  
**Date:** 2026-10-10 (Asia/Shanghai)  
**Base tip:** `3af5c01` (`feat/opening-release`)  
**Status:** implemented — awaiting Integrator Accept  
**Push:** not pushed (no commit requested)

## Gap

**G4:** Begin succeeds then user leaves → permanent `pending` / `not_started` orphans; no TTL/GC to `rejected`.

## Fix

Pending TTL sweeper → `upload_state='rejected'` + `error` jsonb + return swept ids (optional notify hook).

### Expiry rules

| Case | Expiry |
|---|---|
| Primary | `upload_url_expires_at < now()` — set by `issueUploadTicket` from ticket `expiresAt` (`STAGING_UPLOAD_LEASE_MS = 900_000` = 15m in `source-service.ts`) |
| Null-lease fallback | `upload_url_expires_at IS NULL` AND `created_at < now - PENDING_UPLOAD_TTL_FALLBACK_MS` (same **900_000** ms). Aligns with delete cleanup fallback in `opening-source-actions.ts` (`now + 900_000` when lease missing) |

### Behavior

1. Select `upload_state='pending'` rows past primary or fallback expiry.
2. Update to `upload_state='rejected'`; **leave `parse_state` unchanged** (typically `not_started`).
3. Set `error = { code: 'UPLOAD_TTL_EXPIRED', message: '上传凭证已过期，文件未在有效期内完成上传。', retryable: false }` (`apiFailureSchema` shape).
4. Idempotent: SQL requires `upload_state='pending'` in both subquery and outer UPDATE — already-rejected / uploaded skipped.
5. Optional notify: **return** `SweptPendingUpload[]` (`{ id, workspaceId }`). No Slack/email invent; Pipeline may iterate the list later.

### API surface

| Export | Role |
|---|---|
| `sweepExpiredPendingUploads(sql, scope, options?)` | Workspace-scoped |
| `sweepExpiredPendingUploadsAll(sql, { now?, limit? })` | Global worker/cron entry (default `limit=100`) |
| `createOpeningSourceRepository(sql).sweepExpiredPendingUploads(scope, options?)` | Repo method |
| `PENDING_UPLOAD_TTL_FALLBACK_MS` | `900_000` |
| `PENDING_UPLOAD_TTL_SWEEP_LIMIT` | `100` |
| `UPLOAD_TTL_EXPIRED_ERROR` | frozen error payload |

Re-exported via existing `export * from "./repositories/opening-sources"` in `packages/database/src/index.ts`.

## Files

| Path | Change |
|---|---|
| `packages/database/src/repositories/opening-sources.ts` | constants, query helper, scoped + All exports, repo method |
| `packages/database/src/repositories/opening-sources.test.ts` | +6 G4 unit tests (file total 10) |
| `docs/superpowers/evidence/2026-10-10-opening-release/holistic-upload-p1-g4-data-implement.md` | this evidence |

## Not done (other owners / out of scope)

- **Pipeline:** cron/repeatable job calling `sweepExpiredPendingUploadsAll` + optional notify delivery (Slack/email/in-app). No similar sweeper jobs existed under `apps/worker`; Data did **not** wire a worker job.
- Experience UI (G5 queue cancel, badges, etc.)
- Pipeline G8 / G12 / G19
- commit / push / stash / reset
- Did not delete `docs/.../rp5-gha-91b1c73-typecheck-fail.md`

## Commands

```bash
npx vitest run packages/database/src/repositories/opening-sources.test.ts
npx tsc -p packages/database/tsconfig.json --noEmit
```

**Result:** Test Files 1 passed; Tests **10 passed** (4 prior upload-boundary + **6 new G4**). Database `tsc --noEmit` clean.

## Optional notify (what it means)

Returning swept `{ id, workspaceId }[]` is the notify hook. A future Pipeline worker can:

1. Call `sweepExpiredPendingUploadsAll(sql, { limit })` on a schedule.
2. For each swept row, enqueue / send a user-visible notice if product wants one.

Data does **not** send mail, Slack, or push.

## Needs Pipeline

- Schedule (cron / BullMQ repeatable) for `sweepExpiredPendingUploadsAll`
- Optional notify channel + copy if product wants user alerts after TTL reject
