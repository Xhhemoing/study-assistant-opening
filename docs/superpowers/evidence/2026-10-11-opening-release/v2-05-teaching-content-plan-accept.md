# V2-05 accept — Teaching content Plan (TeachingUnit + ActivitySpec)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator (executor / Grok Bot) — Plan ACCEPT only  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `5d7124861c3c981a735fe26ada40bb188a875465` — matches required tip  
**Stage:** Plan ACCEPT (not Implement). **No ALTER. No product code land. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Verdict:** **ACCEPT**

## Scope of this accept

Accept of:

- `docs/superpowers/plans/ai-led-learning-v2/v2-05-teaching-content-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-05-teaching-content-plan.md`
- Plan-stage evidence `docs/superpowers/evidence/2026-10-11-opening-release/v2-05-teaching-content-plan-implement.md`

against pack `plan.md` §6.1 + V2-05, ADR D2 (+ D1/D3/D4/D6/D7 seams), Paula/PM embed + design locks, and V2-04 attach on tip.

**This ACCEPT authorizes opening the Implement gate** (contracts → migration → repo → thin service → T1–T9 → implement evidence). It does **not** apply DDL, invent product behavior beyond the plan, or move `tasks.json` → `verified`.

## Inputs reviewed

| Artifact | Role |
|---|---|
| `v2-05-teaching-content-understand.md` | Restatement + inventory |
| `v2-05-teaching-content-plan.md` | Design under review |
| `v2-05-teaching-content-plan-implement.md` | Plan-stage evidence claim |
| `v2-05-pm-design-decisions.md` | PM locked defaults (same-doc+redact; 1:N; checkpoint drafts) |
| `ADR-teaching-activity-context.md` | D2 body authority; D1/D3/D4/D6/D7 |
| `plan.md` §6.1 / §6.3 / §6.5 / V2-05 | Pack scope + acceptance |
| `tasks.json` V2-05 | Scope / verification / rollback / proposed paths |
| `review-test-gates.md` | Independent accept rules |
| Tip spot-checks | `0053_opening_teaching_activities.sql`, `teaching-activity.ts`, `opening-teaching-activities.ts`, `library.ts` CAS, `opening-knowledge.ts` CAS, `opening-backup-records.ts`, `0001_library.sql`, fixtures, `activity-panel.tsx` |

## Stronger Plan review

### 1. Restatement ↔ Paula/PM intent (no invented scope)

| Check | Result |
|---|---|
| Outcome = continue / cite / partial-update versioned teaching — not chat snapshot, not second body | Pass — Understand restatement + Plan §1 + pack acceptance |
| TeachingUnit + ActivitySpec = goals, ordered block indexes, source refs, verification, generation config, versions | Pass — Plan §2 sketches; matches tasks.json scope |
| Library sole body; teaching tables indexes/order/metadata only (ADR D2) | Pass — Plan §1.2 link graph; rejected alts §8 |
| Personal drafts / feedback / in-progress ≠ reusable body; formal attempts on learning ledger | Pass — Plan §5; PM default #3 |
| Unrevealed keys = server refs only in client init / restore | Pass — Plan §5.2; PM default #1; T6/T7 |
| OOS: V2-06/07, Experience render, learning schema forks, chat-as-body, invented migr # | Pass — Understand OOS + Plan §10/§11 |
| Embed-in-app (ADR D7): attach to V2-04 activity + CT-03 panel; no bypass app | Pass — Plan §6; no new shell; Today CTA identity unchanged |

**PM defaults (locked) mapped into plan:**

| PM decision | Plan coverage | Accept |
|---|---|---|
| Same library document + server redact; opaque `answerRef` | §2 clientInit + §5.2 | Pass |
| TeachingUnit 1:N activities; one current spec per activity | §1.2 UNIQUE `(workspace_id, activity_id)`; unit→many specs index | Pass |
| Drafts = checkpoint (+ optional scratch library doc); lost blockIds → explicit mismatch | §2 draft anchors + §5.3 | Pass |
| No second body / chat-as-lesson / parallel answer ledger | §8 rejected | Pass |
| `00xx` until Integrator assigns (tip ended 0053) | §3 / §9 | Pass → **0054 assigned this accept** (see below) |

### 2. Claims name real files/APIs; migration need clear

| Claim | Tip spot-check | Result |
|---|---|---|
| V2-04 `opening_teaching_activities` + `content_version` stub / `checkpoint_json` / `generate_status` | `0053_*.sql` L12–27; contracts `contentVersion`; repo maps fields; **no** `document_id` on activity | Pass — bind via proposed `opening_teaching_activity_specs` honest |
| Library Document/Block/Revision + `expectedRevisionNumber` | `0001_library.sql`; `library.ts` CAS | Pass |
| Knowledge `expectedVersion` soft-idempotent pattern | `opening-knowledge.ts` L188–256 | Pass — Plan §4 reuses |
| `assertOwnedActivity` / `lockLearningOwner` | `opening-teaching-activities.ts` | Pass — Plan §4 reuse |
| Backup list already has `opening_teaching_activities`; new tables must register on Implement | `opening-backup-records.ts` L7–10 | Pass — Plan §9 |
| Proposed paths match pack | `teaching-content.ts` + `opening-teaching-content.ts` | Pass |
| Product Implement artifacts absent | No `teaching-content.ts` / repo / `00xx`/`0054` SQL on tip before this accept | Pass |
| Migration **needed** | Yes — two new tables (units + activity_specs); optional answer_refs / denorm deferred | Pass |
| Integrator assigns number | Placeholder `00xx` in plan; tip migrations end **0053**; no `0054_*` file | Pass → assigned **0054** |

