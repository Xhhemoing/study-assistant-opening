# UI 闭环收敛 R2 — ACCEPT（去干扰 IMPLEMENT）

**Date:** 2026-10-10 ~11:45 CST (Asia/Shanghai)  
**Reviewer:** INTEGRATOR  
**Branch tip (box):** `697d1d6` (working tree dirty — **no commit / no push**)  
**Source claim:** [`ui-loop-converge-r2-implement.md`](./ui-loop-converge-r2-implement.md)  
**Reviewed against:** [`ui-loop-converge-r2-understand.md`](./ui-loop-converge-r2-understand.md) + [`ui-loop-converge-r2-integrator-review.md`](./ui-loop-converge-r2-integrator-review.md) hard-retain  
**Verdict:** **ACCEPT**

## Gates re-run (this Accept)

```text
npx vitest run \
  apps/web/src/features/search/command-palette-model.test.ts \
  apps/web/src/features/search/command-palette.test.ts \
  apps/web/src/features/settings/settings-view.nav.test.ts \
  apps/web/src/features/opening/assistant/ai-readiness.test.ts \
  apps/web/src/features/opening/planning/today-overview.test.ts
→ PASS  Test Files 5 passed (5) / Tests 21 passed (21)

cd apps/web && npx tsc -p tsconfig.json --noEmit
→ PASS (exit 0)
```

## Hard-retain check (Today / 计划 / Tutor / 练习·复测 / 卡片 / 连接材料)

| Required | Intact? | Evidence |
|---|---|---|
| Today | Yes | Sidebar `/opening/today`; palette `today`; Today page body unchanged aside from removing「写笔记」 |
| 计划 | Yes | Today loop `#action-digest` + course resume; main settings `#planning` still mounts `SemesterSettingsForm` + `TimetableImport` |
| Tutor | Yes | Sidebar `/opening/assistant`; palette `assistant`; AiReadiness **hard** blockers unchanged (`isHardBlocker` still excludes only soft vision/reconcile) |
| 练习·复测 | Yes | Unchanged course practice/retest surfaces (`course-view` `#course-practice`, retest flows); R2 did not touch them |
| 卡片 | Yes | Sidebar `/opening/cards`; Today shortcut; Topbar icon; palette `cards` |
| 连接材料 | Yes | Sidebar `/opening/settings/connections`; Today「连接」; palette `connections`; main settings short-link「打开连接设置」 |

Skipped optional `@aistudy/ui` Explore cleanup as claimed — Opening shell nav already custom; no impact on hard-retain.

## Claimed removals / folds verified

- Palette: removed `new-note` / `learn` / `library` / `goals` / `review` (`/learn/review`) / `export`; kept closed-loop + `search` + settings/advanced.
- Shell Topbar + Today:「写笔记」→ `/library/new` removed; cards/review icons + Today loop shortcuts kept.
- Main settings: `DingTalkConnectionsPanel` embed removed; short link → `/opening/settings/connections`; schedule (semester + timetable) kept on main; AI daily-budget short links kept.
- Advanced: `AiSettingsPanel` + `ProviderSettingsPanel` remain top/always visible; default-entry/explore, export, danger, developer wrapped in collapsed `<details>` (`data-advanced-fold`).
- Vision soft tip: `showVisionHint` defaults `false`; hard blocks unchanged; vision never hard-blocks.

## R2 dirty files (for later joint push with AI default-model slice)

Do **not** commit/push from this Accept. Integrator coordinates joint deploy with AI glm-5.3 / default-model work.

**R2-scoped (Experience UI denoise):**

```text
apps/web/src/features/opening/assistant/ai-readiness.test.ts
apps/web/src/features/opening/assistant/ai-readiness.tsx
apps/web/src/features/opening/planning/today-overview.test.ts
apps/web/src/features/opening/planning/today-overview.tsx
apps/web/src/features/opening/shell/opening-shell.tsx
apps/web/src/features/search/command-palette-model.test.ts
apps/web/src/features/search/command-palette-model.ts
apps/web/src/features/search/command-palette.test.ts
apps/web/src/features/settings/advanced-settings-view.tsx
apps/web/src/features/settings/settings-view.nav.test.ts
apps/web/src/features/settings/settings-view.tsx
docs/superpowers/evidence/2026-10-10-opening-release/ui-loop-converge-r2-implement.md
docs/superpowers/evidence/2026-10-10-opening-release/ui-loop-converge-r2-understand.md  (status line touch)
docs/superpowers/evidence/2026-10-10-opening-release/ui-loop-converge-r2-accept.md  (this file; untracked until joint add)
```

## AI glm-5.3 / default-model dirt mixed in same working tree

**Yes — mixed.** Unrelated to R2; leave in place for joint deploy. Includes:

```text
.env.example
apps/web/src/app/api/opening/ai-settings/route.test.ts
apps/web/src/features/settings/ai-settings-service.ts
apps/worker/src/runtime/tutor-model.ts
apps/worker/src/runtime/tutor-model.test.ts
packages/ai/src/index.ts
packages/ai/src/opening/catalog-merge.ts
packages/ai/src/opening/catalog-merge.test.ts
packages/contracts/src/opening/ai-settings.ts
packages/contracts/src/opening/ai-settings.test.ts
docs/operations/hermes-deployment.md
docs/operations/opening-model-routing.md
```

Also untracked (out of R2 scope): `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`, `docs/superpowers/evidence/2026-10-10-opening-release/unify-default-lant-glm-daily-cap-schema.md`.

Note: `ai-settings-service.ts` and related AI files continued to change on the shared box during this Accept pass; treat all non-R2 dirt as AI default-model / Lant-glm slice for joint push.

## Non-goals honored

- No commit / no push  
- Not marked verified  
- No tasks.json status flips  
- No hermes / Q03 / Docker  
