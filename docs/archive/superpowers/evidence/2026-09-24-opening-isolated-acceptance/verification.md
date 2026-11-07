# Opening isolated acceptance — 2026-09-24

## Scope and evidence boundary

Baseline: `feat/opening-release`, HEAD `8d616c0`, with existing uncommitted changes preserved. This is local working-tree evidence, not a release SHA or remote CI approval. No commit, push, deployment, production access, or paid model call was performed.

Services are task-owned PostgreSQL `127.0.0.1:15432`, Redis `127.0.0.1:16379`, MinIO `127.0.0.1:19000/19001`, Web `127.0.0.1:3100`, and fixture model `127.0.0.1:18081`. E2E uses `aistudy_opening_e2e`; integration/handler use the explicit guarded `aistudy_opening_test` database. The generic integration guard retains its existing CI compatibility; this run explicitly fixes port 15432. The E2E guard rejects any query/fragment, wrong port/name, non-loopback host, or missing opt-in.

The service binaries, parser virtual environment, offline model assets, and Chromium were already installed locally. Starting/reusing this environment does not prove installation on a fresh machine. Missing-bucket control flow is separately tested against a local HTTP fixture using the real AWS SDK. Browser and service suites use real local MinIO.

## Verification ledger

Commands were launched in PowerShell 7, with `$ErrorActionPreference = 'Stop'`. Direct Node executables are recorded explicitly because the root npm quality scripts require Bash, which is unavailable on this host. They are not claimed as successful root npm gates.

| Check | Command | Result |
| --- | --- | --- |
| Tooling | `node --test tests/tooling/*.test.mjs` | PASS: 59 tests (September 25 continuation) |
| Full unit | `node node_modules/vitest/vitest.mjs run --project unit` | PASS: 209 files, 1112 tests (fresh September 25 continuation) |
| Archive regression | `node node_modules/vitest/vitest.mjs run --project unit packages/database/src/storage/opening-backup-archive.test.ts` | PASS: 1 file, 4 tests |
| Storage/parser integration | isolated environment, `node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-sources-storage.test.ts tests/integration/opening-parse-job.test.ts` | PASS: 2 files, 11 tests |
| Full integration | same isolated environment, `node node_modules/vitest/vitest.mjs run --project integration` | PASS: 43 files, 224 tests (fresh September 25 continuation) |
| Full handler | same isolated environment, `node node_modules/vitest/vitest.mjs run --project handler` | PASS: 23 files, 87 tests (fresh September 25 continuation) |
| TypeScript | direct `node node_modules/typescript/bin/tsc -p <project> --noEmit` | PASS: domain/contracts/config/database/ai/ui/worker/web and `tsconfig.e2e.json`; four explicit test roots pass after strict-index fixes |
| ESLint | direct `node node_modules/eslint/bin/eslint.js .` | PASS after excluding generated Playwright report/result bundles |
| Opening browser + production build | `pwsh -NoProfile -File scripts/opening-e2e/run.ps1` | PASS: 8 tests, production build, runner exit 0 (September 25 continuation) |
| Plan integrity | `node scripts/validate-opening-plan.mjs` | PASS: 43 tasks; does not assert product correctness |
| Root CI wrapper | `node scripts/verify-ci.mjs` | BLOCKED: nested npm command requires unavailable Bash |
| Initial unit + contract | `node node_modules/vitest/vitest.mjs run --project unit --project contract` | 211 files passed, 2 failed, 1 skipped; 1129 tests passed, 2 failed, 12 skipped, 1 todo. Archive failure fixed below; Bash contract remains environment-blocked. |

Integration commands were run through `.local/opening-e2e/check-service-tests.ps1`, which constructs the explicit environment below, then runs `node node_modules/vitest/vitest.mjs run @args`. The script and raw logs remain local ignored artifacts.

