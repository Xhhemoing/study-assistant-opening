# V2-05 Teaching content — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `5d7124861c3c981a735fe26ada40bb188a875465` — **matches required tip**  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (commands + results, or `not_run`)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-05-teaching-content-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-05-teaching-content-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-05-teaching-content-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `packages/contracts/src/opening/teaching-content.ts`
- No `packages/database/src/repositories/opening-teaching-content.ts`
- No migration SQL applied or added under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress
- No Experience UI / CT-03 rewrites
- No push / hermes / stash / reset / commit

## Tip / branch verification

```text
$ git rev-parse HEAD
5d7124861c3c981a735fe26ada40bb188a875465

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
5d71248 feat(opening): CT-03 Today primary CTA → teaching activity

$ ls packages/database/src/migrations/*.sql | tail -1
packages/database/src/migrations/0053_opening_teaching_activities.sql
```

**Result:** tip OK; migrations tip ends at **0053** (V2-04). Next migration number remains Integrator-assigned (`00xx` in Plan).

## Inventory commands run + results

### Library + revision proposals

```text
$ rg -n "library_documents|library_blocks|library_revisions|revision_proposals" \
  packages/database/src/migrations/0001_library.sql \
  packages/database/src/migrations/0010_revision_proposals.sql | head -20
```

**Result:** exit 0 — confirmed Document/Block/Revision append-only + `revision_proposals` base_revision / accept path (cited in Understand §1).

### V2-04 teaching activity attach

```text
$ rg -n "content_version|contentVersion|TeachingActivity|document_id" \
  packages/contracts/src/opening/teaching-activity.ts \
  packages/database/src/migrations/0053_opening_teaching_activities.sql \
  packages/database/src/repositories/opening-teaching-activities.ts | head -25
```

**Result:** exit 0 — `content_version` stub present; no library `document_id` on activity yet (Plan proposes bind via `opening_teaching_activity_specs`).

### CAS / version patterns

```text
$ rg -n "expectedRevisionNumber|expectedVersion|expectedHead" \
  packages/database/src/repositories/library.ts \
  packages/database/src/repositories/opening-knowledge.ts \
  packages/contracts/src/opening/learning-revisions.ts | head -20
```

**Result:** exit 0 — library `expectedRevisionNumber`, knowledge `expectedVersion` CAS, observation `expectedHead` (Plan §2/§4 reuse).

### Backup registration baseline

```text
$ rg -n "OPENING_BACKUP_TABLES|opening_teaching_activities|opening_learning_activity_history" \
  packages/database/src/repositories/opening-backup-records.ts | head -15
```

**Result:** exit 0 — V2-04 tables already listed; Plan notes new teaching-content tables must register on Implement.

### Plan / ADR V2-05 refs

```text
$ rg -n "TeachingUnit|ActivitySpec|§6\.1|V2-05" \
  docs/superpowers/plans/ai-led-learning-v2/plan.md \
  docs/decisions/ADR-teaching-activity-context.md | head -20
```

**Result:** exit 0 — §6.1 + V2-05 + ADR D2 cited in Understand/Plan.

### Additional Reads (no shell exit codes; completed)

| Path | Purpose |
|---|---|
| `docs/decisions/ADR-teaching-activity-context.md` | D2 content authority |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §6.1, §6.5, V2-05 | Scope |
| `docs/superpowers/plans/ai-led-learning-v2/tasks.json` V2-05 | Task fields |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Evidence rules |
| `0001_library.sql`, `0010_revision_proposals.sql`, `0053_opening_teaching_activities.sql` | Schema inventory |
| `teaching-activity.ts`, `opening-teaching-activities.ts` (+ schema) | V2-04 contracts/repo |
| `learning.ts`, `learning-revisions.ts` | Answer / revision boundaries |
| `library.ts` (CAS update + listRevisions) | Body versioning |
| `opening-knowledge.ts` replace CAS | expectedVersion pattern |
| `opening-backup-records.ts` | Backup list |
| `activity-panel.tsx`, CT-03 implement evidence | Attach note (no body yet) |
| V2-02 fixtures `activity-outline.json`, `teaching-goals.json`, `correct-examples.json` | Shape inspiration |
| `v2-04-migration-work-order-draft.md` OOS TeachingUnit | Confirm deferral |

## Planned product tests (from Plan §7) — status

| ID | Status | Reason |
|---|---|---|
| T1–T9 (contracts, CAS, old revision, draft anchors, client-init redaction, backup registration, observation regression) | **`not_run`** | Plan stage only; no Implement / no test code landed |
| Migration apply / Integrator numbering | **`not_run`** | Placeholder `00xx`; no ALTER |
| Browser / client DOM leak check for answer keys | **`not_run`** | No client init API yet |
| Typecheck / vitest suites | **`not_run`** | Docs-only slice |

## Plan summary (for Accept)

1. TeachingUnit + ActivitySpec metadata; library Document/Revision = sole body (ADR D2).  
2. Bind activity → unit via `opening_teaching_activity_specs` (`document_id` + `revision_number` + block_order indexes).  
3. CAS publish bumps `opening_teaching_activities.content_version` (`expectedVersion`).  
4. Personal drafts in checkpoint (+ optional scratch docs); formal answers stay on learning ledger.  
5. Client init redacts unrevealed answer keys to opaque refs.  
6. Migration **needed** as `00xx` (Integrator assigns; tip at 0053).  
7. Backup-register new tables on first Implement.  
8. Rejected: second body store, chat-as-lesson, parallel answer facts, invented migration numbers.

## Open questions for PM (defaults in Plan)

1. Same library document + server redaction vs separate answer-key document — **default: same + redaction**.  
2. TeachingUnit 1:N activities vs 1:1 — **default: 1:N**.  
3. Draft home = checkpoint anchors (+ optional scratch library doc) — **default: yes**.

## Verdict this slice

- Understand + Plan **written**.  
- **Await Plan ACCEPT** before any Implement.  
- Confirm: **no Implement / no ALTER / no push** performed.
