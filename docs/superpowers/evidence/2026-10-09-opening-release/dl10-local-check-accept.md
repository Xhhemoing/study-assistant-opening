# DL10 Windows local runbook and readiness self-check — agent-owned accept

Verifier: AIstudy Integrator. Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § DL10

Deliverables present:
- `docs/operations/opening-local-windows.md` — start order, ports (dev 5432, test **5434** / `aistudy_opening_test`, Redis 6379, MinIO 9000/9001, web 3000), data dirs, logs, stop, no-bash typecheck/vitest/eslint, warns against shared **15432**, MinIO 19000 risk note, PARSER_PYTHON/CWD, AI readiness not-implemented until DL7.
- `scripts/opening-local-check.mjs` + `scripts/opening-local-check.test.mjs` — ports, `/api/opening/health` up/down, env set booleans only, parser path exists, `GET /api/opening/ai-readiness` state; no secret values in output.
- `docs/operations/opening-release.md` Readiness checks links the Windows doc and script.

Agent does not start/stop services for this task (plan).

## Verification

- `node --test scripts/opening-local-check.test.mjs` — **3/3 pass** (Integrator re-run).
- Live `node scripts/opening-local-check.mjs` — **exit 1**; see `dl10-local-check-live.md`. Self-check **clearly points missing**: postgres-test 5434 closed; PARSER_PYTHON/CWD unset; parser path missing; ai-readiness `not-implemented`. Core health on this box was ok. Output contains env **names** only (`S3_SECRET_ACCESS_KEY set: true`), never values.

Plan acceptance: "自检全部通过或明确指出缺失项" + no secret leak → agent-owned bar met.

## Not run (user / later work)

- Full Windows follow of the runbook on Paula's machine (no bash/Docker).
- Upload → parse → tutor → answer → retest walk (needs Docling/parser, models, and DL3 for retest UI).
- Bringing up isolated Postgres on 5434 and setting PARSER_* for a green self-check.
- Browser acceptance of the learning loop (`AGENTS.md` user-owned).
- DL7 ai-readiness implementation.

## Ledger

- `tasks.json` DL10 → `verified` with this evidence path (and cite live prep md). No commit.
