# Upload-delete P0 — Integrator ACCEPT

**Date:** 2026-10-10 ~12:27 CST  
**Reviewer:** INTEGRATOR (ACCEPT)  
**Branch:** `feat/opening-release`  
**HEAD baseline:** `697d1d6775fd18d508e9889cbb3df984ff664c75`  
**Sources:** `upload-delete-p0-plan.md`, `upload-delete-p0-integrator-review.md`, `upload-delete-p0-implement.md`  
**Verdict:** **ACCEPT**

## Gates (re-run)

```text
npx vitest run \
  apps/web/src/features/opening/inbox/upload-queue.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/source-actions-client.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts
# → Test Files  4 passed (4)
# → Tests  28 passed (28)
# → Duration  ~2.55s

cd apps/web && npx tsc -p tsconfig.json --noEmit
# → exit 0
```

Matches claim (4 files / 28 tests + tsc clean).

## Spot-checks vs plan + AGREE notes

| Check | Result |
|---|---|
| `dismiss` only removes `failed`; else no-op | **PASS** — `upload-queue.ts` guards `state !== "failed"`; tests cover failed dismiss, saved/idle no-op |
| UploadStrip + Inbox queue show 清除 for failed | **PASS** — both keep 重试, add 清除 → `queue.dismiss` |
| SourceRow 删除 for rejected/failed parse; ready does not; 管理材料 kept | **PASS** — `failed && onDelete`; manage button unchanged when `onManage` set; ready test asserts no 删除 |
| Panel `initialAction` resets on record.id / close / switch | **PASS** — effect deps `[api, record.id, attempt, initialAction]`; clears action then reapplies; `closeManage` / `openManage(..., null)` clear; panel remounts per `managedId === record.id` |
| Reuses impact + POST actions delete (no new DELETE API) | **PASS** — shortcut opens `SourceActionsPanel` with `initialAction="delete"`; confirm still `api.act(..., { action: "delete", ... })`; no new DELETE route in inbox/assistant P0 paths |

## P0 dirty file list (this slice only)

Modified (uncommitted):
- `apps/web/src/features/opening/inbox/upload-queue.ts`
- `apps/web/src/features/opening/inbox/upload-queue.test.ts`
- `apps/web/src/features/opening/assistant/upload-strip.tsx`
- `apps/web/src/features/opening/inbox/inbox-panel.tsx`
- `apps/web/src/features/opening/inbox/inbox-panel.test.ts`
- `apps/web/src/features/opening/inbox/source-row.tsx`
- `apps/web/src/features/opening/inbox/source-row.test.ts`
- `apps/web/src/features/opening/inbox/source-actions-panel.tsx`

Evidence (untracked for this work):
- `docs/superpowers/evidence/2026-10-10-opening-release/upload-delete-p0-plan.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/upload-delete-p0-integrator-review.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/upload-delete-p0-implement.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/upload-delete-p0-accept.md` (this file)

Claimed file list matches; no R2 palette/settings or AI packages in the P0 slice.

## R2 / AI dirt note (out of scope — do not mix into P0 commit)

Pre-existing mixed dirty tree on same tip includes (non-exhaustive): `.env.example`, `ai-settings` route/contracts/packages, `ai-readiness`, `today-overview`, `opening-shell`, `command-palette*`, `settings-view*` / `advanced-settings-view` / `ai-settings-service`, `tutor-model*`, ops docs, `ui-loop-converge-r2-*` evidence, `unify-default-lant-*` evidence. Left untouched by this Accept; commit/push deferred to PM.

## Boundaries honored

- Did **not** mark verified in `tasks.json`
- Did **not** commit or push
- Accept covers upload-delete P0 slice only

## Next

PM may authorize a separate commit for this P0 (split from R2+AI dirty) when ready.
