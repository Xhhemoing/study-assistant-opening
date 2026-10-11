# V2-14 Plan — Learning breakpoint & cross-device resume

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`feat/opening-release`) — matches V2-13 tip baseline `a8eb193`  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · migration number placeholder **`00xx`** if needed (Integrator assigns; tip migrations end at **0057**)  
**Align:** `plan.md` §V2-14; Understand `v2-14-learning-resume-understand.md`; PM locks 1–7; charter G2/G7/G8; gates `review-test-gates.md`

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **LearningBreakpoint (server)** | Official state inside `opening_teaching_activities` + existing learning fact tables | Chat transcript product |
| **LearningResume (DTO)** | Read package: activity meta + clientInit + thought train + drafts + attempts + help + open problems + gates + continuable actions | Experience chrome / resume-card layout |
| **Checkpoint nest** | Extend `checkpoint_json` keys only when needed (`interactionParams`; optional `openProblemIds` cache) | Parallel resume table |
| **Draft authority** | Server `drafts[]` via CAS save; client holds **unsent** text only | Local as source of truth |
| **Resume gates** | Permission (owned), material availability, unknown/in-flight jobs | Provider orchestration rewrite |
| **Summary independence** | Resume + draft save never await AI/course summarize | Closing auto-summary UX copy (Experience) |

### 1.2 Link graph

```
Device A / Device B
        │
        │ POST checkpoint | draft-anchors (CAS expectedVersion)
        │ optional local unsent draft buffer (non-authority)
        ▼
opening_teaching_activities.checkpoint_json
  ├── drafts[]              (V2-05)
  ├── currentBlockId / skippedBlockIds / branchStack / commandLog  (V2-12 thought train)
  ├── interventionPrefs / interventionDecisions  (V2-11 — preserve, disjoint)
  ├── interactionParams?    (V2-14 reserve; V2-15 consumers)
  └── openProblemIds?       (optional cache; facts remain authority)
        │
        ├── opening_learning_attempts / observations (activity_id) → actual attempts + open problems (derive)
        ├── opening_help_exposures (activity_id, delivered, kind) → help already delivered
        └── generate_status / source_ids → unknown job + material gates
        │
GET resume / getClientInit
        ▼
LearningResume  ──►  Experience resume-card (OOS Data Implement)
        │
        └── immediately continuable: commands API + draft continue + return-if-stack + wait-if-unknown
```

### 1.3 Core rules (encoded in domain + contracts)

1. **Nest, don't fork:** Official breakpoint lives on the existing activity row (`checkpoint_json` + versions) and existing fact tables. **No** `opening_learning_resume` / parallel activity.
2. **Breakpoint coverage (lock 1):**
   - **content version** → `activity.contentVersion` (+ `pathVersion`, pinned spec revision via clientInit)
   - **current block / interaction params** → `checkpoint.currentBlockId` + `checkpoint.interactionParams` (map `blockId → params`; default `{}`)
   - **drafts** → `checkpoint.drafts` (`TeachingDraftAnchor[]`)
   - **actual attempts** → activity-scoped attempt/observation heads (read projection)
   - **help already delivered** → delivered help exposures for activity (`kind` preserved)
   - **open problems** → **derive** from attempts/observations (Plan default); optional `openProblemIds` cache must not silently drop facts
3. **Thought train** = `branchStack` + `commandLog` + `currentBlockId` + `skippedBlockIds` (V2-12). Resume must return them (via sanitized checkpoint / clientInit), not only chat turns.
4. **Summary independence (lock 2):** `assembleLearningResume` and `saveDraftAnchors` / checkpoint POST **must not** call `summarizeLearning`, tutor digest, or compile completion. Summary failure is irrelevant to structured resume success.
5. **Server authority (lock 3):** After successful POST, server checkpoint wins. Local unsent drafts may exist only until acknowledged; on conflict, **juxtapose** server drafts vs local unsent — **never** silent LWW overwrite (reuse `draft_anchor_lost` / stale version conflicts).
6. **Resume gates (lock 4):**
   - **Permission:** `assertOwnedActivity` (other owner → NOT_FOUND)
   - **Material availability:** probe activity `sourceIds` (admit / privacy-exclusion / upload+chunks); return structured `materials: available|unavailable|partial` + unavailable ids — do not fabricate content
   - **Unknown jobs:** if `generateStatus ∈ {unknown, queued, generating}` (and optionally `stale`), set `jobGate` accordingly; still return structured checkpoint/drafts so user can wait or export — do not erase drafts
