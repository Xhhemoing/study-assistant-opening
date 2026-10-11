# V2-05 Plan — Teaching content (TeachingUnit + ActivitySpec)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `5d7124861c3c981a735fe26ada40bb188a875465` (`feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · migration number placeholder **`00xx`** (Integrator assigns; tip migrations end at **0053** after V2-04)  
**Align:** ADR D2; `plan.md` §6.1 + V2-05; Understand `v2-05-teaching-content-understand.md`

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **TeachingUnit** | Reusable teaching package identity: goals metadata, generation config, verification status, pointer to sole library document | Body bytes; user answer ledger |
| **ActivitySpec** | Binding of one `opening_teaching_activities` row → a TeachingUnit revision + ordered block index + source refs + teach actions metadata | Copy of block content; mastery scores |
| **Library Document/Block/Revision** | Sole teaching **body** store (prompts, examples, tagged answer-key blocks) | Activity progress; observation outcomes |
| **Personal draft / checkpoint** | Mid-lesson typed answers & restore anchors | Answer keys; formal attempts |
| **Learning observation/attempt** | Formal verified attempts (existing ledger) | Teaching body |

### 1.2 Link graph

```
opening_teaching_activities (V2-04)
  id, content_version, path_version, checkpoint_json, generate_status, …
        │
        │ 1:1 current ActivitySpec binding (metadata row)
        ▼
opening_teaching_activity_specs   ←── indexes / order / refs only
  activity_id, teaching_unit_id, document_id, revision_number,
  block_order jsonb, source_refs jsonb, goals jsonb,
  verification_status, generation_config jsonb, version
        │
        │ document_id + revision_number (FK logical)
        ▼
library_documents / library_revisions.blocks   ←── sole body
  (blocks may include type=answer_key | solution — redacted on client init)
```

- Bumping ActivitySpec `version` **and** activity `content_version` happens in one transaction (CAS on `expectedVersion` = current `content_version`).
- Reading an **old** lesson version = `listRevisions` / get revision by number on the library document; ActivitySpec may pin a historical `revision_number`.
- Partial update = library update with `expectedRevisionNumber` for touched body **or** metadata-only ActivitySpec patch that keeps the same revision when only order/refs change; either path must preserve draft anchors or return explicit mismatch (see §5).

## 2. Contract field sketches

**Proposed file:** `packages/contracts/src/opening/teaching-content.ts`  
(Read patterns from `teaching-activity.ts`, `learning.ts`, library CAS; export via `packages/contracts/src/opening/index.ts` at Implement.)

```ts
// sketches — not implemented this slice

teachingGoalSchema = {
  goalId: string,                 // stable within unit
  statement: string,              // max ~2k
  successCriteria?: string[],
  linkedSourceIds?: uuid[],
}

teachingBlockRefSchema = {
  blockId: uuid,                  // library block id (stable across revisions when preserved)
  position: int >= 0,
  blockType: string,              // text | formula | prompt | example | steps | answer_key | …
  role: "teach" | "prompt" | "example" | "answer_key" | "meta",
}

teachingSourceRefSchema = {
  sourceId: uuid,
  version?: string | number | null,
  chunkId?: string | null,
  page?: number | null,
}

teachingVerificationStatusSchema = enum[
  "unchecked", "structure_ok", "needs_check", "verified", "rejected", "stale"
]

teachingGenerationConfigSchema = {
  providerHint?: string,
  budgetClass?: string,
  locale?: string,
  // opaque extensibility; strict unknown keys rejected at boundary
  extras?: Record<string, unknown>,
}

teachingUnitSchema = {
  id: uuid,
  workspaceId, ownerUserId,
  title: string,
  documentId: uuid,                 // library_documents.id — sole body
  currentRevisionNumber: int >= 0,  // mirror of library current (denorm OK)
  goals: teachingGoalSchema[],
  verificationStatus: teachingVerificationStatusSchema,
  generationConfig: teachingGenerationConfigSchema,
  version: int >= 0,                // unit metadata CAS version
  createdAt, updatedAt,
}

activitySpecSchema = {
  id: uuid,
  activityId: uuid,                 // → opening_teaching_activities.id
  teachingUnitId: uuid,
  documentId: uuid,
  revisionNumber: int > 0,          // pinned library revision for this publish
  blockOrder: teachingBlockRefSchema[],  // index only — no content jsonb
  sourceRefs: teachingSourceRefSchema[],
  goals: teachingGoalSchema[],      // snapshot of goals at publish (or refs by goalId)
  verificationStatus: teachingVerificationStatusSchema,
  generationConfig: teachingGenerationConfigSchema,
  version: int >= 0,                // equals activity.contentVersion after publish
  createdAt, updatedAt,
}

// Client-safe projection (GET init / restore) — answer_key content stripped
activitySpecClientInitSchema = activitySpecSchema.extend({
  blocks: array({
    blockId, position, blockType, role,
    content: unknown | null,        // null when role=answer_key and unrevealed
    answerRef?: { refId: uuid, revealState: "hidden" | "revealed" },
  }),
}).strict()
// Invariant: no answer_key plaintext in blocks[].content when revealState=hidden

activitySpecPublishInputSchema = {
  activityId,
  teachingUnitId?,                  // optional create-or-bind
  expectedVersion: int >= 0,        // activity.content_version CAS
  expectedRevisionNumber?: int,     // when also writing library body
  blockOrder, sourceRefs, goals, verificationStatus, generationConfig,
  // body write goes through library repo; this input carries metadata + optional body patch handle
}

teachingDraftAnchorSchema = {
  blockId: uuid,
  contentVersion: int,              // activity content_version when draft was saved
  draftText?: string,               // small inline
  draftDocumentId?: uuid,           // optional personal scratch library doc
}
// Stored under activity.checkpoint_json.drafts[] (or adjacent key) — not in TeachingUnit
```

