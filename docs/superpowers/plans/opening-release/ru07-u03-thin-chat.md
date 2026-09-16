# RU-07 / U03 thin chat work order

**Goal:** Earliest honest M1 chat shell: upload → select materials → ask → citations → refresh restore.
**Owner:** chat-ui (EXPERIENCE thin slice). **Branch:** `feat/opening-release`.

## In scope
- Minimal `composer` / `message-list` / `assistant-view` under `apps/web/src/features/opening/assistant`
- Typed client for interfaces.md opening routes (`apps/web/src/features/opening/client/api.ts`)
- Consume continuity `page-selection` + `conversation-continuity` (do not fork DTOs)
- Wire materials list/upload client paths (begin → PUT → complete → list); only `uploadState=uploaded` selectable
- Early-slice note on U03 in `07-experience.md`

## Out of scope
- Global nav / opening-shell (U01)
- Sensitive memory panel / privacy-gated memory
- Plan/today views (P03), learning evidence ownership
- Native CSS / inline styles

## Depends
| Piece | Status |
|---|---|
| continuity page-selection + conversation-continuity | DONE (26 tests) |
| materials upload-policy + opening-sources complete/list | DONE (repo + policy) |
| T03 live tutor HTTP for real Q&A | PENDING — UI client ready; live ask waits T03 |
| Formal Q03→Q01→Q02 | Unchanged; thin UI does not waive |

## AC map
- AC03/AC07: discover + resume via server `ConversationResume.boundedHistory` (no client-invented history)
- AC04: optional `currentPage`/`chunkId` through `validatePageSelection` (file ≠ page)
- AC11: keep composer draft on send error
- RU-07: thin UI required if M1 claims user-usable

## Verify
```
npx vitest run apps/web/src/features/opening --project unit
```

## Handoff
Live ask/citations need T03 routes. Upload HTTP routes may still land; client already targets interfaces.md paths.
