# V2-14 Learning resume — Experience UI Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Data half ACCEPT merged):** `a818df6` — `feat(opening): V2-14 learning breakpoint resume (Data half)`  
**Status:** **implemented, awaiting Integrator Experience ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No commit / push / hermes / stash / reset · No Data rewrite (contracts/domain/database/resume-service/routes untouched) · OpeningApi helpers already present (`getTeachingResume` / `postTeachingCheckpoint` / `patchTeachingActivityStatus`) — **not** re-touched · Exclusive Experience UI tree

## Authority followed

- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md`（§1.4 Experience · §6 Experience preview）
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-understand.md`
- Data Implement + ACCEPT:
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-implement.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-accept.md`
- Contracts: `packages/contracts/src/opening/teaching-resume.ts`
- OpeningApi: `apps/web/src/features/opening/client/api.ts`（consume only）
- Style mirror: `v2-12-teaching-commands-experience-implement.md`
- PM locks: resume-card + TeachingWorkspace continue entry；GET resume / POST checkpoint；`clientInit` 可 null；草稿冲突并排禁止 LWW；≠ ConversationResume；摘要独立；保留 V2-10/11/12；gate fail-soft；continuableActions

## Diff scope (Experience only)

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/resume-card.tsx` | ResumeCardView + ResumeCard；标题/状态、思路深度、草稿 chips、未解决问题、materials/job gate banners、continuableActions、Continue CTA；草稿冲突并排（禁止强制覆盖/后写优先）；暂停/恢复经 `patchTeachingActivityStatus`；同步未发送经 `postTeachingCheckpoint`（409/`draft_anchor_lost` → 并排 + 重读，无 LWW） |
| `apps/web/src/features/opening/teaching/resume-card.test.ts` | helpers（thoughtTrain / summary independence / juxtapose policy）+ SSR ResumeCardView（null clientInit、gates、并排草稿、Continue CTA） |

### Updated

| Path | Change |
|---|---|
| `apps/web/src/features/opening/teaching/teaching-workspace.tsx` | 新增 `TeachingContinueEntry`：先挂 ResumeCard；Continue 优先用 `resume.clientInit`；null → wait_init / 重拉 `getTeachingClientInit`（fail-soft）；**不**走 ConversationResume |
| `apps/web/src/features/opening/teaching/teaching-workspace.test.ts` | Continue entry：card 起步；`startInWorkspace` 进 workspace；保留 V2-10/11/12 chrome（prefs / returnDisabled / 次要自由对话） |
| `apps/web/src/features/opening/planning/today-dashboard.tsx` | teaching workspace 开启时挂 `TeachingContinueEntry`；预取 `getTeachingResume`（clientInit 可来自 resume 或回退 client-init）；resume+clientInit 双失败才提示回退摘要 |

### Explicitly not touched

- Data: `packages/contracts|domain|database` teaching-resume、`resume-service.ts`、resume/checkpoint/status routes（reuse only）
- OpeningApi：helpers 已由 Data 落地，本切片 **未**改 `client/api.ts` / `api.test.ts`
- 无新 migration / 无 `0058`
- preference-controls / block-commands 行为未改写（workspace 阶段仍挂载）
- Tutor ConversationResume / chat resume
- No commit / push / hermes / stash / reset / self-ACCEPT / `tasks.json` verified
- 无关未跟踪文档（`rp5-gha-…`、`p0-assistant-list-…`）未动

## UX summary

