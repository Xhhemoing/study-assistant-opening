# Paula UI loop converge — accept

**Date:** 2026-10-09 ~22:24 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` (working tree; UI changes **uncommitted**)  
**Scope:** Ad-hoc Paula Experience — hide/downgrade non-loop UI; sidebar collapse; core/more nav; Today shortcuts.  
**Verdict:** **ACCEPT** (with noted gaps).  
**tasks.json:** no matching task id (searched for sidebar / loop converge / command palette / EntryLinks / core nav). **verified not marked** — ad-hoc ask; evidence only.  
**Browser / e2e:** **not run**. Full suite: **not run**.

## Claim checklist

| # | Claim | Result | Notes |
|---|---|---|---|
| 1 | Hide/downgrade non-loop UI into 更多/高级 (budget, settings extras, command palette, EntryLinks) | **PASS** (nuance) | Budget → `<details data-advanced-section="daily-budget">`「更多 / 高级 · 每日 AI 额度」in `ai-settings-panel.tsx`. Settings extras (AI/provider + entry/guidance/preferences/autonomy/export/demo/diagnostics) under Settings `<details>`「更多 / 高级」; connections + timetable stay primary. Palette drops explore / new-exploration / new-goal / exams / marketplace; adds cards / connections. **EntryLinks** retargeted to loop routes (今日/卡片/待确认/课程/连接), not wrapped in a 更多/高级 disclosure — downgrade of *non-loop targets*, not literal collapse of the component. Palette still lists some legacy pages (`/learn`, `/library`, `/learn/goals`, `/learn/review`, `/search`, `/settings`, export). |
| 2 | Sidebar collapse via OpeningShell→AppShell + `localStorage` `aistudy.shell.sidebarCollapsed` | **PASS** | `SIDEBAR_COLLAPSED_STORAGE_KEY` exported from `packages/ui`; `AppShell` takes `sidebarCollapsed` / `onToggleSidebar`, `data-sidebar-collapsed`, toggle button. `OpeningShell` reads on mount (`readSidebarCollapsed`), writes on toggle via `localStorage`. |
| 3 | Core nav Today/Assistant/Courses; more Cards/Pending/Connections; Today shortcuts | **PASS** | `openingNavigation()`: core 今日/助理/课程; more 卡片/待确认/连接 (`group: "more"`; shell label「更多」). Today: `data-today-loop-links` + cards/review/connections/#action-digest + course knowledge link; `today-view` wraps ActionDigest in `id="action-digest"`. |

## Files spot-checked (UI/shell/settings/search/today only)

**Changed (this Experience; uncommitted at accept time)**

- `packages/ui/src/app-shell.tsx` / `app-shell.test.ts` / `index.ts`
- `apps/web/src/features/opening/shell/opening-shell.tsx`
- `apps/web/src/features/opening/shell/navigation.ts` / `navigation.test.ts`
- `apps/web/src/features/search/command-palette-model.ts` / `command-palette-model.test.ts` / `command-palette.test.ts`
- `apps/web/src/features/settings/settings-view.tsx`
- `apps/web/src/features/settings/ai-settings-panel.tsx`
- `apps/web/src/features/opening/design/ui.tsx` (`EntryLinks`)
- `apps/web/src/features/opening/planning/today-overview.tsx` / `today-overview.test.ts`
- `apps/web/src/features/opening/planning/today-view.tsx`

**Out of scope / not touched by this accept:** RP5 unit/database/ai catalog paths. Working tree also has unrelated dirty `q03-*.md` evidence edits and untracked `services/parser/opening_parser.egg-info/` — ignored for this verdict.

## Gates re-run (cited)

```text
npx vitest run --project unit \
  packages/ui/src/app-shell.test.ts \
  apps/web/src/features/opening/shell/navigation.test.ts \
  apps/web/src/features/search/command-palette-model.test.ts \
  apps/web/src/features/search/command-palette.test.ts \
  apps/web/src/features/opening/planning/today-overview.test.ts
→ Test Files  5 passed (5)
→ Tests       20 passed (20)
→ Duration    ~2.31s

npx tsc -p packages/ui/tsconfig.json --noEmit
→ exit 0

npx tsc -p apps/web/tsconfig.json --noEmit
→ exit 0
```

## Gaps

- **No e2e / browser** — collapse persistence, mobile bottom nav, and Settings/palette UX not visually verified.
- **No full vitest / CI suite** — only the five cited unit files + two `tsc` projects.
- **EntryLinks** = loop retarget, not a 更多/高级 disclosure (claim wording slightly overstates).
- **Command palette** demotes several non-loop entries but still surfaces legacy `/learn` / `/library` / goals / review / search / settings pages.
- **Uncommitted** UI diff at accept time — parent must land or discard; this accept does not commit product code.
- **No tasks.json id** — do not mark verified.

## Recommendation

**ACCEPT yes** for the stated UI-loop-converge Experience against cited unit/`tsc` gates and path spot-checks. Do **not** mark tasks.json. Gaps above are non-blocking for this ad-hoc accept unless PM requires e2e or stricter palette demotion.
