# Cite Package D — Experience UI implement (chip → in-app viewer)

**Date:** 2026-10-10 ~23:32 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` (tip baseline `cf5d046` or later; HEAD at start `cf5d046`)  
**Owner:** Experience  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package D (C11/C12/C14/C17/C7 — Experience half: chip / viewer)  
**Status:** IMPLEMENT (Experience half only) — **not committed / not pushed**

## Scope done (Experience)

1. **Contracts (optional locators only)**
   - `citationSchema` gained optional `page`, `startMs`, `slideLabel` for UI deep-links.
   - AI concurrently populates these in `packages/ai/.../citations.ts` (Experience did **not** edit AI populate / soft-filter / page guard).
   - Unit: `contracts.test.ts` accepts optional locators; omit keeps legacy shape.

2. **Citation chip → in-app viewer (primary), download secondary**
   - `sourceViewerHref(sourceId, version, { page?, startMs?, slideLabel? })` → `/opening/library?tab=materials&source=&version=&page=` (+ startMs/slide when set).
   - `message-list.tsx`: primary chip `href` uses viewer; secondary download icon uses `sourceDownloadHref` (optional `#page=`).
   - Readable label via `citationChipLabel`: source name + 第 N 页 / 幻灯片 / timestamp when present; else `citation.label`.
   - `assistant-view` passes `sourceNames` from loaded sources.

3. **Source viewer / open-original honors page**
   - `SourceViewer` accepts `page`; copy + open-original CTA show page; download href gets `#page=N` when set.
   - `SourceContent` accepts `initialPage` and loads that page.
   - Library route parses `source`/`version`/`page`/`startMs`/`slide` via `parseSourceViewerSearchParams` → `InboxPanel.initialOpen` auto-opens viewer.

## Out of scope (AI / Domain owns)

- `packages/ai` soft resolve / label humanize / populate locators (WIP on tree concurrently)
- `tutor-turn` soft-filter / page-guard soften
- Image-only / vision gate in ephemeral & tutor-service (WIP on tree; not Experience)
- Pipeline OCR

## Files touched (Experience)

| Path | Change |
|---|---|
| `packages/contracts/.../sources.ts` (+ contracts test) | Optional citation locators |
| `apps/web/.../inbox/source-viewer.tsx` (+ test) | `sourceViewerHref`, `citationChipLabel`, `parseSourceViewerSearchParams`; page on download/copy |
| `apps/web/.../inbox/source-content.tsx` | `initialPage` |
| `apps/web/.../inbox/inbox-panel.tsx` | `initialOpen` deep-link open |
| `apps/web/.../library/page.tsx` / `library-view.tsx` / `material-library.tsx` | Pass viewer query → panel |
| `apps/web/.../assistant/message-list.tsx` (+ test) | Primary viewer chip + secondary download; readable label |
| `apps/web/.../assistant/assistant-view.tsx` | Pass `sourceNames` |

## Gates

```bash
cd apps/web && npx tsc --noEmit
# from repo root:
npx vitest run apps/web/src/features/opening/assistant/message-list.test.ts \
  apps/web/src/features/opening/inbox/source-viewer.test.ts --project unit
```

**Results (2026-10-10 ~23:32 CST):**
- `apps/web` `npx tsc --noEmit` — PASS
- vitest unit (message-list + source-viewer) — **23 passed**
- contracts citation locator test — PASS (included in contracts suite)

## Diff summary (Experience)

- Chip primary → library materials viewer with `version` + `page` (and startMs/slide when useful).
- Download remains a secondary control; open-original can `#page=` for PDF plugins.
- Label prefers source name + page/slide/time when locators / names available.

## Blockers / notes

- **Schema:** Experience added optional locator fields; AI Package D WIP already consumes them in `citations.ts` (populate + soft resolve). Prefer AI schema going forward — no further Experience contracts edits planned.
- Concurrent dirty tree may include AI/Domain Package D edits (`citations.ts`, `provider.ts`, ephemeral/tutor image-only). Experience did not author those; do not attribute in Experience Accept.
- Manual: PDF page-3 cite → chip opens library viewer near that page (unit covers href/label; browser not driven this turn).
- NEVER commit / push / stash / reset (per task).
