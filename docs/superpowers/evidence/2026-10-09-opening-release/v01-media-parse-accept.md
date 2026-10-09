# V01 accept — Audio transcription and video/audio-slide alignment (media parse slice)

**Date:** 2026-10-09 ~17:47 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **PIPELINE** thin slice against `docs/superpowers/plans/opening-release/10-media-knowledge.md` § V01.  
**Verdict:** **ACCEPT** (agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**Real classroom footage:** **not run** (plan live accept path — human verify).  
**tasks.json:** **not edited**. **verified:** **not marked**.  
**Commit/push:** **not done**.

## Migration 0050 (Integrator-approved)

| Item | Result |
|---|---|
| File | `packages/database/src/migrations/0050_opening_parse_media_job.sql` |
| Content | **Job-kind CHECK only** — drops/re-adds `opening_jobs_kind_check` to include `'parse-media'` alongside existing kinds (`parse`,`tutor`,`retest`,`remind`,`build-course-knowledge`) |
| Conflict with 0049 | **None** — `0049_opening_skill_evidence.sql` is K02 (`CREATE TABLE opening_skill_evidence` only; no job-kind change) |
| Prior job-kind owner | `0048_opening_knowledge.sql` introduced `build-course-knowledge`; 0050 extends that CHECK |
| Filename | **Keep `0050_opening_parse_media_job.sql`** — Integrator confirms **0050 OK** |
| Rollback | Commented restore of CHECK without `parse-media` |

Contracts/`jobKindSchema`, worker `handlers.ts` / `queue.ts` / `index.ts` also register `"parse-media"`.

## Files reviewed

**Create (plan + claimed)**  
- `apps/worker/src/parsers/media-process.ts` (+ `media-process.test.ts`) — FFmpeg/ffprobe argv (no shell), network-protocol ban, 512MiB/120min limits, keyframe caps 2/min & 120/file  
- `apps/worker/src/parsers/media-segments.ts` (+ `media-segments.test.ts`) — `validateMediaSegments` duration/order checks  
- `apps/worker/src/jobs/parse-media.ts` (+ `parse-media.test.ts`) — server-loaded source/version; stream-to-temp with declared-byte cap; optional `transcribe` adapter; `claimsVisualUnderstanding: false`  
- `services/parser/opening_parser/media.py`, `transcribe.py`, `tests/test_media.py`  
- `tests/fixtures/opening/media/README.md`  
- `apps/web/src/app/api/opening/sources/[id]/segments/route.ts` — GET  
- `apps/web/src/app/api/opening/sources/[id]/segments/corrections/route.ts` — POST  
- `apps/web/src/features/opening/media/media-segments-service.ts` (+ test)  
- `packages/database/src/migrations/0050_opening_parse_media_job.sql`

**Modify**  
- `services/parser/pyproject.toml` — optional `media = ["faster-whisper>=1.1.0"]`; `dev` pytest  
- `services/parser/model-manifest.json` — media.transcription optional / blocked until offline weights  
- `packages/contracts/src/opening/media.ts`, `jobs.ts`  
- `apps/worker/src/runtime/handlers.ts`, `queue.ts`, `index.ts` — `"parse-media"` slot wired to `createParseMediaHandler`

## Plan criteria checklist

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Timestamp reject outside duration (`validateMediaSegments`) | **PASS** | Unit: outside duration, reversed/zero-length, defensive copy |
| 2 | FFmpeg/ffprobe argv, no shell interpolation; ban network protocols; container/duration/size/audio validation; 512MiB/120min | **PASS** | TS + Python builders; worker does not load whole media into Web memory |
| 3 | Audio → faster-whisper; video keyframes capped; reuse I02 for frames | **PARTIAL** | Caps + argv present; **faster-whisper not installed**; **keyframe→I02 not wired**; audio-only never claims visual understanding |
| 4 | Python synthetic tests (audio present/missing, bad container, limits, cancel/config) | **PASS** | **7** pytest; ffmpeg present on box |
| 5 | Correction → new source version + invalidate derived knowledge | **DEFERRED** | POST corrections rewrite timed chunks at **current** version with `quality: checked`; explicit thin-slice comment in service |
| 6 | Re-run unit + pytest; authorized real classroom accept path | **PARTIAL** | Tests re-run green; **real footage not run**; browser not run |

## Tests re-run (actual)

```text
# Vitest unit — media slice + run-job handler key (= 27 claimed)
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/parsers/media-segments.test.ts \
  apps/worker/src/parsers/media-process.test.ts \
  apps/worker/src/jobs/parse-media.test.ts \
  apps/web/src/features/opening/media/media-segments-service.test.ts \
  apps/worker/src/runtime/run-job.test.ts
# → Test Files  5 passed (5)
# → Tests  27 passed (27)
# Breakdown: media-segments 3 + media-process 10 + parse-media 4 + segments-service 1 + run-job 9 = 27

# Pytest media
cd services/parser && .venv/bin/python -m pytest tests/test_media.py -v
# → 7 passed in 0.60s
```

## Known gaps (do not treat as verified)

1. **faster-whisper not installed** — optional `[media]` extra; live transcription returns `blocked_not_configured` / `CONFIGURATION` until offline weights configured; no auto-download.  
2. **Keyframe → I02 not wired** — scene argv + frame caps exist; frames are not yet attached via I02 layout/image path with retained timestamps.  
3. **Correction version / knowledge invalidate deferred** — same `source.version` chunk replace; no new source version and no derived-node invalidation in this slice.  
4. **Real classroom footage not run** — synthetic lavfi fixtures only; plan path “转写定位→播放原片段→关键帧/课件引用→提问” is human verify.  
5. **Browser not run** — no UI playback/accept.

## Verdict rationale

Thin slice delivers: argv-safe FFmpeg bridge, limits/caps, `parse-media` job + handler registration, Python media/transcribe skeleton with honest CONFIGURATION when whisper missing, GET segments / POST corrections contracts, fixture README, and **0050 job-kind-only migration** with Integrator OK and no 0049 conflict. Documented gaps are explicit and match claim; they do not overturn agent accept of the implemented boundary. **Not verified.** Live transcription, I02 keyframes, correction versioning, and classroom accept remain follow-ups.
