# ACCEPT：Holistic cite Package B — AI half (server course-pool fill)

**Date:** 2026-10-10 ~22:55 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `0031b85` (Package A + cite plan; working tree dirty for Data B + AI B + Experience B WIP)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-cite-pkg-b-ai-implement.md`  
**Data ACCEPT:** `holistic-cite-pkg-b-data-accept.md`  
**Plan:** `holistic-chat-cite-audit-p0-plan.md` § Package B (AI / server fill only)

---

## Verdict

**ACCEPT** AI half of cite Package **B**: saved `submitTurn` fills empty client `sourceIds` from `listReadySourceIdsForCourse` when `conversation.courseId` is set; explicit client ids outrank; empty pool stays `[]` with no hard 422; runtime wires the Data factory.

No product edits by this Accept turn, no commit/push. Experience UI and Data repo halves are **out of scope** for this slice (dirty tree may contain them; not reviewed here). Ephemeral skip OK per claim.

---

## Gates (re-run 2026-10-10 ~22:55 CST)

```bash
cd /workspace/study-assistant-opening
npx vitest run apps/web/src/features/opening/tutor/tutor-service.test.ts
# → Test Files  1 passed (1)
# → Tests       17 passed (17)

(cd apps/web && npx tsc -p tsconfig.json --noEmit)
# → exit 0
```

| Gate | Result |
|---|---|
| Vitest `tutor-service.test.ts` (17) | **Pass** |
| `apps/web` tsc -p tsconfig.json --noEmit | **Pass** (exit 0) |

---

## Spot-checks (claim acceptance hooks)

| Hook | Result |
|---|---|
| Empty client `sourceIds` + `conversation.courseId` → `listReadySourceIdsForCourse(scope, courseId)` → effective ids for auth / page selection / `appendSavedTurn` | **Pass** (`tutor-service.ts` submitTurn; test "fills ready course sourceIds…") |
| Explicit non-empty client `sourceIds` outrank pool (no call, no merge) | **Pass** (test "keeps explicit client sourceIds…") |
| `courseId: null` + empty → no pool call; append `[]` | **Pass** |
| Empty pool `[]` → append `[]`, no throw / no `COURSE_SOURCES_REQUIRED` 422 | **Pass** (resolves; no `COURSE_SOURCES_REQUIRED` in opening tutor paths) |
| Runtime wires `createOpeningCourseReadySourcesRepository(sql).listReadySourceIdsForCourse` | **Pass** (`runtime.ts` `getTutorService`) |
| Privacy + cap 32 left to Data (AI does not re-filter/re-limit) | **Pass** — AI only assigns pool result |
| Ephemeral skipped this slice | **Pass** — no ephemeral `courseId` / pool fill |
| No Experience UI / Data repo edits **in this AI slice** | **Pass** — AI-touched: `tutor-service.ts`, `tutor-service.test.ts`, `runtime.ts` (+ this claim evidence). `assistant-view*` dirty from Experience half ignored |
| Vitest 17 green (13 prior + 4 Package B) | **Pass** |
| 未推 | **Pass** — tip still `0031b85`; no commit/push by Integrator |

---

## Files in scope (AI half)

| Path | Role |
|---|---|
| `apps/web/src/features/opening/tutor/tutor-service.ts` | optional dep + effectiveSourceIds fill |
| `apps/web/src/features/opening/tutor/tutor-service.test.ts` | factory courseId/pool stub + 4 Package B tests |
| `apps/web/src/features/opening/runtime.ts` | wire Data factory into `getTutorService` |

## Explicitly not accepted here

- Experience: `assistant-view` courseId bind, picker default membership, upload auto-select
- Data: `opening-course-ready-sources` impl (already **ACCEPT** in `holistic-cite-pkg-b-data-accept.md`)
- Ephemeral courseId / pool fill
- commit / push

---

## Notes

- Data export `createOpeningCourseReadySourcesRepository` / `listReadySourceIdsForCourse` present in `@aistudy/database` `index.ts` (Data ACCEPT).
- Integrator did not commit or push.