7. **Not chat resume (lock 5):** Do **not** route teaching resume through `ConversationResume` / `buildConversationResume`. Continuable actions = teaching commands + draft continue + pause/active status — not “open last chat”.
8. **Disjoint checkpoint keys (V2-11 / V2-12):** New writes use `mergeCheckpointPreservingPrefs`-style merges. Forbidden to clobber `interventionPrefs` / `interventionDecisions` / command keys when saving interaction params or drafts.
9. **Pause status:** Thin `setActivityStatus(scope, id, { status: "paused"|"active", expectedUpdatedAt? })` — enum already exists; enables cross-device “continue paused”. Completing activity remains separate; **complete ≠ mastery** (V2-13 lock stays).
10. **CAS everywhere:** Checkpoint/draft writes require `expectedVersion` (= content_version). Stale → CONFLICT with current versions; client rereads resume/clientInit.
11. **Sanitize on read:** Always `sanitizeCheckpointForRestore` before returning checkpoint to clients (no unrevealed answer keys).
12. **Idempotency / dual device:** Same as commands — soft-idempotent clientKeys where writes create jobs; draft save is version-CAS; dual-device draft conflict → explicit mismatch / side-by-side, never silent merge-drop.
13. **read-service role:** Keep course summarize as-is. Resume service is a **sibling** thin aggregator under `teaching/` (plan proposed path). May **reuse** ownership/read patterns from `read-service.ts` but does not extend course summary into teaching resume.
14. **History:** Do not backfill invented open problems or interaction params for old activities; empty defaults.
15. **No push/hermes.**

### 1.4 Ownership split — Data vs Experience

| Path / concern | Data Implement | Experience |
|---|---|---|
| `packages/contracts/.../teaching-resume.ts` (or extend teaching-activity/content) | LearningResume + checkpoint write schemas | Consume |
| `packages/domain/.../teaching-resume.ts` | Gates, open-problem derive, merge helpers, summary-independence asserts | — |
| `packages/database` activity `setStatus`; activity-scoped help/attempt list helpers | Extend existing repos | — |
| `apps/web/.../teaching/resume-service.ts` | **New** thin assemble + pause + checkpoint facade | — |
| HTTP `GET .../resume`, `POST .../checkpoint` (and/or draft-anchors route) | New routes | Call via OpeningApi |
| Wire OpeningApi helpers | Data may add typed helpers | Experience binds UI |
| `resume-card.tsx` | **Document only** | **Experience OOS for Data Implement** |
| TeachingWorkspace “continue” entry | — | Mount card / deep-link after contracts stable |
| Local unsent draft buffer UX | Spec only | Experience |

## 2. Contract sketches

**Proposed:** `packages/contracts/src/opening/teaching-resume.ts` (new) — or additive schemas beside `teaching-activity.ts` / `teaching-content.ts` if Integrator prefers fewer files. Plan default: **new file** for resume DTO clarity.

