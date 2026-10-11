# V2-10 Teaching workspace — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy Experience)  
**Stage:** Plan ACCEPT only (no product Implement, no migration, no push / hermes / stash / reset / commit)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`)  
**Baseline:** V2-08 merged at tip; dirty tree = V2-10 (+ V2-09 parallel) plan docs + unrelated untracked evidence only  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop Plan gate (stronger review of design claims vs code)  
**Docs reviewed:**
- `docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-plan.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-10-teaching-workspace-plan-implement.md` (Plan-stage evidence filename)
- Authority: `plan.md` §V2-10 (L525–543); `tasks.json` V2-10; CT-03 ACCEPT; V2-05 contracts/redact

## Verdict

**ACCEPT**

Plan matches PM claimed alignment (CT-03 panel + V2-05 clientInit; no HTML/JS; no preload answers; Continue/Start primary CTA; **no DDL**; Plan-only), tip `f5dae08` surfaces, and Experience ownership without stealing AI V2-09 validation scope. Soft gaps listed for Implement Accept (do not overturn ACCEPT).

## Tip / tree verification

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
f5dae08 feat(opening): V2-08 teaching plan outline + compiler

$ git status --short
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-plan-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-10-teaching-workspace-plan-implement.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-plan.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-understand.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-plan.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-understand.md
(+ this accept evidence file after write)

$ test ! -f apps/web/src/features/opening/teaching/teaching-workspace.tsx \
  && test ! -f apps/web/src/features/opening/teaching/block-renderer.tsx \
  && test ! -f apps/web/src/features/opening/teaching/component-catalog.ts && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056*
```

**Result:** tip OK. Proposed workspace modules **not** landed (Plan-only scope honored). Migrations tip ends at **0055** — V2-10 claims **no DDL** correctly.

## Claimed PM alignment (verify)

| Claim | Plan / Understand coverage | Spot-check | Result |
|---|---|---|---|
| CT-03 panel + V2-05 clientInit | Understand §2–3; Plan §2–3, T-C/T-D/T-E | `today-dashboard.tsx` mounts `TeachingActivityPanel` / Empty; `data-today-primary-cta` → `runPrimaryCta`; `getClientInit` on service L93–96 + repo L422+; `activitySpecClientInitSchema` + `redactBlocksForClientInit` | **Pass** |
| No HTML/JS (no raw HTML/JS injection) | Plan §4.1 rejected catalog; T-B rejects `dangerouslySetInnerHTML`; C9 | No `dangerouslySetInnerHTML` under `teaching/` today; allowlist excludes `html`/`script`/`iframe` | **Pass** |
| Do not preload answers | Plan §5; C2; contracts superRefine | `answer_key` + `revealState=hidden` forbids non-null `content` (`teaching-content.ts` L156–166); redact strips plaintext | **Pass** |
| Continue/Start as primary CTA | Plan §3, C5; CT-03 ACCEPT | `todayActivityCtaLabel` →「继续学习」/「开始学习」; single `data-today-primary-cta`; empty pane reuses `runPrimaryCta` | **Pass** |
| **No DDL** | Plan §8; Understand OOS | Tip migrations end `0055`; V2-05 `0054` already landed content tables | **Pass** |
| Plan-only (no product Implement) | Plan §1, §15; claim evidence | Product teaching tree unchanged; only docs untracked | **Pass** |

## Stronger-review table (claims vs tip `f5dae08`)

