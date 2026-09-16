# Ingestion and Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; red/green each task before integration.

**Goal:** Accept real mobile files, preserve originals and process them recoverably.

2026-09-14扩展：I01/I02仍是基础存储与文档解析任务；视频/录音理解已由[10-media-knowledge.md](10-media-knowledge.md)的V01列为M5必须项。下文audio unsupported仅表示V01启用前的诚实状态，不是取消转写需求。
**Architecture:** Direct private object upload plus PostgreSQL metadata; outbox dispatches bounded jobs to an actual BullMQ worker. Parsing is an isolated conversion process, not a second business backend.
**Tech Stack:** Existing AWS S3 SDK/BullMQ; Docling 2.126.0 candidate parser, Python 3.12 isolated runtime (PyPI MIT metadata checked; conversion behavior still needs tests).

## Global Constraints

Read master and interfaces.md. Source IDs, not arbitrary URLs, cross trust boundaries. No parser network/file access beyond its job directory and preinstalled model files. No external OCR/transcription silently enabled.

### I01: Signed upload and verified completion

**Owner:** PIPELINE. **Depends:** F03.
**Create:** `apps/web/src/features/opening/sources/source-service.ts`, `apps/web/src/features/opening/sources/upload-policy.ts`, `apps/web/src/features/opening/sources/upload-policy.test.ts`, `packages/database/src/storage/opening-s3.ts`, `apps/web/src/app/api/opening/sources/route.ts`, `apps/web/src/app/api/opening/sources/[id]/complete/route.ts`, `apps/web/src/app/api/opening/sources/[id]/download/route.ts`, `tests/integration/handler/opening-sources.test.ts`.
**Interfaces:** beginUpload, completeUpload, listSources, readSource in interfaces.md; `validateStoredUpload(expected:UploadInput, actual:{bytes:number;sha256:string;mime:string}): void`.

- [ ] Write failing policy test:
```ts
import { expect, it } from 'vitest';
import { validateStoredUpload } from './upload-policy';
it('rejects completion before matching the stored object', () => {
  const expected = {name:'a.pdf',mime:'application/pdf' as const,bytes:12,sha256:'a'.repeat(64)};
  expect(() => validateStoredUpload(expected,{bytes:11,mime:'application/pdf',sha256:'a'.repeat(64)})).toThrow();
});
```
- [ ] Run `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/sources/upload-policy.test.ts`; require red.
- [ ] Implement server-generated staging object keys and short-lived signed PUT/GET. Completion verifies object exists, size, permitted magic/MIME and server-verified checksum; do not trust Content-Type, client sha or multipart ETag as SHA-256. Stream hashing with limits; don't load 200MiB into web memory. Copy verified staging bytes into a distinct server-only immutable final key, using source-version/ETag preconditions to reject a changed upload; an unexpired PUT ticket must never overwrite finalized source bytes. Unfinished uploads/orphan staging objects expire; cleanup only own unreferenced objects with an audit record.
- [ ] Completion transaction switches uploaded state and writes one parse outbox item. Same completion replay returns original state. All downloads verify workspace before signing. GET headers prevent HTML execution and private caching leaks.
- [ ] Rerun unit and guarded handler tests: expired ticket, other user, interrupted upload, duplicate completion, over-limit file, MIME spoof, missing object. No real storage -> handler gate blocked, not marked pass. Commit this vertical slice only when original bytes can be retrieved.

### I02: Structured conversion and explicit fallback

**Owner:** PIPELINE. **Depends:** I01.
**Create:** `apps/worker/src/parsers/types.ts`, `apps/worker/src/parsers/docling-process.ts`, `apps/worker/src/parsers/docling-process.test.ts`, `apps/worker/src/jobs/parse-source.ts`, `apps/worker/src/jobs/parse-source.test.ts`, `services/parser/pyproject.toml`, `services/parser/opening_parser/__main__.py`, `services/parser/tests/test_conversion.py`, `services/parser/model-manifest.json`, `tests/fixtures/opening/README.md`.
**Interfaces:** `ParserInput={path:string;mime:string;maxPages:number}`; `ParsedPage={page:number;text:string;imagePath:string|null}`; `parseDocument(input:ParserInput, signal:AbortSignal): Promise<ParsedPage[]>`; `decodeParserOutput(text:string):ParsedPage[]`. Node passes only its own staging path; output normalized into SourceChunk.