## 3. DDL sketch (placeholder `00xx`)

**Migration needed: YES.**  
**File (Implement):** `packages/database/src/migrations/00xx_opening_teaching_content.sql`  
**Numbering:** Integrator assigns against live `schema_migrations`. Tip currently ends at **`0053_opening_teaching_activities.sql`**; next candidate is likely **0054**, but **do not invent** — keep `00xx` until Integrator confirms (same discipline as V2-04 → 0053).

```sql
-- 00xx_opening_teaching_content.sql  (SKETCH ONLY — do not apply in this slice)

CREATE TABLE opening_teaching_units (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  document_id UUID NOT NULL,  -- library_documents.id (composite FK if workspace-scoped unique exists)
  current_revision_number INTEGER NOT NULL DEFAULT 0 CHECK (current_revision_number >= 0),
  goals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (verification_status IN (
      'unchecked', 'structure_ok', 'needs_check', 'verified', 'rejected', 'stale'
    )),
  generation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
  -- FOREIGN KEY (workspace_id, document_id) REFERENCES library_documents(workspace_id, id)
);

CREATE INDEX opening_teaching_units_owner_idx
  ON opening_teaching_units (workspace_id, owner_user_id, updated_at DESC);

CREATE TABLE opening_teaching_activity_specs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id UUID NOT NULL
    REFERENCES opening_teaching_activities(id) ON DELETE CASCADE,
  teaching_unit_id UUID NOT NULL
    REFERENCES opening_teaching_units(id),
  document_id UUID NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  block_order JSONB NOT NULL DEFAULT '[]'::jsonb,   -- teachingBlockRef[]
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  goals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status TEXT NOT NULL DEFAULT 'unchecked',
  generation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL CHECK (version >= 0),    -- mirrors activity.content_version at publish
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, activity_id),               -- one current spec binding per activity
  UNIQUE (workspace_id, id)
);

CREATE INDEX opening_teaching_activity_specs_unit_idx
  ON opening_teaching_activity_specs (workspace_id, teaching_unit_id);

-- Optional server-only answer ref index (no plaintext). Prefer deriving refs from
-- library blocks with role=answer_key at read time; add this table only if query
-- patterns require stable refIds independent of block ids:
-- CREATE TABLE opening_teaching_answer_refs (
--   id UUID PRIMARY KEY,
--   workspace_id UUID NOT NULL,
--   teaching_unit_id UUID NOT NULL,
--   block_id UUID NOT NULL,
--   revision_number INTEGER NOT NULL,
--   UNIQUE (workspace_id, teaching_unit_id, block_id, revision_number)
-- );

-- ALTER opening_teaching_activities: optional denorm pointer for fast joins
-- ALTER TABLE opening_teaching_activities
--   ADD COLUMN teaching_unit_id UUID NULL,
--   ADD COLUMN content_document_id UUID NULL,
--   ADD COLUMN content_revision_number INTEGER NULL;
-- Prefer reading via activity_specs first; add columns only if list/Today hot path needs them.
```

