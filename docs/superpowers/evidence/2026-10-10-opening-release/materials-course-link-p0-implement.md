# Materials + course link P0 — IMPLEMENT

**Date:** 2026-10-10 ~22:18 CST  
**Owner:** Experience  
**Branch:** `feat/opening-release`  
**Status:** IMPLEMENTED — not accepted, not pushed, not committed  
**Plan:** `materials-course-link-p0-plan.md`  
**Integrator review:** AGREE (`materials-course-link-p0-integrator-review.md`)

## What shipped

### P0-1 Restore materials entry
- `apps/web/src/features/opening/shell/navigation.ts` — added more-group item `{ href: "/opening/library?tab=materials", label: "材料", icon: "library", group: "more" }`; `navigationIsActive` strips query and treats `/opening/library` paths as active.
- `apps/web/src/features/search/command-palette-model.ts` — added palette command `materials` → 「材料」→ `/opening/library?tab=materials`.
- EntryLinks / Today shortcuts: **skipped** (optional; avoid fighting R2 denoise).

### P0-2 Course page 「添加材料」
- New `apps/web/src/features/courses/course-add-materials.tsx` — panel beside heading: lists sources not already on course (`assetType === "source"` via `assetId` / `source.id`), prefers `uploadState === "uploaded"` (pending shown gray/disabled), multi-select + role (default `reference`) → `createMaterialOrganizationClient().addToCourse`.
- `apps/web/src/features/courses/course-detail.tsx` — wires button next to 「管理知识库」; empty state title/description updated; link to materials library kept; `onAdded` calls `useCourseBundle.reload`.

### P0-3 Per-row 「归入课程」
- `apps/web/src/features/opening/inbox/source-row.tsx` — optional `onAssign` shows 「归入课程」.
- `apps/web/src/features/opening/inbox/inbox-panel.tsx` — passes `onAssign` / `renderBelow`.
- New `apps/web/src/features/opening/library/material-assign-panel.tsx` — course + role picker.
- `apps/web/src/features/opening/library/material-library.tsx` + `use-material-library.ts` — wires assign panel; `assignOne` calls `addToCourse`; batch bar unchanged.

## Files changed

| Path | Change |
|---|---|
| `apps/web/src/features/opening/shell/navigation.ts` | materials more entry + active path fix |
| `apps/web/src/features/opening/shell/navigation.test.ts` | expect materials + library highlight |
| `apps/web/src/features/search/command-palette-model.ts` | materials palette command |
| `apps/web/src/features/search/command-palette-model.test.ts` | expect materials; still exclude demoted `library` id |
| `apps/web/src/features/courses/course-add-materials.tsx` | **new** add-to-course panel |
| `apps/web/src/features/courses/course-add-materials.test.ts` | **new** diff-list + membership mock |
| `apps/web/src/features/courses/course-detail.tsx` | button + empty state |
| `apps/web/src/features/opening/inbox/source-row.tsx` | 归入课程 action |
| `apps/web/src/features/opening/inbox/source-row.test.ts` | assign shortcut |
| `apps/web/src/features/opening/inbox/inbox-panel.tsx` | onAssign / renderBelow |
| `apps/web/src/features/opening/library/material-assign-panel.tsx` | **new** row picker |
| `apps/web/src/features/opening/library/material-assign-panel.test.ts` | **new** |
| `apps/web/src/features/opening/library/material-library.tsx` | wire assign |
| `apps/web/src/features/opening/library/use-material-library.ts` | `assignOne` |

## Commands run

```bash
cd apps/web && npx tsc --noEmit
# exit 0

npx vitest run \
  apps/web/src/features/opening/shell/navigation.test.ts \
  apps/web/src/features/search/command-palette-model.test.ts \
  apps/web/src/features/courses/course-add-materials.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/library/material-assign-panel.test.ts \
  apps/web/src/features/opening/library/material-organization-client.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts
# 7 files, 32 tests passed
```

## Skipped checks
- EntryLinks / today-overview materials shortcut (optional per plan).
- Full apps/web vitest suite (only related files).
- No commit, no push, not marked verified / accepted.

## Notes for Integrator Accept
- Reuses existing memberships POST via `material-organization-client.addToCourse`; no new API.
- Does not restore explore/marketplace/learn.
- Ready for Integrator Accept → PM push/hermes.