- [ ] Write a fake-process unit test with a real injected runner signature `run(argv:string[],signal:AbortSignal):Promise<{exitCode:number;stdout:string}>`:
```ts
import { expect, it } from 'vitest';
import { decodeParserOutput } from './docling-process';
it('rejects malformed pages instead of declaring ready', () => {
  expect(() => decodeParserOutput('{"pages":[{"page":0,"text":"x"}]}')).toThrow();
  expect(decodeParserOutput('{"pages":[{"page":1,"text":"x","imagePath":null}]}')).toHaveLength(1);
});
```
- [ ] Run parser and parse-source unit files; require red. Generate labelled synthetic PDF/PPTX/image fixtures with expected page/slide text; fixture README records generation and hashes.
- [ ] Pin Docling 2.126.0 and lock transitive environment after compatibility spike. CLI emits bounded normalized JSON, preserving page/slide provenance from conversion; reject missing provenance rather than inventing page numbers. Disable runtime model downloads; model manifest records only actually downloaded revisions/checksums. Bound execution time, expanded ZIP bytes and output size; subprocess uses argv, never shell interpolation.
- [ ] Digital documents take text-first conversion; images remain available for vision with original-source citation when OCR unavailable. Audio remains uploaded with parseState unsupported until a separately tested transcription adapter is enabled. Unsupported scans/slides explicitly surface limitations while originals remain readable.
- [ ] Rerun `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/parsers/docling-process.test.ts apps/worker/src/jobs/parse-source.test.ts` and parser's isolated `python -m pytest services/parser/tests/test_conversion.py`. Real conversion, page association and resource limits must be observed before claiming PDF/PPT support. CPU/audio quality gate may remain blocked independently of original-file storage.

### I03: Outbox dispatch and real BullMQ runtime

**Owner:** PIPELINE. **Depends:** F03.
**Create:** `apps/worker/src/runtime/queue.ts`, `apps/worker/src/runtime/dispatch.ts`, `apps/worker/src/runtime/run-job.ts`, `apps/worker/src/runtime/run-job.test.ts`, `apps/worker/src/runtime/handlers.ts`, `tests/integration/opening-worker.test.ts`.
**Modify:** `apps/worker/src/index.ts`, `apps/worker/package.json`.
**Interfaces:** `JobHandler=(job:JobRecord,payload:unknown)=>Promise<unknown>`; `jobQueueId(workspaceId:string,jobId:string):string`; `dispatchPending():Promise<number>`; handlers finite map for parse/tutor/retest/remind, missing handler fails explicitly.

- [ ] Test deterministic queue IDs and pure transition guard `canClaimJob(status:JobRecord['status']):boolean`:
```ts
import { expect, it } from 'vitest';
import { canClaimJob } from './run-job';
it('does not run succeeded or cancelled jobs again', () => {
  expect(canClaimJob('succeeded')).toBe(false);
  expect(canClaimJob('cancelled')).toBe(false);
  expect(canClaimJob('queued')).toBe(true);
});
```
- [ ] Run runtime unit tests to see red, then guarded worker integration tests against test Redis/DB namespaces.
- [ ] Outbox poll locks rows, enqueues deterministic IDs, then records dispatch. DB CAS claims active job; Redis redelivery rechecks DB; final result writes transactionally once. Queue IDs use dash-safe formatting, not prohibited colon IDs. Configure bounded retries/backoff, per-kind concurrency, heartbeat and stale-job reconciliation.
- [ ] For crash after external call, mark outcome_unknown and retain request/usage metadata; no blind automatic recost. Worker checks source version/privacyEpoch before reading and before committing results; cancelled work must not reappear. Graceful shutdown stops claims and records unfinished jobs without deleting user files.
- [ ] Integration must kill/restart worker, duplicate enqueue, replay completion, cancel while running, lose Redis briefly and verify one business result. Log content-free status only. Commit with actual restart evidence; smoke function alone is not acceptance.
