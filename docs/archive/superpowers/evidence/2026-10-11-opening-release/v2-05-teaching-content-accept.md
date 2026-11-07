# V2-05 accept — Teaching content Implement (TeachingUnit + ActivitySpec)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator Accepting Data (executor / Grok Bot) — Implement ACCEPT  
**Branch:** `feat/opening-release`  
**Tip HEAD (dirty tree, no commit):** `5d7124861c3c981a735fe26ada40bb188a875465`  
**Migration under review:** `packages/database/src/migrations/0054_opening_teaching_content.sql`  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-05-teaching-content-implement.md`  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Verdict:** **ACCEPT**

## Scope of this accept

Independent Implement ACCEPT of V2-05 teaching content (contracts → migration → Drizzle → repo → thin service → backup registration → T1–T9 unit where runnable) against Plan ACCEPT + PM design locks + migration assign **0054**. Implementer ≠ accepter. **No** migrate apply / `psql` ALTER on live DB. **No** commit / push / stash / reset / hermes.

## Authority compared

| Artifact | Role |
|---|---|
| `v2-05-teaching-content-plan.md` | Design (DDL sketch, contracts, repo methods, T1–T9, rejected alts) |
| `v2-05-teaching-content-plan-accept.md` | Plan ACCEPT + soft gaps for Implement |
| `v2-05-pm-design-decisions.md` | Same-doc+redact; 1:N; checkpoint drafts |
| `v2-05-migration-number-assigned.md` | Assigned **0054** |
| Implement gate freezes (steering) | Soft-idempotent=knowledge; **no** denorm on activities; **no** ActivitySpec history table |
| `v2-05-teaching-content-implement.md` | Claimed inventory + commands |
| Working tree vs tip `5d71248` | Uncommitted product + backup + 0054 SQL |

## Stronger review (diff vs plan + PM locks)

### PM / freeze matrix

| # | Lock | Result | Evidence |
|---|---|---|---|
| 1 | Soft-idempotent = knowledge (`expectedVersion+1` + same graph → success; else CONFLICT) | **PASS** | `sameActivitySpecGraph` equality set = `teachingUnitId`, `documentId`, `revisionNumber`, `blockOrder`, `sourceRefs`, `goals`, `verificationStatus`, `generationConfig`. `publishActivitySpec` returns existing row when `content_version === expectedVersion+1` and graphs equal; different graph → CONFLICT; stale `expectedVersion` → CONFLICT. Unit T2 covers both. |
| 2 | **No** denorm columns on `opening_teaching_activities` | **PASS** | 0054 has no `ALTER TABLE opening_teaching_activities`; schema/activities untouched; JOINs via `opening_teaching_activity_specs`. |
| 3 | **No** ActivitySpec history table; M1 `getActivitySpecAtVersion` honest | **PASS** | Only current specs row; method returns current when `version` matches else `null`; service 404 message names M1 + library revision for past body; `activitySpecAtVersionM1Note` in contracts. |
| 4 | Same library document + server redact; opaque `answerRef` | **PASS** | Sole body = library; `redactBlocksForClientInit` nulls answer_key/solution content + `revealState: "hidden"`; clientInit schema `superRefine` forbids plaintext when hidden (T1/T6). |
| 5 | TeachingUnit 1:N activities; one current spec per activity | **PASS** | `UNIQUE (workspace_id, activity_id)` on specs; unit→many via `opening_teaching_activity_specs_unit_idx`. |
| 6 | Drafts in `checkpoint_json`; lost blockIds → `draft_anchor_lost` (no silent remap) | **PASS** | `saveDraftAnchors` writes `checkpoint_json.drafts[]`; missing blockIds → `{ ok:false, mismatch:"draft_anchor_lost", lostBlockIds }` (T5). |
| 7 | No second body / chat-as-lesson / parallel answer ledger | **PASS** | No `opening_teaching_answer_refs` / `opening_teaching_answers` DDL; T8 asserts backup allowlist excludes them. |

### SQL vs plan sketch

| Check | Result |
|---|---|
| Sole `0054_*` file | **PASS** — only `0054_opening_teaching_content.sql` under `packages/database/src/migrations/` |
| Tables / CHECKs / UNIQUE / indexes match sketch | **PASS** — units + activity_specs; verification enum; `revision_number > 0`; owner + unit indexes; rollback notes |
| FK tighten `document_id REFERENCES library_documents(id)` | **PASS** (honest) — plan optional composite FK deferred because library PK is `id` only (`0001_library.sql`); implement evidence documents this |
| Optional answer_refs / activities denorm | **Absent** — matches PM freeze (prefer derive-at-read) |
| No invented second migration number | **PASS** |

### Diff scope vs plan preview §11

New paths match plan: contracts (+test), 0054 SQL, schema, repo (+test), thin `teaching-content-service.ts`, backup/domain allowlists → **31** tables. Explicitly not touched: V2-07 worker, CT-03 layout / `activity-panel.tsx`, learning observation schema, Experience lecture render — **PASS**.

### Anti-hide / test honesty

| ID | Claim | Integrator read |
|---|---|---|
| T1 | Contract reject unknown keys; clientInit forbids hidden answer plaintext | Real schema assertions — not loosened |
| T2 | CAS CONFLICT + soft-idempotent same graph | Unit mock SQL; exercises real `publishActivitySpec` branches |
| T3 | Old library revision after two publishes | **`not_run`** (needs live DB) — honest |
| T4 | Library `expectedRevisionNumber` conflict | **`not_run`** (needs live DB) — honest; publish checks unit denorm revision when `expectedRevisionNumber` set (metadata path); body CAS remains library-owned |
| T5 | Draft keep + `draft_anchor_lost` | Real mismatch path — not silent drop |
| T6 | Redact fixture with `solutionZh` | Asserts `SECRET` absent from JSON |
| T7 | Sanitize checkpoint | Strips `answerKeys` / solution blocks |
| T8 | No teaching answer ledger in backup | Negative contain on table names |
| T9 | Backup registration / length 31 / apply order | Units+specs in `OPENING_BACKUP_TABLES`, domain allowlist, restore columns, apply order after activities |

No evidence of tests weakened to match broken code.

## Commands re-run by Integrator (cwd: repo root)

### Vitest (exact command from implement evidence)

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

**Result:** exit 0 — **10 files, 112 tests passed** (vitest 4.1.10). Claim **confirmed**.

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

**Result:** exit 0.

## not_run list (honest)

| Check | Reason |
|---|---|
| Migrate apply (`0054` → live DB) | Forbidden this accept; also no usable DB on box |
| Live `schema_migrations` max &lt; 0054 | **`not_run`** — `DATABASE_URL` / `OPENING_TEST_DATABASE_URL` unset; no listener on `:5432`; cannot query. If live max ≥ 0054, renumber before apply (same caveat as assignment note). |
| T3 (old library revision after two publishes) | Needs live library revisions — DB ECONNREFUSED / unset |
| T4 (library `expectedRevisionNumber` body conflict) | Needs live library CAS — DB unavailable |
| Browser / DOM leak E2E for answer keys | Not a claimed runnable check this Data slice; redaction covered by T1/T6 unit |

## Soft gaps (do not overturn ACCEPT)

1. **`createUnit`** creates library document then unit row in separate transactions — orphan doc possible on unit insert failure (implementer noted; acceptable M1).
2. **Drizzle** `opening_teaching_units_owner_idx` omits `updated_at DESC` present in SQL migration index — non-blocking schema mirror drift.
3. **Full `getClientInit`** against real library revisions not integration-tested (helper T6 + repo wiring present).
4. **Live migration number** unconfirmed — confirm `schema_migrations` max &lt; 0054 before apply.
5. **`teachingUnitId` required** on publish input (plan sketch had optional create-or-bind) — intentional tighten; create unit is a separate API.
6. **T4 path:** publish’s `expectedRevisionNumber` guards unit denorm `current_revision_number`, not an in-call library body write — aligned with “body via library”; true library conflict remains T4 `not_run`.

## Hard-rules compliance

| Rule | Held? |
|---|---|
| No commit / push / stash / reset / hermes | Yes |
| No migrate apply to live DB | Yes |
| Implementer ≠ accepter; no self-ACCEPT by implementer | Yes — this document is Integrator Accept |
| `tasks.json` → verified | Left to Projects Manager / process after this ACCEPT (not mutated here) |

## Verdict

**ACCEPT** V2-05 teaching content Implement on dirty tip `5d71248`.

- Required re-runnable checks (claimed vitest 112/10 files + contracts/database/web tsc) re-executed green.
- Sole migration file **0054**; SQL matches plan sketch under PM freezes.
- T3/T4/migrate apply/live `schema_migrations` listed **`not_run`** without pretending pass.
- Soft gaps tracked; none are design-lock breaks.

**Next (outside this accept):** before live apply, query `schema_migrations` max; if ≥ 0054 renumber; then migrate + run T3/T4 against `OPENING_TEST_DATABASE_URL`.