**Explicit non-DDL this slice:** no change to `library_*` body shape beyond conventions (`block.type` / `content.role`); no second body table; no DROP of user data.

## 4. Repository methods

**Proposed:** `packages/database/src/repositories/opening-teaching-content.ts`  
Reuse: `assertOwnedActivity`, library `getDocument` / `listRevisions` / update-with-`expectedRevisionNumber`, `lockLearningOwner`.

| Method | Behavior |
|---|---|
| `createUnit(scope, input)` | Create library doc (lifecycle `candidate`/`scratch`) + unit row; body via library |
| `getUnit` / `listUnits` | Owner-scoped |
| `publishActivitySpec(scope, input)` | CAS: `expectedVersion === activity.content_version`; write/update spec; set `activity.content_version = expectedVersion+1`; soft-idempotent if already at +1 with same spec graph (knowledge pattern) |
| `getActivitySpec(scope, activityId)` | Current binding |
| `getActivitySpecAtVersion(scope, activityId, version)` | Historical: resolve pinned `revision_number` for that version (may require append-only spec history — see rejected alts; M1 minimum = keep prior revision readable via library even if only current spec row retained, by storing `revision_number` and never deleting library revisions) |
| `getClientInit(scope, activityId)` | Load revision blocks; **strip** `answer_key` plaintext → `answerRef { revealState: "hidden" }`; never include keys in checkpoint restore payload |
| `saveDraftAnchors(scope, activityId, { expectedVersion, drafts })` | Update `checkpoint_json` only; if `expectedVersion` mismatch → CONFLICT; if anchors’ `blockId`s missing from current blockOrder → return `{ ok:false, mismatch: "draft_anchor_lost", lostBlockIds }` without silently dropping |
| `readRevision(scope, documentId, revisionNumber)` | Pass-through library list/get revision (old versions readable) |

Drizzle schema companion (Implement): `packages/database/src/schema/opening-teaching-content.ts`.

Service wiring (Implement, thin): extend `activity-service` or add `teaching-content-service` under `apps/web/src/features/opening/teaching/` — **out of Plan ACCEPT execution**; Experience render stays later.

## 5. Draft / answer separation + client-init rules

### 5.1 Separation

| Data | Where | Client init? |
|---|---|---|
| Teach prompts / examples / steps | `library_revisions.blocks` | Yes (content) |
| Answer keys / solutions | Same revision, `role=answer_key` (or `type=answer_key`) | **No plaintext** — opaque `answerRef` only until reveal path |
| Mid-lesson drafts | `opening_teaching_activities.checkpoint_json` (+ optional personal scratch doc) | Yes (user’s own drafts) |
| Formal attempts | `opening_learning_observations` / attempts | Via learning APIs, not teaching init |
| Feedback (non-mastery) | Future feedback API (plan §6.3); not body | Not in reusable unit |

### 5.2 Unrevealed answers — hard rules

1. `getClientInit` / any restore snapshot serializer **must** redact answer-key block content.
2. DOM/JSON fixtures for client must not embed `solutionZh` / answer plaintext under teaching init keys.
3. Backup/restore of **Opening** tables restores metadata + checkpoint; library body restores via **native library backup**. Opening restore must not invent a second plaintext dump of keys into checkpoint.
4. Reveal later: help exposure / tutor policy already distinguishes `revealed`; V2-05 only ensures keys are not pre-leaked. Reveal payload is a separate authorized read, not part of init.

### 5.3 Local revision vs draft anchors

On content publish that changes block set:

- If every draft `blockId` still present in new `blockOrder` → keep drafts; record `contentVersion` bump on anchors optionally.
- If any draft `blockId` missing → **explicit mismatch** in API result (`draft_anchor_lost`); do not invent silent remaps.

