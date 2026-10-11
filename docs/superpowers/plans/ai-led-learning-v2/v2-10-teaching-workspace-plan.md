# V2-10 Plan — AI teaching workspace + controlled block render

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch tip:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`, `feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no migrations/ALTER/DDL · no push / hermes / stash / reset / commit · no `tasks.json` status changes  
**Align:** `plan.md` §V2-10; `tasks.json` V2-10; Understand `v2-10-teaching-workspace-understand.md`; V2-03/V2-05/CT-03 landed; `docs/product/UX_AND_AI_POLICY.md`; `review-test-gates.md`  
**Source refs:** E03, E04, C01, C14  
**Owner:** Experience（前端/交互）

## 1. Sequencing

```
Understand (docs, this slice)
    → Integrator Plan ACCEPT (independent; no self-ACCEPT)
        → PM may open Implement gate later
            → Implement (catalog + renderer + workspace + thin clientInit HTTP/API + Today main-pane wire)
                → Independent Implement ACCEPT (+ user_browser pending_user)
```

- This slice delivers **Understand + Plan + plan-stage evidence only**.
- V2-09 verification (AI, parallel) is **orthogonal**: workspace displays `verificationStatus` honestly; does not implement verifiers.
- V2-11 prefs / V2-12 local commands stay out of this Plan.

## 2. Smallest design

Three **proposed_new** modules under existing teaching feature + thin wire into CT-03 Today main pane + thin clientInit client surface — **no DDL**.

| Piece | Path | Status | Responsibility |
|---|---|---|---|
| **Component catalog** | `apps/web/src/features/opening/teaching/component-catalog.ts` | `proposed_new` | Allowlist ids + param schemas + `blockType`→catalog normalize; unknown → fail-soft descriptor |
| **Block renderer** | `apps/web/src/features/opening/teaching/block-renderer.tsx` | `proposed_new` | Pure(ish) map: one clientInit block → React via catalog; Tailwind only; no HTML/JS eval |
| **Teaching workspace** | `apps/web/src/features/opening/teaching/teaching-workspace.tsx` | `proposed_new` | Main-pane shell: render ordered blocks; expandable outline / materials / drafts; cite panel; honesty when empty/not ready |
| **Today wire** | `apps/web/src/features/opening/planning/today-dashboard.tsx` (+ keep `activity-panel.tsx`) | **existing** | When flag + data ready, main column mounts workspace instead of metadata-only panel; **reuse** primary CTA |
| **clientInit client** | Opening API route (**proposed_new** under `apps/web/src/app/api/opening/…`) + `OpeningApi` method (**edit** `client/api.ts`) | thin wire | Call existing `createOpeningTeachingContentService().getClientInit` — no new Data semantics |

```
Today primary CTA (CT-03, unchanged semantics)
        │
        ▼
pickCurrentTeachingActivity / createTeachingActivity
        │
        ▼
[flag OFF] ──► TeachingActivityPanel / Empty (CT-03 honesty)
[flag ON ] ──► fetch getTeachingClientInit(activityId)
                    │
                    ├─ missing / not ready / error → ActivityPanel honesty (no fake lecture)
                    └─ ActivitySpecClientInit
                            │
                            ▼
                   TeachingWorkspace
                     ├─ BlockRenderer × blockOrder
                     │     └─ component-catalog allowlist
                     ├─ expandable: outline / sourceRefs / drafts (on demand)
                     └─ actions → server-authorized endpoints only
```

## 3. How workspace replaces/extends activity-panel main pane

| Mode | Main pane | CTA / chrome |
|---|---|---|
| **Empty activity** | Keep `TeachingActivityEmpty` (CT-03) |「开始学习」= `runPrimaryCta` |
| **Activity, flag off** | Keep `TeachingActivityPanel` metadata + honesty |「继续学习」selects activity |
| **Activity, flag on, no usable clientInit** | Keep panel or workspace “preparing” honesty using `teachingActivityContentHonesty` — **no** static AI lecture | same CTA |
| **Activity, flag on, usable clientInit** | Mount **`TeachingWorkspace`** as main pane body (replaces metadata-only panel content) | same primary CTA; free chat stays `ui.quiet` secondary |
| **Rollback** | Flag off → panel; previously rendered content remains readable if Data still serves clientInit (read-only path OK) | no static samples disguised as AI |

