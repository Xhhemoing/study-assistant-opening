# cite Package D — AI/contracts/domain implement (cite resolve + soft page + locators)

**Owner:** AIstudy AI  
**Date:** 2026-10-10 ~23:32 CST (Asia/Shanghai)  
**Branch tip baseline:** `feat/opening-release` @ `cf5d046` (Package C)  
**Status:** implemented — awaiting Integrator Accept  
**Push:** **未推** (no commit / no push / no stash / no reset)

## Scope (AI / contracts / domain half)

1. **`citationSchema` locators** (`packages/contracts/src/opening/sources.ts`): optional `page`, `startMs`, `slideLabel` on every citation object (Experience agreed notify contract; schema present in tree for chip deep-links).
2. **`resolveCitations`** (`packages/ai/src/opening/citations.ts`): populate locators from chunk when present; optional `sourceNames` humanize label; **`soft` default true** — unknown cited ids filtered, not thrown.
3. **Soft page guard** (`packages/domain/.../tutor-policy.ts`): `assertCitationsForPage` no longer fails empty cites; new `preferCitationsForPage` keeps on-page cites when any match.
4. **Durable tutor-turn**: soft-resolve + prefer page; empty cites + `currentPage` completes as general.
5. **Prompt tighten**: `makeTutorInstruction` cite suffix + provider `outputInstruction` prefer non-empty `citedChunkIds` when materials used.
6. **Image-only cite path**: `authorizedChunksFor` / ephemeral allow `imageObjectKey` + empty text; ephemeral throws existing `VISION_REQUIRED` Chinese message when no vision; worker VISION_REQUIRED unchanged.

## Files (this half)

| Path | Change |
|---|---|
| `packages/contracts/src/opening/sources.ts` | optional citation locators (+ resume/contracts tests) |
| `packages/ai/src/opening/citations.ts` (+test) | soft resolve, locators, sourceNames |
| `packages/ai/src/opening/provider.ts` | outputInstruction cite prefer |
| `packages/domain/src/opening/tutor-policy.ts` (+test) | soft assert + preferCitationsForPage + instruction |
| `packages/domain/src/index.ts` | export preferCitationsForPage |
| `apps/worker/src/jobs/tutor-turn.ts` (+test) | soft filter + prefer page; empty cites completes |
| `apps/web/.../tutor/tutor-service.ts` (+test) | authorize image-only chunks |
| `apps/web/.../tutor/ephemeral-service.ts` | image-only filter + vision gate + page default |
| this evidence | |

## Untouched (Experience UI)

`assistant-view*`, `message-list*`, `source-viewer*`, `upload-strip*` — **not edited by this Implementer** (parallel Experience WIP may exist in working tree; left alone).

## Tests

```bash
./node_modules/.bin/vitest run \
  packages/ai/src/opening/citations.test.ts \
  packages/domain/src/opening/tutor-policy.test.ts \
  packages/contracts/src/opening/contracts.test.ts \
  packages/contracts/src/opening/conversation-resume.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts \
  apps/web/src/features/opening/tutor/tutor-service.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  packages/ai/src/opening/provider.test.ts
```

**Result:** Test Files **8 passed**; Tests **142 passed** (~23:32 CST).

## Notify contract for Experience

`citations[].page | startMs | slideLabel` optional on every citation object returned from durable complete / ephemeral reply / resume history.

## Non-goals

No Experience deep-link UI, Pipeline OCR, GraphRAG, embeddings, push/commit.

## 未推

Working tree dirty with Package D AI/domain/contracts + unrelated Experience WIP; **no commit / no push / no stash / no reset**.
