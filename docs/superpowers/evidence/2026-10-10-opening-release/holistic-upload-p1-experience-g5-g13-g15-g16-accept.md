# ACCEPT：Holistic upload P1 — Experience G5 / G13 / G15 / G16 (+ G10/G11/G17)

**Date:** 2026-10-10 ~23:47 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `3af5c01` (cite D shipped; Experience P1 uncommitted on working tree)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-upload-p1-experience-g5-g13-g15-g16-implement.md`  
**Plan:** `holistic-upload-materials-audit-understand.md` gaps + `holistic-upload-materials-audit-p0-plan.md` § P1 backlog (Experience)

---

## Verdict

**ACCEPT** Experience P1 wave **G5 / G13 / G15 / G16** with nice-to-haves **G10 / G11 / G17**.

Behavior matches plan gaps; focused vitest **49** + `apps/web` tsc **PASS** re-verified this turn. No product edits by Accept; no commit/push/stash/reset.

Concurrent dirty tree from AI G18/G9, Pipeline G4/G12/G19, Data G4, worker, and `source-content.tsx` (OCR copy) is **out of slice** — not reviewed / not accepted here.

---

## Gates (re-run 2026-10-10 ~23:46–23:47 CST)

```bash
cd /workspace/study-assistant-opening
npx vitest run \
  apps/web/src/features/opening/inbox/upload-queue.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/upload-dropzone.test.ts \
  apps/web/src/features/opening/library/material-collection.test.ts \
  apps/web/src/features/opening/library/material-batch-actions.test.ts \
  apps/web/src/features/opening/library/material-batch-delete.test.ts \
  apps/web/src/features/opening/sources/media-reader.test.ts \
  --project unit
# → Test Files  8 passed (8)
# → Tests       49 passed (49)

(cd apps/web && npx tsc -p tsconfig.json --noEmit)
# → exit 0
```

| Gate | Result |
|---|---|
| Vitest Experience 8 files (claimed 49) | **Pass** — 49/49 |
| `apps/web` `tsc -p tsconfig.json --noEmit` | **Pass** (exit 0) |

---

## Per-G spot-checks (vs tip `3af5c01` + untracked helpers)

| ID | Behavior | Result |
|---|---|---|
| **G5** | `dismiss` removes `idle` \| `uploading` \| `failed`; `cancelled` set ignores late progress/completion; Inbox + UploadStrip show **取消** for idle/uploading, **清除**+**重试** only failed; start snapshots idle ids so mid-loop dismiss does not skip siblings | **Pass** |
| **G13** | `MaterialBatchActions` **删除材料** + irreversible Chinese confirm; `deleteSelectedMaterials` sequential `impact` → `act(delete)` with version/membershipIds; `useMaterialLibrary.deleteSelected` + library `onDelete` wire; tests for bar presence + helper succeeded/failed | **Pass** |
| **G15** | `MaterialStatus` splits `incomplete_upload` (not fully uploaded) vs `parsing` (uploaded + not_started\|queued\|running); dropdown 「上传未完成」「正在解析」; badge counts separate; `processing` removed from library types | **Pass** |
| **G16** | `canDeleteSourceShortcut` / `isAgedQueuedParse` / exported `AGED_QUEUED_MS` (3 min); shortcut for failed\|rejected\|pending\|unsupported\|aged queued; source-row uses helper; tests for unsupported / aged / fresh queued | **Pass** |
| **G10** | Dropzone accept + labels `.mp4`/`.webm`; `resolveUploadMime` video/mp4 + video/webm | **Pass** |
| **G11** | `media-reader` distinct `parse_unsupported_original_saved` vs failed; copy via `sourceStatusLabel` | **Pass** |
| **G17** | When `!organizationReady` and no org error: amber Chinese guidance (课程关系尚未就绪…) | **Pass** |

### Acceptable limitations (not reject)

- **G5:** Cancel is queue UI remove + ignore late completions; no XHR `AbortController` through `putPrivateBytes` this turn — claim + plan-acceptable when abort is hard.
- **G13:** Shared result banner still says 「整理成功」 for delete outcomes (membership-batch copy reuse) — polish only.
- Batch/select remain gated on `organizationReady` (same as pre-existing assign UX); G17 copy covers the disabled state.

---

## Files in scope (Experience pack only)

| Path | Role |
|---|---|
| `inbox/upload-queue.ts` (+ test) | G5 dismiss idle/uploading + late-ignore |
| `inbox/inbox-panel.tsx` | G5 取消 UI |
| `assistant/upload-strip.tsx` | G5 取消 UI |
| `inbox/upload-state.ts` (+ test) | G16 helpers; G10 video MIME |
| `inbox/source-row.tsx` (+ test) | G16 shortcut |
| `inbox/upload-dropzone.tsx` (+ test) | G10 video accept |
| `library/material-collection.ts` (+ test) | G15 status split |
| `library/material-library.tsx` | G15 labels/badges; G13 wire; G17 copy |
| `library/material-batch-actions.tsx` (+ test, untracked) | G13 bulk delete confirm |
| `library/material-batch-delete.ts` (+ test, untracked) | G13 impact+act helper |
| `library/use-material-library.ts` | G13 `deleteSelected` |
| `sources/media-reader.tsx` (+ test) | G11 distinct failed/unsupported |

## Explicitly not accepted here

- AI: `ai-readiness*` / `packages/ai` (G18/G9) — separate claim
- Pipeline/Data: `source-service*`, `parse-source*`, `queue*`, `sweep-pending-uploads*`, `opening-sources*` (G4/G12/G19 etc.)
- `inbox/source-content.tsx` OCR empty-page copy (other agent dirty)
- commit / push / stash / reset

---

## Notes

- Tip remains `3af5c01`; Experience P1 is uncommitted (as claim stated). Integrator did not commit or push.
- Untracked `material-batch-delete.ts` / `material-batch-*.test.ts` are in scope and covered by the re-run gates.
- No blockers for Experience Accept.

## Blockers

None for this slice.
