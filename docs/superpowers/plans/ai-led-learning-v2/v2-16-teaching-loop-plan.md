# V2-16 Plan — First AI-led teaching loop integration & controlled internal trial

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator / QA (executor / Grok Bot) — **plan author**  
**Branch tip:** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`, `feat/opening-release`) — matches Understand / PM tip baseline `74ba005`  
**Stage:** Plan only — **Plan ACCEPT required from AIstudy Data (Experience backup) before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · no self-ACCEPT · no `tasks.json` verified · **DDL: NO** (tip migrations end **0057**; no schema gap)  
**Align:** `plan.md` §V2-16; Understand `v2-16-teaching-loop-understand.md`; PM locks; charter G1–G8; sources C01/R01/R02/U01; gates `review-test-gates.md`  
**Owner split:** Integrator/QA lead for integration tests + feature flag + e2e harness; Data / Experience / AI only for touch points they already own — **do not dual-edit exclusive trees in one Implement gate** (sequence halves if needed)  
**Plan ACCEPT reviewer (PM locked):** **AIstudy Data** (Experience backup) — **≠ Integrator**

## 0. Open decisions / Plan ACCEPT gate

| Item | Decision |
|---|---|
| Who **ACCEPT**s this Plan? | **AIstudy Data** (primary). Experience backup if Data unavailable. **Integrator must not ACCEPT.** |
| After Plan ACCEPT | PM / Paula opens Implement authorization for Integrator/QA (and sequenced halves if exclusive trees need edits) |
| DDL | **NO** — no new migr; do not invent `0058` |
| Implement this turn | **Forbidden** |

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **Teaching loop trial** | Compose enter→teach→ask→attempt→pause→resume→(optional independent) behind internal flag | New teaching product; chat-as-tutor substitute |
| **`OPENING_TEACHING_LOOP` flag** | Internal trial gate (default off); existing env/release process | Replacing `OPENING_TEACHING_WORKSPACE` semantics |
| **Integration harness** | Agent-isolated DB: activity + compile/ready fixture + command + attempt + checkpoint/status + resume package | Live browser; long-term learning_effect |
| **E2E script** | Playwright path for teaching workspace loop (may stay `pending_user` for visual) | Proving score gain |
| **Understandable states** | Map no-course / no-model / budget / parse incomplete / source withdrawn to existing hooks + fail-soft assertions | Inventing parallel error product |
| **Evidence split** | UX accept vs `learning_effect=unknown` recorded separately | Flipping learning_effect without evidence |

### 1.2 Link graph (loop → tip modules)

```
Flag OPENING_TEACHING_LOOP (+ workspace surface)
        │
        ▼
Enter: POST teaching-activities (+ associate-course)
        │  fail-soft: no course / materials not admitted
        ▼
AI teach: compile job / generateStatus → ready → GET client-init
        │  TeachingWorkspace + BlockRenderer (+ optional matrix_transform)
        │  fail-soft: no model / budget / generate failed|unknown|stale
        ▼
Local ask: POST .../teaching/activities/{id}/commands
        │  (why|rephrase|expand|example|skip|branch|return)
        ▼
Attempt feedback: opening attempts + help exposures (activity-scoped)
        │  honesty: no invented mastery from UI-only events
        ▼
Pause: POST .../status {paused} + POST .../checkpoint
        ▼
Resume: GET .../resume (LearningResume ≠ ConversationResume)
        │  gates: owned / materials / job
        ▼
Optional independent problem: attempt/retest / openProblems on resume
        │