```ts
// sketches — not implemented this slice

teachingResumeJobGateSchema = enum[
  "ready",           // generateStatus ready | needs_check | failed | cancelled (content usable or clearly failed)
  "in_flight",       // queued | generating
  "unknown",         // generateStatus unknown (provider timeout/network class)
  "stale"            // privacy/epoch stale
]

teachingResumeMaterialsGateSchema = enum["available", "partial", "unavailable"]

teachingContinuableActionSchema = enum[
  "continue_block",
  "edit_draft",
  "command_why",
  "command_rephrase",
  "command_expand",
  "command_example",
  "command_skip",
  "command_branch",
  "command_return",  // only if branchStack non-empty
  "wait_job",        // when jobGate in_flight | unknown
  "resolve_material" // when materials unavailable/partial
]

learningResumeAttemptSummarySchema = {
  attemptId: uuid,
  problemId: uuid | null,
  itemVersionId: uuid | null,
  outcome: "correct" | "incorrect" | "unverified" | "in_progress" | null,
  assistance: assistanceLevelSchema.optional(),
  submittedAt: iso.optional(),
}.strict()

learningResumeHelpSummarySchema = {
  id: uuid,
  kind: helpExposureKindSchema,  // instruction | hint | solution
  level: enum["hinted", "revealed"],
  problemId: uuid | null,
  deliveredAt: iso.optional(),
}.strict()

learningResumeOpenProblemSchema = {
  problemId: uuid,
  itemVersionId: uuid | null,
  reason: enum["attempt_open", "incorrect_unresolved", "unverified_unresolved", "checkpoint_listed"],
}.strict()

learningResumeSchema = {
  activityId: uuid,
  status: teachingActivityStatusSchema,           // active|paused|...
  generateStatus: teachingActivityGenerateStatusSchema,
  contentVersion: int.nonnegative(),
  pathVersion: int.positive(),
  clientInit: activitySpecClientInitSchema,       // includes sanitized checkpointJson + redacted blocks
  thoughtTrain: {
    currentBlockId: uuid | null,
    skippedBlockIds: uuid[],
    branchStack: teachingBranchFrameSchema[],
    commandLog: teachingCommandLogEntrySchema[],  // may truncate to last N for payload size
  },
  drafts: teachingDraftAnchorSchema[],
  interactionParams: z.record(uuid, z.record(z.string(), z.unknown())).default({}),
  actualAttempts: learningResumeAttemptSummarySchema[].max(100),
  helpDelivered: learningResumeHelpSummarySchema[].max(100),
  openProblems: learningResumeOpenProblemSchema[].max(100),
  gates: {
    permission: literal("owned"),                 // else request fails NOT_FOUND
    materials: teachingResumeMaterialsGateSchema,
    unavailableSourceIds: uuid[],
    job: teachingResumeJobGateSchema,
  },
  continuableActions: teachingContinuableActionSchema[],
  // OPTIONAL best-effort; never required for ok:true
  summary: { status: enum["skipped", "failed", "ready"], text: string.optional() }.optional(),
}.strict()

teachingCheckpointSaveInputSchema = {
  expectedVersion: int.nonnegative(),
  // partial patch — server merges preserving prefs/command keys
  drafts: teachingDraftAnchorSchema[].max(64).optional(),
  currentBlockId: uuid.nullable().optional(),
  interactionParams: z.record(uuid, z.record(z.string(), z.unknown())).optional(),
  openProblemIds: uuid[].max(64).optional(),      // cache only
}.strict()

teachingActivityStatusUpdateInputSchema = {
  status: enum["active", "paused"],               // M1 resume slice: pause/unpause only
  expectedUpdatedAt: iso.optional(),
}.strict()
```

**Domain (proposed):** `packages/domain/src/opening/teaching-resume.ts`

```ts
// sketches
deriveOpenProblems(attempts, observations): OpenProblem[]
mapGenerateStatusToJobGate(generateStatus): JobGate
probeMaterialsAvailability(admittedIds, requestedIds): MaterialsGate
listContinuableActions(input: { jobGate, materials, branchStack, drafts, status }): ContinuableAction[]
assertResumeIndependentOfSummary(): void  // test seam: assemble path must not call summarize
mergeCheckpointResumePatch(prev, patch): Record<string, unknown>
  // preserves interventionPrefs/Decisions + V2-12 keys unless explicitly patched
```

**Service (proposed):** `apps/web/src/features/opening/teaching/resume-service.ts`

```ts
createOpeningTeachingResumeService(sql) => {
  getResume(scope, activityId)           // assemble LearningResume
  saveCheckpoint(scope, activityId, raw) // CAS merge; may delegate draft-only to saveDraftAnchors
  setStatus(scope, activityId, raw)      // paused|active
}
```

**Routes (proposed):**

| Method | Path | Notes |
|---|---|---|
| GET | `/api/opening/teaching/activities/{id}/resume` | Auth + assemble; Plan default primary read |
| POST | `/api/opening/teaching/activities/{id}/checkpoint` | plan.md §6.3; CAS body |
| PATCH | `/api/opening/teaching-activities/{id}/status` | pause/unpause — or nest under teaching/activities for consistency |

Also acceptable: expose draft-only as `POST .../draft-anchors` wrapping existing `saveDraftAnchors` if checkpoint POST lands later — **must** exist for lock 3 before Experience can stop showing “接口未接”.

**Experience (document only):** `apps/web/src/features/opening/teaching/resume-card.tsx` — **OOS for Data Implement**.

## 3. Behavior tables

### 3.1 Resume assemble

| Case | Expected |
|---|---|
| Owner reads resume | 200 LearningResume; checkpoint sanitized; answer keys hidden |
| Other owner / wrong workspace | NOT_FOUND |
| Mid-generate (`queued`/`generating`) | jobGate=`in_flight`; drafts+thought still returned; continuable includes `wait_job` |
| Provider unknown | jobGate=`unknown`; drafts preserved; no pretend ready |
| Source privacy-excluded / missing chunks | materials=`unavailable` or `partial`; `resolve_material` action; do not invent blocks |
| Source version changed but still admitted | materials available; clientInit shows current contentVersion; caller may show “内容有更新” via version fields |
| Summary job fails / omitted | `summary.status=failed|skipped`; **resume still ok** |
| Empty new activity | empty drafts/attempts/help/openProblems; continuable from clientInit readiness |

### 3.2 Checkpoint / draft save

