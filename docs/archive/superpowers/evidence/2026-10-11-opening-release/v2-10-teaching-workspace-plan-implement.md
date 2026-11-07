# V2-10 Teaching workspace — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`) — **matches required tip** (V2-08 merged)  
**Stage:** Understand → Plan only. **No product Implement. No migrations/ALTER/DDL. No push / hermes / stash / reset / commit.**  
**Status:** **Plan only — not ACCEPT** (await Integrator Plan ACCEPT/REJECT)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-10-teaching-workspace-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `apps/web/src/features/opening/teaching/teaching-workspace.tsx`
- No `apps/web/src/features/opening/teaching/block-renderer.tsx`
- No `apps/web/src/features/opening/teaching/component-catalog.ts`
- No edits to `activity-panel.tsx`, `today-activity.ts`, `today-dashboard.tsx`, `client/api.ts`, `teaching-content-service.ts`
- No edits to `packages/contracts`, `packages/database`, `packages/domain`, `packages/ai`, worker
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence files present in tree were **not** created or modified by this slice (e.g. `rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`)
- Did **not** edit V2-09 docs (AI writing Plan in parallel)

## Tip / branch verification

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
f5dae08 feat(opening): V2-08 teaching plan outline + compiler

$ test ! -f apps/web/src/features/opening/teaching/teaching-workspace.tsx \
  && test ! -f apps/web/src/features/opening/teaching/block-renderer.tsx \
  && test ! -f apps/web/src/features/opening/teaching/component-catalog.ts \
  && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0053_opening_teaching_activities.sql
packages/database/src/migrations/0054_opening_teaching_content.sql
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql
```

**Result:** tip OK (`f5dae08`). Proposed workspace files **absent**. Migrations tip ends at **0055**; V2-10 Plan = **no DDL**.

## Inventory commands / Reads

### Tip confirm

```text
$ git log -1 --oneline
f5dae08 feat(opening): V2-08 teaching plan outline + compiler

$ git status --short
(at start: unrelated untracked evidence only; this slice adds the three docs above)
```

**Result:** exit 0 — matches required baseline `f5dae08`.

### Plan §V2-10 + tasks + UX policy

```text
$ Read docs/superpowers/plans/ai-led-learning-v2/plan.md L525–543
$ Read tasks.json task id V2-10 (python extract)
$ Read docs/product/UX_AND_AI_POLICY.md (layers, homepage budget, AI代学, a11y)
$ Read style refs: v2-05-teaching-content-understand.md / plan.md; v2-08-teaching-plan-understand.md / plan.md
$ Read ct-03-today-activity-accept.md (ACCEPT attach)
```

**Result:** scope/reuse/proposed paths/acceptance/rollback aligned with PM assignment; Experience owner; deps V2-03/V2-05.

### CT-03 Today / activity panel attach

```text
$ Read apps/web/src/features/opening/teaching/activity-panel.tsx
$ Read apps/web/src/features/opening/teaching/today-activity.ts
$ Read apps/web/src/features/opening/planning/today-dashboard.tsx
$ rg -n "data-today-primary-cta|TeachingActivityPanel|runPrimaryCta|todayActivityCtaLabel" \
    apps/web/src/features/opening/planning/today-dashboard.tsx \
    apps/web/src/features/opening/teaching/
```

**Result:** exit 0 — single primary CTA; main pane = panel/empty; free chat quiet secondary; honesty when no lecture.

### V2-05 clientInit / redact

```text
$ Read packages/contracts/src/opening/teaching-content.ts
$ Read packages/contracts/src/opening/teaching-content.test.ts (clientInit hidden answer)
$ Read apps/web/src/features/opening/teaching/teaching-content-service.ts (getClientInit)
$ Read packages/database/src/repositories/opening-teaching-content.ts \
    (redactBlocksForClientInit, sanitizeCheckpointForRestore, getClientInit)
