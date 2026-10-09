# P04 import-chunks wiring accept — Data `listAuthorizedImportChunks` + AI worker re-wire

**Date:** 2026-10-09 ~18:04 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Integrator **re-accept** of Data’s `listAuthorizedImportChunks` delivery and AI’s worker wiring (no longer stub) for P04 extract path.  
**Verdict:** **ACCEPT** (wiring slice; agent-owned)  
**P04 verified:** **not marked** — still waiting overlay **0052** (Integrator-assigned for Data to write separately) + integration for full P04 verify.  
**Browser:** **not run**.  
**tasks.json:** **not edited**.  
**Commit/push:** **not done**.  
**0052 required for this accept:** **No** — do not block on 0052 here.

## Claims checked

| Claim | Result |
|---|---|
| Data: `listAuthorizedImportChunks` delivered | **PASS** |
| Data unit **7** (course membership + ImportReceipt → chunks; missing `sentAt` stays null) | **PASS** — 7/7 green |
| AI: worker uses `createOpeningImportChunksRepository(sql).listAuthorizedImportChunks` (not stub) | **PASS** |
| Extract worker unit green | **PASS** — 3/3 |
| Worker `tsc` green | **PASS** — `npx tsc -p apps/worker --noEmit` exit 0 |

## Files reviewed

**Create (Data)**
- `packages/database/src/repositories/opening-import-chunks.ts` — `listAuthorizedImportChunks`, `channelFromConnectionKind`, `createOpeningImportChunksRepository`; exported from `packages/database/src/index.ts`
- `packages/database/src/repositories/opening-import-chunks.test.ts` — unit **7**

**Modify (AI re-wire)**
- `apps/worker/src/index.ts` — replaces prior `listAuthorizedImportChunks: async () => []` stub with:
  ```ts
  const importChunks = createOpeningImportChunksRepository(sql);
  const extractStudyActions = createExtractStudyActionsHandler({
    listAuthorizedImportChunks: (scope, courseId, receiptIds) =>
      importChunks.listAuthorizedImportChunks(scope, courseId, receiptIds),
  });
  ```

**Related (already accepted earlier; not re-scoped)**
- `apps/worker/src/jobs/extract-study-actions.ts` (+ `.test.ts`) — handler still deps-injected; units inject mock list

## Review notes (Data repo)

| Check | Result |
|---|---|
| Course ownership gate | `assertOwnedCourse` via courses ⊕ workspaces; `NOT_FOUND` when missing |
| Course membership | `course_asset_memberships` with `asset_type = 'source'` and `course_id` |
| ImportReceipt path | `opening_import_receipts` → connection → source → chunks |
| Auth / state gates | scope workspace + owner; `upload_state = 'uploaded'`; `parse_state = 'ready'`; `conn.state <> 'revoked'`; non-blank chunk text |
| Chunk join | One `ExtractableImportChunk` per receipt; pages joined with `\n` ordered by page / created_at |
| `sentAt` | **Always `null`** — comment + code never invent sync/ingest `created_at` as notification send time |
| Channel map | `imap` → `mail`; `dingtalk` → `dingtalk` |
| `receiptIds` filter | Empty array short-circuits `[]` (no list query); non-empty uses `r.id IN …` |

## Review notes (AI worker wiring)

| Check | Result |
|---|---|
| Stub removed | **Yes** — no `async () => []` / thin-slice stub for import chunks in `index.ts` |
| Factory used | `createOpeningImportChunksRepository(sql)` then `.listAuthorizedImportChunks` |
| Handler wiring | Still `createExtractStudyActionsHandler({ listAuthorizedImportChunks })` under `"extract-study-actions"` |

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-import-chunks.test.ts \
  apps/worker/src/jobs/extract-study-actions.test.ts
# → Test Files  2 passed (2)
# → Tests  10 passed (10)
# Breakdown: Data import-chunks 7 + worker extract 3 = 10
```

**tsc:**
- `npx tsc -p apps/worker --noEmit` → exit 0

## Gaps (ACCEPT wiring; not full P04 verify)

1. **Overlay migration 0052** — not present under `packages/database/src/migrations/` (latest formal is 0051 job-kind). Integrator-assigned for Data to write separately; **not required** for this accept.
2. **Integration** (e.g. extract → digest / `opening-action-digest`) — not run for this accept.
3. **Durable notification `sentAt` column** — still absent; repo correctly returns `null` until that exists (0052 or later may address).
4. **Browser not run**; **P04 not verified**; **tasks.json not edited**; **no commit/push**.

## Verdict

**ACCEPT** — Data `listAuthorizedImportChunks` (unit 7) and AI worker re-wire to `createOpeningImportChunksRepository(sql).listAuthorizedImportChunks` meet the claimed P04 wiring slice; extract unit 3 + combined 10 green; worker tsc green. Full P04 remains open until 0052 overlay + integration (and any remaining Experience digest verify) land in a separate verify pass.