```powershell
$ErrorActionPreference = 'Stop'
$isolatedJson = node --input-type=module -e 'import { buildOpeningE2eEnvironment } from "./scripts/opening-e2e/environment.mjs"; console.log(JSON.stringify(buildOpeningE2eEnvironment({})));'
if ($LASTEXITCODE -ne 0) { throw 'Cannot construct isolated environment' }
$isolated = $isolatedJson | ConvertFrom-Json -AsHashtable
foreach ($entry in $isolated.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
}
$env:NODE_ENV = 'test'
$env:OPENING_RELEASE = $null
$env:OPENING_E2E = $null
$env:OPENING_MODEL_API_KEY = ''
$env:OPENING_MODEL_DAILY_CAP_CENTS = '0'
$env:OPENING_TEST_DB = '1'
$env:OPENING_TEST_DATABASE_URL = 'postgres://opening:opening-local-test@127.0.0.1:15432/aistudy_opening_test'
$env:DATABASE_URL = $env:OPENING_TEST_DATABASE_URL
# Run the desired integration/handler command here, serially.
```

These fixed credentials are disposable loopback fixture values, not user secrets. No application `.env` was copied into this configuration.

## Failure → cause → fix → recheck

1. **First-start bucket creation:** extracted storage preparation without changing its behavior; a real-SDK/local-HTTP regression returned 404 and failed `HeadBucketCommand: NotFound` (1 failed, 2 passed). The diagnostic middleware had replaced the SDK error and dropped `$metadata.httpStatusCode`. Removed that wrapper; absent bucket creation, existing bucket reuse, and 403 rejection now pass in the 52-test tooling suite. Logs: `storage-red.log`, `tooling-green.log`.
2. **Cleanup exit status:** actual PowerShell runner with stubbed service commands reported success for browser=0/stop=7. Preserve a failing browser exit; otherwise propagate failed cleanup. Three exit combinations now pass. The first harness version needed `exit $LASTEXITCODE` after invoking a script to retain a nonzero numeric child exit; that harness issue is not claimed as a product defect. Logs: `cleanup-red.log`, `environment-cleanup-red.log`, `tooling-green.log`.
3. **Inherited context budget:** inherited `OPENING_TUTOR_MAX_CONTEXT_CHARS=1` survived environment construction. Pin the fixture context budget to 12000 so source text remains available. Regression first failed and now passes. Logs: `environment-cleanup-red.log`, `tooling-green.log`.
4. **Archive object reads:** full unit/contract run exposed `object verification failed` when reading the second archive member before the first. The reader used the shared sequential file cursor and ignored member offsets. Compute object starts after the complete metadata section and use explicit positional reads, including partial/chunk offsets. Regression covers reverse, repeated, and concurrent reads; 4 focused tests and the full 1112-test unit suite pass. Logs: `unit-contract.log`, `archive-green.log`, `unit-green.log`.
5. **Integration storage routing:** explicit isolated service environment still produced `ECONNREFUSED 127.0.0.1:9000` (10 failed, 1 passed, plus cleanup errors). Two integration files hardcoded MinIO endpoints/credentials. A shared test fixture now uses validated `loadEnv().s3`; PDF and unsupported-audio paths plus upload guards pass, 11/11. Logs: `storage-integration-red.log`, `storage-integration-green.log`.
6. **Browser assertion drift:** reproduced 3 failures/1 pass in the shell suite. Unscoped “助理” matched both the navigation entry and the “向助理提问” CTA; the old empty-state wording no longer exists. Scope navigation assertions to the labelled navigation landmark, and assert the current empty-state heading and usable assistant link. Recheck: PASS in the final 8-test browser suite. Logs: `shell-red.log`, `browser-continuation-green.log`.

7. **Explicit test-root typecheck:** package and E2E checks passed, then direct compilation of four test roots found seven `TS2532` unchecked-index diagnostics. Use optional access in assertions (missing rows still fail) and checked Buffer byte methods for tampering. The identical explicit-root command now passes; focused archive and service tests were rerun. Logs: `typecheck.log`, `test-types-green.log`, `archive-final.log`, `storage-integration-final.log`.
8. **Lint scope after browser reports exist:** whole-tree ESLint reported 2968 errors, all in five generated Playwright report bundles. A new scope regression first failed. Exclude only `playwright-report` and `test-results`; retain browser specification linting. Whole-tree ESLint now passes, and tooling is 53/53. Logs: `lint-red.log`, `lint-scope-red.log`, `lint-green.log`, `tooling-final.log`.