**Assigned migration number:** **0054**  
Evidence: `docs/superpowers/evidence/2026-10-11-opening-release/v2-05-migration-number-assigned.md`  
Implement filename: `packages/database/src/migrations/0054_opening_teaching_content.sql` (replace `00xx`). **No ALTER applied by this assignment.**

### 3. Tests cannot pass by hiding behavior; rejected alternatives present

| ID | Intent (anti-hide) | Plan status |
|---|---|---|
| T1 | ClientInit schema forbids answer_key plaintext | `not_run` (Plan stage) |
| T2 | CAS CONFLICT + soft-idempotent same graph | `not_run` |
| T3 | Old library revision readable after republish | `not_run` |
| T4 | Partial body `expectedRevisionNumber` conflict | `not_run` |
| T5 | Draft keep vs explicit `draft_anchor_lost` | `not_run` |
| T6 | `getClientInit` fixture with solutions → no plaintext leak | `not_run` |
| T7 | Restore/snapshot helper no key dump into checkpoint | `not_run` |
| T8 | Observation still learning tables only | `not_run` |
| T9 | Backup registration for new tables | `not_run` |

Rejected alternatives §8 present and correct (second body, chat-as-lesson, parallel teaching_answers, ghost course, separate answer DB, invented migr #, full ActivitySpec history deferred for M1). Matches ADR D2/D3/D4/D5 spirit.

### 4. Dependencies acyclic; embed respected

| Edge | Check |
|---|---|
| Pack `depends_on: [V2-03]`; later tasks depend on V2-05 | Acyclic |
| Operational attach to landed V2-04 (0053) | Honest in Understand/Plan; V2-04 already ACCEPT’d implement |
| Downstream V2-08/10/12/14 list V2-05 | No cycle |
| Embed: CT-03 panel exists (`activity-panel.tsx`); Plan fills Data APIs for later Experience render | Pass — no new app |

### 5. Design validators / test re-run (Plan Accept)

| Check | Status | Reason |
|---|---|---|
| Product T1–T9 | **`not_run`** | Plan stage; no Implement |
| `validate_design.py` / design validators | **`not_run`** | Plan-implement evidence did **not** claim a design-validator run; N/A to re-run |
| Typecheck / vitest / migrate apply | **`not_run`** | Docs-only slice; no ALTER |
| Browser / DOM leak for answer keys | **`not_run`** | No client init API yet |

Per gates: Plan Accept does not require re-running product tests that were never claimed.

## Soft gaps (do not overturn ACCEPT; track for Implement / PM–Data)

1. **`tasks.json` depends_on lists only V2-03** while Plan correctly binds V2-04 activity rows. Non-blocking (V2-04 landed); optional hygiene: add V2-04 to depends_on in a later pack edit.
2. **M1 ActivitySpec history:** only current spec row + pinned `revision_number`; `getActivitySpecAtVersion` cannot reconstruct past `block_order`/goals without library archaeology or a future history table. Plan §8 rejects full history for M1 — OK; Implement must document the M1 read contract honestly in API errors/docs.
3. **Soft-idempotent “same graph”** for `publishActivitySpec` needs an explicit field equality set at Implement (which of blockOrder / sourceRefs / goals / verification / generationConfig / pinned revision).
4. **Optional DDL:** denorm columns on `opening_teaching_activities` and `opening_teaching_answer_refs` — Plan prefers derive-at-read; freeze before writing 0054 SQL.
5. **Live `schema_migrations`:** not queried on this box (same caveat as V2-04 assignment). If live max ≥ 0054, renumber before apply.
6. **Pack `existing_paths`** only names `learning.ts`; Plan correctly also reuses `teaching-activity.ts` / library / knowledge CAS — fine; path_basis can widen at Implement evidence.

## Tree / discipline confirmation

| Check | Result |
|---|---|
| Tip | `5d71248` |
| Migrations on tip before assign | End at **0053**; **0054** absent |
| Product teaching-content files | Absent |
| Plan-implement claim “no Implement / no ALTER” | Consistent with tree |
| This accept writes | Accept evidence + migration-number note only |
| ALTER / migrate / psql | **Not run** |

## Verdict

**ACCEPT** Plan for V2-05 teaching content.

- Migration number assigned: **0054** (`v2-05-migration-number-assigned.md`).
- Next: separate Implement slice may replace `00xx` → `0054`, land contracts/repo/tests T1–T9, register backup tables, write implement evidence — then independent Implement ACCEPT.
- Soft gaps above for PM/Data; none block Plan ACCEPT.
- **No ALTER executed.**

