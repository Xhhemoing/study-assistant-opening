# M02 Privacy Deletion and M03 No-Save Mode Verification

Status: implementation and non-browser verification are complete for M02 and M03. Browser acceptance remains explicitly pending user review; this is not final release approval.

## M02 implementation and evidence

- Memory deletion transaction locks the workspace, tombstones the memory, advances `privacy_epoch`, records content-free source exclusions, invalidates dependent learning eligibility, and optionally clears source turn text.
- Tutor work checks the epoch before provider send and again atomically under the workspace row lock during `completeTurn`; the privacy deletion and writeback paths share the workspace-first lock order.
- Saved tutor history, memory context, ephemeral receipts, learning evidence, and backup record export honor privacy exclusions. Excluded source chunks remain stored as user-owned source data; model/context admission rejects them rather than destructively deleting reusable source storage.
- Deletion `clientKey` reuse across memories or operations conflicts. A replay is accepted only for the same already-deleted memory and matching key.
- Deleted memory bodies are omitted from backup records; content-free memory deletion facts survive archive boundaries and prevent an old archive from restoring a deleted memory.
- The memory panel exposes the choice to delete source conversation text. Original uploaded materials are not deleted by that choice.
- Real isolated PostgreSQL integration: privacy deletion, two true writeback/delete lock-order races, worker/provider privacy input, history filtering, candidate/provenance regressions, and memory deletion backup boundary: 10 files / 54 tests passed.
- M01/M02/M03 handler slice: memory, candidate-memory, ephemeral, and snippets handlers: 4 files / 35 tests passed. The final memory-handler run independently passed 9/9 after adding source-backed correction and delete-source-text cases.
- Memory context and owner/source admission integration: 2 files / 11 tests passed.
- Focused privacy worker/database unit tests: 61 tests passed before the final client-key regression was added; final semantic-writer unit file passed 16/16.
- Contract/database/domain/AI/web/worker typechecks, changed-file ESLint, diff check, and plan validator passed. The latest contract/database/web typechecks were rerun after enforcing non-empty correction provenance.

### M02 boundary

Q03 restore execution, production recovery drill, and final publication protocol remain separate unfinished work. This evidence covers backup deletion metadata/preflight and old-archive exclusion tests, not a full production restore. The deletion-choice UI is awaiting user browser acceptance; agent browser automation was not run. Task verification covers implemented backend behavior and automated tests only.

## M03 implementation and evidence

- `canProposeTask` disallows task proposals in listen mode; ephemeral provider candidates are stripped for all modes.
- Ephemeral requests use bounded in-tab history, authenticated source admission, budget accounting, privacy-epoch checks, content-free provenance, cancellation, and `Cache-Control: no-store`.
- Handler assertions verify no saved conversation/turn/job/candidate/memory/learning rows and no ephemeral body in receipts/logs/recovery paths; prior-epoch history is discarded after a privacy change.
- M03 unit slice: 9 files / 108 tests passed.
- M03 handler slice is included in the 4-file / 35-test pass above; ephemeral + snippets alone passed 2 files / 21 tests.

### M03 boundary

This is not browser acceptance, external model retention assurance, or a claim that provider-side zero retention exists. The saved/no-save selector and refresh behavior await user browser acceptance. Task verification covers implemented behavior and automated tests only.

## Note 2026-10-05

Browser acceptance for M02 (deletion-choice UI) and M03 (saved/no-save selector, refresh behavior) is **still pending**. The `verified` status in `tasks.json` covers backend behavior and automated tests only, not user browser acceptance or release approval. See `docs/quality/2026-10-05-opening-repo-review.md`. CI browser tests on `feat/opening-release` were still failing at review time; no agent Playwright run was performed for M02/M03.