No assertion was removed to disguise missing product behavior. The real workflow still requires upload, asynchronous parsing without a reload workaround, a selected page/source, in-flight refresh, a single fixture model call, a versioned original download with byte equality, and refresh persistence.

## Review, artifacts and remaining work

Read-only independent review confirmed the bucket, cleanup, context-budget and archive-offset fixes. Main-agent executions above supply the test evidence; review prose is not test evidence.

Raw logs are under `.local/opening-e2e/evidence/`; Playwright HTML/traces/screenshots are under `playwright-report/opening-isolated/` and `test-results/opening-isolated/`. Failed baseline screenshots/traces must not be confused with the final accepted run.

Graph update: PASS (exit 0). Final diff check: PASS (exit 0). Service cleanup: PASS; ports 15432/16379/19000/19001/3100/18081 all closed and zero owned-service manifests remain. See continuation details below.

Release limitations remain: no real-model quality/budget acceptance, no external reminder delivery, no restore-apply executor or restore drill, no Docker packaging verification, no full legacy browser suite, no remote CI run bound to a pushed SHA. The 43-task `tasks.json` statuses are unchanged. No migration or destructive product change was added in this slice; only disposable test data was written. Acceptance before merging still requires the documented PR/CI gates and any remaining manual release checks.

## September 25 continuation (Asia/Shanghai)

The September 24 `browser-final.log` already contained 8 passes and closed-port evidence, but this document had not been reconciled. A fresh run strengthened the failed-upload test and revealed two product failures. The earlier pass is not used to override the fresh failures.

### Failure → cause → fix → recheck

9. **Provider fixture false positive:** the question itself contained `page one`, which satisfied the fixture's whole-message substring check without proving that PDF text reached it. Six local HTTP regressions first failed. The fixture now verifies the text `Opening parser page one` inside a complete, matching source block for v0/page 1 and cites that block's chunk. The browser asks `Summarize the selected page.` Five invalid-source cases are rejected and a valid second block is cited correctly: 6/6 pass. Logs: `provider-fixture-red.log`, `provider-fixture-green.log`.
10. **Loopback redirect lost login:** the fresh browser run reached `http://localhost:3100/login` after authenticating on `127.0.0.1`. Trace shows `/learn` returned a 307 to `localhost`, followed by `/api/auth/me` 401. The installed Next URL normalizer canonicalized loopback hosts. `skipMiddlewareUrlNormalize: true` preserves the request URL for redirects; the browser now asserts the complete same-origin URL and authenticated navigation for every legacy entry. The same browser command passes. Logs: `browser-continuation.log`, `browser-continuation-green.log`.
11. **Failed parse never ended the source spinner:** the strengthened failed-PDF test waited 120 seconds; repeated source responses still returned `parseState: "not_started"`. The parser threw and `runJob` finished the job, but `opening_jobs.finish` never projected a source failure. New `opening-job-failure.ts` commits job failure and the source status in one transaction. It locks the workspace before the job/source and checks job CAS, owner, privacy epoch, source version, uploaded state, nonterminal parse state, and privacy exclusions. The source gets a contract-valid generic error; parser paths/content stay out of the source error. Existing parse-handler behavior remains unchanged. A real-database regression first failed on the unchanged source state. It now passes with cancellation/redelivery/stale-version/epoch/ready/unsupported/cross-workspace/owner/exclusion guards and a real lock-wait race: 11 new tests plus 5 existing worker tests pass. Logs: `parse-failure-red.log`, `parse-failure-green.log`, `parse-failure-race-green.log`.

The failed-upload browser test now waits for the real parser to fail, opens the actual original link, checks downloaded bytes against the uploaded malformed PDF, refreshes, and verifies failure/original access persist. No parser or product API was mocked. The valid-PDF workflow verifies real parse-to-provider text transport, one fixture provider call, versioned citation bytes, in-flight refresh recovery and persisted messages. It uses a fixture model and is not evidence of real-model answer quality.

