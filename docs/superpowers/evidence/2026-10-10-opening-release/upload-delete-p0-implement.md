# Upload-delete P0 — IMPLEMENT

**Date:** 2026-10-10 ~12:27 CST  
**Owner:** Experience  
**Branch:** `feat/opening-release`  
**HEAD:** `697d1d6775fd18d508e9889cbb3df984ff664c75` (`docs(opening): UI denoise R2 list + Integrator review`)  
**Auth:** PM IMPLEMENT per Integrator-AGREE `upload-delete-p0-plan.md` + review notes  
**Status:** Ready for Integrator **Accept** — **no commit / no push**

## What shipped

### P0-1 upload-queue dismiss
- `upload-queue.ts`: `dismiss(id, update?)` removes item only when `state === "failed"`; otherwise no-op; exported on queue object.
- `upload-strip.tsx` + `inbox-panel.tsx` (`aria-label="上传队列"`): failed rows keep **重试**, add **清除** → `queue.dismiss`.

### P0-2 failed SourceRow delete shortcut
- `source-row.tsx`: optional `onDelete`; danger-ish **删除** when `uploadState === "rejected" || parseState === "failed"` and `onDelete` set; **管理材料** / retry unchanged.
- `source-actions-panel.tsx`: optional `initialAction?: "exclude" | "delete" | null`; after impact loads, sets action to enter confirm; effect deps include `record.id` + `initialAction` so switch/close resets.
- `inbox-panel.tsx`: `managedId` + `manageInitialAction`; failed `onDelete` → open panel with `initialAction="delete"`; `onManage` → `null`; `onClose` clears both. Reuses existing impact + POST delete via panel/client.

## Files changed (this work only)

| File | Change |
|---|---|
| `apps/web/src/features/opening/inbox/upload-queue.ts` | `dismiss` |
| `apps/web/src/features/opening/inbox/upload-queue.test.ts` | dismiss only-failed / no-op |
| `apps/web/src/features/opening/assistant/upload-strip.tsx` | 清除 |
| `apps/web/src/features/opening/inbox/inbox-panel.tsx` | queue 清除 + manageInitialAction wiring |
| `apps/web/src/features/opening/inbox/inbox-panel.test.ts` | failed row shows 删除 + 管理材料 |
| `apps/web/src/features/opening/inbox/source-row.tsx` | onDelete + 删除 |
| `apps/web/src/features/opening/inbox/source-row.test.ts` | failed/rejected show 删除; ready does not |
| `apps/web/src/features/opening/inbox/source-actions-panel.tsx` | `initialAction` |

No dedicated `source-actions-panel` DOM test: vitest env is `node` + `renderToStaticMarkup` (no jsdom); confirm step needs client `useEffect` after impact. Behavior covered by panel prop wiring + inbox/source-row assertions.

## Gates

```text
npx vitest run \
  apps/web/src/features/opening/inbox/upload-queue.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/source-actions-client.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts
# → 4 files / 28 tests passed

cd apps/web && npx tsc -p tsconfig.json --noEmit
# → exit 0
```

## R2 / AI isolation

- Did **not** edit palette / settings / ai-settings / worker `tutor-model` / `.env*` / `packages/ai` / contracts ai-settings.
- Pre-existing dirty R2+AI tree left untouched; this work is a separate unstaged set (inbox/assistant upload-delete + evidence only).
- **No commit, no push.**

## Accept ask

Integrator: Accept this IMPLEMENT evidence when gates + scope look good.