**Do not:** re-embed `AssistantView` in main pane; invent a second `/opening/teaching` shell; make MediaReader the main pane.

## 4. Component catalog allowlist + unknown fail-soft

### 4.1 Allowlist (PM / plan.md)

| Catalog id | Intent | Typical library `blockType` / role inputs (normalize) | Notes |
|---|---|---|---|
| `text` | Prose teach | `text`, `meta` teach copy | Tailwind typography only; escape/plain React text — **no** raw HTML |
| `math` | Formula | `formula`, `math` | Prefer existing safe math path if present; else plaintext/KaTeX-safe pipeline — never `eval` |
| `step` | Ordered steps | `steps`, `step` | Ordered list UI |
| `example` | Worked example | `example` + role `example` | |
| `question` | Prompt / try | `prompt`, `question` + role `prompt` | Draft capture → server draft-anchors; not local “grade” |
| `draft` | Personal draft UI | checkpoint / draft anchors | Separated from answer_key body |
| `evidence` | Cite / sourceRefs | driven by `teachingSourceRefSchema` | In-pane expandable; quiet deep-link secondary |

**Rejected catalog entries (M1):** `html`, `script`, `iframe`, `raw_markdown_html`, OpenMAIC widgets, arbitrary `component: "AnyReact"`.

### 4.2 Unknown / illegal schema fail-soft

```ts
// sketches — not implemented this slice
export type CatalogId =
  | "text" | "math" | "step" | "example" | "question" | "draft" | "evidence";

export function normalizeToCatalogId(blockType: string, role: string): CatalogId | "unknown";

export type RenderDecision =
  | { ok: true; catalogId: CatalogId; params: Record<string, unknown> }
  | { ok: false; reason: "unknown_component" | "illegal_link" | "illegal_action" | "unknown_schema_version" | "answer_hidden" };

export function decideBlockRender(block: ActivitySpecClientInit["blocks"][number], opts: { schemaVersion?: string }): RenderDecision;
```

- `ok: false` → render a single honest placeholder card (zinc, `role="status"`) with reason; **continue** remaining blocks (partial render).
- `role === "answer_key"` && `answerRef.revealState === "hidden"` → never render plaintext; show gated “查看解析” control that calls **server** reveal — until authorized, content stays null.
- Illegal `http(s)` / `javascript:` / data URLs in params → strip / reject link; fail-soft.
- Unknown `schemaVersion` (if present on generationConfig.extras) → whole workspace fail-soft banner + metadata panel fallback; do not crash Today shell.

### 4.3 Model picks components+params; client does not invent

Upstream compile (V2-08) emits library blocks + `blockOrder`; Experience only **maps** to catalog. Client must not invent new blockTypes from chat text.

## 5. No preload answers / server-authorize actions

| Rule | Mechanism (existing vs proposed) |
|---|---|
| No hidden answer plaintext in client init | **Existing:** `activitySpecClientInitSchema` superRefine + `redactBlocksForClientInit` |
| No answers in checkpoint restore dumps | **Existing:** `sanitizeCheckpointForRestore` |
| UI never “optimistically” embeds answer_key from another API | **Plan rule:** workspace only consumes clientInit (+ explicit reveal response) |
| Reveal / submit / follow-up | **Server-authorized** endpoints (help exposure / draft anchors / tutor turn as already scoped) — client buttons disabled until call succeeds |
| Anti AI代学 (UX policy §5) | Prefer attempt (`question`/`draft`) before reveal; reveal is user-initiated |

## 6. Files (existing vs proposed) + approach + rejected alternatives

