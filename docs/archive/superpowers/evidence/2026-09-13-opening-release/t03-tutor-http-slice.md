# T03 saved conversations / tutor HTTP slice → verified (2026-09-13)

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Marked by aistudy-lead for **U03-blocking HTTP vertical** (tutor/conversations/sources), not the full T03 plan checklist.

## Delivered (verified this slice)

| Surface | Evidence |
|---|---|
| `GET/POST /api/opening/conversations` | route present |
| `GET …/conversations/[id]/resume` | continuity `buildConversationResume` |
| `GET …/conversations/[id]/turns` | route present |
| `POST /api/opening/turns` | `validatePageSelection`→422; `shouldCreateLearningSession` |
| `GET/POST /api/opening/sources` + staging/complete | materials `source-service` (single owner) |
| `tutor-service.ts` + opening runtime `requireOpeningScope` | L01 routes mounted |
| migration `0017_opening_conversations.sql` | present |
| U03 thin UI integration | staging→complete; page 422 UX; pending job hint |

## Commands / results (2026-09-13)

```
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/tutor \
  apps/web/src/features/opening/sources \
  apps/web/src/features/opening/client \
  packages/domain/src/opening/assistance.test.ts \
  packages/contracts/src/opening/contracts.test.ts
```

**Result:** 8 files / **49 passed**.

Related: full `apps/web/src/features/opening` unit → 9 files / 33 passed (chat-ui U03×T03).

## Explicitly NOT done (remain after this verified mark)

- `apps/worker/src/jobs/tutor-turn.ts` (+ tests) — real model worker
- `apps/web/src/app/api/opening/candidates/route.ts`
- `tests/integration/handler/opening-tutor.test.ts`
- Plan deps still `planned`: **T02**, **I03** (and upstream T01/F03)
- Job path: assistant turn stays **pending** until worker exists
- Page selection with `currentPage` requires authorized chunks (fail-closed 422) — no chunk table path yet

Follow-ups stay LOCAL-ONLY; do not treat this as “full 03-tutor.md T03 checkbox complete.”
