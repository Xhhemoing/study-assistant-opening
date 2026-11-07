# V2-10 Teaching workspace — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Experience)  
**Stage:** Implement ACCEPT  
**Branch:** `feat/opening-release`  
**Tip (verified):** `5e51feeb528438549b4ad34ccdfdf51f21db5610` (`5e51fee`) — dirty product land (V2-10 uncommitted); no commit expected  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Authority:** Plan ACCEPT + Plan + Implement claim + PM (CT-03 panel + V2-05 clientInit; flag default off; ready blocks; no HTML/JS; no preload answers; Continue/Start primary CTA; no DDL)  
**PM steering (this Accept):** browser/e2e/migrate not run → label **`not_run`** (not automatic REJECT)

## Verdict

**ACCEPT**

Independent stronger review matches plan + PM frozen defaults; claimed vitest (71) and `apps/web` tsc re-run green; tests not loosened; browser/e2e/migrate honestly `not_run` per plan C10 + Plan ACCEPT soft deferral + PM clarification. No product fixes applied; no push/hermes/commit.

## Tip / dirty tree

```text
$ git rev-parse HEAD
5e51feeb528438549b4ad34ccdfdf51f21db5610

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
5e51fee feat(opening): V2-09 teaching validation layers + V2-10 plans

$ git status --short (product + this accept)
 M apps/web/src/features/opening/client/api.test.ts
 M apps/web/src/features/opening/client/api.ts
 M apps/web/src/features/opening/planning/today-dashboard-activity.test.ts
 M apps/web/src/features/opening/planning/today-dashboard.tsx
 M apps/web/src/features/opening/runtime.ts
?? apps/web/src/app/api/opening/teaching-activities/[id]/client-init/
?? apps/web/src/features/opening/teaching/block-renderer.test.ts
?? apps/web/src/features/opening/teaching/block-renderer.tsx
?? apps/web/src/features/opening/teaching/component-catalog.test.ts
?? apps/web/src/features/opening/teaching/component-catalog.ts
?? apps/web/src/features/opening/teaching/teaching-workspace-flag.test.ts
?? apps/web/src/features/opening/teaching/teaching-workspace-flag.ts
?? apps/web/src/features/opening/teaching/teaching-workspace.test.ts
?? apps/web/src/features/opening/teaching/teaching-workspace.tsx
(+ unrelated untracked evidence; + this accept file)
```

**Migrations tip still ends `0055`** — no new DDL.

## Stronger review (diff vs plan)

| Area | Path(s) | Result |
|---|---|---|
| Component catalog | `teaching/component-catalog.ts` (+ test) | **Pass** — allowlist `text/math/step/example/question/draft/evidence`; normalize `formula→math`, `steps→step`, `prompt→question`; unknown/illegal → fail-soft; answer_key → `answer_hidden` |
| Block renderer | `teaching/block-renderer.tsx` (+ test) | **Pass** — Tailwind-only map; no `dangerouslySetInnerHTML` in source (C9 asserted by reading `.tsx`); math = monospace/`code` plaintext |
| Teaching workspace | `teaching/teaching-workspace.tsx` (+ test) | **Pass** — ordered blocks; expand outline/materials/drafts; displays `verificationStatus` only; free chat quiet Link; usable gate `generateStatus==="ready"` + non-empty blocks |
| Flag | `teaching/teaching-workspace-flag.ts` (+ test) | **Pass** — `OPENING_TEACHING_WORKSPACE` / `NEXT_PUBLIC_*`; default **off** (`{}` → false) |
| Today dashboard wire | `planning/today-dashboard.tsx` (+ activity test) | **Pass** — flag off → CT-03 panel; flag on + ready + usable clientInit → `TeachingWorkspace`; else honesty panel; single `data-today-primary-cta` retained (C5/C6) |
| client-init API route | `app/api/opening/teaching-activities/[id]/client-init/route.ts` (+ test) | **Pass** — thin GET → `getTeachingContentService().getClientInit` + `activitySpecClientInitSchema.parse` |
| API client | `client/api.ts` (+ test) | **Pass** — `getTeachingClientInit` → same path; zod parse |
| runtime export | `runtime.ts` | **Pass** — `getTeachingContentService` exported for route |

### PM constraint checklist

