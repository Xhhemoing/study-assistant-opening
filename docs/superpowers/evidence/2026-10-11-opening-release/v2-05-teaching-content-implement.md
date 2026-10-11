# V2-05 Teaching content — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (before & after Implement; dirty tree, no commit):** `5d7124861c3c981a735fe26ada40bb188a875465`  
**Migration:** `packages/database/src/migrations/0054_opening_teaching_content.sql`  
**Status:** **implemented, awaiting Integrator Accept** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit

## Authority followed

- Plan ACCEPT: `v2-05-teaching-content-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-05-teaching-content-plan.md`
- Understand + PM decisions + migration assign **0054**
- ADR D2; gates `review-test-gates.md`
- PM Implement gate freeze (steering):
  1. Soft-idempotent = knowledge pattern (`expectedVersion+1` + same graph → success; else CONFLICT)
  2. **No** denorm columns on `opening_teaching_activities` (JOIN via activity_specs)
  3. **No** ActivitySpec history table; M1 `getActivitySpecAtVersion` documented (current row only; past body via library `revision_number`)

## Diff scope

### New
| Path | Role |
|---|---|
| `packages/contracts/src/opening/teaching-content.ts` | TeachingUnit / ActivitySpec / clientInit / drafts |
| `packages/contracts/src/opening/teaching-content.test.ts` | T1 (+ M1 note) |
| `packages/database/src/migrations/0054_opening_teaching_content.sql` | units + activity_specs DDL |
| `packages/database/src/schema/opening-teaching-content.ts` | Drizzle |
| `packages/database/src/repositories/opening-teaching-content.ts` | createUnit, publish CAS, getClientInit redact, drafts, readRevision |
| `packages/database/src/repositories/opening-teaching-content.test.ts` | T2/T5/T6/T7/T8/T9 unit |
| `apps/web/src/features/opening/teaching/teaching-content-service.ts` | Thin service (no CT UI) |

### Updated (exports + backup registration same batch)
| Path | Change |
|---|---|
| `packages/contracts/src/opening/index.ts` | export teaching-content |
| `packages/database/src/index.ts` | export schema + repo helpers |
| `packages/database/src/repositories/opening-backup-records.ts` | `OPENING_BACKUP_TABLES` +2 → **31** |
| `packages/database/src/repositories/opening-backup-record-table-queries.ts` | SELECT + filter specs by activity |
| `packages/database/src/repositories/opening-backup-apply.ts` | `OPENING_RESTORE_ROW_COLUMNS` |
| `packages/database/src/repositories/opening-backup-empty-namespace.ts` | namespace counts |
| `packages/domain/src/opening/backup-apply-plan.ts` | apply order: activities → units → specs → sessions |
| `packages/domain/src/opening/backup-policy.ts` | TABLE_ALLOWLIST |
| `packages/domain/src/opening/backup-compose-validation.ts` | BACKUP_TABLES |
| Backup unit test fixtures / length asserts | 29 → 31 |

### Explicitly not touched
- V2-07 worker; CT-03 layout / `activity-panel.tsx`; learning observation schema
- No denorm on `opening_teaching_activities`
- No `opening_teaching_answer_refs` / parallel answer ledger
- No ActivitySpec history table
- No Experience lecture render
- No `tasks.json` → verified; no push/commit

## Design notes landed

- **Sole body** = library Document/Block/Revision; teaching tables metadata only.
- **FK tighten:** `document_id REFERENCES library_documents(id)` (library has PK on `id` only; no `UNIQUE (workspace_id, id)`).
- **Soft-idempotent graph equality set:** `teachingUnitId`, `documentId`, `revisionNumber`, `blockOrder`, `sourceRefs`, `goals`, `verificationStatus`, `generationConfig`.
- **getClientInit:** `redactBlocksForClientInit` → answer_key / solution blocks get `content: null` + `answerRef { revealState: "hidden" }`.
- **Drafts:** `checkpoint_json.drafts[]`; lost blockIds → `{ ok:false, mismatch:"draft_anchor_lost", lostBlockIds }` (no silent remap).
- **M1 getActivitySpecAtVersion:** returns current row only when `version` matches; else null / 404 with message to use library revision for past body.

## Commands run + results

### Unit / contracts / backup (cwd: repo root)

```text
PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
  packages/contracts/src/opening/teaching-content.test.ts \
  packages/database/src/repositories/opening-teaching-content.test.ts \
  packages/database/src/repositories/opening-backup-records.test.ts \
  packages/database/src/repositories/opening-backup-apply.test.ts \
  packages/domain/src/opening/backup-apply-plan.test.ts \
  packages/domain/src/opening/backup-compose.test.ts \
  packages/domain/src/opening/backup-learning-state.test.ts \
  packages/database/src/repositories/opening-backup-entrypoint.test.ts \
  packages/database/src/repositories/opening-backup-compose.test.ts \
  packages/contracts/src/opening/teaching-activity.test.ts
```

**Result:** exit 0 — **10 files, 112 tests passed** (vitest 4.1.10).

### Typecheck

```text
PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh bash -c \
  'tsc -p packages/contracts/tsconfig.json --noEmit && tsc -p packages/database/tsconfig.json --noEmit'
```

**Result:** exit 0.

```text
PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh bash -c \
  'tsc -p apps/web/tsconfig.json --noEmit --pretty false'
```

**Result:** exit 0 (no `teaching-content` / TS errors in filtered output).

### Migrate apply / live schema_migrations

**`not_run`** — local `DATABASE_URL` → `ECONNREFUSED 127.0.0.1:5432`; `OPENING_TEST_DATABASE_URL` unset; docker/pg not available on this box.  
**Did not invent another migration number.** File remains **`0054_opening_teaching_content.sql`** only.  
If live `schema_migrations` already has ≥0054, Integrator must renumber before apply (same caveat as assignment note).

## Tests T1–T9 status

| ID | Status | How |
|---|---|---|
| T1 | **pass** | `teaching-content.test.ts` — unknown keys rejected; clientInit forbids answer_key plaintext when hidden |
| T2 | **pass** (unit) | CAS stale → CONFLICT; soft-idempotent same graph at +1 |
| T3 | **`not_run`** | Needs live library revisions after two publishes (DB down) |
| T4 | **`not_run`** | Needs library `expectedRevisionNumber` conflict against live DB |
| T5 | **pass** (unit) | draft keep + `draft_anchor_lost` |
| T6 | **pass** (unit) | `redactBlocksForClientInit` fixture with solutionZh — no plaintext in JSON |
| T7 | **pass** (unit) | `sanitizeCheckpointForRestore` strips answer key dumps |
| T8 | **pass** (smoke) | Backup tables do not include teaching_answers / answer_refs ledger |
| T9 | **pass** | New tables in `OPENING_BACKUP_TABLES` + apply order / fixture length 31 |

## Blockers / soft gaps for Integrator

1. **DB down** — migrate apply + T3/T4 integration **`not_run`**; confirm live max migration &lt; 0054 before apply.
2. Full `getClientInit` repo path against real library revisions not integration-tested (redaction helper covered by T6).
3. `createUnit` creates library doc then unit row in separate transactions (orphan doc possible on unit insert failure) — acceptable M1; optional same-tx later.

## Verdict (Implementer)

Implement complete on dirty tip for Integrator Accept. **No self-ACCEPT.**
