# V01 follow-up accept — media parse slice (keyframes / transcribe / correction CAS)

**Date:** 2026-10-09 ~17:51 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent re-accept of **PIPELINE** follow-up slice against `docs/superpowers/plans/opening-release/10-media-knowledge.md` § V01.  
**Prior accept:** `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-accept.md`  
**Verdict:** **ACCEPT** (agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**Real classroom footage:** **not run** (plan live accept path — human verify).  
**tasks.json:** **not edited**. **verified:** **not marked**.  
**Commit/push:** **not done**.  
**K01 knowledge invalidate:** **still deferred** (avoid fighting K01 owners).

## Claimed this round (vs prior gaps)

| Claim | Result | Notes |
|---|---|---|
| Keyframe ffmpeg extract → I02 `frames/` object keys + timed chunks | **PASS** | `extractKeyframes` + `mediaFrameObjectKey` → `opening/sources/{id}/v{n}/frames/{timestampMs}.png`; `parse-media` `putObject` + `replaceChunks` with `imageObjectKey`; `linkFrameChunkIds` for segment↔frame linking |
| `transcribe-adapter` / Python `process_media` (missing whisper → CONFIGURATION, no auto-download) | **PASS** | `createPythonTranscribeAdapter` maps exit 2 / `CONFIGURATION` / `blocked_not_configured`; `transcribe.py` uses `local_files_only=True`; worker `index.ts` wires adapter + `putObject` |
| Correction CAS bumps `opening_sources.version` (source side) | **PASS** | `applyCorrections`: `FOR UPDATE` + `expectedVersion` check; `version = n+1`; `opening_source_versions` insert; prior-version chunks kept; keyframe rows carried forward to new version |
| No new migration; 0050 already Integrator-OK | **PASS** | Still only `0050_opening_parse_media_job.sql` (job-kind CHECK); no 0051+ in this slice |
| Tests: vitest unit **25**; pytest media **10** | **PARTIAL vs claim / PASS actual** | Claim understated vitest; **actual 28** vitest + **10** pytest (see below) |
| Still missing: K01 invalidate; object-store v{n}→v{n+1} copy; API async `{jobId}` re-run | **CONFIRMED gaps** | Explicit TODOs in `media-segments-service.ts`; corrections POST is sync rewrite only — no job enqueue |

## Files reviewed (follow-up delta)

**Create / expand**  
- `apps/worker/src/parsers/media-process.ts` — `extractKeyframes`, `mediaFrameObjectKey`, `parseShowinfoTimestamps`  
- `apps/worker/src/parsers/transcribe-adapter.ts` (+ test) — Python `opening_parser.process_media` bridge  
- `services/parser/opening_parser/process_media.py` — CLI JSON (probe / transcribe / frames)  
- `apps/worker/src/jobs/parse-media.ts` — keyframe persist via `putObject` + timed image chunks  
- `apps/web/src/features/opening/media/media-segments-service.ts` — CAS version bump on correction  

**Modify / wiring**  
- `apps/worker/src/index.ts` — `createPythonTranscribeAdapter()` + S3 `putObject` into `createParseMediaHandler`  
- `services/parser/opening_parser/transcribe.py` — offline-only weights  
- `services/parser/tests/test_media.py` — 10 cases (was 7)  
- Prior V01 surface unchanged in role: segments GET/POST routes, media-segments validate, fixtures README, 0050  

## Plan criteria checklist (§ V01, this slice)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Timestamp reject outside duration | **PASS** | Unchanged; unit still green |
| 2 | FFmpeg/ffprobe argv; network ban; 512MiB/120min | **PASS** | Unchanged + keyframe argv still literal / no shell |
| 3 | Audio → faster-whisper; video keyframes capped; reuse I02 for frames | **PASS (wiring)** | Caps + I02 `frames/` keys + timed chunks; live whisper still optional/`CONFIGURATION` until offline weights |
| 4 | Python synthetic tests | **PASS** | **10** pytest |
| 5 | Correction → new source version + invalidate derived knowledge | **PARTIAL** | **Source version CAS done**; **K01 invalidate deferred**; **object binary copy v{n}→v{n+1} deferred** (Pipeline next) |
| 6 | Re-run unit + pytest; real classroom accept | **PARTIAL** | Tests re-run green; browser / real footage **not run** |

## Tests re-run (actual)

```text
# Vitest unit — follow-up media slice (claimed 25; actual 28)
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/parsers/media-segments.test.ts \
  apps/worker/src/parsers/media-process.test.ts \
  apps/worker/src/jobs/parse-media.test.ts \
  apps/web/src/features/opening/media/media-segments-service.test.ts \
  apps/worker/src/parsers/transcribe-adapter.test.ts
# → Test Files  5 passed (5)
# → Tests  28 passed (28)
# Breakdown: media-segments 3 + media-process 13 + parse-media 6
#            + segments-service 2 + transcribe-adapter 4 = 28

# Pytest media (claimed 10)
cd services/parser && .venv/bin/python -m pytest tests/test_media.py -v
# → 10 passed in 0.53s
```

## Known gaps (do not treat as verified)

1. **K01 knowledge invalidate still deferred** — correction bumps source version / replaces segment rows but does not mark derived knowledge `needs_check` or scoped rebuild (TODO in service; avoid K01 ownership fight).  
2. **Object-store v{n}→v{n+1} binary copy after correction** — DB version + chunk rows advance; media object under `finalKey(id, version)` not copied (TODO; Pipeline doing next). Frame object keys from prior version are re-referenced, not re-uploaded.  
3. **API async `{jobId}` re-run** — corrections POST is synchronous CAS rewrite; no enqueue of `parse-media` / rebuild job returning `{jobId}`.  
4. **CAS path not integration-tested in this unit set** — service unit covers contract + `linkFrameChunkIds` only; version bump reviewed in code, not SQL integration here.  
5. **Live faster-whisper / offline weights** — still optional; honest `CONFIGURATION` / `blocked_not_configured` (no auto-download).  
6. **Real classroom footage + browser** — not run; human verify path remains.

## Verdict rationale

Follow-up closes the prior accept’s main wiring gaps: keyframes land as I02 `frames/` object keys with retained timestamps and timed chunks; Python `process_media` + TS adapter report CONFIGURATION without downloading weights; correction CAS bumps `opening_sources.version` and inserts `opening_source_versions` while preserving prior chunk versions. Migration surface unchanged (0050 Integrator-OK). Claimed remaining gaps (K01 invalidate, object copy, async jobId) are confirmed still open and explicitly deferred. Tests: **28** vitest + **10** pytest green (claim said 25 vitest — record actual). **ACCEPT** agent-owned thin follow-up. **Not verified.**