Rollback: OPENING_TEACHING_LOOP=off → trial UI/API gate closed; user content retained
```

### 1.3 Core rules

1. **Compose, do not fork:** Loop uses tip modules from V2-08…V2-15 + V2-07 compile; no parallel `opening_teaching_loop_*` tables or second resume product.
2. **AI主讲 acceptance:** Trial success = structured teaching activity with blocks/commands/attempts/resume — **not** PDF reader + free chat.
3. **Real path honesty:** Engineering tests may mock provider; `real_model` evidence stays `not_run` until secrets + recorded live call; never claim real-model green from mocks alone.
4. **Flag default off:** `OPENING_TEACHING_LOOP` / `NEXT_PUBLIC_OPENING_TEACHING_LOOP` truthy only when `1|true|yes` (same helper pattern as `teaching-workspace-flag.ts`).
5. **Workspace relationship:** Loop trial entry checks loop flag; mounting `TeachingWorkspace` still respects `OPENING_TEACHING_WORKSPACE` (both on for full UI trial; integration may inject flags in process env).
6. **States must be understandable:** Each of the five PM states has an assertion or scripted check (see §4); silent empty ready-workspace is a defect.
7. **Preserve checkpoint disjointness:** Pause/resume/checkpoint must not clobber V2-11 prefs or V2-12 command keys (reuse merge helpers).
8. **G6 honesty:** Attempt outcomes / help kinds from facts ledger only; matrix stepping ≠ graded proof.
9. **Evidence split:** `user_browser` / UX script vs `learning_effect=unknown` — do not conflate.
10. **No DDL.** Tip stays **0057**.
11. **Exclusive trees:** If Implement needs Data/Experience/AI file edits, **sequence** separate gates — Integrator owns tests/flag/e2e first.
12. **No push/hermes; no Implement until Data Plan ACCEPT + PM Implement auth.**

### 1.4 Feature flag proposal

```ts
// apps/web/src/features/opening/teaching/teaching-loop-flag.ts  — NEW (Integrator)
// Mirror teaching-workspace-flag.ts

export function isOpeningTeachingLoopEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.OPENING_TEACHING_LOOP ??
    env.NEXT_PUBLIC_OPENING_TEACHING_LOOP ??
    ""
  ).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
```

**Rollback:** unset / `0` / `false` → trial path off; content/checkpoint/attempts remain; document failures in evidence.

**Rejected name:** inventing non-`OPENING_*` flags or hardcoding trial-on in production builds.

## 2. Ownership split

| Path / concern | Owner | Notes |
|---|---|---|
| `tests/integration/opening-teaching-loop.test.ts` **NEW** | **Integrator/QA** | Agent-isolated DB loop |
| `tests/e2e/opening-teaching.spec.ts` **NEW** | **Integrator/QA** | Playwright; browser may remain pending_user for visual polish |
| `apps/web/.../teaching/teaching-loop-flag.ts` (+ test) **NEW** | **Integrator/QA** | Flag helper |
| Thin gate wiring (today dashboard / workspace entry check loop flag) | **Integrator** if ≤ small guard; else **Experience** half | Prefer minimal: export flag + one entry guard; polish copy = Experience |
| Empty-state copy in exclusive UI trees | **Experience** (sequenced) | Only if Integrator cannot assert via existing honesty strings |
| Compile / provider / validation knobs | **AI** (already owned) | Touch only if loop needs documented env; no dual-edit with Integrator tests in same gate |
| Contracts/domain teaching-* exclusive | **Data** | Touch only if gap found; Plan expects **reuse** — no schema change |
| `GET /api/opening/ai-readiness` | **Reuse** (existing) | Assert teaching trial consults same blockers class |
| Migrations | **None** | Integrator confirms DDL NO |
| Plan ACCEPT | **Data** (Experience backup) | Not Integrator |
| Implement ACCEPT (later) | Independent Accept ≠ Implementer | Gates |
| `tasks.json` verified | **Accept only** | Not this Plan slice |

**Sequencing:** Integrator Implement (tests + flag + thin gate) → if Experience copy/UI needed → Experience half → if Data contract gap (unexpected) → Data half. Prefer zero exclusive-tree edits.

## 3. Loop step mapping (Implement checklist)

| # | Step | Tip path(s) | Integration assert (sketch) |
|---|---|---|---|
| L1 | Enter | `activity-service.ts`; `POST .../teaching-activities`; associate-course | Creates owned activity; no-course path returns understandable error / empty (not ready workspace) |
| L2 | AI teach | compiler + `generateStatus`; `getClientInit`; `TeachingWorkspace` / `isTeachingWorkspaceContentUsable` | With ready fixture: usable true; with queued/failed: usable false + honesty label |
| L3 | Local ask | `command-service.ts`; `POST .../commands` | At least one command (e.g. skip or why) CAS-ok; conflict forces reread |
| L4 | Attempt feedback | `attempt-service.ts`; attempts API | Submit attempt tied to activity/session; resume `actualAttempts` reflects |
| L5 | Pause | `POST .../status` paused; `POST .../checkpoint` | Status paused; drafts/interactionParams merge preserves prefs/commands |
| L6 | Resume | `GET .../resume`; `resume-card` / package schema | LearningResume gates owned; materials/job exposed; ≠ conversation resume shape |
| L7 | Optional independent | openProblems / retest or new attempt | Optional; if run, does not invent eligibility |

## 4. Error / empty states — UI/API hooks

| State | API / domain hook | UI / user-visible hook | Loop test |
|---|---|---|---|
| No course | Activity create / associate without course; courses list empty | `material-space-nav.tsx` 「暂无课程空间」; enter blocked | T-state-course |
| No model config | Model availability `missing_key` / `vault_disabled`; ai-readiness `available_model` | `AiReadinessChecklist` / BUDGET-adjacent hard block | T-state-model |
| Budget insufficient | `daily_budget` hard; budget reserve fail | `BUDGET_CONFIRM_LEAD` / CTA | T-state-budget |
| Parse incomplete | Source `parse_state` not ready; `admitLearningSources` VALIDATION | Source actions / activity create fail-soft | T-state-parse |
| Source withdrawn | `probeMaterialsAvailability` → unavailable/partial; privacy exclude | Resume materials gate / `resolve_material` action | T-state-withdrawn |

## 5. Test plan (Implement; all `not_run` at Plan stage)

| ID | Layer | Check |
|---|---|---|
| T1 | integration | Flag default off; truthy `1/true/yes` on |
| T2 | integration | L1 enter creates activity under fixture workspace+course |
| T3 | integration | L2 ready clientInit → usable; non-ready → not usable |
| T4 | integration | L3 command succeeds with expectedVersion CAS |
| T5 | integration | L4 attempt recorded; resume lists attempt summary |
| T6 | integration | L5 pause + checkpoint persist; prefs/command keys preserved |
| T7 | integration | L6 resume package schema; materials/job gates; not ConversationResume |
| T8 | integration | T-state-withdrawn: materials unavailable when sources not admitted |
| T9 | integration | T-state-parse / admit failure surfaces VALIDATION (not silent ready) |
| T10 | integration | Optional L7 open problem derive or skip without failure |
| T11 | typecheck | Affected packages/apps for any thin gate files |
| T12 | e2e | Spec file exists; smoke navigate teaching path when flags on (**may** skip live model) |
| T13 | e2e / browser | Full visual script **pending_user** until Paula/user runs |
| T14 | real_model | Documented env; **not_run** without secrets — never fake green |
| T15 | evidence | UX checklist recorded separate from `learning_effect=unknown` |
| T16 | CI | Existing `npm run test:integration` picks up new file; no workflow redesign required |

**Plan-stage:** all **`not_run`**. `user_browser=pending_user`. `learning_effect=unknown`. `real_model=not_run`.

### Test commands (Implement preview)

```bash
# Agent-isolated integration (CI pattern)
npm run test:integration -- tests/integration/opening-teaching-loop.test.ts

