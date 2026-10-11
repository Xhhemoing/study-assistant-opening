# V2-12 Plan — Teaching commands (why / rephrase / expand / example / skip / branch / return)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `3083809f7c29652f6a859a81bd402c486e5e66d1` (`feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · migration number placeholder **`00xx`** if needed (Integrator assigns; tip migrations end at **0056**)  
**Align:** `plan.md` §V2-12 + §6.3; Understand `v2-12-teaching-commands-understand.md`; PM design locks (bind activityId+blockId+contentVersion; rewrite=new Revision; branch=same activity; clientKey+expectedVersion CAS; forbid LWW; nest TeachingWorkspace; no push/hermes)

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **TeachingCommand** | User-initiated envelope: kind + activityId + blockId + contentVersion (+ optional pathVersion) + clientKey | Tutor proactive policy; mastery scores |
| **CommandService** | Domain+repo orchestration: validate, CAS, rewrite/skip/branch/return, preserve drafts | UI chrome; free-chat product |
| **Rewrite Revision** | New `library_revisions` row via `updateDocument(expectedRevisionNumber)` for rephrase/expand/example | Mutating prior revision bodies |
| **Branch stack** | Same-activity recoverable path frames in `checkpoint_json.branchStack` | Isolated chat threads |
| **Command log ring** | Soft-idempotent `clientKey` replay + audit of recent commands | Formal observation ledger |
| **Experience affordances** | Buttons / menus on TeachingWorkspace blocks (preview only) | Domain CAS |

### 1.2 Link graph

```
TeachingWorkspace (V2-10)
  blocks from getClientInit (V2-05)
        │
        │ POST /api/opening/teaching/activities/{id}/commands
        ▼
command-service.ts
  validate envelope (activityId, blockId, contentVersion, clientKey, kind)
        │
        ├── CAS: activity.content_version === expectedVersion
        │         (+ optional path_version === expectedPathVersion)
        │         conflict → CONFLICT codes (no LWW)
        │
        ├── why      → assist projection (no body mutate); may enqueue help later
        ├── rephrase │
        ├── expand   ├── library.updateDocument(expectedRevisionNumber)
        ├── example  │   → new Revision; pin ActivitySpec.revision_number
        │            └── bump activity.content_version (+ publish soft-idempotent)
        ├── skip     → checkpoint skippedBlockIds + cursor; NO observation/incorrect
        ├── branch   → push branchStack frame; path_version++
        └── return   → pop branchStack; restore cursor; path_version++
        │
        ▼
checkpoint_json keys (disjoint from V2-11):
  drafts | interventionPrefs | interventionDecisions   ← preserve
  branchStack | commandLog | currentBlockId | skippedBlockIds  ← V2-12
        │
        ▼
response: ok + new versions + refreshed clientInit OR conflict → reread/merge
```

### 1.3 Core rules (encoded in domain)

