# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260804-002] correction

**Logged**: 2026-08-04T23:17:00+08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Luna delegation is available through OpenCodex injection, not the native subagent model parameter.

### Details
The native subagent model validator accepts only Sol/Terra labels, while OpenCodex injects the enabled `gpt-5.6-luna` runtime behind the compatible OCX agent type. Treating the native validation result as Luna unavailability caused an incorrect user-facing response.

### Suggested Action
Before rejecting a requested model, check `opencodex models live` and delegate through the matching OCX route when it reports the requested runtime as enabled.

### Metadata
- Source: user_feedback
- Related Files: docs/superpowers/plans/2026-08-04-task-15-selective-promotion-implementation.md
- Tags: subagent, opencodex, luna, model-routing

---

## [LRN-20260803-001] best_practice

**Logged**: 2026-08-03T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: docs

### Summary
PowerShell documentation checks must specify UTF-8 when matching Chinese content.

### Details
`Get-Content` without an explicit encoding decoded a UTF-8 Chinese brainstorm document incorrectly and produced a false report that required headings were missing. Re-running the same check with `Get-Content -Encoding UTF8` and `Select-String -Encoding UTF8` found every required section.

### Suggested Action
Use explicit `-Encoding UTF8` for PowerShell reads and searches that validate repository documents containing non-ASCII text.

### Metadata
- Source: error
- Related Files: docs/brainstorm/2026-08-03-self-directed-student-artifact-autopilot.md
- Tags: powershell, utf8, documentation, validation
- Pattern-Key: tooling.powershell_utf8_document_validation
- Recurrence-Count: 1
- First-Seen: 2026-08-03
- Last-Seen: 2026-08-03

---

## [LRN-20260804-001] correction

**Logged**: 2026-08-04T17:10:00+08:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Do not treat an HTTP 200 shell response as a usable app when the client-side entry redirect is still loading.

### Details
The root page renders a loading shell and waits for `/api/workspace/preferences` before routing. Missing environment configuration caused that API to throw before its error boundary, leaving the browser on "正在进入 AIstudy" indefinitely. User feedback correctly identified that the app was not actually usable.

### Suggested Action
Verify the browser-visible state after client-side redirects, inspect dependent API responses, and treat an unresolved loading state as a blocking defect.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/features/workspace/root-redirect.tsx, apps/web/src/app/api/workspace/preferences/route.ts
- Tags: nextjs, client-redirect, loading-state, verification

---

## [LRN-20260917-NOTION1] task_endpoint_boundary

**Logged**: 2026-09-17T00:00:00Z
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Notion Meeting Notes file transcription is queued through `enqueueTask` with event `transcribeAudio`; it is not initiated by the browser-visible `runInferenceTranscript` endpoint.

### Details
- The client upload path writes `pre_recorded_transcription`, changes state to `recorded_audio_transcribing`, and calls `enqueueTask` with audio URLs and a transcription block pointer.
- The task layer polls task output through task subscriptions / `getTasks`; a successful task can transition into server-side summarization.
- Therefore absence of `runInferenceTranscript` alone does not establish that upload transcription was never started.

### Suggested Action
Capture and classify `enqueueTask`, task status/output, record-map updates, and the eventual `transcription_state` before evaluating inference endpoints.

### Metadata
- Source: error
- Related Files: `.tmp/notion-transcription-bundles/a685aba3c3eebee0.js`, `.tmp/notion-transcription-bundles/fde44899f8c0be9e.js`
- Tags: notion, meeting-notes, transcription, queue

---

## [LRN-20260917-NOTION2] clean_upload_reached_native_transcript

**Logged**: 2026-09-17T00:00:00Z
**Priority**: critical
**Status**: pending
**Area**: frontend

### Summary
A clean disposable Meeting Notes upload of the spoken WAV successfully produced a native readable Transcript; the prior apparent pre-inference failure was a stale/previous lifecycle observation, not a universal WAV or browser limitation.

### Details
- Test block was reset only on the disposable page, then uploaded through Meeting Notes → Upload audio or video.
- Observed lifecycle: `recorded_audio_file_uploading` → `recorded_audio_transcribing` → `summarizing` → `idle`.
- `enqueueTask` returned HTTP 200 with a task ID; `getTasks` progressed from `in_progress` to `success`.
- Record-map updates created a transcript child and populated `transcription_transcript_id`; the Transcript tab contained: `0:00 This is a short transcription test. The answer is 42. A. A study audio pipeline.`
- Summary also completed in this run.
- The browser did not need `/api/v3/runInferenceTranscript`; uploaded-file transcription is driven by the `transcribeAudio` queued task.

### Suggested Action
Use the queued task and record-map state as the acceptance instrumentation. Preserve the native Transcript as proof, then move to the complete-source/audio-format and workspace authorization gates; do not infer failure from a missing `runInferenceTranscript` request.

### Metadata
- Source: error
- Related Files: `.tmp/notion-fresh-clean-upload-capture.out`, `.tmp/notion-fresh-transcript-panel-stable.out`, `.tmp/notion-transcription-bundles/a685aba3c3eebee0.js`
- Tags: notion, meeting-notes, transcript, enqueueTask, resolved
- See Also: LRN-20260917-NOTION1

---