Fresh focused verification:

- `node --test tests/tooling/*.test.mjs`: 59/59 pass.
- Guarded integration `opening-parse-failure-repository.test.ts` and `opening-worker.test.ts`: 2 files, 16/16 pass.
- Direct Vitest unit `parse-source.test.ts`, `run-job.test.ts`, `access-middleware.test.ts`: 3 files, 22/22 pass.
- Direct TypeScript checks for database, E2E config and five explicit test roots: pass.
- ESLint on all nine changed code/test files: pass.
- `pwsh -NoProfile -File scripts/opening-e2e/run.ps1`: 8/8 pass in 2.8 minutes, including the isolated Next production build; runner exit 0. Failed PDF completes in 24.3 seconds; valid PDF workflow in 41.7 seconds.

Read-only quality review found no actionable issues in the bounded continuation; the main thread ran the checks above. A specification recheck attempt encountered an upstream 503 and supplied no evidence; the successful final reviewer independently checked that fixture requirement and the new terminal-state safeguards.

Artifacts: prior failing traces/screenshots are retained in `.local/opening-e2e/evidence/continuation-red-traces/`. The final browser report is `playwright-report/opening-isolated/index.html`; final desktop/mobile screenshots are in `test-results/opening-isolated/opening-workflow-real-uplo-f2b38-ight-refresh-fixture-model-/` and were visually inspected. The earlier `Acceptance service stopped unexpectedly (1)` message occurred during Playwright's Windows process-tree teardown after all tests; the final fresh run has no such message. Runner status and closed ports are the cleanup evidence.

No migration was added. Before merging, acceptance still requires a PR/CI run tied to the actual committed SHA. Operational rollback for this slice is reverting the redirect configuration and failure-projection code; there is no schema rollback. Existing source failure labels are safe terminal metadata and original object bytes remain intact. No commit, push, deployment or task-status promotion was performed.

### Final continuation gates and cleanup

- Fresh full unit suite: 209 files / 1112 tests pass (`continuation-full-unit.log`).
- Fresh guarded full integration suite: 43 files / 224 tests pass (`continuation-full-integration.log`).
- Fresh guarded full handler suite: 23 files / 87 tests pass (`continuation-full-handler.log`). Service-test orchestration exit 0.
- Fresh direct worker and web TypeScript checks and whole-tree ESLint: exit 0 (`continuation-worker-types.log`, `continuation-web-types.log`, `continuation-full-lint.log`). Together with database/E2E/explicit roots and the isolated production build, these cover the changed paths. They do not turn the Bash-dependent root wrappers into successful runs.
- `node scripts/validate-opening-plan.mjs`: PASS, 43 tasks. `git diff --check`: exit 0. No `tasks.json` status was changed by this continuation.
- One `graphify update .`: exit 0, 13,749 nodes / 30,076 edges / 682 communities. AST-only, no semantic/paid calls. The tool reports 27 SQL files omitted because `tree_sitter_sql` is missing and seven metadata files producing no nodes. It also renamed 200 communities using hub labels after the community set changed; no LLM relabel was requested. Generated graph files are not included in any commit.
- `continuation-cleanup-ports.json`: all six task ports closed. No `.local/opening-e2e/*.process.json` files remain. Existing developer service ports were not stopped.

One main-thread verification shell stalled after its service-start child exited while output was redirected. Process inspection showed no test child had started and only the known task services were alive (consistent with inherited pipe handles). Only that verified task shell was stopped; the already-owned services were reused for the explicit integration/handler commands above, followed by normal owned-service cleanup. This was an orchestration recovery, not a product test failure or a reason to retry assertions.

This completes the local isolated-acceptance slice. Next: exercise the full fixed-table backup/export SQL and consistency boundaries against these isolated services, then finish the publish/apply protocol and real restore drill. Real-model quality, external reminder delivery, fresh-machine/Docker packaging, full legacy browsers and remote SHA-bound CI remain outside this passing local slice.