1. **Bind:** every command carries `activityId`, `blockId`, `expectedVersion` (= activity `content_version`), `clientKey` (≥8 chars). `blockId` must exist in current ActivitySpec `blockOrder` (except `return`, which may omit or ignore block when popping).
2. **Kinds:** `why` | `rephrase` | `expand` | `example` | `skip` | `branch` | `return` only (strict Zod).
3. **Rewrite → new Revision:** `rephrase` / `expand` / `example` never UPDATE old `library_revisions` rows; always `updateDocument` with `expectedRevisionNumber` = current pin → append revision; then pin spec + bump `content_version` in **one transaction**.
4. **Preserve drafts + answer state:** on rewrite/content bump, merge checkpoint keeping `drafts` whose `blockId` still present; preserve revealed `answerRef` state in server metadata (clientInit still redacts hidden keys). If draft blockIds vanish → return `draft_anchor_lost`-style mismatch (same spirit as V2-05), not silent drop.
5. **Skip ≠ wrong answer:** `skip` writes checkpoint path only; **forbids** insert into `opening_learning_observations` / attempts as incorrect/correct.
6. **Branch = same activity:** push `{ fromBlockId, contentVersion, pathVersion, label?, createdAt }` onto `branchStack` (max **16**); cursor may move to branch entry block; **not** a new activity / chat session.
7. **Return:** pop stack; restore `currentBlockId` to `fromBlockId` (or recorded resumeBlockId); if stack empty → CONFLICT `branch_stack_empty`.
8. **CAS / no LWW:** mismatch on `expectedVersion` (or optional `expectedPathVersion`) → `CONFLICT` with current versions; client must GET clientInit / merge. Soft-idempotent: **same** `clientKey` + identical command intent → replay prior success payload; different intent same key → `CONFLICT` `client_key_intent_mismatch`.
9. **Generate-in-flight:** if activity `generateStatus` ∈ `queued|generating`, path-change commands (`skip`/`branch`/`return`) may proceed on checkpoint; **rewrite** commands that need body generation → `CONFLICT` `generate_in_flight` or `defer` result code — Plan default = **`CONFLICT` `generate_in_flight`** for rewrite kinds; skip/branch/return allowed.
10. **Intervention non-conflict:** do not call `decideIntervention` to *deny* these commands; they are explicit user actions. Quiet mode still allows them.
11. **Nest:** only TeachingWorkspace / activity commands API — no parallel product route tree.

### 1.4 Version fields

| Field | When bumps | Command CAS |
|---|---|---|
| `content_version` | Rewrite publish (rephrase/expand/example) that pins new library revision | **Required** `expectedVersion` |
| `path_version` | skip / branch / return (cursor / stack changes) | Optional `expectedPathVersion`; if sent, must match |
| Library `current_revision_number` | `updateDocument` on rewrite | `expectedRevisionNumber` inside service (from pinned spec) |
| ActivitySpec `version` | Mirrors `content_version` after rewrite publish | Same txn as V2-05 publish |

`why` alone: Plan default **does not** bump content or path version (read/assist only); may append `commandLog` best-effort.

## 2. Contract sketches

**Proposed file:** `packages/contracts/src/opening/teaching-commands.ts`  
(Export via `packages/contracts/src/opening/index.ts` at Implement.)

```ts
// sketches — not implemented this slice

teachingCommandKindSchema = enum[
  "why", "rephrase", "expand", "example", "skip", "branch", "return"
]

teachingCommandRequestSchema = {
  clientKey: string.min(8).max(200),
  kind: teachingCommandKindSchema,
  blockId: uuid,                    // required except return may be optional
  expectedVersion: int >= 0,        // activity.content_version
  expectedPathVersion: int >= 1,    // optional
  expectedRevisionNumber: int > 0,  // optional; rewrite kinds: server may fill from spec pin
  // kind-specific:
  prompt?: string.max(2000),        // why / rephrase / expand / example user hint
  branchLabel?: string.max(200),    // branch
  targetBlockId?: uuid,             // branch entry / skip-to
}.strict()

teachingBranchFrameSchema = {
  frameId: uuid,
  fromBlockId: uuid,
  resumeBlockId?: uuid,             // default = fromBlockId
  contentVersion: int >= 0,         // content_version at push
  pathVersion: int >= 1,
  label?: string.max(200),
  createdAt: isoDateTime,
}.strict()

teachingCommandLogEntrySchema = {
  clientKey: string,
  kind: teachingCommandKindSchema,
  blockId?: uuid,
  at: isoDateTime,
  result: "ok" | "conflict" | "rejected",
  contentVersionAfter?: int,
  pathVersionAfter?: int,
  revisionNumberAfter?: int,
}.strict()

teachingCommandConflictCodeSchema = enum[
  "stale_content_version",
  "stale_path_version",
  "stale_revision",
  "client_key_intent_mismatch",
  "block_not_in_spec",
  "branch_stack_empty",
  "generate_in_flight",
  "draft_anchor_lost",
  "validation"
]

teachingCommandSuccessSchema = {
  ok: true,
  kind: teachingCommandKindSchema,
  activityId: uuid,
  contentVersion: int >= 0,
  pathVersion: int >= 1,
  revisionNumber?: int,             // when rewrite
  checkpointJson: record,           // sanitized
  clientInit?: activitySpecClientInitSchema, // Plan default: include refreshed init
  replayed: boolean,                // soft-idempotent hit
}.strict()

teachingCommandConflictSchema = {
  ok: false,
  conflict: teachingCommandConflictCodeSchema,
  message: string,
  currentContentVersion?: int,
  currentPathVersion?: int,
  currentRevisionNumber?: int,
  lostBlockIds?: uuid[],
  // client MUST reread getClientInit / merge — never retry as LWW overwrite
}.strict()

teachingCommandResponseSchema = discriminatedUnion("ok", [
  teachingCommandSuccessSchema,
  teachingCommandConflictSchema,
])
```