| ID | Owner | Deps | Files | Approach | Rejected alternative |
|---|---|---|---|---|---|
| T-A | Experience | — | **New** `component-catalog.ts` + vitest | Allowlist + normalize + decideBlockRender pure functions | Pass-through any `blockType` string to dynamic `require()` |
| T-B | Experience | T-A | **New** `block-renderer.tsx` + vitest (purity / fail-soft) | Switch on catalog id; Tailwind via `design/ui`; no `dangerouslySetInnerHTML` of model HTML | Markdown→HTML dump; iframe sandbox for arbitrary HTML |
| T-C | Experience | T-B, V2-05 | **New** `teaching-workspace.tsx` | Compose blocks + expandable cite/outline/draft; honesty empty states | Full MediaReader as main pane; new route shell |
| T-D | Experience | V2-05 service | **New** API route for clientInit + **edit** `client/api.ts` (+ tests) | Thin wrap `getClientInit`; zod parse `activitySpecClientInitSchema` | Duplicate redact on client; fetch unredacted ActivitySpec + library revision from browser |
| T-E | Experience | T-C, CT-03 | **Edit** `today-dashboard.tsx` (and optionally thin adapter in `activity-panel.tsx`) | Flag-gated swap main pane; keep CTA | Second primary button; re-embed AssistantView |
| T-F | Experience | T-A–E | Feature flag + rollback copy | Env/capability flag; off = CT-03 panel | Hard-cut all users; delete new content on rollback |

## 7. Placement justification

| Proposed file | Why under `features/opening/teaching/` |
|---|---|
| `component-catalog.ts` | Pure mapping next to activity helpers; unit-testable without DOM |
| `block-renderer.tsx` | Presentational; consumes catalog + one block |
| `teaching-workspace.tsx` | Feature shell replacing panel body; stays beside `activity-panel.tsx` |
| Not under `sources/media-reader` | Acceptance: learn without opening reader |
| Not under `assistant/` | Free chat remains secondary (CT-03) |
| Not new package | Keep Opening feature cohesion; contracts already in `@aistudy/contracts` |

## 8. Migration

| Item | Plan decision |
|---|---|
| DDL needed? | **No** — UI-only |
| Why | V2-05 tables (`0054_opening_teaching_content.sql`) + activity rows (`0053`) + clientInit redact already landed |
| Migration number | **None** — do not invent `00xx` |

## 9. Feature flag rollback

- **Proposed flag:** `OPENING_TEACHING_WORKSPACE` truthy (`1`/`true`/`yes`) — mirror parse style of `isOpeningRelease` in `access-policy.ts` **or** a dedicated helper colocated with teaching feature (Implement picks without inventing a second global product mode).
- **Off:** Today main pane = CT-03 `TeachingActivityPanel` / Empty; CTA unchanged.
- **On + failure:** fail-soft to panel honesty; never show fixture lecture as AI.
- **Rollback (`plan.md`):** flag off restores old entry; new content remains **read-only** readable via Data; **do not** disguise static samples as AI-generated.
- Progressive open: align with plan.md C01 — per-user/capability flag, not hard-cut all users.

## 10. Verification plan

### 10.1 Plan-stage checks (this slice)

| Check | Status |
|---|---|
| Tip `git log -1` = `f5dae08` | **run** (see evidence) |
| Docs-only writes (understand + plan + evidence) | **run** |
| Inventory Reads: plan.md §V2-10, tasks.json, UX policy, activity-panel, today-activity, today-dashboard, teaching-content contracts, redact/getClientInit, media-reader, knowledge-evidence, design/ui, CT-03 accept | **run** |
| Product `vitest` / browser | **`not_run`** — no Implement |
| migrate / hermes / push | **`not_run`** — forbidden |

### 10.2 Implement-later verification

Suggested commands (exact scripts at Implement):

```text
pnpm exec vitest run apps/web/src/features/opening/teaching/component-catalog.test.ts
pnpm exec vitest run apps/web/src/features/opening/teaching/block-renderer.test.ts
pnpm exec vitest run apps/web/src/features/opening/teaching/teaching-workspace.test.ts
pnpm exec vitest run apps/web/src/features/opening/planning/today-dashboard-activity.test.ts
pnpm exec vitest run apps/web/src/features/opening/client/api.test.ts
# + new API route test for clientInit
pnpm exec vitest run packages/contracts/src/opening/teaching-content.test.ts
```

