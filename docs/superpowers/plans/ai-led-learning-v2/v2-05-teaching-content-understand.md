# V2-05 Understand — 保存版本化教学活动而非只有聊天文本

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `5d7124861c3c981a735fe26ada40bb188a875465` (`feat/opening-release`) — matches required tip  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no ALTER, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §6.1 + §V2-05; `tasks.json` V2-05; approved ADR `docs/decisions/ADR-teaching-activity-context.md` **D2**; V2-04 landed (migration `0053`)

## Restated outcome

A lesson can **continue, cite, and partially update** as versioned teaching content — not a long chat snapshot and not a second body store.

Concretely:

1. Define **TeachingUnit** + **ActivitySpec** contracts: goals, ordered block indexes, source refs, verification status, generation config, versions.
2. **Body authority** stays sole: `library_documents` / `library_blocks` / `library_revisions` (`0001_library.sql`); candidate edits via `revision_proposals` (`0010`). Teaching tables hold **indexes / order / metadata only** (ADR D2).
3. Bind an ActivitySpec to an existing `opening_teaching_activities` row (V2-04) via library `documentId` + pinned `revisionNumber`, and advance the activity’s existing `content_version` with CAS (`expectedVersion`).
4. Separate **personal drafts / feedback / in-progress answers** from reusable teaching body; **formal** attempts stay on the learning ledger (`opening_learning_*`). **Unrevealed answer keys** exist only as server-side refs in client init JSON/DOM/restore snapshots.
5. Rollback: old library revisions remain readable; stopping new generation does not delete user notes/drafts.

## Why this exists (gap after V2-04 + CT-03)

| Layer | Landed | Missing for V2-05 |
|---|---|---|
| Activity identity | `opening_teaching_activities` + `content_version` stub (always `0` at create) | No TeachingUnit / ActivitySpec; nothing bumps `content_version` against a body |
| Today entry (CT-03) | Primary CTA → activity panel; honesty copy when no lecture | Panel has **no** renderable teaching blocks; cannot continue/cite/partial-update a lesson body |
| Body store | Library Document/Block/Revision + `expectedRevisionNumber` CAS | Teaching domain does not yet point activities at library docs |
| Facts ledger | Observations/attempts carry `activity_id`; course nullable | Must **not** fork a parallel answer store for teaching “answers” that belong in observations |

## Inventory (paths cited)

### 1. Library sole body store

- `packages/database/src/migrations/0001_library.sql` — `library_documents` (lifecycle + `current_revision_number`), `library_blocks` (`content jsonb`, position), `library_revisions` (append-only snapshot `blocks jsonb`), `library_relations`, `library_properties`.
- `packages/database/src/migrations/0010_revision_proposals.sql` — candidate rewrite with `base_revision_number`, immutable snapshot, accept → resulting revision.
- `packages/database/src/repositories/library.ts` — `getDocument`, `listRevisions`, update with **`expectedRevisionNumber`** conflict; opening-note readability filter.
- Native library backup is **separate** from Opening backup (`packages/domain/src/opening/backup-learning-state.ts`: “native library assets use their own backup”).

### 2. V2-04 landed (attach point)

- Migration tip: `packages/database/src/migrations/0053_opening_teaching_activities.sql` (Integrator-assigned; tip ends at **0053** after V2-04).
- Contracts: `packages/contracts/src/opening/teaching-activity.ts` — `contentVersion`, `pathVersion`, `checkpointJson`, generate vs progress status split.
- Schema/repo: `packages/database/src/schema/opening-teaching-activities.ts`, `packages/database/src/repositories/opening-teaching-activities.ts` (`create` / `get` / `listByOwner` / `associateCourse`; **no** content publish yet).
- Service: `apps/web/src/features/opening/teaching/activity-service.ts`.
- CT-03 (Experience, read-only note for V2-05): Today CTA → activity; `activity-panel.tsx` shows metadata + honesty, **no** teaching body. V2-05 attaches by giving Data APIs that return client-safe ActivitySpec projections so Experience can later render blocks without inventing a second store.

