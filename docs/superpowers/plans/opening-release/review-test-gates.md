# Review & test gates (Paula 2026-10-11)

Applies to all opening-release / AI-led v2 slices. **Implementer ≠ Accepter.** Status `verified` / **ACCEPT** only after an independent Accept that re-ran named tests (or honestly marked them `not_run`).

## After every IMPLEMENT

Implementer evidence must include:

| Field | Rule |
| --- | --- |
| Diff scope | Paths changed; what was *not* touched |
| Commands run | Exact commands (cwd / package) |
| Results | Exit code + pass/fail counts; paste or link log snippet |
| Not run | Every planned check not executed → label **`not_run`** + reason (e.g. no `OPENING_TEST_DB`) |
| Forbidden | Do **not** self-mark Accept / `verified` / “done” |

## Independent ACCEPT (Integrator or designated other)

1. **Stronger review** — read diff against plan / understand checklist / PM decisions; look for green tests that hide missing behavior.
2. **Re-run** — re-execute the implementer’s claimed unit/typecheck (and integration/browser when env allows). Record commands + results in accept evidence.
3. **Verdict**
   - **ACCEPT** only if required checks that *could* run were re-run green, and every skipped check is listed `not_run` without pretending it passed.
   - **REJECT** if behavior misses the checklist, tests were loosened to match broken code, or evidence claims pass without a real run.
4. Browser / device checks that are acceptance criteria and were **not** run → **not ACCEPT** (leave open or REJECT).

## Evidence paths

- Implement: `docs/superpowers/evidence/<date>-opening-release/<id>-implement.md`
- Accept: `docs/superpowers/evidence/<date>-opening-release/<id>-accept.md`  
  Must name: reviewer, tip/SHA or dirty tree, commands re-run, `not_run` list, ACCEPT/REJECT + soft gaps.

## Status in tasks.json

Only Accept may move a task to `verified`. Implement leaves `planned` / `in_progress`.

## Push / hermes

Unaffected by this doc: push and hermes only via Projects Manager / Paula standing auth. Default: **no hermes** on iterative merges unless Paula asks.

## CT-03 note

Today → activity wiring Accept must follow this page: re-run named UI/unit checks; any browser E2E not run → `not_run` (blocks ACCEPT if the plan requires it).
