# Notion Meeting Pipeline CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, recoverable CLI that validates a complete Zhixue recording, prepares upload-safe audio, drives the proven Notion Meeting Notes **Upload audio or video** UI, and accepts only a readable native Transcript.

**Architecture:** Keep the pipeline under `scripts/notion-meeting-pipeline/`, independent of the generic parser and Worker request lifecycle. Pure policy/state helpers are tested without a browser; media helpers invoke explicitly configured `ffmpeg`/`ffprobe`; a Playwright adapter owns the long-lived Notion UI operation. A JSON manifest and lock are written atomically after every stage so reruns resume or refuse unsafe duplication.

**Tech Stack:** Node.js 20 ESM, Node built-ins (`fs`, `crypto`, `child_process`, `fetch`), existing Playwright installation, Vitest.

## Global Constraints

- Only Meeting Notes → **Upload audio or video** is a successful upload route; ordinary attachments and Public API File Uploads are not acceptance evidence.
- The final source must be complete; no previews, cuts, or segments.
- Native Transcript readability is the hard acceptance gate; Summary/audio/task enqueue alone is insufficient.
- Do not modify `createParseSourceHandler`, the general parser, or web request handlers.
- Never persist or print tokens, authorization headers, signed URLs, credentials, or raw network request bodies.
- Default browser operations are restricted to disposable `Meeting-...` pages and reject the known real target unless explicit safety flags are supplied.
- `ffmpeg` and `ffprobe` are external tools selected by CLI flags/environment; no binary is added as a project dependency.
- Existing unrelated working-tree changes must not be staged, overwritten, or committed.

---

### Task 1: Pure pipeline policy and manifest contracts

**Files:**
- Create: `scripts/notion-meeting-pipeline/policy.mjs`
- Create: `scripts/notion-meeting-pipeline/state.mjs`
- Test: `scripts/notion-meeting-pipeline/policy.test.mjs`
- Test: `scripts/notion-meeting-pipeline/state.test.mjs`
- Modify: `vitest.config.ts`

**Interfaces:**
- `assertCompleteDuration(actualSeconds, expectedSeconds, toleranceSeconds)` throws a `PipelinePolicyError` when the source is not complete.
- `assertUploadSize(bytes, limitBytes)` rejects the observed frontend boundary (`26,214,400` bytes by default).
- `assessTranscript(text, sourceDurationSeconds, options)` returns normalized text, timestamp statistics, coverage, and `readable`/`accepted` booleans.
- `assertSafeTarget({ pageUrl, blockId, allowNonDisposable, allowRealTarget })` rejects accidental real-target operations.
- `createManifest(input)`, `loadManifest(path)`, `saveManifestAtomic(path, manifest)`, and `withFileLock(path, fn)` provide the persisted state boundary.

- [x] Write tests for duration, size, transcript coverage, target safety, stable job identity, atomic JSON recovery, and concurrent lock refusal.
- [x] Run the focused Vitest project and observe the expected missing-module failures.
- [x] Implement the smallest pure helpers and manifest schema needed by the tests.
- [x] Re-run the focused project until green.

### Task 2: Complete-source acquisition and audio preparation

**Files:**
- Create: `scripts/notion-meeting-pipeline/media.mjs`
- Create: `scripts/notion-meeting-pipeline/media.test.mjs`

**Interfaces:**
- `sha256File(path)` streams bytes and returns `{ bytes, sha256 }`.
- `inspectMedia(path, { ffprobePath, ffmpegPath })` returns duration and stream metadata without logging command arguments containing URLs.
- `downloadResumable(url, destination, options)` resumes a `.part` file with HTTP Range and verifies the final byte count/hash.
- `convertToMeetingAudio(inputPath, outputPath, options)` uses `-map 0:a:0 -vn -ac 1 -ar 16000 -c:a aac -b:a 32k -movflags +faststart`, then validates duration preservation and upload size.

- [x] Add tests for streaming hash, duration mismatch rejection, upload-size rejection, and resume behavior with a local HTTP fixture.
- [x] Run tests red.
- [x] Implement media helpers with temp-output rename and redacted errors.
- [x] Run tests green; validate the existing complete fixture with the external ffmpeg binary only if explicitly configured.

### Task 3: Notion UI upload and native Transcript verifier

**Files:**
- Create: `scripts/notion-meeting-pipeline/notion-ui.mjs`
- Create: `scripts/notion-meeting-pipeline/notion-ui.test.mjs`

**Interfaces:**
- `uploadMeetingAudio({ pageUrl, blockId, audioPath, manifest, browserOptions, onProgress })` uses visible ARIA/role controls, captures only endpoint paths/status/task IDs, and updates the manifest after upload/task enqueue.
- `verifyNativeTranscript({ pageUrl, blockId, sourceDurationSeconds, manifest, browserOptions })` reacquires locators after rerenders, extracts the visible Transcript panel, writes a local transcript artifact, and rejects anything short of the native Transcript gate.
- `inspectMeetingDom(page, blockId)` uses attribute/role queries and never constructs a CSS selector from a digit-leading block ID.