1. **Resume card** 展示：活动标题/状态、思路深度（branchStack / commandLog / currentBlock）、服务端草稿 chips、本地未发送 chips、openProblems、materials + job gate banners、continuableActions、**继续学习** CTA。  
2. **Continue CTA** → `TeachingContinueEntry` 进入 TeachingWorkspace；优先 `resume.clientInit`；`clientInit === null` 时 wait / 重拉 client-init，**不崩溃、不伪造讲义**。  
3. **409 / draft_anchor_lost / 版本冲突**：并排服务端 vs 本地未发送；重读 resume；文案禁止强制覆盖 / 后写优先；**无 LWW 按钮**。  
4. 本地未发送标注「未发送」；同步成功后清空本地缓冲，服务端权威。  
5. **暂停 / 恢复进行** 经已有 `OpeningApi.patchTeachingActivityStatus`（active↔paused）。  
6. 无新壳：嵌在 Today + TeachingContinueEntry；自由对话仍为次要；V2-11 prefs / V2-12 block-commands 在 workspace 阶段保留。  
7. Gate fail-soft：`in_flight|unknown|stale` / materials partial|unavailable 仍展示结构化断点与草稿。  
8. 摘要独立：卡片明示断点不依赖 AI 摘要。

## Soft gaps (honest)

1. **Browser:** `not_run` / pending_user（本切片无交互浏览器验收）。  
2. **本地未发送草稿缓冲** 仅经 ResumeCard props / 内存；未做 IndexedDB 持久化（Plan：Experience optional；Data 不要求）。  
3. **Today 双请求**：dashboard 预取 resume + ResumeCard 在无 prefetch 时也会拉；可后续去重，行为正确。  
4. **冲突后「保留哪一侧」** 需用户手动编辑后再同步；无一键「仅用服务端/仅用本地」合并助手（有意避免伪装 LWW）。  
5. Data soft gaps（live DB ownership/CAS/sanitize `not_run`）本切片不宣称。  
6. `TeachingContinueEntry` 的 Continue→workspace 交互路径以单元/SSR + mock 覆盖；完整 onClick 状态机 **not_run**（无 jsdom 用户事件套件本切片）。

## Commands run + results

### Tip

```text
$ git rev-parse --short HEAD
a818df6

$ git log -1 --oneline
a818df6 feat(opening): V2-14 learning breakpoint resume (Data half)

$ git branch --show-current
feat/opening-release

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058'
no 0058

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:36 CST
```

### Targeted vitest

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    apps/web/src/features/opening/teaching/resume-card.test.ts \
    apps/web/src/features/opening/teaching/teaching-workspace.test.ts \
    apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

 Test Files  3 passed (3)
      Tests  22 passed (22)
   Duration  ~3.32s
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

### Dirty scope (no commit)

```text
 M apps/web/src/features/opening/planning/today-dashboard.tsx
 M apps/web/src/features/opening/teaching/teaching-workspace.test.ts
 M apps/web/src/features/opening/teaching/teaching-workspace.tsx
?? apps/web/src/features/opening/teaching/resume-card.test.ts
?? apps/web/src/features/opening/teaching/resume-card.tsx
# (+ this evidence file when written)
```

## Accept ask (Integrator) — 中文交接

请 **ACCEPT** V2-14 Experience UI 半边，若满足：

1. Tip 仍为 `a818df6`（脏树仅 Experience：`resume-card*` + TeachingContinueEntry + Today 挂载；**未**改 Data contracts/domain/database/resume-service/routes；OpeningApi 仅消费既有 helpers）。  
2. Resume card 含标题/状态、思路深度、草稿 chips、openProblems、materials/job gate、Continue CTA；`clientInit` 可 null fail-soft。  
3. Continue 进入 TeachingWorkspace（优先 resume.clientInit）；409/`draft_anchor_lost`/版本冲突 → 并排对照 + 重读，**无强制覆盖 / 无 LWW**。  
4. 暂停/恢复走 `patchTeachingActivityStatus`；≠ ConversationResume；摘要不阻塞继续；保留 V2-10 workspace / V2-11 prefs / V2-12 block-commands。  
5. 定向 vitest **3 files / 22 tests** 绿 + `apps/web` tsc 干净；Browser 诚实 `not_run`。  
6. Soft gaps（浏览器、IndexedDB 缓冲、Continue 交互机 not_run、Data DB not_run）已如实记录。

**请勿**在 Integrator ACCEPT 前把 `tasks.json` 标 verified。