| Claim | File / API on tip | Result |
|---|---|---|
| Today primary CTA + activity panel (CT-03 ACCEPT) | `today-dashboard.tsx` L16, L95, L154–155, L208–215; `activity-panel.tsx` panel + empty; `today-activity.ts` CTA/honesty helpers; CT-03 accept evidence | **Pass** |
| Main pane = metadata panel only (no block render yet) | `activity-panel.tsx` intentSummary + badges + honesty; honesty still admits full AI 主讲 may be later | **Pass** (gap correctly owned by V2-10) |
| Proposed paths match `plan.md` / `tasks.json` | `teaching-workspace.tsx`, `block-renderer.tsx`, `component-catalog.ts` under `features/opening/teaching/` | **Pass** (absent = `proposed_new`) |
| V2-05 clientInit contracts | `activitySpecClientInitSchema`, `activitySpecClientBlockSchema`, `teachingAnswerRefSchema`, `teachingSourceRefSchema`; roles `teach\|prompt\|example\|answer_key\|meta` | **Pass** |
| Server redact + `getClientInit` | `redactBlocksForClientInit` / `sanitizeCheckpointForRestore` in `opening-teaching-content.ts`; service `getClientInit` | **Pass** |
| No browser clientInit HTTP yet | `rg getClientInit\|client-init` under `app/api/opening` + `OpeningApi` → **empty**; OpeningApi has activity CRUD only (`list/create/get/associateTeachingActivity*`); api routes under `teaching-activities/` only | **Pass** (Plan T-D thin wire honest) |
| Catalog ids vs library `blockType` | Plan normalize map (`formula`→`math`, `steps`→`step`, `prompt`→`question`); unknown→fail-soft | **Pass** (design; Implement must land) |
| Cite without leaving context | `knowledge-evidence.tsx` + `media-reader.tsx` exist; Plan: in-pane `evidence` first; MediaReader seek OOS as primary | **Pass** |
| Design tokens | `design/ui.tsx` `ui.primary` / `ui.quiet` / `ui.badge` used by panel | **Pass** |
| Feature-flag rollback precedent | `isOpeningRelease` / `OPENING_RELEASE` truthy parse in `access-policy.ts` L11–16; Plan proposes `OPENING_TEACHING_WORKSPACE` (dedicated, not product-wide mode) | **Pass** (name soft; pattern exists) |
| No steal AI V2-09 validation | Plan §1, §12, §14: display `verificationStatus` only; V2-09 Plan explicitly leaves `apps/web` to Experience; AI owns `teaching-validation` / `teaching-verifiers` | **Pass** |
| Experience ownership clear | Owner 前端/交互; T-A–T-F Experience; Data owns redact; AI owns compile/verify | **Pass** |
| Acceptance tests cannot pass without CTA / no-preload / no-HTML | C2 (hidden answer never plaintext — forbids mocking content non-null); C5 (single `data-today-primary-cta`); C9 (no `dangerouslySetInnerHTML` of model HTML); C1 allowlist; C3 illegal links | **Pass** (Plan-stage design; Implement Accept must enforce) |
| Scope = docs only this handoff | Claim evidence + tree status; proposed modules absent | **Pass** |

### Invented / soft-named pieces (not REJECT)

| Sketch | Reality on tip | Integrator note |
|---|---|---|
| `OpeningApi.getTeachingClientInit` + HTTP route | **Absent** — service/repo `getClientInit` only | Soft gap #1 — Implement T-D must add thin route + client method wrapping existing service; zod-parse `activitySpecClientInitSchema`; no unredacted body |
| Exact route path | Plan says `GET` or “existing teaching-content route group” | Soft gap #2 — pick e.g. `teaching-activities/[id]/client-init` (or sibling) at Implement; document in implement evidence |
| `OPENING_TEACHING_WORKSPACE` flag | Not in env today; `OPENING_RELEASE` is product-wide | Soft gap #3 — Implement adds dedicated helper (mirror truthy parse); default **off** |
| Answer **reveal** HTTP | Contracts have `revealState`; redact/hidden enforce; `saveDraftAnchors` exists on service/repo; **no** reveal route under `app/api/opening` yet | Soft gap #4 — gated “查看解析” must stay disabled / fail-soft until server reveal lands (or reuse an authorized help path); do **not** invent client plaintext |
| Math path (KaTeX vs plaintext) | Plan: prefer safe math if present else plaintext | Soft gap #5 — Implement picks existing safe pipeline; never `eval` |
| Usable-content gate vs V2-09 | Plan default: `generateStatus === "ready"` **or** V2-09 verified/structure_ok when available | Soft gap #6 — until V2-09 lands, honesty panel when not ready; never fake lecture |

None drop a PM constraint or invent silent DDL.

## DDL decision

| Item | Decision |
|---|---|
| New DDL for V2-10? | **No** |
| Why | UI + thin clientInit HTTP only; tables/redact already in V2-05 `0054` |
| Invent migration number? | **Do not.** Tip ends `0055`. |

## Ownership / V2-09 boundary

