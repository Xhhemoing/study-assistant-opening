# V2-10 Teaching workspace — Implement evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Stage:** Implement (product code) — **no self-ACCEPT**; ask Integrator for Implement ACCEPT  
**Branch:** `feat/opening-release`  
**Baseline tip (verified before Implement):** `5e51feeb528438549b4ad34ccdfdf51f21db5610` (`5e51fee`)  
**Hard rules honored:** no commit / push / stash / reset / hermes; no DDL; no `tasks.json` status change; no self-ACCEPT

## Authority followed

- `docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-plan.md` (Plan ACCEPT)
- `docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-understand.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-10-teaching-workspace-plan-accept.md`
- PM frozen defaults: flag `OPENING_TEACHING_WORKSPACE` default **off**; blocks only when `generateStatus === "ready"`; normalize `formula`→`math`, `steps`→`step`, `prompt`→`question`; cite in-pane `sourceRefs` first; thin HTTP + OpeningApi → existing `getClientInit`; no arbitrary HTML/JS; no preload hidden answers; wire CT-03 Today main pane; **no DDL**

## Diff scope

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/component-catalog.ts` | Allowlist + normalize + `decideBlockRender` |
| `apps/web/src/features/opening/teaching/component-catalog.test.ts` | Catalog unit tests (C1–C3, schema) |
| `apps/web/src/features/opening/teaching/block-renderer.tsx` | Tailwind-only block map; no `dangerouslySetInnerHTML` |
| `apps/web/src/features/opening/teaching/block-renderer.test.ts` | Renderer / C2 / C9 |
| `apps/web/src/features/opening/teaching/teaching-workspace.tsx` | Main-pane workspace + expandable outline/materials/drafts |
| `apps/web/src/features/opening/teaching/teaching-workspace.test.ts` | Workspace + usable gate + schema fail-soft |
| `apps/web/src/features/opening/teaching/teaching-workspace-flag.ts` | `OPENING_TEACHING_WORKSPACE` / `NEXT_PUBLIC_*` truthy parse |
| `apps/web/src/features/opening/teaching/teaching-workspace-flag.test.ts` | Flag default-off |
| `apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route.ts` | Thin GET → `getTeachingContentService().getClientInit` + zod parse |
| `apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route.test.ts` | Route unit test |

### Modified

| Path | Change |
|---|---|
| `apps/web/src/features/opening/runtime.ts` | Export `getTeachingContentService` |
| `apps/web/src/features/opening/client/api.ts` | `getTeachingClientInit(activityId)` |
| `apps/web/src/features/opening/client/api.test.ts` | ClientInit client method test |
| `apps/web/src/features/opening/planning/today-dashboard.tsx` | Flag-gated main-pane swap to `TeachingWorkspace` |
| `apps/web/src/features/opening/planning/today-dashboard-activity.test.ts` | V2-10 gate / C5 / C6 cases |

### Non-touches (intentional)

- No migrations / DDL / `00xx` SQL
- No `tasks.json` status
- No MediaReader as main pane; no AssistantView re-embed
- No reveal HTTP invented (gated UI honesty only — soft gap from Plan ACCEPT)
- Unrelated untracked evidence (`rp5-gha-…`, `p0-assistant-list-preview-…`) **not** edited

## UX summary

- Flag **off** (default): Today main pane = CT-03 `TeachingActivityPanel` / Empty; primary CTA unchanged (`data-today-primary-cta`).
- Flag **on** + activity `generateStatus === "ready"` + usable `clientInit` blocks → mount `TeachingWorkspace` (ordered allowlisted blocks; outline / materials / drafts on-demand; free chat quiet secondary).
- Otherwise honesty panel / fail-soft (fetch error, not ready, empty blocks, unknown schema) — never fake lecture; hidden `answer_key` stays redacted placeholder.

## Exact commands + results

### Baseline

```text
$ git log -1 --oneline
5e51fee feat(opening): V2-09 teaching validation layers + V2-10 plans