## 6. How V2-05 attaches to V2-04 + CT-03 (read-only note)

- V2-04 activity row already has `content_version` / `checkpoint_json` / `generate_status` stubs — V2-05 **owns** publishing meaning into `content_version` and filling client-safe body projection.
- CT-03 Today panel currently shows honesty without lecture; after Implement + Experience follow-up, panel consumes `getClientInit` instead of empty honesty-only shell.
- No change to Today CTA identity rules in this Data plan.

## 7. Tests list (Implement; all `not_run` at Plan stage)

| ID | Check |
|---|---|
| T1 | Contract parse: TeachingUnit / ActivitySpec / clientInit reject unknown keys; answer_key content forbidden on clientInit schema path |
| T2 | `publishActivitySpec` CAS: stale `expectedVersion` → CONFLICT; soft-idempotent same graph at +1 |
| T3 | Read old library revision after two publishes — body of rev N still readable |
| T4 | Partial body update with `expectedRevisionNumber` conflict |
| T5 | Draft anchors preserved across metadata-only publish; lost when block removed → explicit mismatch |
| T6 | `getClientInit` JSON has no answer-key plaintext (fixture with solution blocks) |
| T7 | Restore / snapshot helper (unit) does not place unrevealed answers into checkpoint dump |
| T8 | Formal observation still writes learning tables only (no teaching answer ledger fork) — regression smoke |
| T9 | Backup registration: new tables present in `OPENING_BACKUP_TABLES` + apply order / empty-namespace counts (when Implement lands) |

## 8. Rejected alternatives

| Alt | Why rejected |
|---|---|
| Store teaching body JSON on `opening_teaching_*` | Violates ADR D2; second body store |
| Chat transcript / turn dump as lesson | Fails continue/cite/partial-update; not versioned teaching structure |
| Parallel “teaching_answers” fact table for scoring | Forks learning ledger; conflicts G8 / D3 |
| Ghost course to hang content | Forbidden D1/D5 |
| Separate answer-key DB without library | Still a second body; prefer library + redaction |
| Nullable invent migration `0054` in docs as assigned | Integrator-only; keep `00xx` |
| Full append-only ActivitySpec history table in M1 | Nice-to-have; M1 pins `revision_number` + library append-only; add history table only if product needs list of past specs without library archaeology |

## 9. Migration + backup registration

| Item | Plan decision |
|---|---|
| Migration needed? | **Yes** (`00xx_opening_teaching_content.sql`) |
| Number | Placeholder **`00xx`**; Integrator assigns vs live `schema_migrations` (tip ends **0053**) |
| Backup | On Implement: register `opening_teaching_units`, `opening_teaching_activity_specs` (and answer_refs if created) in `OPENING_BACKUP_TABLES`, record table queries, restore apply order/columns, domain allowlists — **same batch as first write**. Library body remains on **native library backup**. |
| Rollback | Feature-flag off new publish/init; **retain** rows; old library revisions readable; stop generation without deleting notes/drafts/checkpoints. No DROP of user data. |

## 10. Implement gate (after Plan ACCEPT)

1. Integrator / designated Reviewer **ACCEPT** this Plan.  
2. Integrator assigns migration number replacing `00xx`.  
3. Separate Implement slice: contracts → migration → repo → thin service → tests T1–T9 → evidence per `review-test-gates.md`.  
4. **This document does not authorize ALTER or product code.**

## 11. Files to add/change at Implement (preview)

| Path | Action |
|---|---|
| `packages/contracts/src/opening/teaching-content.ts` (+ test) | New |
| `packages/contracts/src/opening/index.ts` | Export |
| `packages/database/src/migrations/00xx_opening_teaching_content.sql` | New (Integrator renumbers) |
| `packages/database/src/schema/opening-teaching-content.ts` | New |
| `packages/database/src/repositories/opening-teaching-content.ts` (+ test) | New |
| `packages/database/src/repositories/opening-backup-*.ts` + domain backup lists | Register new tables |
| Optional: `opening_teaching_activities` denorm columns | Only if hot-path justified |
| `apps/web/.../teaching/*` content service | Thin; Experience render separate |

**Not touching in V2-05 Data Implement:** CT-03 UI layout; V2-07 worker; learning observation schema.
