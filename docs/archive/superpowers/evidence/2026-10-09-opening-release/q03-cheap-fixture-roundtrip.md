# Q03 — Cheap fixture backup roundtrip (no live S3)

**Date:** 2026-10-09 ~19:39–19:40 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Status:** progress only — **not verified**, **no commit**, **no push**, **no Docker**, **no live S3**, **no mutating apply** into shared test DB.

## What was exercised

Local staged draft → `scripts/opening-backup.ts` publish (archive + encrypt) → `scripts/opening-restore.ts --dry-run` → non-executing `planOpeningRestoreApply` artifact. Scratch under `/tmp`; cleaned after evidence capture.

## Fixture (minimal)

| Piece | Value |
|---|---|
| workspaceId | `a1000000-0000-4000-8000-000000000001` |
| sourceId | `c3000000-0000-4000-8000-000000000010` |
| staged object | `objects/<sourceId>/v1.bin` body `abcd` (4 bytes) |
| sha256 | `88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589` |
| tables | full `OPENING_BACKUP_TABLES` keys; only `opening_sources` has 1 row |
| journal | `[]` |
| passphrase | env-only `OPENING_BACKUP_PASSPHRASE` for encrypt path (never argv; not retained in evidence) |

## Commands / results (CST)

| Step | Command | Exit | Notes |
|---|---|---|---|
| Publish | `npx tsx scripts/opening-backup.ts --confirm-local-backup --staging … --draft … --out backup.opening --encrypt-out backup.opening.enc` | **0** | archive 1320 B; enc 1382 B; “not a DB+S3 atomic snapshot” note printed |
| Dry-run restore | `npx tsx scripts/opening-restore.ts --confirm-local-restore --dry-run --draft … --journal …` | **0** | `DRY_RUN_OK`, `preview.allowed=true`, `plan.objectCount=1`, `opening_sources:1`, **`mutated=false`** |
| Plan artifact | `planOpeningRestoreApply(draft, journal, { confirmLocalRestore: true })` | ok | wrote `q03-fixture-apply-plan-artifact.json`; **`mutated:false`**, **`executed:false`**; pseudo-SQL documented only |
| `tsc -p packages/domain --noEmit` | — | **0** | scoped; not full monorepo |
| `tsc -p packages/database --noEmit` | — | **0** | scoped; not full monorepo |

### Dry-run guarantees (from CLI stderr)

```
guarantees: secretsRestored=false
guarantees: apiKeysRestored=false
guarantees: sessionsRestored=false
guarantees: pendingJobs=cancelled
mutated=false
```

Saved: `q03-fixture-dry-run.stderr.txt`.

## Secrets absence (honest)

- Passphrase **not** present in encrypted envelope bytes (`passphrase_in_enc=false`).
- Draft JSON has **no** `apiKey` / `password` / `passphrase` / `session_token` fields.
- CLI never prints passphrase; encrypt uses env only.
- A naive `rg -i 'secret|session|api_key|passphrase'` over outputs matches **table names** (`opening_learning_sessions`, `opening_timetable_sessions`) and **guarantee labels** (`secretsRestored=false`, …) — not credential material. Binary archive also trips `\0` scans; content is fixture metadata + `abcd` object bytes.

## Artifacts retained in evidence

| File | Role |
|---|---|
| `q03-cheap-fixture-roundtrip.md` | this note |
| `q03-fixture-apply-plan-artifact.json` | non-executing apply plan / pseudo-SQL doc |
| `q03-fixture-dry-run.stderr.txt` | dry-run CLI stderr |

Scratch `/tmp/q03-fixture-roundtrip-*` removed after copy (no live S3; no DB writes).

## Still blocked for Q03 verified

1. Opening row/object **mutating** apply executor + isolated empty DB/S3 drill  
2. Production image build / compose up (docker CLI absent; scaffold only)  
3. Full live `exportOpeningBackup` + S3 E2E  
4. Full monorepo lint/typecheck/build packaging green (only domain+database `tsc` claimed here)  
5. CI release-SHA evidence (**no commit**)

## Tasks

`tasks.json` Q03 remains **`active`**. Evidence path appended; status not flipped to verified. No Experience U04 UI edits.
