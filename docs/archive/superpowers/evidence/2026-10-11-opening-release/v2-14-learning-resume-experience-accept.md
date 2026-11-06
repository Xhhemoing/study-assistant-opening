# V2-14 Learning resume — Experience UI Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Experience)  
**Stage:** Independent Implement ACCEPT (Experience UI half only)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Data half ACCEPT merged):** `a818df6defdfe77c3dc23d3dc2c7481533365cdd` (`a818df6`) — `feat(opening): V2-14 learning breakpoint resume (Data half)`  
**Tree:** **dirty Experience UI** (uncommitted; excluded from any clean-tip push)  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md` | Plan（§1.4 Experience · §6 Experience preview） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-accept.md` | Data Implement ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-experience-implement.md` | Experience Implement claim |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| Style: `v2-12-teaching-commands-experience-accept.md` / `v2-11-intervention-prefs-experience-accept.md` | Accept sample |
| PM locks (room) | resume-card + TeachingWorkspace continue；clientInit may be null → empty protection；conflict drafts juxtaposed, **no LWW**；no self-verified；no push/hermes |

## Tip / dirty tree (read-only; no stash / reset / push)

```text
$ git rev-parse HEAD
a818df6defdfe77c3dc23d3dc2c7481533365cdd

$ git log -1 --oneline
a818df6 feat(opening): V2-14 learning breakpoint resume (Data half)

$ git branch --show-current
feat/opening-release

$ git status --short  (product Experience only)
 M apps/web/src/features/opening/planning/today-dashboard.tsx
 M apps/web/src/features/opening/teaching/teaching-workspace.test.ts
 M apps/web/src/features/opening/teaching/teaching-workspace.tsx
?? apps/web/src/features/opening/teaching/resume-card.test.ts
?? apps/web/src/features/opening/teaching/resume-card.tsx
# (+ this accept evidence; claim implement.md already present)