| ID | Case | Must not hide by |
|---|---|---|
| C1 | Catalog allowlist only; unknown `blockType` → placeholder, other blocks still render | Snapshotting happy path only |
| C2 | Hidden `answer_key` never shows plaintext (clientInit + renderer) | Mocking content non-null in UI tests |
| C3 | Illegal link / `javascript:` action rejected | Asserting only CSS class names |
| C4 | Unknown schema version → fail-soft banner, Today shell alive | Throwing uncaught to fail the whole page |
| C5 | Primary CTA still single `data-today-primary-cta`; workspace does not add competing primary | Checking only workspace heading |
| C6 | Flag off → CT-03 panel path unchanged | Deleting panel tests |
| C7 | Cite/evidence expandable without requiring MediaReader mount | Treating course deep-link as only cite path |
| C8 | Keyboard focus: expand cite / draft controls operable; text alternative for math/status | Color-only status |
| C9 | No `dangerouslySetInnerHTML` of model HTML in renderer | “Trusted markdown” exception without sanitize policy |
| C10 | Browser / responsive / device | **`pending_user`** / `not_run` until user accepts — agent does not screenshot (`plan.md` / AGENTS) |

**evidence_status (from tasks.json, unchanged by this slice):** engineering `not_run`; real_model `not_run`; user_browser `pending_user`; learning_effect `unknown`.

## 11. Acceptance checks (must match plan.md / tasks.json)

When Implement is later accepted (Integrator — **not** this slice):

1. User can **start / continue learning** from Today primary CTA **without** opening the original MediaReader / library viewer first.
2. Main pane shows **current AI teaching** (workspace) when content ready; outline / materials / drafts are **on-demand**, not the default whole screen.
3. **Citations checkable** via evidence/`sourceRefs` UI; follow-up stays in teaching context (no forced navigate-away).
4. Catalog limited to **text/math/step/example/question/draft/evidence**; Tailwind-only layout; **no** arbitrary HTML/JS.
5. **No preload** of hidden answers; actions server-authorized.
6. Rollback via feature flag to old entry; new content read-only; no static sample disguised as AI.

## 12. Explicit non-goals

- V2-11 intervention preferences; V2-12 local commands.
- V2-09 verifier implementation (display-only of verificationStatus).
- MediaReader seek as primary teaching surface.
- Outline full editor (may show read-only expandable strip if metadata present).
- DDL / migration numbers; worker/compiler changes (AI owns V2-08/09).
- Implement / push / hermes / stash / reset / commit in **this** slice.
- Self-ACCEPT.

## 13. Default design decisions for PM to confirm (if ambiguous)

If PM Plan-ACCEPTs without comment, treat these as confirmed:

1. **Flag:** `OPENING_TEACHING_WORKSPACE` (truthy parse) gates workspace; default **off** until Implement + Accept.
2. **Usable content gate:** show workspace blocks only when clientInit returns and product rule says readable (recommend: `generateStatus === "ready"` **or** explicit verified/structure_ok policy from V2-09 when available); otherwise honesty panel — never fake.
3. **Normalize map:** `formula`→`math`, `steps`→`step`, `prompt`→`question`; `answer_key` never catalog-rendered as plaintext; unknown→fail-soft.
4. **Cite:** in-pane `evidence` from `sourceRefs` first; MediaReader/course link quiet secondary.
5. **HTTP:** `GET` (or existing teaching-content route group) → `getClientInit` via OpeningApi; no unredacted body to browser.
6. **No DDL**; no migration number.
7. **A11y:** keyboard for expanders; status not color-only; math has text fallback where feasible.

## 14. Ownership boundaries

| Role | Owns | Boundary |
|---|---|---|
| **Experience (this)** | catalog, renderer, workspace, Today main-pane wire, thin clientInit HTTP/API client | Does not own compile/verify pipelines; does not invent redact rules |
| **Data** | V2-05 repo `getClientInit` / redact (landed) | Experience consumes; does not reimplement redact in browser |
| **AI** | V2-08 compiler / V2-09 verifiers (parallel) | Experience displays statuses; does not claim verified |
| **Integrator** | Plan/Implement ACCEPT | No self-ACCEPT by Experience |

## 15. Handoff

1. **Integrator Plan ACCEPT** required before any product Implement of the three proposed files + Today/API wire.
2. Do **not** mark `tasks.json` verified; do **not** self-ACCEPT.
3. Implement gate (later) must list commands + results per `review-test-gates.md`; browser checks remain `pending_user` / `not_run` until user.
4. **This document does not authorize product code, migrations, or self-ACCEPT.**

## Ready for Plan ACCEPT?

**Yes.** Hand to Integrator for Plan ACCEPT against Understand + this Plan + plan-stage evidence. AIstudy Experience does **not** self-ACCEPT.