$ rg -n "getClientInit|client-init" apps/web/src/app/api apps/web/src/features/opening/client/api.ts
```

**Result:** exit 0 — contracts + server redact + service `getClientInit` landed. **Gap confirmed:** no HTTP route under `app/api/opening` for clientInit; OpeningApi has teaching-activity CRUD only (no getTeachingClientInit). Plan includes thin client wire as Implement-later.

### Cite / MediaReader patterns (non-goals vs reuse)

```text
$ Read apps/web/src/features/opening/sources/media-reader.tsx (limit)
$ Read apps/web/src/features/opening/knowledge/knowledge-evidence.tsx (limit)
$ rg -n "MediaReader|evidenceTargetsForNode" apps/web/src/features/opening apps/web/src/features/courses
```

**Result:** MediaReader is course/select mount — **not** Today main pane. knowledge-evidence provides honest cite link patterns. V2-10 Plan: in-pane evidence first; MediaReader seek OOS as primary.

### Design tokens / proposed files absent

```text
$ Read apps/web/src/features/opening/design/ui.tsx (ui.primary / quiet / badge)
$ test ! -f …/teaching-workspace.tsx && … block-renderer && … component-catalog → absent
```

### Additional Reads (completed; no product mutation)

| Path | Purpose |
|---|---|
| `plan.md` §V2-10; `tasks.json` V2-10 | Authority + PM wording |
| `UX_AND_AI_POLICY.md` | Homepage budget / AI代学 / a11y |
| `activity-panel.tsx` / `today-activity.ts` / `today-dashboard.tsx` | CT-03 attach |
| `teaching-content.ts` + test + service + repo redact | clientInit / no preload answers |
| `media-reader.tsx` / `knowledge-evidence.tsx` | cite-without-leaving / non-goal seek |
| `design/ui.tsx` | Tailwind token reuse |
| `ct-03-today-activity-accept.md` | ACCEPT baseline |
| `v2-05-*` / `v2-08-*` understand+plan | Doc shape |
| migrations tip `0055_…` | Confirm no DDL for V2-10 |

## Product tests — status

| Check | Status | Reason |
|---|---|---|
| vitest catalog / renderer / workspace | **`not_run`** | Plan stage; modules not landed |
| vitest today-dashboard-activity / api / teaching-content contracts | **`not_run`** | Docs-only; not re-executed this slice |
| Browser / E2E / responsive / device | **`not_run`** / **`pending_user`** | N/A this slice; Implement later needs user accept |
| tsc / typecheck | **`not_run`** | Docs-only |
| migrate | **`not_run`** | None planned (UI-only, no DDL) |
| push / hermes | **`not_run`** | Forbidden this slice |

## Plan summary (for Accept)

1. Experience owns three **proposed_new** files: `component-catalog.ts`, `block-renderer.tsx`, `teaching-workspace.tsx`.  
2. Wire into CT-03 Today **main pane**; **reuse** primary CTA「继续/开始学习」; free chat stays quiet secondary.  
3. Render from V2-05 **`ActivitySpecClientInit`** only; thin HTTP + OpeningApi for `getClientInit` (server redact already exists).  
4. Catalog allowlist: **text/math/step/example/question/draft/evidence**; Tailwind only; unknown schema/component **fail-soft**.  
5. **No** arbitrary HTML/JS; **no** preload hidden answers; actions **server-authorized**.  
6. Cite in-pane from `sourceRefs`; do **not** require MediaReader to start learning.  
7. Feature flag rollback → old panel; content read-only; no static AI disguise.  
8. **No migration / DDL**.  
9. Product tests `not_run`; browser `pending_user` at Implement.

## Ask Integrator

**Please Plan ACCEPT** (or REJECT with gaps) before any product Implement.  
This evidence **does not** self-ACCEPT / self-verify / move `tasks.json`.

## Verdict this slice

- Understand + Plan **written**.  
- Tip still `f5dae08…` at evidence time.  
- Confirm: **no Implement / no migration / no push / no hermes / no commit** performed by this agent.  
- Working tree product/app/package source trees: **unchanged by this agent** (docs only).  
- Await Integrator **Plan ACCEPT**.