$ git diff --name-only HEAD -- packages/database packages/domain packages/contracts apps/web/src/features/opening/client apps/web/src/app/api
# (empty — Data half + OpeningApi helpers untouched this slice)

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058'
no 0058
```

**Also dirty (outside Experience product):** untracked `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`、`docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md` — unrelated; not part of this ACCEPT.

**Confirmed:** tip remains `a818df6`. Dirty product tree is Experience UI only. **No stash, reset, checkout, commit, push, or hermes** performed this Accept. `tasks.json` left alone.

## Stronger review

### 1. Diff scope — Experience only

| Path | Role | OK? |
|---|---|---|
| `resume-card.tsx` (+test) | New ResumeCardView + ResumeCard; GET resume / POST checkpoint / PATCH status | YES |
| `teaching-workspace.tsx` (+test) | New `TeachingContinueEntry`; Continue → workspace; wait_init when clientInit null | YES |
| `today-dashboard.tsx` | Prefetch `getTeachingResume`; mount `TeachingContinueEntry`; dual-fail → 回退摘要 | YES |
| Data contracts / domain / database / resume-service / routes | **Untouched** in dirty tree | YES |
| OpeningApi `client/api.ts` (+test) | **Untouched** — consume Data helpers only | YES |
| Migration `0058` | **Absent** | YES |

### 2. PM locks vs UI behavior

| Lock | Finding |
|---|---|
| resume-card + TeachingWorkspace continue | `ResumeCard` + `TeachingContinueEntry`（Today mounts entry；Continue CTA → workspace） | **Hold** |
| clientInit may be null → empty protection | Card `data-resume-client-init="null"` copy；Continue path → `wait_init` / re-fetch `getTeachingClientInit`；不伪造讲义 | **Hold** |
| Conflict drafts juxtaposed；**no LWW** | `data-forbid-lww` + 并排服务端 vs 本地未发送；`draft_anchor_lost` / version catch → conflict + reread；文案「禁止强制覆盖 / 禁止后写优先」；**无** force-overwrite / LWW 按钮 | **Hold** |
| Uses Data resume APIs | `getTeachingResume` / `postTeachingCheckpoint` / `patchTeachingActivityStatus` / `getTeachingClientInit` via OpeningApi | **Hold** |
| ≠ ConversationResume | No import/route to ConversationResume / resumeConversation；tests assert absence | **Hold** |
| Summary independence | Card copy「断点恢复不依赖 AI 摘要」+ `resumeIgnoresSummary` helper | **Hold** |
| Gate fail-soft | materials/job banners for partial/unavailable/in_flight/unknown/stale；草稿仍展示 | **Hold** |
| Pause / unpause | `patchTeachingActivityStatus` active↔paused | **Hold** |
| Preserve V2-10/11/12 | Workspace phase still mounts PreferenceControls + BlockCommands；tests assert chrome | **Hold** |

### 3. Tests not loosened

- resume-card tests: thought train；summary independence；`draft_anchor_lost` → juxtapose；SSR null clientInit / gates / Continue CTA / `data-forbid-lww` / 禁止强制覆盖.
- teaching-workspace tests: ContinueEntry starts on card；`startInWorkspace` → workspace；V2-11 prefs / V2-12 returnDisabled / 次要自由对话 retained.
- No `it.skip` / `.only` in claimed files.
- Suite strength matches claim (helpers + SSR view；Continue click state machine honestly soft / not_run).

## Independent re-runs (Integrator)

### Vitest

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    apps/web/src/features/opening/teaching/resume-card.test.ts \
    apps/web/src/features/opening/teaching/teaching-workspace.test.ts \
    apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

 Test Files  3 passed (3)
      Tests  22 passed (22)
   Duration  ~3.14s
exit 0
```

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
exit 0
```

### Browser

```text
not_run / pending_user — no interactive browser pass this Accept (honest).
```

Plan §6 Experience preview lists resume-card / juxtaposition / Continue as UI deliverables; it does **not** name a browser E2E acceptance criterion. Gates: browser required-by-plan normally blocks ACCEPT. Prior V2-10/11/12 Experience UI halves soft-deferred browser as `not_run` with ACCEPT when unit/tsc green. This slice follows that pattern; **do not invent browser pass**. Soft gap recorded below — does not overturn ACCEPT for this UI half.

## Soft gaps (honest; non-blocking)

1. **Browser E2E** — `not_run` / pending_user（soft gap；prior Experience UI pattern）.  
2. **Local unsent draft buffer** — props/内存 only；无 IndexedDB（Plan：Experience optional）.  
3. **Today 双请求** — dashboard prefetch + ResumeCard may re-fetch when no prefetch；行为正确，可后续去重.  
4. **冲突后无一侧一键合并助手** — 有意避免伪装 LWW；用户手动编辑后再同步.  
5. **Continue→workspace 完整 onClick 状态机** — 单元/SSR + mock；交互机 `not_run`（claim soft gap）.  
6. Data soft gaps（live DB ownership/CAS/sanitize `not_run`）— Experience 不宣称.  
7. Unrelated untracked docs（`rp5-gha-…`、`p0-assistant-list-…`）— outside this slice.

## Forbidden actions (this Accept)

- **No** stash / reset / checkout / clean of dirty Experience UI  
- **No** commit / push / hermes  
- **No** Data contract/domain/repo/route rewrite；**No** OpeningApi rewrite  
- **No** new migration / DDL  
- **No** product fix (would REJECT instead)  
- **No** self-mark `tasks.json` verified（left alone）

## Verdict

**ACCEPT** Experience UI Implement of V2-14 Learning resume at dirty tip `a818df6`.

- Diff scope Experience-only；Data half + OpeningApi helpers reused；no `0058`.  
- resume-card + TeachingContinueEntry；clientInit null fail-soft；冲突并排 **无 LWW**；Continue CTA；uses Data resume APIs；≠ ConversationResume；V2-10/11/12 chrome retained.  
- Re-runs: vitest **3 files / 22 tests** exit 0；`apps/web` tsc **exit 0**.  
- Browser **`not_run`**（honest soft gap；prior V2-11/12 Experience pattern；plan did not mandate browser E2E）.  
- Soft gaps recorded. **Confirmed: no stash / reset / push / hermes / tasks.json touch.**

## One-line

ACCEPT — tip `a818df6` dirty Experience UI；vitest 22 + web tsc green；resume-card+Continue；null clientInit fail-soft；juxtapose no LWW；browser `not_run`；no push/hermes/commit.