$ git rev-parse HEAD
5e51feeb528438549b4ad34ccdfdf51f21db5610
```

### Targeted vitest

```text
$ npx vitest run \
  apps/web/src/features/opening/teaching/component-catalog.test.ts \
  apps/web/src/features/opening/teaching/block-renderer.test.ts \
  apps/web/src/features/opening/teaching/teaching-workspace.test.ts \
  apps/web/src/features/opening/teaching/teaching-workspace-flag.test.ts \
  apps/web/src/features/opening/planning/today-dashboard-activity.test.ts \
  apps/web/src/features/opening/client/api.test.ts \
  apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route.test.ts

 RUN  v4.1.10 /workspace/study-assistant-opening

 Test Files  7 passed (7)
      Tests  71 passed (71)
   Start at  12:03:41
   Duration  4.43s (transform 1.51s, setup 0ms, import 2.88s, tests 197ms, environment 1ms)
```

**Exit code:** `0`  
**Pass counts:** 7 files / 71 tests

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
```

**Exit code:** `0` (no diagnostics)

## not_run

| Check | Status | Reason |
|---|---|---|
| Browser / user_browser / responsive / device | **`not_run`** / **`pending_user`** | Agent does not screenshot; awaits user / Implement ACCEPT browser criteria |
| E2E / Playwright | **`not_run`** | Not claimed for this slice; no new e2e authored |
| migrate / db apply | **`not_run`** | No DDL planned or applied |
| push / hermes / commit | **`not_run`** | Forbidden for Experience Implement handoff |
| Full monorepo `npm run typecheck` / `npm test` | **`not_run`** | Paula gate asked targeted vitest + `apps/web` tsc; those were run |
| Answer **reveal** HTTP | **`not_run` / absent** | Soft gap from Plan ACCEPT — UI keeps `answer_hidden` gated; no client plaintext |

## Soft gaps (honest, for Integrator)

1. Reveal endpoint still absent — “查看解析” remains fail-soft / honesty via `answer_hidden` placeholder; no preload.
2. Client flag: `OPENING_TEACHING_WORKSPACE` **or** `NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE` (browser needs `NEXT_PUBLIC_` for client bundle); default off.
3. Math = monospace plaintext / `code` (no KaTeX package in tree); never `eval`.
4. Draft save / submit buttons are descriptive only until draft-anchors route is wired from UI (service already exists server-side).

## Accept ask (Integrator)

Please independently **Implement ACCEPT** V2-10 against this evidence + Plan ACCEPT + PM frozen defaults.  
AIstudy Experience does **not** self-ACCEPT / self-verify `tasks.json`.

### Suggested ACCEPT checklist

- [ ] Catalog allowlist only; unknown → fail-soft; siblings still render (C1)
- [ ] Hidden `answer_key` never plaintext (C2)
- [ ] No `dangerouslySetInnerHTML` of model HTML (C9)
- [ ] Single Today primary CTA retained (C5); flag off → CT-03 panel (C6)
- [ ] Route = `GET /api/opening/teaching-activities/[id]/client-init` wraps existing `getClientInit`
- [ ] No DDL
- [ ] Browser checks remain `pending_user` until user

## Room-ready Chinese handoff (Integrator Accept)

V2-10 教学工作区已实现（未 commit）：组件目录 + BlockRenderer + TeachingWorkspace；薄路由 `GET .../teaching-activities/[id]/client-init` 调现有 `getClientInit`；OpeningApi 已加方法；Today 在 `OPENING_TEACHING_WORKSPACE` 开启且 `generateStatus===ready` 且 clientInit 可用时挂载工作区，否则保持 CT-03 活动面板诚实态。默认 flag 关闭。定向 vitest 7 文件 / 71 通过；`apps/web` tsc 通过。浏览器/e2e/migrate 标 `not_run`。请 Integrator 独立 Implement ACCEPT；Experience **不**自标 ACCEPT。