# Flag unit (vitest colocated)
npx vitest run apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts

# E2E (when env ready; else pending_user)
npx playwright test tests/e2e/opening-teaching.spec.ts

# Typecheck touched projects (exact filter per repo scripts)
npm run typecheck
```

## 6. Files / tasks preview (Implement after Data Plan ACCEPT + PM auth)

| Path | Action | Owner | Deps |
|---|---|---|---|
| `apps/web/src/features/opening/teaching/teaching-loop-flag.ts` (+ test) | **NEW** | Integrator | — |
| Thin entry guard (e.g. today-dashboard / workspace wrapper) | Edit **only if needed** | Integrator → Experience if UI-heavy | flag |
| `tests/integration/opening-teaching-loop.test.ts` | **NEW** | Integrator | fixture + tip services |
| `tests/e2e/opening-teaching.spec.ts` | **NEW** | Integrator | opening-auth helpers |
| `.github/workflows/ci.yml` | **Prefer no change** | Integrator | only if new file not auto-included |
| Experience copy polish | Optional sequenced | Experience | after Integrator |
| Data contracts/domain | **Expect none** | Data | only if gap |
| Migrations | **None** | — | DDL NO |

**Not touching:** V2-17 adaptive policy; OpenMAIC; inventing mastery; conversation-resume-as-teaching; push/hermes; `tasks.json` verified.

### Rejected alternatives

| Alt | Why rejected |
|---|---|
| Reader + chat as “AI主讲 trial” | PM acceptance / G1 |
| New `opening_teaching_loop_state` table | Nest checkpoint; DDL NO |
| Reuse only `ConversationResume` | G7 anti-example; V2-14 lock |
| Integrator self-ACCEPT Plan | PM lock; gates Implementer≠Accepter |
| Dual-edit Data+Experience exclusive trees in one gate | Ownership rule |
| Claim `learning_effect` proven for M1 | PM: not required; keep unknown |
| Mark `real_model` green from mocks | Honesty |
| Require independent problem every run | PM optional |
| Invent migr 0058 “for loop” | No schema gap |
| Turn trial on by default in prod | Rollback / release process |

## 7. Acceptance checks

### 7.1 Plan ACCEPT (docs-only — this stage)

**AIstudy Data** (or Experience backup) may **ACCEPT** this Plan when:

1. Understand + Plan restatement matches `plan.md` §V2-16 + PM locks (real path, loop steps, states, flag, tests, accept≠score proof).
2. Ownership table names Integrator for tests/flag/e2e; exclusive trees sequenced.
3. Every claim cites inventory paths or marks **NEW**.
4. Loop step map cites tip modules (V2-08…V2-15 + compile/readiness).
5. Feature flag proposal follows `OPENING_*` pattern; rollback = off.
6. Error/empty states inventory complete for five PM states.
7. Test IDs listed with `not_run`; browser `pending_user`; learning_effect unknown; real_model not_run.
8. **DDL = NO**; tip **0057**.
9. Open decisions include Plan ACCEPT owner = **Data** (not Integrator).
10. No product code landed in this slice; Integrator did **not** self-ACCEPT.

### 7.2 Later Implement ACCEPT (after authorized Implement)

1. Independent Accept re-runs named integration/typecheck; lists `not_run` honestly.
2. Flag default off; on enables trial gate.
3. Integration covers L1–L6 at minimum; L7 optional documented.
4. At least one withdrawn/parse/budget/model/no-course state asserted or scripted.
5. E2e file present; visual `pending_user` until user script.
6. UX evidence ≠ learning_effect claim.
7. Rollback demonstrated (flag off) in notes; content retained.
8. No DDL unless Integrator-assigned (none expected).
9. Only Accept may move `tasks.json` → `verified`.

## 8. Soft gaps / PM design locks (2026-10-11 recorded)

**Locked by PM (encode in Implement; do not reopen):**

1. Plan ACCEPT owner = **AIstudy Data** (Experience backup) — not Integrator.
2. Real materials / real model path as the trial **claim**; mocks OK for engineering green only with honest `real_model` status.
3. Flow steps fixed: enter → AI teach → local ask → attempt feedback → pause → resume → optional independent.
4. Five understandable states required.
5. Internal flag via existing release/env process; rollback = off + keep content + record failures.
6. Proposed test paths fixed: `tests/integration/opening-teaching-loop.test.ts` + `tests/e2e/opening-teaching.spec.ts`.
7. First trialable milestone = AI主讲; not reader+chat; no long-term score proof required.
8. UX acceptance vs learning-effect recorded separately.
9. **DDL: NO** unless a real schema gap appears (none on tip `74ba005`).

**Open for PM (non-blocking defaults in Plan):**

1. Fixture materials catalog for first internal trial unit (which course/source fixture).
2. Whether CI may store live `OPENING_MODEL_API_KEY` / catalog for `real_model` runs.
3. Whether loop flag alone is enough for entry or both loop+workspace must be on (Plan default: **both** for UI trial; integration sets both in env).

## 9. Implement gate (after Plan ACCEPT)

1. **AIstudy Data** **ACCEPT**s this Plan (and Understand). Experience backup only if Data unavailable.  
2. PM / Paula opens Implement authorization (Integrator/QA primary).  
3. Implement follows ownership + tests T1–T16; browser pending_user; real_model honesty.  
4. Evidence under `docs/superpowers/evidence/<date>-opening-release/…` per gates.  
5. **This document does not authorize product code, ALTER, commit, push, or hermes.**

## 10. Dirty tree note

Unrelated untracked evidence (`rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`) may exist on the worktree — **not** touched. No stash/reset. This slice writes **only** V2-16 Understand/Plan docs (+ optional evidence stubs) under `docs/superpowers/plans/ai-led-learning-v2/` and `docs/superpowers/evidence/2026-10-11-opening-release/`.
