# Q03 real export integration evidence

Date: 2026-09-25 (local +08:00). Branch: `feat/opening-release`; base HEAD: `8d616c0`. Results apply to the existing dirty worktree, not a publishable commit SHA. No commit, push, deployment, paid model, production connection, or task-status promotion.

## Scope and verified behavior

- Fixed 17-table durable export tested against real guarded PostgreSQL; all tables contain meaningful connected fixture rows. Non-owner requests fail before storage reads. Foreign workspace/owner rows, transient auth/job tables, and private image locators are excluded.
- Real SQL covers excluded/pending/foreign/missing/stale sources, citation-only and version-only lineage, filtered session descendants, deleted/excluded memories, malformed JSON, numeric citation versions, and case-insensitive UUID references.
- An actual table-lock waiter proves repeatable-read consistency: a deletion commits between source and chunk reads; the in-flight snapshot retains its original epoch/journal/data, while the next read sees the deletion. This is snapshot consistency, not publication authorization.
- Real MinIO bytes pass source inventory, staging, composition, archive, AES-GCM encryption/decryption and independent archive object verification. Wrong password, wrong bytes and missing objects fail closed. Privacy/version/journal/new-source changes during staging reject the draft and clean its owned directory without touching a sentinel file.
- A deletion after successful drafting is still rejected by restore preflight against the current journal. No restore application occurred.

## Failure → cause → fix → recheck

| Failure evidence | Root cause | Minimal fix | Recheck evidence |
| --- | --- | --- | --- |
| `q03-records-red.log`: 18/18 fail with `operator does not exist: text = uuid` | JSON set-returning function alias `source_id` is shadowed by a column inside the exclusion subquery | Explicit `source_ref(id)` and qualified reference | `q03-records-alias-recheck.log`: SQL executes; underlying privacy failures become visible |
| `q03-records-confirmed-red.log`: 8 failing tests | Non-array candidate lineage treated as empty; filtered sessions leave problems/observations/turns; malformed memory UUID casts abort export | Require candidate array shape; shared owner/source-clean session predicate; guarded memory UUID cast and array expansion | `q03-records-green.log`: 18/18 pass |
| `q03-snapshot-red.log`: caller scope mutation switches the exported workspace | Scope is read only inside the asynchronous transaction callback | Capture both scope strings before starting the transaction | Focused final integration passes both scope capture and real MVCC overlap cases |
| `q03-empty-memory-red.log`: otherwise valid compose returns `ok:false` | SQL exports memory with empty provenance while existing restore policy rejects it | Safely require nonempty memory turn references; restore policy remains unchanged | Focused final compose passes; sourced memories still round-trip |
| `q03-review-red.log`: 2 tests fail | Citation `->>` accepts string versions; candidate UUID text comparison rejects uppercase IDs | Require JSON numeric version; normalize both source and exclusion UUID comparisons | `q03-integration-final-focused.log`: 4 files / 31 tests pass |
| `q03-unit-first.log`, `q03-cipher-isolated.log`: cipher round-trip exceeds 5s | Diagnostic timing: encryption 188ms, decryption/read 157ms, generic 1MB Buffer deep comparison 4413ms (`q03-cipher-timing.json`) | Use exact native `Buffer.equals` byte comparison; do not increase acceptance timeout | `q03-cipher-green.log`: 3/3 pass, 1.20s test time, original 5s limit |
| `q03-types.log`: strict indexed access and missing `destroy` on narrowed client interface | Existing tamper assertion lacks proven index value; new cleanup used an API not exposed by `S3ClientLike` | Non-null assertion for known populated fixture byte; `instanceof S3Client` before cleanup | `q03-types-final.log`: explicit test roots and database/domain types pass |
| `q03-unit-full.log`: editor save test differs by 1ms | Actual and expected paths each call `documentToDraft`, whose missing timestamp fallback calls `new Date()` | Fix Date only within the affected test and restore it on completion; preserve full result assertions | `q03-editor-cipher-green.log`: both files / 9 tests pass; full unit rerun passed below |

Fixture corrections were made before trusting JSON regressions: array test parameters must not be unpacked by `it.each`, and JSON text is explicitly bound as text before `::jsonb` to avoid double serialization / SQL NULL. These were test setup issues, not product fixes. Earlier candidate-alias and malformed-reference failures remain recorded separately.

## Commands and final checks

Service setup: `pwsh -NoProfile -File scripts/opening-e2e/services.ps1 start`. Services are task-owned loopback PostgreSQL 15432, Redis 16379 and MinIO 19000/19001. Repository fixtures require `OPENING_TEST_DB=1` plus the guarded `aistudy_opening_test` URL. All object keys use generated source UUIDs and are removed in fixture cleanup.

- Focused integration: `pwsh -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project integration tests/integration/opening-backup-records-repository.test.ts tests/integration/opening-backup-records-json-repository.test.ts tests/integration/opening-backup-records-snapshot-repository.test.ts tests/integration/opening-backup-compose-repository.test.ts` — 4 files / 31 tests passed.
- Explicit tests: `node .local/opening-e2e/check-q03-types.mjs` — 6 roots plus imported fixtures passed (`q03-types-post-editor-final.log`).
- Package types: direct `tsc -p packages/database/tsconfig.json --noEmit`, domain equivalent, and web equivalent passed.
- Full-tree ESLint passed after the final editor change (`q03-lint-post-editor-final.log`). `node scripts/validate-opening-plan.mjs` passed (43-task structural integrity only); final `git diff --check` passed (`q03-diff-final.log`).
- Full unit: `node node_modules/vitest/vitest.mjs run --project unit` — 209 files / 1112 tests passed (`q03-unit-full-final.log`). The subsequent callback return-type-only fix passed the focused editor/cipher run: 2 files / 9 tests (`q03-editor-cipher-final.log`).
- Full integration: `pwsh -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project integration` — 47 files / 255 tests passed (`q03-integration-full-final.log`).
- Owned services stopped successfully; 15432/16379/19000/19001/3100/18081 all closed and owned-process manifest count is zero.
- One AST-only `graphify update .` completed: 13,829 nodes / 30,205 edges / 674 communities (`q03-graph-update.log`). No LLM extraction. The known missing `tree_sitter_sql` omits 27 SQL files; seven metadata files yield no nodes. Generated graph output remains outside commit scope.

Raw logs are retained under ignored `.local/opening-e2e/evidence/q03-*`; profiling instrumentation was restored and is not part of the implementation. No unit timeout was relaxed in the final code.

## Independent review and limits

A read-only agent identified the empty-memory, citation-version and UUID-case issues. Each received an actual real-database regression before its fix. Final static recheck closed all three and found no additional actionable issue in the four production files/four integration test files. The editor clock agent independently located the time drift; after its service interruption, the parent confirmed no partial edit and completed the fix.

Unsourced memories are omitted under the existing fail-closed restore provenance policy; this does not claim complete preservation of handwritten memories. Supporting them requires an explicit provenance contract. No released migration changed.

This slice does not implement an atomic publication protocol, restore apply, isolated recovery drill, CLI packaging, Docker/fresh-machine installation, real external integrations, or release-SHA CI. Root npm Bash wrappers are not claimed passed. The original 43-task release scope remains active; `tasks.json` is not promoted by these local checks.

The editor test was added to explicit TypeScript roots: its cleanup callback initially returned VitestUtils (TS2322). A void block body preserves the cleanup call and satisfies onTestFinished; the same explicit type check and focused tests passed afterward. No editor production behavior changed.
