# ACCEPT：Holistic cite Package A — Never silent-ungrounded (C2/C16/C19)

**Date:** 2026-10-10 ~22:50 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `a837bb8` (working tree dirty; **not** committed / **not** pushed)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-cite-pkg-a-implement.md` (READY_FOR_ACCEPT)  
**Plan AGREE:** `holistic-chat-cite-audit-p0-integrator-review.md`  
**Plan:** `holistic-chat-cite-audit-p0-plan.md` § Package A

---

## Verdict

**ACCEPT** Experience Package **A** (C2 + C16 + C19): ephemeral cite display parity via `resolveCitations`, general-material honesty badge, and soft confirm when course-bound with empty `sourceIds`.

No product edits by this Accept turn, no commit/push, `tasks.json` untouched. Package B/C/D out of scope (no membership pool, retrieval pick, or page deep-link work in the dirty tree).

---

## Gates (re-run 2026-10-10 ~22:49 CST)

```bash
cd /workspace/study-assistant-opening
(cd apps/web && npx tsc -p tsconfig.json --noEmit)  # exit 0

npx vitest run \
  apps/web/src/features/opening/assistant/assistant-view.test.ts \
  apps/web/src/features/opening/assistant/message-list.test.ts \
  apps/web/src/features/opening/assistant/message-model.test.ts \
  apps/web/src/features/opening/assistant/composer.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-abort.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-privacy.test.ts \
  apps/web/src/features/opening/client/api.test.ts \
  packages/contracts/src/opening/contracts.test.ts \
  packages/contracts/src/opening/snippets.test.ts
# → Test Files  10 passed (10)
# → Tests       158 passed (158)
```

| Gate | Result |
|---|---|
| `apps/web` tsc -p tsconfig.json --noEmit | **Pass** (exit 0) |
| Unit (10 files / 158 tests) | **Pass** |

---

## Spot-checks

### C16 — Ephemeral cite display parity

| Check | Result |
|---|---|
| `ephemeralTurnResponseSchema` adds `citations: Citation[].default([])` | Pass (`packages/contracts/.../tutor.ts`) |
| Service soft-filters `citedChunkIds` to authorized context, then `resolveCitations` → `citations` | Pass (`ephemeral-service.ts`; unknown id filtered; no fabricate) |
| `appendEphemeralResponseIfActive` maps `output.citations` + labels; **stops** hardcoding assistant `citations: []` | Pass (`assistant-view.tsx`) |
| Unit: valid cite ids → non-empty `citations`; empty model cites → `[]` (no chips from sourceIds alone) | Pass (`ephemeral-service.test.ts`, `assistant-view.test.ts`) |

### C19 — General badge when materials intended but uncited

| Check | Result |
|---|---|
| `hadMaterialContext` on `ChatMessageView` + `showsGeneralMaterialBadge()` | Pass (`message-model.ts`) |
| MessageList: empty cites + `hadMaterialContext` →「一般说明（未引用材料）」; cites present keep「出处：」 | Pass (`message-list.tsx` + tests) |
| Ephemeral assistant sets `hadMaterialContext` from turn `sourceIds.length > 0` | Pass (`appendEphemeralResponseIfActive` + handleSubmit passes `selectedSourceIds`) |
| Free / no-material turns do not show false「出处」or general badge | Pass (message-list + message-model tests) |

### C2 — Soft confirm empty selection in course context

| Check | Result |
|---|---|
| `shouldConfirmEmptyCourseSources` when `courseId` set + empty `sourceIds` | Pass |
| Free chat (`courseId` null/undefined) skips confirm | Pass |
| Cancel path opens 参考资料 (`setContextOpen(true)`) | Pass (`handleSubmit`) |
| Copy includes「当前课程有材料，尚未选入本轮」+ continue vs open materials | Pass (`EMPTY_COURSE_SOURCES_CONFIRM`) |
| `hasReadyCourseMaterials` helper reserved (Package B); not wired to membership this turn | Pass (intentional; claim notes) |

### T02 / rejected alternatives

| Check | Result |
|---|---|
| Do **not** force ≥1 citation every turn | Pass (empty cites allowed; labeled when material context) |
| No fabricated chips from `sourceIds` alone | Pass (service + UI tests) |
| Ephemeral privacy mode retained | Pass (no hide-privacy change) |

### Scope / hygiene

| Check | Result |
|---|---|
| Dirty files = Package A claim list only (10 product files) | Pass |
| No Package B/C/D product edits (`listReadySourceIdsForCourse`, pick-sources, page deep-link, etc.) | Pass |
| Tip still `a837bb8`; no commit/push | Pass |
| `docs/superpowers/plans/opening-release/tasks.json` untouched | Pass |

---

## Non-blocking note (claim)

Durable `TurnRecord` / resume mapping still lacks per-turn `sourceIds` (or equivalent) in the API contract, so **saved** turns do not set `hadMaterialContext` after reload. Ephemeral + MessageList unit cover C19 for Package A; durable badge needs a turn field or a later package. **Non-blocking** for this Accept (explicit in claim).

---

## Ready for next

- Integrator **ACCEPT** Package A recorded.
- Per AGREE sequencing: next is Experience + Data + AI Package **B** (course membership pool + upload auto-select + courseId bind).
- Coordinate hermes redeploy of tip `a837bb8` before any push of this client/contract delta; **do not push** until PM authorizes.