### 3. Learning facts vs teaching “answers” (boundary)

| Kind | Store | V2-05 rule |
|---|---|---|
| **Answer keys / solutions** (authoring, unrevealed until help) | Library body (tagged blocks) + **server-only** refs in teaching metadata | Never dump into client init / restore snapshot; reveal gated later (help exposure) |
| **Personal drafts** (in-progress typed answers, notes mid-lesson) | Activity `checkpoint_json` anchors and/or personal library scratch docs | Separate from reusable TeachingUnit body; keep across content version bumps when anchors still match |
| **Formal attempts / observations** | `opening_learning_observations` / `opening_learning_attempts` (+ `activity_id`) | **Do not fork**; teaching content must not become a second mastery ledger |
| **Help reveal** | `opening_help_exposures` (`hinted` / `revealed`) | Existing assistance policy; V2-05 only ensures keys are not pre-leaked |

Existing learning answer field: `packages/contracts/src/opening/learning.ts` `observationInputSchema.answer`; revisions use `expectedHead` (`learning-revisions.ts`).

### 4. Version / CAS patterns to reuse

| Pattern | Path | Use in V2-05 |
|---|---|---|
| Library revision CAS | `library.ts` `expectedRevisionNumber` | Body publish / partial update |
| Knowledge CAS | `opening-knowledge.ts` `expectedVersion` → `+1`, soft-idempotent same graph | ActivitySpec / unit metadata publish → bump activity `content_version` |
| Observation revision | `learning-revisions.ts` `expectedHead` | Formal answer rewrites (unchanged; not teaching body) |
| Activity associate | `expectedUpdatedAt` optional on associate-course | Keep for course pointer; content uses `expectedVersion` on content APIs |

### 5. Fixtures (shape inspiration only; not product schema)

- `tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/activity-outline.json` — ordered activities, goalIds, blockTypes, sourceIds.
- `…/goals/teaching-goals.json`, `…/examples/correct-examples.json` (`solutionZh` = answer-key class content).
- Held-out isolation already forbids teaching retrieval of eval answers — same spirit as client-init redaction.

## Out of scope (OOS) for V2-05

- **No Implement** of product code / migrations / ALTER in this Understand+Plan slice.
- Pipeline / `compile-teaching-unit` worker (V2-07); source coverage package (V2-06); full Experience render of lecture blocks (post–Plan ACCEPT + later Experience).
- Changing `opening_learning_*` schema further; retest / skill_evidence course NOT NULL; parallel scoring / Episode-as-score.
- Chat transcript as teaching body; dumping answers into `checkpoint_json` as the durable answer key store.
- Inventing migration numbers (use **`00xx`**; Integrator assigns against live `schema_migrations` — tip currently ends at **0053**).
- Push / hermes / stash / reset / commit; `tasks.json` → verified.

## Open decisions for PM / Paula

Only items that change product meaning (defaults proposed in Plan; escalate if Paula disagrees):

1. **Client-init redaction model (D2 detail):** Prefer **same** library document for prompts + answer keys, with server projecting a redacted client view (opaque `answerRef` only). Alternative: separate answer-key document. **Plan default = same document + projection.**
2. **TeachingUnit reuse:** Prefer **1 unit → many activities** (reusable body); ActivitySpec binds one activity to a unit revision + block order. Alternative: 1:1 unit per activity. **Plan default = 1:N.**
3. **Personal draft home:** Prefer **checkpoint anchors** (+ optional personal scratch `library_documents` when draft body is large). No new parallel “teaching answers” table for formal scoring. Confirm Paula OK that mid-lesson typed text is checkpoint/scratch until formal submit → observation.

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Ready for Plan?

**Yes.** Inventory closed; ADR D2 + V2-04 attach points clear; stop here until Plan is written and Plan ACCEPT granted before any Implement.
