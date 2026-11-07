# DL10 live `opening-local-check` — Integrator follow-up (not verified)

Verifier: AIstudy Integrator. Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted. **DL10 stays `planned`.**

## Checks run (2026-10-09 ~16:14 CST)

- `node --test scripts/opening-local-check.test.mjs` — previously 3/3 pass (unit).
- `node scripts/opening-local-check.mjs` — **exit 1**. Output booleans/status only (no secret values).

### Live outcome

| Check | Result |
| --- | --- |
| postgres-dev 5432 | open: true |
| redis 6379 | open: true |
| minio 9000 / console 9001 | open: true |
| web 3000 | open: true |
| postgres-test 5434 | **open: false** |
| `/api/opening/health` | status ok; database/redis/storage/workerBacklog all up |
| env core (DATABASE/REDIS/S3/PUBLIC) | set: true |
| env PARSER_PYTHON / PARSER_CWD | set: **false** |
| env OPENING_TEST_* | set: true in this shell (exported for handler gates); not a substitute for a 5434 instance |
| parser PYTHON exists | **false** (default `.local/docling-venv/...` path missing on this box) |
| ai-readiness | **not-implemented** (DL7) |

## What still blocks upload → parse → tutor

1. No Docling/`PARSER_PYTHON`+`PARSER_CWD` on this box → parse path cannot run.
2. Isolated test Postgres on **5434** not started (handbook instance); Q01-style isolation still incomplete even though handler tests can use 5432/`aistudy_opening_test` when pointed there.
3. DL7 `GET /api/opening/ai-readiness` missing → self-check cannot score AI readiness.
4. Full Windows walk of `opening-local-windows.md` and browser E2E loop remain user-owned; Agent must not start/stop services for this task beyond what was already up.

## Ledger

Do **not** mark DL10 verified until self-check is green or each red item is explicitly waived after user Windows evidence.
