# Technical debt cleared — full integration project green for the first time — 2026-09-18

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Debt-removal pass executed by `xhh/gpt-5.6-luna-fast` run `mu6gpa2u-327404b4` (6 suites) + lead (search.test.ts root-cause analysis and contract-aligned fix). Committed as `c7eade3` by the parallel session (its commit message describes parser work; the 7 test files in it are this pass's debt fixes).

## The debt

All 25 integration-project files had NEVER been run as one gate on this branch — every prior evidence file ran explicit opening file lists only. The first full run failed 19 tests across 7 Phase-1-era suites.

## Root causes and fixes (all test-side; NO product code weakened, NO test deleted)

1. **Duplicate-owner workspace seeds (4 suites)** — `exploration-repository`, `promotion-repository`, `revision-proposal-repository` each inserted TWO workspaces with the SAME owner in one INSERT, necessarily violating `workspaces_owner_user_uidx` (UNIQUE(owner_user_id) from migration 0003/0004 identity repair; the seeds predate it). Fix: one user per workspace, preserving each test's intent; deliberate WORKSPACE_MISMATCH assertions keep using a genuinely non-owner user id.
2. **Incomplete TRUNCATE lists (2 suites)** — `multi-goal-course` and `card-multi-goal-state` failed on leftovers from earlier suites sharing tables. Fix: extended TRUNCATE lists (RESTART IDENTITY CASCADE), assertions untouched.
3. **identity-migration-compatibility** — owner-exists pre-condition scenarios reworked to satisfy the unique index while keeping the migration-compatibility intent intact.
4. **search.test.ts "escapes LIKE wildcards"** — NOT a product bug (worker suspected one; lead disproved it with direct SQL): LIKE escaping is correct (`'百分比 100% 完成' ILIKE '%100\_%'` → false), but library search is FTS ∪ LIKE, and the `simple` dictionary strips `_` as a separator, so `plainto_tsquery('simple','100_')` → `100` legitimately matches. The old assertion `[]` encoded a wildcard coincidence, not the contract. Fix: assert the escape property (`"_"` alone → `[]`; the LIKE branch itself does not broaden) and accept the legitimate FTS hit. Direct SQL evidence recorded in the transcript.

## Acceptance gates (exact output)

```text
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration
Test Files 27 passed (27)   Tests 136 passed (136)   ← FIRST-EVER full green, run twice consecutively (reused DB proves no leakage)
$ ... regression: opening 7-suite set → 7 files / 33 tests passed
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files 145 passed (145)   Tests 704 passed (704)
$ npx eslint tests/integration → clean
```

## Related fixes landed alongside (parallel session, reviewed by lead)

- `751f27b` parse Worker concurrency serialized to 1 (CPU-bound docling) with explicit conversion timeout passed through.
- `42b0d93` parse tempDir resolved to an absolute path for the parser child cwd.
- `c7eade3` parser stderr surfaced in job errors (diagnosable conversion failures instead of opaque "conversion failed").

## Note on parallel sessions

This branch had TWO active lead sessions; commit `c7eade3` folded this session's staged debt fixes together with the parallel session's parser changes. Verified: `git show c7eade3 --name-only` matches exactly the 7 test files of this pass; the parser changes came through `751f27b`/`c7eade3` reviewed above. Full unit+integration re-run on the final tree is green.
