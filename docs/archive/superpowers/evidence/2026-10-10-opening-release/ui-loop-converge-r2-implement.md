# UI 闭环收敛 R2 — IMPLEMENT（去干扰）

**Date:** 2026-10-10 ~11:43 CST (Asia/Shanghai)  
**Branch tip (box):** `697d1d6` (working tree dirty — no commit)  
**Owner:** Experience  
**Status:** IMPLEMENT done — ready for Integrator Accept  
**Auth:** PM authorized per Integrator-AGREE list + Paula/PM §C decisions  
**Non-goals honored:** no commit / no push / no verified / no hermes / no Q03/Docker / backend routes kept

## What changed (file list)

| File | Change |
|---|---|
| `apps/web/src/features/search/command-palette-model.ts` | Removed palette entries: `new-note`, `learn`, `library`, `goals`, `review` (`/learn/review`), `export`. Kept loop + `search` + settings/advanced. |
| `apps/web/src/features/search/command-palette-model.test.ts` | Assert removed legacy ids; keep loop + search; filter query updated off `export`. |
| `apps/web/src/features/search/command-palette.test.ts` | Assert `command-option-new-note` absent. |
| `apps/web/src/features/opening/shell/opening-shell.tsx` | Removed Topbar「写笔记」→ `/library/new` and unused `PenLine` import. Kept cards/review icons + focus. |
| `apps/web/src/features/opening/planning/today-overview.tsx` | Removed「写笔记」link; kept course + loop shortcuts (cards/review/connections/#action-digest/course knowledge). |
| `apps/web/src/features/opening/planning/today-overview.test.ts` | Assert `/library/new` absent; loop links still present. |
| `apps/web/src/features/settings/settings-view.tsx` | Removed embedded `DingTalkConnectionsPanel`; `#connections` keeps short copy +「打开连接设置」→ `/opening/settings/connections`. Planning (Semester + Timetable) KEPT on main. |
| `apps/web/src/features/settings/settings-view.nav.test.ts` | Assert no dingtalk embed; connections short-link; semester/timetable present; advanced folds markers. |
| `apps/web/src/features/settings/advanced-settings-view.tsx` | AI + provider panels stay top/always visible. Collapsed `<details>` groups: 默认入口与探索相关 / 导出与备份 / 危险操作 / 开发者. Softened free-explore copy（备选，非推荐）. Export link stays inside advanced only. |
| `apps/web/src/features/opening/assistant/ai-readiness.tsx` | Soft vision tip omitted by default (`showVisionHint` default `false`). Hard blockers unchanged; vision never hard-blocks. |
| `apps/web/src/features/opening/assistant/ai-readiness.test.ts` | Reaffirm vision stays soft. |

### Skipped (optional / risky)

| Item | Why |
|---|---|
| `packages/ui/src/workspace-navigation.tsx` Explore cleanup | Optional; Opening shell already uses custom nav. Changing shared `@aistudy/ui` types/`getWorkspaceEntry` risks other surfaces/tests. Left untouched; Opening does not expose Explore via shell nav. |

## Kept loop entries (hard KEEP verified)

- Sidebar: `/opening/today`, `/opening/assistant`, `/opening/courses`, `/opening/cards`, `/opening/review`, `/opening/settings/connections`
- Today: course link + cards / review / connections / `#action-digest` / course knowledge shortcuts
- Palette: today, assistant, courses, cards, opening-review, connections, search, settings, settings-advanced
- Topbar: cards + review icons, focus timer/mode (via shell); settings gear via AppShell
- Main settings: connections short-link, planning (semester+timetable), learning preferences, AI daily-budget short link → `/settings/advanced#daily-budget`
- Advanced: AI panel + `#daily-budget` discoverable at top; export link only here
- AiReadiness HARD items unchanged; vision soft tip not prominent by default

## Commands run

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

No browser e2e run (not required; local DB not assumed).

## Git status / diffstat (no commit)

**HEAD:** `697d1d6`  
**Working tree:** dirty (R2 edits uncommitted)

R2-scoped diffstat:

```text
 apps/web/src/features/opening/assistant/ai-readiness.test.ts         |  10 ++
 apps/web/src/features/opening/assistant/ai-readiness.tsx             |  18 ++-
 apps/web/src/features/opening/planning/today-overview.test.ts        |   6 +-
 apps/web/src/features/opening/planning/today-overview.tsx            |   1 -
 apps/web/src/features/opening/shell/opening-shell.tsx                |   3 +-
 apps/web/src/features/search/command-palette-model.test.ts           |  16 +-
 apps/web/src/features/search/command-palette-model.ts                |   6 -
 apps/web/src/features/search/command-palette.test.ts                 |   2 +-
 apps/web/src/features/settings/advanced-settings-view.tsx            | 164 ++++++++++++---------
 apps/web/src/features/settings/settings-view.nav.test.ts             |  17 ++-
 apps/web/src/features/settings/settings-view.tsx                     |   6 +-
 11 files changed, 154 insertions(+), 95 deletions(-)
```

**Note:** Shared box also had unrelated dirty paths at implement time (e.g. `.env.example`, `apps/worker` tutor-model, `packages/ai` catalog-merge, prior untracked evidence). Those are **out of scope** for R2; not reverted.

## Ready for Integrator

- Code matches Integrator-AGREE §B + Paula/PM §C decisions (DingTalk short-link only; planning stays main; advanced deeper fold; vision tip weakened not hard-blocked; search KEPT).
- Unit + tsc green.
- **No push; no verified; no hermes.**