- [x] Add unit tests around DOM inspection/normalization using fixtures and a fake page adapter; cover stale rerender and error/pending states.
- [x] Run tests red.
- [x] Implement the persistent-context adapter with configurable profile/Chrome paths, timeout/backoff, no request-body logging, and explicit duplicate-upload refusal.
- [x] Run tests green and perform one dry-run against a disposable page only after the policy gate passes.

### Task 4: CLI commands and documentation

**Files:**
- Create: `scripts/notion-meeting-pipeline.mjs`
- Modify: `package.json`
- Modify: `notion-ai-meeting-audio-transcript-pipeline.md`

**Interfaces:**
- Commands: `prepare`, `upload`, `verify`, `run`, and `status`.
- Required safety inputs: `--job-key`, `--source` or `--source-url`, `--expected-duration-seconds`, `--page-url`, `--block-id`; browser upload additionally requires an explicit disposable-target acknowledgement unless an operator intentionally supplies the real-target override.
- Recovery behavior: completed manifest stages are reused; a recorded task is verified rather than uploaded again; incomplete stages remain retryable; unsafe/ambiguous states fail closed.

- [x] Add CLI help and dry-run tests, including the real-target refusal and no-secret output assertions.
- [x] Run tests red.
- [x] Implement argument parsing, stage orchestration, owner-aware stale-lock cleanup, JSON/human summaries, and exit codes.
- [x] Run focused tests, `node ... --help`, and a non-mutating `status`/`prepare` dry run.
- [x] Update the design note with the proven 16 kHz mono AAC format, complete-source gate, native Transcript gate, and separate UI/API limits.

### Task 5: Verification and handoff evidence

**Files:**
- No production boundary changes outside the files above.
- Create only sanitized local evidence under `.tmp/` (ignored).

- [x] Run focused pipeline tests and the relevant worker typecheck without changing worker/parser code.
- [x] Run `graphify update .` once after the coherent implementation slice.
- [x] Inspect `git diff --name-only` and confirm unrelated opening changes are untouched.
- [x] Report exact commands/output, unresolved workspace authorization, and the fact that no real Meeting was modified.

### Task 6: Pre-live hardening and module boundaries

**Files:**
- Modify: `scripts/notion-meeting-pipeline.mjs`
- Split: `scripts/notion-meeting-pipeline/{cli-options,orchestrator,pipeline-operations}.mjs`
- Modify/split: `scripts/notion-meeting-pipeline/media.mjs` and focused media modules
- Modify/split: `scripts/notion-meeting-pipeline/notion-ui.mjs` and focused browser/upload/verification modules
- Modify: closest `*.test.mjs` files
- Modify: `notion-ai-meeting-audio-transcript-pipeline.md`

- [x] Add failing regressions for a container-safe ffmpeg temp suffix, exact prepared-audio profile, occupied/error Meeting states, atomic transcript metadata, and manifest-identity mismatch without state corruption.
- [x] Implement only the safety behavior required by those tests; persist upload intent before handing a file to the browser and keep retry fail-closed unless the disposable Meeting has been reset cleanly.
- [x] Split production modules before any changed JavaScript file exceeds 200 lines; retain facade exports so callers/tests remain stable.
- [x] Confirm recorded `enqueueTask` and `getTasks` shapes against sanitized captures, then run read-only CLI verification on the proven disposable full-lecture page with an isolated profile.
- [x] Update the operational note with the measured UI/API boundaries, complete 32 kbps artifact, CLI recovery model, API-plan/token blockers, and native Transcript hard gate.

## Verification record (2026-09-23)

- Focused pipeline: `npm test -- --project notion-pipeline` → 6 files, 65 tests passed after the final hardening changes.
- Repository checks: `npm run verify:ci`, `npm run lint`, `npm run typecheck`, `npm run build`, worker typecheck, unit project (203 files / 1,078 tests), and contract project (19 passed; 12 skipped; 1 todo) passed before the final standalone CLI hardening; the final CLI slice additionally passed focused ESLint, `node --check`, and `git diff --check`.
- CLI checks: `--help`, redacted `status`, and complete-source `--dry-run` passed; dry-run created no manifest and performed no browser/Notion mutation.
- Live disposable evidence: isolated profile, `prepare → upload --no-wait → upload resume/poll → verify`; final manifest `stage=verified`, task `success`, native Transcript accepted with 140 timestamps and last timestamp 5,779 seconds. The real Meeting remained read-only.
- `npm test` and `npm run test:integration` remain environment-blocked because `OPENING_TEST_DATABASE_URL` is unset; Vitest global setup fails before those projects can run. `docker` is also unavailable, so compose-backed integration/browser prerequisites were not started.
- Public API probing remains blocked by workspace authorization and the sanitized HTTP 401 `API token is invalid.` result; no claim is made about unverified API multipart behavior.
