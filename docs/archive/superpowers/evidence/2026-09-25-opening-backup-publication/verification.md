# Q03 exclusive file publication — 2026-09-25

## Scope and result

The in-flight exclusive-file slice is complete locally. Archive, encrypt and decrypt now write an owned same-directory `wx` temporary file (requested mode `0o600`), close it, and use exclusive hard-link publication. Existing destinations and colliding temporary files are preserved. Unsupported hard links fail closed. Published and unpublished cleanup failures have distinct errors carrying the destination, owned temporary path and original cause; unpublished cleanup errors also retain `cleanupError`.

This is file visibility/ownership evidence, not a database/filesystem atomic transaction, crash-durability proof, Windows ACL verification or restore drill. Partial `FileHandle.write` handling and swallowed `sync` errors remain PU05 follow-up work. No production, paid call, push, deployment or task-status promotion occurred in this slice.

## Failure → cause → fix → recheck

| Failure | Cause | Fix | Recheck |
| --- | --- | --- | --- |
| A destination could be visible empty; a competitor could be overwritten | Legacy reservation and probe-then-rename had a race | Stream to an owned temporary, close, then exclusive `link`; no copy/rename fallback | Deterministic gates with real files for archive/encrypt/decrypt; 6 tests |
| A colliding temporary could be removed; unsupported filesystem and post-publication cleanup were ambiguous | Cleanup did not distinguish ownership or publication state | Acquire ownership only after successful `wx`; fail closed on EXDEV/ENOTSUP; `OpeningBackupPublishedError` | Real destination bytes/inode/link count and injected failures; 12 tests |
| Partial plaintext cleanup failure was swallowed; creation did not request owner-only mode | Pre-publication catch discarded `rm` failure; implicit mode | `OpeningBackupUnpublishedCleanupError` retains both causes and owned path; explicit `0o600` | 3 tests first RED, then GREEN; target absent and existing cases |

Implementation agent logs: `.local/opening-e2e/evidence/q03-exclusive-{red,failures-red,green}.log`, `q03-exclusive-review-{red,green,test-types}.log`. An initial text replacement did not apply; files were reread and corrected before rechecking (`q03-exclusive-implementation-check-failed.log`). The parent independently read all changed production modules and the publication regressions; the third row is the parent's review finding, subsequently fixed by the owner.

## Parent-run checks against final files

All commands used PowerShell 7 and checked native exit codes. Logs are local metadata/test output, not release-SHA CI.

| Command / boundary | Result | Local artifact |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run --project unit` with every `*backup*.test.ts` under database/domain | PASS: 24 files / 170 tests | `q03-exclusive-parent-unit.log` |
| Isolated `check-service-tests.ps1 --project integration` with compose, records, JSON and snapshot repository roots | PASS: 4 files / 31 tests, real PostgreSQL and MinIO | `q03-exclusive-parent-integration.log` |
| `node .local/opening-e2e/check-exclusive-types.mjs` | PASS: 5 explicit test roots plus imports | `q03-exclusive-parent-test-types.log` |
| `node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit` | PASS, exit 0 | `q03-exclusive-parent-types.log` |
| ESLint of archive/cipher/publication helper and 3 new regression modules | PASS, exit 0 | `q03-exclusive-parent-lint.log` |

Artifacts above are under `.local/opening-e2e/evidence/`. The isolated services were started for these integrations and stopped afterwards. Full unit/integration counts from the preceding export slice are historical evidence, not a fresh full-suite assertion for this change. The later PU00 snapshot baseline must run its own full unit gate.

## Handoff

Per the user's instruction, continue with `2026-09-25-personal-use-multi-agent.md`, starting PU00 then PU01. Remaining publication design/fence/orchestration, independent memory deletion journal, restore apply, private staging permissions, partial writes/durability and recovery acceptance belong to PU05A0–PU05C. The old publication plan B–F is deferred into that sequence, not marked complete. A static concern about mutable scope in `readOpeningBackupSources` is recorded for that owner; it is not a reproduced failure yet.

Acceptance is a reviewable local slice plus the checks above. Final product delivery still requires the new plan's exact-SHA PR/CI, restore, live, real-device and authorization gates. Rollback disables the new publication caller; it must not delete another owner's final file or treat a published-cleanup error as permission to retry.
