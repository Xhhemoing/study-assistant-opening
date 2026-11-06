# ACCEPT：Holistic cite Package B — Data half (`listReadySourceIdsForCourse`)

**Date:** 2026-10-10 ~22:54 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `0031b85` (Package A + cite plan; working tree dirty for Data B + other Package B WIP)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-cite-pkg-b-data-implement.md`  
**Plan:** `holistic-chat-cite-audit-p0-plan.md` § Package B (Data / membership read only)

---

## Verdict

**ACCEPT** Data half of cite Package **B**: course-scoped ready source id pool via `listReadySourceIdsForCourse`, factory, and `READY_COURSE_SOURCE_IDS_CAP = 32`.

No product edits by this Accept turn, no commit/push. Experience UI and AI `tutor-service` halves of Package B are **out of scope** for this slice (dirty tree may contain them; not reviewed here).

---

## Gates (re-run 2026-10-10 ~22:54 CST)

```bash
cd /workspace/study-assistant-opening
npx vitest run packages/database/src/repositories/opening-course-ready-sources.test.ts
# → Test Files  1 passed (1)
# → Tests       7 passed (7)

(cd packages/database && npx tsc -p tsconfig.json --noEmit)
# → exit 0
```

| Gate | Result |
|---|---|
| Vitest `opening-course-ready-sources.test.ts` (7) | **Pass** |
| `packages/database` tsc -p tsconfig.json --noEmit | **Pass** (exit 0) |

---

## Spot-checks (claim acceptance hooks)

| Hook | Result |
|---|---|
| Export `@aistudy/database`: `listReadySourceIdsForCourse`, `createOpeningCourseReadySourcesRepository`, `READY_COURSE_SOURCE_IDS_CAP` (+ type `OpeningCourseReadySourcesRepository`) | **Pass** (`packages/database/src/index.ts`) |
| SQL: membership `asset_type='source'`, `upload_state='uploaded'`, `parse_state='ready'` | **Pass** |
| SQL: `NOT EXISTS` on `opening_privacy_exclusions` (workspace + source_id) | **Pass** |
| Cap: `READY_COURSE_SOURCE_IDS_CAP = 32` + `LIMIT ${cap}` | **Pass** |
| Order: `m.sort_order ASC, m.created_at ASC, s.id ASC` | **Pass** |
| Course ownership: workspace owner + `archived_at IS NULL` → else `OpeningKnowledgeError` `NOT_FOUND` | **Pass** |
| Factory wires `(scope, courseId)` for deps injection | **Pass** (test + impl) |
| No UI / tutor-service edits **in this Data slice** | **Pass** — Data B files only: `opening-course-ready-sources.ts` / `.test.ts` + `index.ts` exports. Experience/AI dirty paths ignored for this Accept. |

---

## Files in scope (Data half)

| Path | Role |
|---|---|
| `packages/database/src/repositories/opening-course-ready-sources.ts` | new — list + factory + cap |
| `packages/database/src/repositories/opening-course-ready-sources.test.ts` | new — 7 unit tests |
| `packages/database/src/index.ts` | export list + factory + cap + type |

## Explicitly not accepted here

- Experience: `assistant-view` courseId bind, picker default membership, upload auto-select
- AI: tutor/ephemeral server fill of empty `sourceIds`
- commit / push

---

## Notes

- Plan §B listed path as `opening-material-organization.ts` or thin helper; implementer chose dedicated `opening-course-ready-sources.ts` — acceptable thin repository, matches claim.
- Tip remains `0031b85`; Data B is uncommitted (as claim stated). Integrator did not commit or push.