| Constraint | Evidence | Result |
|---|---|---|
| Flag default **off** | `isOpeningTeachingWorkspaceEnabled({}) === false`; Today uses prop/env default | **Pass** |
| Ready-gated content | `isTeachingWorkspaceContentUsable` requires `generateStatus==="ready"`; Today only fetches clientInit when ready | **Pass** |
| No HTML/JS injection | Catalog strips `html`/`script`/`dangerouslySetInnerHTML`; illegal `javascript:`/`data:`; renderer source has no `dangerouslySetInnerHTML` | **Pass** |
| No answer preload | Hidden `answer_key` → `answer_hidden`; content null / revealState hidden; route comment + redact via service | **Pass** |
| Continue/Start primary CTA | Single `data-today-primary-cta`; workspace does not add competing primary (C5 test) | **Pass** |
| No DDL | Migrations end `0055`; no new SQL in diff | **Pass** |
| No steal AI V2-09 validation | Workspace displays `verificationStatus` string only; no verifier/validation ownership in Experience paths | **Pass** |
| Tests not loosened | No `skip`/`xit`/`xdescribe` in named suites; C1/C2/C5/C6/C9 asserted specifically | **Pass** |

## Re-runs (Integrator)

### vitest (repo root)

```text
$ PATH="./node_modules/.bin:$PATH" npx vitest run \
  apps/web/src/features/opening/teaching/component-catalog.test.ts \
  apps/web/src/features/opening/teaching/block-renderer.test.ts \
  apps/web/src/features/opening/teaching/teaching-workspace.test.ts \
  apps/web/src/features/opening/teaching/teaching-workspace-flag.test.ts \
  apps/web/src/features/opening/planning/today-dashboard-activity.test.ts \
  apps/web/src/features/opening/client/api.test.ts \
  'apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route.test.ts'

 RUN  v4.1.10 /workspace/study-assistant-opening

 Test Files  7 passed (7)
      Tests  71 passed (71)
   Start at  12:06:18
   Duration  4.47s

Exit: 0
```

### tsc (`apps/web`)

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
EXIT:0
```

## Browser gate decision

**`not_run` / `pending_user` — does not block ACCEPT for this slice.**  
Plan §C10 and Plan ACCEPT soft gap #8 explicitly defer browser/responsive/device to user (`pending_user`); PM steering 2026-10-11: label `not_run`, not automatic REJECT. Gates “browser required-by-plan but not run blocks ACCEPT” does not apply as a hard reject here because the plan text itself marks C10 as pending_user until user, not as an agent-run acceptance criterion for Implement ACCEPT.

## not_run

| Check | Status | Reason |
|---|---|---|
| Browser / user_browser / responsive / device | **`not_run`** / **`pending_user`** | Plan C10 + Plan ACCEPT + PM: agent does not screenshot; user later |
| E2E / Playwright | **`not_run`** | Not authored/claimed for this slice |
| migrate / db apply | **`not_run`** | No DDL |
| Full monorepo typecheck / full test suite | **`not_run`** | Gate asked targeted vitest + apps/web tsc only |
| Answer reveal HTTP | **`not_run` / absent** | Soft gap — UI keeps answer_hidden; no client plaintext |
| push / hermes / commit | **`not_run`** | Forbidden for this Accept |

## Soft gaps (honest; do not overturn ACCEPT)

1. Reveal endpoint still absent — “查看解析” stays fail-soft via `answer_hidden`; no preload.
2. Client flag dual env (`OPENING_TEACHING_WORKSPACE` + `NEXT_PUBLIC_*`) for bundle; default off.
3. Math = monospace plaintext (no KaTeX in tree); never eval.
4. Draft save/submit descriptive only until draft-anchors UI wired (service exists server-side).
5. Browser/responsive/device remain **`pending_user`** until user.
6. Unrelated untracked evidence files (`rp5-gha-…`, `p0-assistant-list-preview-…`) untouched.

## Scope confirmation

- Integrator re-ran named checks; did **not** fix product.
- Integrator did **not** commit / push / stash / reset / hermes / migrate.
- Integrator did **not** change `tasks.json` here (status move to `verified` is a separate PM/tasks step if desired).

## One-line summary

**ACCEPT** tip `5e51fee` dirty; vitest 71 / tsc 0; browser `not_run` per plan C10+PM; soft gaps: reveal API, math plaintext, draft UI, pending_user browser.
