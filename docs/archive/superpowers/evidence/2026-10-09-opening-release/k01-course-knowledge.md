# K01 Source-backed course knowledge — agent-owned verified

**Date:** 2026-10-09 ~17:38 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Verifier:** AIstudy Integrator (not the implementer)  
**Verdict:** **verified** (agent-owned close)

## Prior accept

[`k01-knowledge-accept.md`](./k01-knowledge-accept.md) — Data **ACCEPT** + AI **ACCEPT** (~17:29 CST). Both halves against `10-media-knowledge.md` § K01. Accept left `tasks.json` untouched / not verified pending Integrator close.

## Browser / plan gate check

Plan § K01 (`docs/superpowers/plans/opening-release/10-media-knowledge.md`):

- Required agent gates: unit knowledge-graph/contracts, integration `opening-knowledge` (idempotent replace, illegal refs, cross-owner, cycle, CAS, enqueue, authorized chunks), worker `build-course-knowledge` wiring, migration/rollback notes.
- Mentions **人工审查** of one course’s chapter coverage / prerequisite quality / citation support — **human review**, not a required browser walk.
- No K01 checkbox or `00-browser-boundary.md` item forces Playwright/browser for this task.

Per PM: no required browser gate → close agent-owned. Human chapter-coverage review remains a follow-up note, same pattern as DL4/DL9.

## Cited verification (from accept; not re-run this close)

| Scope | Result |
|---|---|
| Domain + contracts unit | **11** passed |
| Integration `opening-knowledge` | **8** passed (`OPENING_TEST_DB` + `aistudy_opening_test`) |
| Worker `build-course-knowledge` + `run-job` unit | **17** passed |
| tsc domain/contracts/database/web/worker | exit 0 |

## Not run / remaining human notes

- Browser UI for knowledge GET/PUT/rebuild — not required for this ledger close; not claimed.
- Manual course review (章节覆盖 / 关键先修 / 引用支持度) — human verify later.
- Live LLM extract E2E — accept used injected `extractGraph`; production uses provider resolve.
- 「人工更正不被覆盖」 merge-preserving rebuild — flagged in accept as NOTE (full CAS replace); does not block agent-owned wiring verified.

## Ledger

- `tasks.json` K01 → `verified` with this consolidated evidence path.
- Commit/push: evidence + `tasks.json` only.