**Domain (proposed):** `packages/domain/src/opening/teaching-commands.ts`

```ts
// sketches
assertCommandAllowed(activity, kind): void
// generate_in_flight for rewrite; block presence; return needs non-empty stack preview

mergeCheckpointPreservingPrefs(
  prev: Record<string, unknown>,
  patch: Partial<{ branchStack, commandLog, currentBlockId, skippedBlockIds, drafts }>
): Record<string, unknown>
// MUST preserve interventionPrefs / interventionDecisions / unknown keys

pushBranch(stack, frame): TeachingBranchFrame[]  // cap 16
popBranch(stack): { frame, nextStack } | { empty: true }

classifySkipSideEffects(): { writesObservation: false }  // locked
```

**Service (proposed):** `apps/web/src/features/opening/teaching/command-service.ts`  
**Route (proposed):** `apps/web/src/app/api/opening/teaching/activities/[id]/commands/route.ts` — POST only; auth + scope like other teaching routes.

## 3. CAS + revision-for-rewrite + draft preservation

### 3.1 Rewrite transaction (rephrase / expand / example)

1. Lock activity row (`FOR UPDATE`); assert `content_version === expectedVersion`.
2. Load ActivitySpec; assert `blockId` in `blockOrder`; read library revision at pin.
3. Soft-idempotent: if `commandLog` has same `clientKey` with equal intent → return prior success (no second revision).
4. Build rewritten blocks (worker/model may supply candidate body in a later hook; M1 may accept server-side structured rewrite payload in request `prompt` + deterministic stub **or** enqueue compile — **Plan default for M1 Data:** command service accepts an optional `blocksPatch` only from **trusted server-side generator callback**; HTTP request carries `prompt` only, not raw HTML. Experience does not send body bytes. If generator unavailable → result `ok:false` `conflict:"validation"` or deferred job id — prefer **synchronous minimal rewrite** that creates a new revision cloning prior blocks with a metadata `rewriteOf` / note block for the target `blockId` so CAS path is real; full LLM rewrite can attach via V2-07 job later without changing envelope.
5. `library.updateDocument({ expectedRevisionNumber: pinned })` → new revision N+1.
6. Upsert ActivitySpec pin `revision_number = N+1`, `version = content_version+1` (reuse publish equality set spirit).
7. Bump activity `content_version`; merge checkpoint: keep drafts for surviving blockIds; append `commandLog` (ring max **32**); set `currentBlockId` as needed.
8. Return success + `getClientInit` projection.

### 3.2 Skip

1. CAS `expectedVersion` (path optional).
2. Add `blockId` to `skippedBlockIds` (set); advance `currentBlockId` to `targetBlockId` or next in `blockOrder`.
3. Bump `path_version` only (Plan default); **do not** bump `content_version`; **do not** write observation.
4. Activity status stays `active` unless product later maps whole-activity skip separately (OOS).

### 3.3 Branch / return

1. **branch:** push frame; optional `targetBlockId` becomes `currentBlockId`; `path_version++`.
2. **return:** pop; restore `currentBlockId` to `resumeBlockId ?? fromBlockId`; `path_version++`; empty → conflict.
3. Body revision unchanged; drafts preserved.

### 3.4 Conflict codes → client behavior

| Code | Client must |
|---|---|
| `stale_content_version` / `stale_path_version` / `stale_revision` | Reread clientInit; merge local draft; retry with new expected* |
| `client_key_intent_mismatch` | New clientKey; do not overwrite |
| `block_not_in_spec` | Reread; block gone after publish |
| `branch_stack_empty` | Disable return affordance |
| `generate_in_flight` | Wait / poll generateStatus; retry rewrite later |
| `draft_anchor_lost` | Surface lost drafts; user confirms drop or remaps |

**Forbid:** silent overwrite of checkpoint or library body when versions mismatch.

## 4. DDL decision

| Option | Plan choice |
|---|---|
| New `opening_teaching_commands` table | **Rejected for M1** |
| New columns on activity | **Rejected** — checkpoint jsonb sufficient |
| `checkpoint_json.branchStack` + `commandLog` + cursor / skipped | **Accepted** |
| Migration | **NONE required** for M1 if no new column/table |

**Migration needed: NO** (Plan default).  
If Integrator later wants indexed command audit, add `00xx` then — tip today ends **`0056_opening_intervention_settings.sql`**; keep placeholder discipline.

**Backup:** checkpoint_json already on activity row in teaching backup paths — no new table registration.

## 5. Attach point inventory

| Surface | How V2-12 attaches |
|---|---|
| V2-05 publish / getClientInit | Rewrite reuses publish CAS + returns/refreshes clientInit; redact unchanged |
| Library CAS | Sole body rewrite path via `expectedRevisionNumber` |
| Draft anchors | Preserve across bump; lost → explicit mismatch |
| V2-10 TeachingWorkspace | Experience mounts command affordances per block; calls commands API; handles conflict UI |
| V2-11 intervention | Preserve checkpoint prefs keys; commands not gated by quiet/proactive |
| Learning observations | Skip must not write; formal submit remains observation APIs (unchanged) |
| `path_version` | Activated for branch/return/skip cursor CAS |
| plan.md §6.3 | Implements proposed POST commands route (adds `why`/`example` per V2-12 scope) |

## 6. Experience preview (Data does not implement UI)

| Path | Owner | Note |
|---|---|---|
| Command buttons on block chrome (why / rephrase / expand / example / skip / branch / return) | Experience | Nest in TeachingWorkspace; disable return when stack empty; show conflict/reread |
| Conflict / merge toast | Experience | Never offer “force overwrite” |
| `command-service.ts` consumed via OpeningApi | Data delivers | Experience binds after contracts stable |

## 7. Tests list (Implement; all `not_run` at Plan stage)

| ID | Check |
|---|---|
| T1 | Contract: all 7 kinds parse; reject unknown kind / short clientKey / missing expectedVersion |
| T2 | CAS: stale `expectedVersion` → `stale_content_version`; no body/checkpoint LWW |
| T3 | Soft-idempotent: same clientKey+intent → replay; different intent → `client_key_intent_mismatch` |
| T4 | Rewrite creates **new** library revision; old revision bytes unchanged (`readRevision` old N) |
| T5 | Rewrite bumps activity `content_version` + pins spec `revision_number` in one txn |
| T6 | Drafts preserved across rewrite when blockIds survive |
| T7 | Draft blockId removed by rewrite/order change → `draft_anchor_lost` (or equivalent) |
| T8 | Skip does **not** insert observation / incorrect attempt (repo spy or DB assert) |
| T9 | Skip updates `skippedBlockIds` + `path_version`; content_version unchanged |
| T10 | Branch push + return pop restores `currentBlockId`; stack empty return → `branch_stack_empty` |
| T11 | Branch stack cap 16 |
| T12 | Dual-client: A rewrites, B command with old version → conflict; B reread then succeeds |
| T13 | `generateStatus=generating` + rephrase → `generate_in_flight`; skip still OK |
| T14 | Command on blockId absent from spec → `block_not_in_spec` |
| T15 | Checkpoint merge preserves `interventionPrefs` / `interventionDecisions` / `drafts` |
| T16 | `why` does not mutate library revision (content_version unchanged) |
| T17 | clientInit after rewrite still redacts hidden answer_key |
| T18 | Route auth: other owner → NOT_FOUND/FORBIDDEN; no cross-workspace |

**Plan-stage:** all above **`not_run`**.

## 8. Rejected alternatives

| Alt | Why rejected |
|---|---|
| Last-write-wins overwrite | PM lock; C01; loses concurrent drafts |
| Chat-as-branch / new session per digression | PM lock; acceptance: recoverable same-activity path |
| Mutate original library revision in place | PM lock; breaks cite/history; library model is append revision |
| Parallel commands product / second workspace | PM lock; nest TeachingWorkspace |
| Stuff commands into intervention decision ring | Wrong semantics (policy choice ≠ user command) |
| Skip writes incorrect observation | PM lock / verification; pollutes mastery |
| New commands table in M1 | Prefer checkpoint; Integrator can add later |
| Invent migration `0057` as assigned | Integrator-only; DDL not needed in Plan default |
| HTTP client sends full HTML body patch | XSS / arbitrary HTML risk; catalog + server authorize only |
| Gate why/rephrase on quietMode | Conflicts V2-11 user-ask≠interrupt; commands are explicit |

## 9. Migration + rollback

| Item | Plan decision |
|---|---|
| Migration needed? | **No** (M1 default) |
| If later audit DDL | `00xx_…`; tip ends **0056** |
| Rollback | Feature-flag / disable commands route writes; original revisions + drafts remain readable (`plan.md` rollback) |
| Data destruction | Never DROP library revisions or checkpoint drafts on rollback |

## 10. Open questions (Plan defaults)

1. **DDL:** **none** — checkpoint branch stack + command log only.  
2. **Rewrite bumps:** **content_version + library revision + spec pin** in one txn.  
3. **`why`:** **assist-only** (no revision); rewrite kinds = rephrase/expand/example.  
4. **Skip:** **no observation / no incorrect**.  
5. **`path_version`:** bump on skip/branch/return; optional `expectedPathVersion` CAS.  
6. **M1 rewrite body source:** **server-side structured rewrite** (clone + targeted note/replacement); full LLM rewrite may enqueue V2-07 later without envelope change.  
7. **Success payload:** include **refreshed `clientInit`** to reduce race on reread.  
8. **Command log ring size:** **32**; branch stack **16**.

Escalate to Paula only if a default is rejected.

## 11. Implement gate (after Plan ACCEPT)

1. Integrator / designated Reviewer **ACCEPT** this Plan.  
2. Confirm DDL = none (or Integrator assigns `00xx` if PM flips to audited table).  
3. Separate Implement slices:  
   - **Data:** contracts → domain helpers → repo/command-service CAS → route → tests T1–T18 → evidence per `review-test-gates.md`.  
   - **Experience:** command affordances on TeachingWorkspace — after contracts stable.  
4. **This document does not authorize ALTER or product code.**

## 12. Files to add/change at Implement (preview)

| Path | Action | Owner |
|---|---|---|
| `packages/contracts/src/opening/teaching-commands.ts` (+ test) | New | Data |
| `packages/contracts/src/opening/index.ts` | Export | Data |
| `packages/domain/src/opening/teaching-commands.ts` (+ test) | New | Data |
| `packages/database/src/repositories/opening-teaching-commands.ts` (or methods on teaching-content repo) | New / extend | Data |
| `apps/web/src/features/opening/teaching/command-service.ts` | New | Data |
| `apps/web/src/app/api/opening/teaching/activities/[id]/commands/route.ts` | New | Data/Service |
| TeachingWorkspace command chrome | New affordances | **Experience** |
| OpeningApi client helper | Wire POST commands | Experience/Data |

**Not touching in V2-12 Data Implement:** intervention prefs semantics; V2-13 evidence overhaul; V2-14 full resume package; push/hermes; inventing migration numbers.