| Case | Expected |
|---|---|
| Matching expectedVersion | Merge patch; preserve prefs + command keys; return new checkpoint + contentVersion |
| Stale expectedVersion | CONFLICT; no LWW |
| Draft blockId absent from spec | `draft_anchor_lost` + lostBlockIds; keep prior server drafts |
| Dual-device unsent local vs server drafts | Client shows both; server unchanged until user resolves (Experience); Data returns server truth |
| Save while summary failing | Success if CAS ok — **independent** |

### 3.3 Cross-device scenarios (verification map)

| Scenario (plan.md) | Data mechanism |
|---|---|
| Refresh mid-generate | getResume returns in_flight + checkpoint |
| Offline → reconnect | Local unsent drafts flush via POST checkpoint; CAS conflict → juxtapose |
| Service restart | Server checkpoint + facts survive; resume reread |
| Other device continue | Same activityId resume; pause status listable |
| Citation withdrawn / source gone | materials gate unavailable/partial |
| Source version change | contentVersion / clientInit current; no silent downgrade of facts |

## 4. DDL decision

| Option | Plan choice |
|---|---|
| New `opening_learning_resume` / breakpoint table | **Rejected** (PM lock 6) |
| New columns on activity for each field | **Rejected** — jsonb + fact tables suffice |
| Nest `interactionParams` (+ optional `openProblemIds`) in `checkpoint_json` | **Accepted** |
| Activity-scoped read helpers for help/attempts | **Accepted** (code only) |
| `setStatus` for paused/active | **Accepted** (column already exists — **no DDL**) |
| Indexed open-problems table | **Deferred** — only if Integrator rejects derive-only |

**Migration needed: NO** (Plan default).  
If Integrator later wants indexed open problems or generated columns: placeholder **`00xx_…`**; tip today ends **`0057_opening_help_exposure_kind.sql`**.

**Backup:** checkpoint_json already on teaching activity backup paths — no new table registration for M1 default.

## 5. Attach point inventory

| Surface | How V2-14 attaches |
|---|---|
| V2-04 activity | Nest checkpoint; add status pause/unpause |
| V2-05 getClientInit / saveDraftAnchors | Compose into resume; expose HTTP for drafts/checkpoint |
| V2-07 generateStatus / compile jobs | jobGate mapping |
| V2-11 intervention keys | Preserve on merge; disjoint from interactionParams |
| V2-12 commands / thought train | Included in resume; continuable actions mirror command kinds |
| V2-13 help kind + activity_id | helpDelivered projection |
| `learning/read-service.ts` | Pattern reference only; do not overload course summarize |
| Tutor conversation resume | **Untouched** — different product |
| TeachingWorkspace | Experience mounts resume-card / continue entry after Data routes land |

## 6. Experience preview (Data does not implement UI)

| Path | Owner | Note |
|---|---|---|
| `resume-card.tsx` | **Experience** | Show activity title/status, thought depth, draft chips, open problems, gate banners, Continue CTA |
| Conflict / side-by-side draft UI | Experience | Never “force overwrite” |
| Pause / Continue buttons | Experience | Call status + resume APIs |
| Local unsent draft buffer | Experience optional | Must label as unsent; server wins after sync |

## 7. Tests list (Implement; all `not_run` at Plan stage)

| ID | Check |
|---|---|
| T1 | Contract: LearningResume parse; rejects missing activityId/contentVersion |
| T2 | Ownership: other user → NOT_FOUND on getResume / saveCheckpoint / setStatus |
| T3 | Assemble includes contentVersion + currentBlockId + drafts + attempts + help + openProblems |
| T4 | Thought train: branchStack/commandLog/skipped restored from checkpoint |
| T5 | Sanitize: hidden answer_key content null in resume clientInit |
| T6 | Summary independence: assemble succeeds when summarize throws / is not called |
| T7 | Draft save CAS stale → CONFLICT; no checkpoint LWW |
| T8 | draft_anchor_lost when block removed; prior drafts retained on server |
| T9 | Dual patch: saving interactionParams preserves interventionPrefs + commandLog |
| T10 | jobGate=in_flight when generateStatus generating/queued |
| T11 | jobGate=unknown when generateStatus unknown; drafts still present |
| T12 | materials unavailable when source privacy-excluded / missing |
| T13 | Open problems derived from incorrect/unverified/open attempts (fixture) |
| T14 | continuableActions includes command_return iff branchStack non-empty |
| T15 | setStatus paused ↔ active; completed path unchanged / not mastery |
| T16 | Resume ≠ ConversationResume shape (no accidental chat-only fields as sole payload) |
| T17 | Route auth + zod response for GET resume / POST checkpoint |
| T18 | No new migration file when DDL=NO; tip still ends 0057 unless Integrator assigned 00xx |

