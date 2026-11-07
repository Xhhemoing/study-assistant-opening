# ACCEPT：Holistic cite Package B — Experience UI half

**Date:** 2026-10-10 ~22:56 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `0031b85` (Package A; working tree dirty for Experience B + Data/AI Package B WIP)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-cite-pkg-b-experience-implement.md`  
**Plan:** `holistic-chat-cite-audit-p0-plan.md` § Package B (C1/C3/C4/C5 Experience)

---

## Verdict

**ACCEPT** Experience UI half of cite Package **B**: `?courseId=` → createConversation / boundCourseId, membership-default picker with「显示工作区其他材料」and cap 32, upload saved ids auto-select into `selectedSourceIds`, client-side membership filter only.

No product edits by this Accept turn, no commit/push. Data (`opening-course-ready-sources*`, database index) and AI (`tutor-service*`, `runtime.ts`) halves of Package B are **out of scope** for this slice — present dirty in the tree; **not reviewed** here.

---

## Gates (re-run 2026-10-10 ~22:55 CST)

```bash
cd /workspace/study-assistant-opening
(cd apps/web && npx tsc -p tsconfig.json --noEmit)
# → exit 0

npx vitest run \
  apps/web/src/features/opening/assistant/course-source-selection.test.ts \
  apps/web/src/features/opening/assistant/source-page-controls.test.ts \
  apps/web/src/features/opening/assistant/assistant-view.test.ts
# → Test Files  3 passed (3)
# → Tests       43 passed (43)
```

| Gate | Result |
|---|---|
| `apps/web` `tsc -p tsconfig.json --noEmit` | **Pass** (exit 0) |
| Vitest Experience 3 files (43) | **Pass** |

---

## Spot-checks (claim acceptance hooks)

| Hook | Result |
|---|---|
| `?courseId=` → `parseAssistantCourseIdParam` → `AssistantView` `initialCourseId` | **Pass** (`page.tsx`) |
| `createConversation` courseId: `learningAttempt?.courseId ?? initialCourseId ?? null` | **Pass** (`assistant-view.tsx`) |
| Bound resolve: attempt → resume → query via `resolveAssistantCourseId` / `boundCourseId` | **Pass** |
| Picker defaults membership-ready when `membershipSourceIds` set; expand「显示工作区其他材料」 | **Pass** (`source-page-controls.tsx` + test) |
| Cap 32: `MAX_ASSISTANT_SOURCE_IDS` + disable at cap + status copy | **Pass** |
| Upload: `onUploaded(savedSourceIds?)` → `addSelectedSourceIds` into `selectedSourceIds` | **Pass** (`upload-strip.tsx` + `handleUploaded`) |
| Client-side membership via org client `read()`; no Experience database edits | **Pass** |
| Soft confirm gets `hasReadyCourseMaterials` from membership-ready filter | **Pass** |

---

## Files in scope (Experience half)

| Path | Role |
|---|---|
| `apps/web/src/app/(opening)/opening/assistant/page.tsx` | `?courseId=` → `initialCourseId` |
| `apps/web/src/features/opening/assistant/course-source-selection.ts` (+ test) | parse/resolve/cap/membership helpers |
| `apps/web/src/features/opening/assistant/source-page-controls.tsx` (+ test) | membership default + expand + cap |
| `apps/web/src/features/opening/assistant/upload-strip.tsx` | callback returns saved source ids |
| `apps/web/src/features/opening/assistant/assistant-view.tsx` (+ test) | bind courseId, load org, auto-select, soft-confirm flag |

## Explicitly not accepted here

- Data: `packages/database` `listReadySourceIdsForCourse` / `opening-course-ready-sources*` (separate Data Accept)
- AI: tutor-service / runtime server fill of empty `sourceIds`
- commit / push

---

## Notes

- Experience correctly uses client-side organization memberships until a web API exposes Data’s `listReadySourceIdsForCourse` (claim § Out of scope).
- `UploadStrip` may call `onUploaded` twice when `courseId` is set (once before attach, once after); `addSelectedSourceIds` dedupes — not a reject.
- Tip remains `0031b85`; Experience B is uncommitted (as claim stated). Integrator did not commit or push.
