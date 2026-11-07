# V2-12 Teaching commands — Experience UI Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot)  
**Stage:** Independent Implement ACCEPT (Experience UI half only)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline):** `06b474770da2d46a878ea530ddc74bfc41cc029a` (`06b4747`) — `feat(opening): V2-12 teaching commands (Data half)`  
**Tree:** **dirty Experience UI** (uncommitted; excluded from any clean-tip push)  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-accept.md` | Data Implement ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-experience-implement.md` | Experience Implement claim |
| PM locks | block-level why/rephrase/expand/example/skip/branch/return; POST Data endpoint; conflict → re-read/merge **forbid LWW**; return disabled when stack empty; why assist-only |

## Tip / dirty tree (read-only; no stash / reset / push)

```text
$ git rev-parse HEAD
06b474770da2d46a878ea530ddc74bfc41cc029a

$ git log -1 --oneline
06b4747 feat(opening): V2-12 teaching commands (Data half)

$ git branch --show-current
feat/opening-release

$ git status --short  (product Experience only)
 M apps/web/src/features/opening/client/api.test.ts
 M apps/web/src/features/opening/client/api.ts
 M apps/web/src/features/opening/teaching/teaching-workspace.test.ts
 M apps/web/src/features/opening/teaching/teaching-workspace.tsx
?? apps/web/src/features/opening/teaching/block-commands.test.ts
?? apps/web/src/features/opening/teaching/block-commands.tsx

$ ls packages/database/src/migrations/0057* 2>/dev/null || echo 'no 0057'
no 0057
```

**Confirmed:** tip remains `06b4747`. Dirty tree is Experience UI only. **No stash, reset, checkout, commit, push, or hermes** performed this Accept.

## Stronger review

### 1. Diff scope — Experience only

| Path | Role | OK? |
|---|---|---|
| `block-commands.tsx` (+test) | New block toolbar + helpers | YES |
| `client/api.ts` (+test) | Thin `postTeachingCommand` wire; 409 → `ok:false` parse | YES |
| `teaching-workspace.tsx` (+test) | Nest BlockCommands; live cv/pv; reread; prefs kept | YES |
| Data contracts / domain / repo / command-service / route | **Untouched** in dirty tree (tip Data half reused) | YES |
| Migration `0057` | **Absent** | YES |

### 2. PM locks vs UI behavior

| Lock | Finding |
|---|---|
| 7 kinds (why/rephrase/expand/example/skip/branch/return) | `TEACHING_COMMAND_KINDS` length 7; toolbar renders all | **Hold** |
| POST Data endpoint | `POST /api/opening/teaching/activities/{id}/commands` via `postTeachingCommand` | **Hold** |
| Bind activityId+blockId+expectedVersion(+path)+clientKey | Envelope built in `BlockCommands.runCommand`; return omits blockId | **Hold** |
| 409 / `ok:false` → re-read/merge; **forbid LWW** | API parses 409 as conflict body; UI conflict banner +「重新拉取教学内容」; copy forbids「强制覆盖」; no force-overwrite control / no LWW retry | **Hold** |
| `return` disabled when branch stack empty | `isBranchStackEmpty(checkpointJson)` → `returnDisabled`; button `disabled` | **Hold** |
| Skip honesty (≠ wrong-answer) | `SKIP_HONESTY_COPY` visible + skip button title | **Hold** |
| Why assist-only | Assist panel labeled「说明（不改写正文）」; no body rewrite affordance | **Hold** |
| Success refresh | `applySuccess` updates contentVersion / pathVersion / clientInit or checkpoint merge | **Hold** |
| Preserve PreferenceControls / V2-10 shell | `PreferenceControls` still imported + rendered; no new shell | **Hold** |

### 3. Tests not loosened

- block-commands tests assert 7 kinds, return disabled/enabled, skip honesty, reread affordance, **absence** of force-overwrite / LWW strings.
- api tests assert success parse, **409 → ok:false**, non-409 throw.
- teaching-workspace tests assert command chrome + returnDisabled from empty/non-empty branchStack.
- No `it.skip` / `.only` in claimed files.

## Independent re-runs (Integrator)

### Vitest

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    apps/web/src/features/opening/teaching/block-commands.test.ts \
    apps/web/src/features/opening/teaching/teaching-workspace.test.ts \
    apps/web/src/features/opening/client/api.test.ts \
    apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

 Test Files  4 passed (4)
      Tests  65 passed (65)
   Duration  ~4.5s
exit 0
```

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
exit 0
```

### Browser

```text
not_run / pending_user — no interactive browser pass this Accept (honest; does not block Experience UI ACCEPT per claim + soft-gap policy).
```

## Soft gaps (honest; non-blocking)

1. **Browser E2E** — `not_run` / pending_user.  
2. **Local draft editors** still thin (metadata expand only); server drafts preserved via Data CAS — no client LWW.  
3. **Branch / prompt UX** minimal (defaults only; no advanced prompt / targetBlockId field in M1 chrome).  
4. **Workspace-level conflict strip** informational; per-block UI owns the re-read button.  
5. Data soft gaps remain (T4/T5/T12/T17/T18 DB/HTTP `not_run`; M1 rewrite stub) — Experience does not claim them.  
6. Unrelated untracked docs in status (`rp5-gha-…`, `p0-assistant-list-preview-…`) — outside this slice.

## Forbidden actions (this Accept)

- **No** stash / reset / checkout / clean of dirty Experience UI  
- **No** commit / push / hermes  
- **No** Data contract/domain/repo/route rewrite  
- **No** new migration / DDL  
- **No** product fix (would REJECT instead)  
- **No** self-mark `tasks.json` verified beyond this evidence file

## Verdict

**ACCEPT** Experience UI Implement of V2-12 Teaching commands at dirty tip `06b4747`.

- Diff scope Experience-only; Data half reused; no `0057`.  
- 7 kinds; POST Data endpoint; 409/`ok:false` → re-read, **no LWW**; return disabled on empty stack; skip honesty; why assist-only.  
- Re-runs: vitest **65 passed**; `apps/web` tsc **exit 0**.  
- Browser **`not_run`** (honest). Soft gaps recorded.  
- **Confirmed: no stash / reset / push / hermes.**
