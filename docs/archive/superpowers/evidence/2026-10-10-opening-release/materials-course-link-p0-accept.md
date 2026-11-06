# Materials + course link P0 — Integrator ACCEPT

**Date:** 2026-10-10 ~22:19 CST  
**Reviewer:** INTEGRATOR (ACCEPT)  
**Branch:** `feat/opening-release`  
**HEAD baseline:** `7dd1ef8940fb8c7954108b0919c53573606984c4`  
**Sources:** `materials-course-link-p0-plan.md`, `materials-course-link-p0-integrator-review.md`, `materials-course-link-p0-implement.md`  
**Verdict:** **ACCEPT**

## Gates (re-run)

```text
npx vitest run \
  apps/web/src/features/opening/shell/navigation.test.ts \
  apps/web/src/features/search/command-palette-model.test.ts \
  apps/web/src/features/courses/course-add-materials.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/library/material-assign-panel.test.ts \
  apps/web/src/features/opening/library/material-organization-client.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts
# → Test Files  7 passed (7)
# → Tests  32 passed (32)
# → Duration  ~3.39s

cd apps/web && npx tsc -p tsconfig.json --noEmit
# → exit 0 (no output)
```

Matches claim (7 files / 32 tests + tsc clean).

## Spot-checks vs plan + AGREE notes

| Check | Result |
|---|---|
| more nav 「材料」→ `/opening/library?tab=materials` | **PASS** — `navigation.ts` more-group item; `navigationIsActive` strips query and highlights `/opening/library`; tests assert materials in more not core |
| command palette 「材料」→ same href | **PASS** — `PALETTE_COMMANDS` id `materials` label「材料」href `/opening/library?tab=materials`; demoted `library` id still excluded |
| course-detail 「添加材料」uses addToCourse / memberships | **PASS** — `CourseAddMaterials` → `createMaterialOrganizationClient().addToCourse` → `POST /api/courses/:id/memberships`; no new API; default role `reference`; pending gray/disabled; succeeded/failed status |
| empty state + library link | **PASS** — title「还没有挂接材料」; description points to「添加材料」; link `/opening/library?tab=materials` |
| source-row 「归入课程」shortcut | **PASS** — optional `onAssign` button; `MaterialAssignPanel` course+role picker; `assignOne` → `addToCourse` |
| batch bar kept | **PASS** — `MaterialBatchActions` still wired via `library.batch` in `material-library.tsx` |
| R2: materials in more not core; no explore/marketplace restore | **PASS** — core = today/assistant/courses only; palette asserts no explore/marketplace/learn; nav has no explore/marketplace hrefs |
| Today shortcut skipped | **PASS** — optional per plan; claimed skip accepted (no new Today EntryLinks materials shortcut) |

## P0 dirty file list (this slice only)

Modified (uncommitted on tip `7dd1ef8`):
- `apps/web/src/features/opening/shell/navigation.ts`
- `apps/web/src/features/opening/shell/navigation.test.ts`
- `apps/web/src/features/search/command-palette-model.ts`
- `apps/web/src/features/search/command-palette-model.test.ts`
- `apps/web/src/features/courses/course-detail.tsx`
- `apps/web/src/features/opening/inbox/source-row.tsx`
- `apps/web/src/features/opening/inbox/source-row.test.ts`
- `apps/web/src/features/opening/inbox/inbox-panel.tsx`
- `apps/web/src/features/opening/library/material-library.tsx`
- `apps/web/src/features/opening/library/use-material-library.ts`

New (untracked):
- `apps/web/src/features/courses/course-add-materials.tsx`
- `apps/web/src/features/courses/course-add-materials.test.ts`
- `apps/web/src/features/opening/library/material-assign-panel.tsx`
- `apps/web/src/features/opening/library/material-assign-panel.test.ts`

Evidence (untracked for this work):
- `docs/superpowers/evidence/2026-10-10-opening-release/materials-course-link-p0-plan.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/materials-course-link-p0-integrator-review.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/materials-course-link-p0-implement.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/materials-course-link-p0-accept.md` (this file)

Claimed file list matches; memberships client reused (no new API routes).

## Boundaries honored

- Did **not** mark verified in `tasks.json` (slice not present there; file untouched)
- Did **not** commit or push
- Accept covers materials-course-link P0 slice only

## Next

PM may authorize a separate commit for this P0 when ready → hermes as needed.
