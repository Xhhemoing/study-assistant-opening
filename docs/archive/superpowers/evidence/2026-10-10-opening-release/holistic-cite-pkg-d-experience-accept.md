# Cite Package D — Experience UI ACCEPT

**Date:** 2026-10-10 ~23:33 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ base tip `cf5d046` (working tree uncommitted)  
**Owner:** Integrator (Experience half Accept only)  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package D Experience UX  
**Implement evidence:** `docs/superpowers/evidence/2026-10-10-opening-release/holistic-cite-pkg-d-experience-implement.md`  
**Verdict:** **ACCEPT**

## Scope reviewed

Experience UI half only (chip → in-app viewer deep-link + page jump). AI / Domain / worker soft-resolve / page-guard / image-only halves are **out of slice** (dirty on tree; not required clean for this Accept).

## Plan checks vs tree

| Expectation | Result |
|---|---|
| Citation chip primary → `/opening/library?tab=materials&source=&version=&page=` | **PASS** — `sourceViewerHref` + `message-list` primary `href` |
| Readable labels (page/slide); download secondary | **PASS** — `citationChipLabel`; Download icon secondary `sourceDownloadHref` |
| Viewer / library open deep link and jump to page | **PASS** — `parseSourceViewerSearchParams` → `LibraryView` → `MaterialLibrary` → `InboxPanel.initialOpen` auto-opens; `SourceContent.initialPage` → `loadSourceContent(..., page)` query |
| Optional locator contracts (`page`/`startMs`/`slideLabel`) | **PASS** — `citationSchema` optional fields; UI consumes them |
| Stronger review: tests green **without** real wiring = REJECT | **PASS** — wiring present end-to-end, not href-only stubs |

## Diff vs `cf5d046` (Experience)

- `packages/contracts/src/opening/sources.ts` (+ contracts tests)
- `apps/web/.../inbox/source-viewer.tsx` (+ test): `sourceViewerHref`, `citationChipLabel`, `parseSourceViewerSearchParams`, page on download/copy
- `apps/web/.../inbox/source-content.tsx`: `initialPage`
- `apps/web/.../inbox/inbox-panel.tsx`: `initialOpen` deep-link open
- `apps/web/.../library/page.tsx` / `library-view.tsx` / `material-library.tsx`: pass viewer query → panel
- `apps/web/.../assistant/message-list.tsx` (+ test): primary viewer chip + secondary download; readable label
- `apps/web/.../assistant/assistant-view.tsx`: pass `sourceNames`

## Out of slice (AI dirty — do not block Experience Accept)

Uncommitted AI/Domain/worker Package D edits present on tree (not attributed to Experience):

- `packages/ai/src/opening/citations.ts` (+ test), `provider.ts`
- `packages/domain/src/opening/tutor-policy.ts` (+ test), `packages/domain/src/index.ts`
- `apps/worker/src/jobs/tutor-turn.ts` (+ test)
- `apps/web/.../tutor/ephemeral-service.ts`, `tutor-service.ts` (+ test)
- `packages/contracts/.../conversation-resume.test.ts` (AI-adjacent)

Separate AI Accept still required for soft-resolve / page-guard / image-only / locator populate.

## Gates re-run (Accept)

```bash
npx vitest run apps/web/src/features/opening/assistant/message-list.test.ts \
  apps/web/src/features/opening/inbox/source-viewer.test.ts --project unit
(cd apps/web && npx tsc -p tsconfig.json --noEmit)
```

**Results (2026-10-10 ~23:33 CST):**

| Gate | Result |
|---|---|
| vitest unit (message-list + source-viewer) | **23 passed** / 2 files |
| `apps/web` `tsc -p tsconfig.json --noEmit` | **PASS** |

## Blockers

None for Experience half. Manual browser PDF page-3 cite not driven this Accept (unit covers href/label/parse/open-original page; implementer noted same).

## Notes

- No commit / push / stash / reset performed.
- ACCEPT is Experience UI slice only; Package D overall remains incomplete until AI half Accept.
