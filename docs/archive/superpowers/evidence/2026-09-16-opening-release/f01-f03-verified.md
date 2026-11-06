# F01 / F03 verified — DB gates green — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Test database: portable PostgreSQL 17.5 at `127.0.0.1:5433`, db `aistudy_opening_test` (F01 guard: `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test`). Binaries in gitignored `.local/pgsql`; start with `.local/pgsql/bin/pg_ctl.exe -D .local/pgdata -o "-p 5433 -h 127.0.0.1" -l .local/pg.log start`.

## 1) F01 → verified

All conditions of `../../evidence/2026-09-13-opening-release/f01-access.md` §4 met:

- Guarded loopback URL + `OPENING_TEST_DB=1` used for every run below.
- Handler project FULLY GREEN including `opening-access.test.ts`:

```text
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=... node node_modules/vitest/vitest.mjs run --project handler
Test Files  13 passed (13)   Tests  44 passed (44)
```

- Owner setup path against the isolated DB: `scripts/opening-create-owner.ts` via wrapper → refusal path when any user exists ("Owner already exists; refusing to create another via CLI") and, after truncate, creation path → `{"status":"ok",...,"email":"owner@example.com"}` with user+workspace rows verified via psql.

## 2) F03 → verified

Delivered by two `xhh/gpt-5.6-luna-fast` worker runs (`mu3xpgyn-12966d4e`, `mu3y1pcs-8f3440e0`); lead re-verified.

Files: `migrations/0018_opening_jobs_outbox_budget.sql` (fills the 0018 contiguity gap; UNIQUE(workspace_id,key); FK ownership; payload = source IDs only), `schema/opening-jobs.ts`, `schema/opening-budget.ts`, `repositories/opening-jobs.ts` (createOnce idempotent / CONFLICT on payload change), `repositories/opening-budget.ts` (overspend-proof reserve, requestId-idempotent, unknown-outcome retention), transactional source+job+outbox helper, `tests/integration/opening-fixture.ts` (interfaces.md §7), `tests/integration/opening-foundation.test.ts`, additive `index.ts` exports.

```text
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=... node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-foundation.test.ts
Test Files  1 passed (1)   Tests  6 passed (6)
$ node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening packages/domain/src/opening packages/contracts/src/opening packages/database/src/repositories packages/config/src
Test Files  23 passed (23)   Tests  135 passed (135)
$ npm run typecheck → TYPECHECK_EXIT=0 ; targeted eslint → LINT_CLEAN
```

## 3) Incidents found and fixed en route (evidence chain)

1. **MIGRATION_VERSION_GAP**: registry requires contiguous 0001..N; committed 0016/0017/0019 left an 0018 hole. Fixed by landing F03's jobs/outbox/budget in 0018 (its planned scope). Memories/planning/connections/knowledge/skill-evidence reservations shifted +1 → 0020..0024; docs updated (implementation plan §2, 04-memory, 06-planning, 09-connections, 10-media-knowledge).
2. **BOM in committed 0016** broke SQL parsing (`syntax error at or near "﻿"`): stripped.
3. **MIGRATION_CHECKSUM_DRIFT** after a stash cycle rewrote 0016–0018 as CRLF: normalized all opening migrations to LF; `.gitattributes` gains `*.sql text eol=lf` (original `*.sh` rule preserved); test DB recreated + remigrated cleanly.
4. **Pre-existing baseline test bug** (proven at e7639c9 worktree with identical failure): `tests/integration/handler/explorations.test.ts` `registerAs` returned the whole response body under `user`, so the assertion read `user.user.workspaceId` one level too shallow — handler behavior itself is correct (register returns workspaceId; exploration lands in session workspace; client workspaceId ignored). One-line fixture fix (`user: body.user`) → handler project fully green. Baseline handler gates had never been executed (design E06), so this was never observed before.

## 4) Portability note

The portable PG lives under gitignored `.local/` — future sessions/CI must provision their own (Docker `compose:up` or equivalent) and re-run the same guarded commands; nothing in-repo depends on the binary path.