| Role | V2-10 Plan | Integrator check |
|---|---|---|
| Experience | catalog, renderer, workspace, Today wire, thin clientInit HTTP/API | Matches `tasks.json` owner_role 前端/交互 |
| Data | landed `getClientInit` / redact | Experience consumes; no browser re-redact |
| AI (V2-09 parallel) | verifiers / publish gate; **no `apps/web`** | V2-10 displays status only — **no steal** |
| Integrator | Plan/Implement ACCEPT | This document = Plan ACCEPT only |

## Soft gaps / honesty (do not overturn ACCEPT)

1. **clientInit HTTP + OpeningApi** absent — Implement T-D thin wrap of existing `getClientInit`.  
2. **Exact route path** underspecified — choose at Implement; record in implement evidence.  
3. **Feature flag** `OPENING_TEACHING_WORKSPACE` proposed; default off; mirror `isOpeningRelease` parse style.  
4. **Reveal endpoint** not on tip — keep reveal CTA server-gated; do not preload.  
5. **Math render** pipeline choice; never eval / raw HTML.  
6. **Usable gate** vs V2-09 statuses — honesty until ready; align when V2-09 presentation helpers exist.  
7. **Plan-stage product checks** C1–C10 / vitest / tsc / browser — honestly **`not_run`**.  
8. **Browser / responsive / device** remain **`pending_user`** at Implement Accept (agent no screenshots).  
9. **Normalize map** defaults (`formula`→`math`, etc.) — escalate only if PM disagrees.

## Open decisions for PM

**None that block Plan ACCEPT.** If Plan-ACCEPTed without comment, treat Plan §13 defaults as confirmed:

1. Flag `OPENING_TEACHING_WORKSPACE` (default off).  
2. Usable content when clientInit readable / ready (or V2-09 policy when available).  
3. Normalize map as stated; unknown→fail-soft.  
4. Cite in-pane first; MediaReader quiet secondary.  
5. Thin HTTP → `getClientInit` only.  
6. No DDL.  
7. A11y: keyboard expanders; status not color-only; math text fallback where feasible.

## Acceptance-test strength (Plan gate)

| Rule | Guard in Plan | Could tests pass without it? |
|---|---|---|
| Single Continue/Start CTA | C5 forbids “checking only workspace heading” | **No** if Implement lands C5 as written |
| No preload hidden answers | C2 forbids mocking non-null answer content | **No** if C2 asserted against real clientInit shape |
| No arbitrary HTML/JS | C9 forbids `dangerouslySetInnerHTML` of model HTML; C1 allowlist | **No** if C9/C1 run on renderer source + unknown blockType |

**Implement Accept must** re-run named vitest files and confirm C2/C5/C9 cannot be skipped; browser checks stay `pending_user` / `not_run` until user.

## Scope confirmation

- Integrator did **not** implement product code.  
- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** change `tasks.json` status.  
- Integrator did **not** self-ACCEPT Experience Implement (this is Plan ACCEPT of Experience-authored Plan only).

## not_run (Plan ACCEPT)

| Check | Status | Reason |
|---|---|---|
| vitest catalog / renderer / workspace / today-dashboard / api | **`not_run`** | Modules / wire not landed |
| vitest teaching-content contracts regression | **`not_run`** | Plan stage; no product change this slice |
| tsc / typecheck | **`not_run`** | Docs-only |
| Browser / E2E / responsive / device | **`not_run`** / **`pending_user`** | N/A Plan; required at Implement Accept when criteria apply |
| migrate apply | **`not_run`** | No DDL planned |
| push / hermes / commit | **`not_run`** | Forbidden |

Per gates: Plan Accept does not require re-running product tests never claimed as run.

## Handoff

1. **Plan ACCEPT** recorded — PM may open Implement gate later.  
2. Implement must keep: no DDL; wire CT-03 CTA unchanged; catalog allowlist only; clientInit-only body; no HTML/JS; no preload answers; server-authorize actions; flag rollback; cite in-pane; fail-soft unknown schema/component.  
3. Independent **Implement ACCEPT** required after product work (implementer ≠ accepter); browser checks `pending_user` until user.

## One-line soft gaps

clientInit HTTP/API absent (thin T-D); route path TBD; flag name default-off; reveal API not on tip (keep gated); math pipeline choice; usable-gate vs V2-09; C1–C10/vitest/browser `not_run`/`pending_user`.
