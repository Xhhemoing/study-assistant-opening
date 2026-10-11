# V2-12 Teaching commands — Experience UI Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Data half ACCEPT merged):** `06b4747` — `feat(opening): V2-12 teaching commands (Data half)`  
**Status:** **implemented, awaiting Integrator Experience ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No commit / push / hermes / stash / reset · No Data rewrite (contracts/domain/repo/command-service/route untouched aside from thin OpeningApi client wire) · Exclusive Experience UI tree

## Authority followed

- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-understand.md`
- Data Implement + ACCEPT:
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-implement.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-accept.md`
- PM gate: TeachingWorkspace **block-level** commands why/rephrase/expand/example/skip/branch/return; POST existing Data endpoint; conflict → re-read/merge (**forbid LWW**); `return` disabled when branch stack empty; bind activityId+blockId+contentVersion+clientKey; why=assist only; preserve drafts; no new shell

## Diff scope (Experience only)

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/block-commands.tsx` | BlockCommandsBarView + BlockCommands; 7 kinds; skip honesty copy; why assist panel; conflict banner + re-read (no force overwrite); return disabled when stack empty; clientKey mint |
| `apps/web/src/features/opening/teaching/block-commands.test.ts` | Stack helpers; kind labels; conflict→reread policy; SSR toolbar (return disabled, skip honesty, no LWW) |

### Updated

| Path | Change |
|---|---|
| `apps/web/src/features/opening/client/api.ts` | Thin `postTeachingCommand` → `POST /api/opening/teaching/activities/{id}/commands`; **409 structured conflict parsed as `ok:false`** (not throw-as-generic); other errors still `OpeningApiError` |
| `apps/web/src/features/opening/client/api.test.ts` | Success / 409 conflict / non-409 throw tests |
| `apps/web/src/features/opening/teaching/teaching-workspace.tsx` | Live contentVersion/pathVersion/clientInit; per-block BlockCommands; refresh on success; workspace conflict hint; reread via getTeachingClientInit + getTeachingActivity; preference-controls preserved |
| `apps/web/src/features/opening/teaching/teaching-workspace.test.ts` | Assert block command chrome; returnDisabled from empty/non-empty branchStack; mock BlockCommands |

### Explicitly not touched

- Data: `packages/contracts|domain|database` teaching-commands, `command-service.ts`, `…/commands/route.ts` (reuse only)
- No new migration / no `0057`
- No preference-controls rewrite (session expand kept)
- No commit / push / hermes / stash / reset / self-ACCEPT

## UX summary

1. Each TeachingWorkspace block gets a toolbar: **为什么 / 换种说法 / 展开 / 举例 / 跳过 / 分支 / 返回**.  
2. Envelope binds `activityId` + `blockId` (except return) + `expectedVersion` (=contentVersion) + optional `expectedPathVersion` + fresh `clientKey` (≥8).  
3. **Conflict (409 / ok:false):** warning + “重新拉取教学内容”; copy forbids force overwrite / LWW.  
4. **`return` disabled** when `checkpointJson.branchStack` empty.  
5. **Skip honesty:** “跳过只调整学习路径，不会记为答错…”.  
6. **Why:** assist summary panel; “不改写正文”.  
7. Success refreshes `contentVersion` / `pathVersion` / `clientInit` (or checkpoint merge); drafts copy notes preserve anchors.  
8. No new shell — nests under existing TeachingWorkspace; free chat stays secondary; intervention prefs expand intact.

## Soft gaps (honest)

1. **Browser:** `not_run` / pending_user (no interactive browser pass this slice).  
2. **Local draft editors** still thin (workspace drafts expand is metadata only); command path preserves server checkpoint drafts via Data CAS — no client LWW.  
3. **Branch label / targetBlockId / prompt** UX is minimal (defaults only); advanced prompt field not exposed in M1 chrome.  
4. **Workspace-level conflict strip** is informational; per-block conflict UI owns the re-read button.  
5. Data soft gaps remain (T4/T5/T12/T17/T18 DB/HTTP `not_run`; M1 rewrite stub) — Experience does not claim them.

## Commands run + results

### Tip

```text
$ git log -1 --oneline
06b4747 feat(opening): V2-12 teaching commands (Data half)

$ git branch --show-current
feat/opening-release

$ ls packages/database/src/migrations/0057* 2>/dev/null || echo 'no 0057'
no 0057
```

### Targeted vitest

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    apps/web/src/features/opening/teaching/block-commands.test.ts \
    apps/web/src/features/opening/teaching/teaching-workspace.test.ts \
    apps/web/src/features/opening/client/api.test.ts \
    apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

 Test Files  4 passed (4)
      Tests  65 passed (65)
   Duration  ~4.2s
# exit 0
```

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
# exit 0 (no diagnostics)
```

### Browser

```text
not_run / pending_user
```

## Accept ask (Integrator) — 中文交接

请 **ACCEPT** V2-12 Experience UI 半边，若满足：

1. Tip 仍为 `06b4747`（脏树仅 Experience：`block-commands*` + OpeningApi thin wire + TeachingWorkspace；**未**改 Data contracts/domain/repo/route）。  
2. TeachingWorkspace 块级命令含 7 种；POST `/api/opening/teaching/activities/{id}/commands`；409/`ok:false` → 重新拉取/合并，**无强制覆盖 / 无 LWW**。  
3. `return` 在 `branchStack` 空时 disabled；skip 诚实文案（≠答错）；why 仅 assist。  
4. 成功后刷新 contentVersion / pathVersion / clientInit；保留 preference-controls 与 V2-10 壳。  
5. 定向 vitest 65 绿 + `apps/web` tsc 干净；Browser 诚实 `not_run`。  
6. Soft gaps（浏览器、prompt/分支高级字段、Data DB not_run）已如实记录。

**请勿**在 Integrator ACCEPT 前把 `tasks.json` 标 verified。