**Plan-stage:** all above **`not_run`**.

## 8. Rejected alternatives

| Alt | Why rejected |
|---|---|
| Chat-only resume (`ConversationResume`) | PM lock 5 / G7 anti-example |
| Parallel resume / breakpoint table | PM lock 6 |
| Require AI summary before draft save or resume | PM lock 2 |
| LocalStorage / IndexedDB as official state | PM lock 3 |
| Silent LWW draft overwrite on conflict | plan.md verification; V2-12 precedent |
| Stuff resume into intervention decision ring | Wrong semantics |
| Reuse course `read-service.summarizeLearning` as resume | Wrong scope; course ≠ activity package |
| Implement `resume-card.tsx` in Data slice | Owner split; Experience OOS |
| Invent migration `0058` as assigned | Integrator-only; DDL not needed in Plan default |
| Infer mastery / close open problems from resume | V2-13 honesty; facts ledger only |
| Block resume entirely when job unknown | Must keep structured state + drafts readable (rollback spirit) |

## 9. Migration + rollback

| Item | Plan decision |
|---|---|
| Migration needed? | **No** (M1 default) |
| If later DDL | `00xx_…`; tip ends **0057** |
| Rollback | Disable resume/checkpoint routes; keep checkpoint_json + drafts + facts readable/exportable; closing auto-summary can stay off without blocking continue (`plan.md` rollback) |
| Data destruction | Never DROP checkpoint drafts or learning facts on rollback |

## 10. Open questions (Plan defaults)

1. **DDL:** **none** — nest checkpoint + derive open problems.  
2. **Open problems:** **derive** from attempts/observations; optional `openProblemIds` cache non-authoritative.  
3. **HTTP:** **GET resume** + **POST checkpoint** (+ status PATCH); draft-anchors may be alias of checkpoint drafts field.  
4. **Pause:** include thin **active↔paused** in Data Implement.  
5. **Summary field:** optional on DTO; default omit/skip; never gates `ok`.  
6. **Command log size on wire:** truncate to last **32** (existing ring max) already.  
7. **interactionParams:** reserve key now; V2-15 fills semantics.  
8. **read-service.ts:** leave course API unchanged; new teaching resume-service.

Escalate to Paula only if a default is rejected.

## 11. Implement gate (after Plan ACCEPT)

1. Integrator / designated Reviewer **ACCEPT** this Plan.  
2. Confirm DDL = **none** (or Integrator assigns `00xx` if open-problems table demanded).  
3. Separate Implement slices:  
   - **Data:** contracts → domain helpers → repo list/status/checkpoint → `resume-service.ts` → routes → OpeningApi helpers → tests T1–T18 → evidence per `review-test-gates.md`.  
   - **Experience:** `resume-card.tsx` + Workspace continue entry — after contracts stable (**not** this Understand/Plan slice).  
4. **This document does not authorize ALTER or product code.**

## 12. Files to add/change at Implement (preview)

| Path | Action | Owner |
|---|---|---|
| `packages/contracts/src/opening/teaching-resume.ts` (+ test) | New | Data |
| `packages/contracts/src/opening/index.ts` | Export | Data |
| `packages/domain/src/opening/teaching-resume.ts` (+ test) | New | Data |
| `packages/database/src/repositories/opening-teaching-activities.ts` | Add `setStatus` | Data |
| `packages/database/src/repositories/opening-learning-help.ts` (and/or attempts) | Activity-scoped list helpers | Data |
| `packages/database/src/repositories/opening-teaching-content.ts` | Reuse saveDraftAnchors / getClientInit; optional checkpoint merge helper | Data |
| `apps/web/src/features/opening/teaching/resume-service.ts` | New | Data |
| `apps/web/src/app/api/opening/teaching/activities/[id]/resume/route.ts` | New | Data |
| `apps/web/src/app/api/opening/teaching/activities/[id]/checkpoint/route.ts` | New | Data |
| Status route under teaching-activities | New | Data |
| `apps/web/src/features/opening/client/api.ts` | Wire GET resume / POST checkpoint / status | Data |
| `apps/web/src/features/opening/teaching/resume-card.tsx` | New UI | **Experience** |
| `apps/web/src/features/opening/learning/read-service.ts` | **Unchanged** (pattern ref only) | — |

**Not touching in V2-14 Data Implement:** Experience resume-card polish; V2-15 matrix widget; tutor conversation resume rewrite; push/hermes; inventing migration numbers; flipping `tasks.json` verified.
