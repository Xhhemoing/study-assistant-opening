# V2-14 Understand — 保存学习断点并支持跨端恢复

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`feat/opening-release`) — equals PM tip baseline after V2-13 merge (`a8eb193`)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no ALTER, no push / hermes / stash / reset / commit**)  
**Authority:** Charter `docs/plans/2026-10-11-ai-led-learning-v2.md`; `plan.md` §V2-14 (~L605–623); `tasks.json` V2-14; gates `docs/superpowers/plans/opening-release/review-test-gates.md`; style refs `v2-12-teaching-commands-*.md` / `v2-13-teaching-answer-evidence-*.md`  
**Do not conflate:** Conversation `GET .../conversations/{id}/resume` = **chat window only** (G7 anti-example). V2-14 = **teaching activity** structured resume. V2-05 drafts/clientInit ≠ full resume package. V2-12 branchStack/commandLog = train-of-thought fragment, not the whole breakpoint.

## Restated outcome

Persist and restore a **learning breakpoint** so the learner can pause and continue on another device into the **same teaching activity**, with the same train of thought, drafts, actual attempts, help already delivered, and immediately continuable actions — not merely a chat transcript.

Concretely (PM design locks → restatement):

1. **Breakpoint includes:** content version, current block / interaction params, drafts, actual attempts, help already delivered, open problems.
2. **Summary generation may fail;** structured resume + draft save **must not** depend on summary success.
3. **Server is authority** for official state; **local only holds unsent drafts**.
4. **On resume:** check **permission**, **material availability**, **unknown jobs**.
5. **Resume restores** same activity + train of thought + drafts + immediately continuable actions — **not** just the chat window.
6. **Nest** existing activity / `checkpoint_json`; **no parallel product**; migration number **only if Integrator assigns**.
7. **No push / hermes**.

## Why this exists (gap after V2-04…V2-13)

| Layer | Landed | Missing / wrong for V2-14 |
|---|---|---|
| Activity + checkpoint bag | V2-04 `opening_teaching_activities` + `checkpoint_json` JSONB; status ∈ {active,paused,completed,skipped}; `content_version` / `path_version` | **No** `setStatus` / pause API; status column exists but repo only mutates `generate_status` |
| Content versions + clientInit | V2-05 `getClientInit` (redacted blocks + sanitized checkpoint); `saveDraftAnchors` CAS | **No HTTP** for draft-anchors / plan.md `POST .../checkpoint`; UI copy still says “保存需服务端 draft-anchors 接口” |
| Compile / unknown jobs | V2-07 `generateStatus` includes `unknown`; compile job fences | Resume does **not** yet surface `generateStatus=unknown` / in-flight as first-class resume gate |
| Commands / train of thought | V2-12 `branchStack`, `commandLog`, `currentBlockId`, `skippedBlockIds` + CAS | No cross-device **resume package** that bundles path + drafts + evidence + actions |
| Help delivered | V2-13 `opening_help_exposures.kind` + nullable `activity_id` (migration **0057**) | **No** activity-scoped list/read for resume projection |
| Attempts / observations | `activity_id` on attempts/observations (0053) | **No** activity-scoped “actual attempts / open problems” aggregator for resume |
| Intervention keys | V2-11 `interventionPrefs` / `interventionDecisions` on checkpoint | Must stay **disjoint** from V2-14 keys (`interactionParams`, open-problem projection) |
| Chat resume | `buildConversationResume` / `GET .../conversations/[id]/resume` | **Wrong product** for G7 — must not be reused as teaching resume |
| Proposed modules | — | `resume-service.ts` / `resume-card.tsx` / `teaching-resume` contracts+domain **ABSENT** |
| `read-service.ts` | Course-scoped observation list + summarize | Auth-then-read pattern reusable; **not** an activity resume package |

## PM locks map (must encode in Plan)

| # | PM lock | Inventory anchor | Plan must |
|---|---|---|---|
| 1 | Breakpoint = content version + current block/interaction params + drafts + actual attempts + help delivered + open problems | `contentVersion` on activity/clientInit; `checkpoint.currentBlockId` / (proposed) `interactionParams`; `checkpoint.drafts`; attempts/help tables; open problems projection | Define `LearningResume` composing these; do not invent a second ledger |
| 2 | Summary may fail; structured resume + draft save independent | `createOpeningLearningReadService.summarizeLearning`; draft save path in content repo | Resume assemble **never** calls summarize / AI digest; draft save stays CAS-only |
| 3 | Server authority; local = unsent drafts only | `saveDraftAnchors` server checkpoint; no teaching `localStorage` for drafts today | Official state = server; client may buffer unsent draft text only until POST succeeds |
| 4 | Resume checks permission, material availability, unknown jobs | `assertOwnedActivity`; `admitLearningSources` / privacy exclusions; `generateStatus` ∈ {unknown,queued,generating,…} | Gate resume with ownership + source availability probe + unknown/in-flight job flags |
| 5 | Same activity + thought train + drafts + continuable actions ≠ chat window | V2-12 checkpoint path keys; commands API; clientInit | Resume returns activityId + clientInit + checkpoint path + evidence summaries + next-action hints — **not** `ConversationResume` |
| 6 | Nest activity/checkpoint; Integrator assigns migration # | tip migrations end **0057**; checkpoint jsonb already present | Prefer **no DDL**; placeholder `00xx` only if Integrator demands indexed table |
| 7 | No push/hermes | gates | Docs only this slice |

## Inventory (paths cited)

### 1. Authority / task

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-14 (~L605–623): reuse `learning/read-service.ts`; proposed `teaching/resume-service.ts` + `resume-card.tsx`; verify refresh mid-generate, offline reconnect, service restart, other device, citation withdrawn, source version change; draft local conflicts kept side-by-side (no silent overwrite); accept: restore activity+thought+drafts+continuable actions; rollback: keep read-only resume data + draft export; closing auto-summary must not block continue.
- `plan.md` §6.3 proposed `POST .../activities/{id}/checkpoint` (save drafts + recoverable state; version conflicts explicit).
- `tasks.json` V2-14 — owner `数据/前端`; depends_on V2-04, V2-05, V2-07, V2-12, V2-13; goals G2/G7/G8; status `proposed`; evidence_status all `not_run` / pending_user / unknown.
- Charter G7 continuous recovery; G2 companionship continuity; Facts ledger — Observation/Attempt/Exposure only.
- Gates: Implementer ≠ Accepter; no self-verified; no push/hermes by default.

### 2. Activity + checkpoint (V2-04)

- Migration `0053_opening_teaching_activities.sql`: `checkpoint_json JSONB NOT NULL DEFAULT '{}'`; `content_version`; `path_version`; `status` includes `paused`; `generate_status` includes `unknown`.
- Repo `packages/database/src/repositories/opening-teaching-activities.ts`: `create` / `get` / `listByOwner` / `associateCourse` / `setGenerateStatus` / `enqueueCompileTeachingUnit` / `assertOwnedActivity`. **No** `setStatus` / pause / resume status transition.
- Contract `packages/contracts/src/opening/teaching-activity.ts`: `intentKind` includes `resume` / `course_continue`; activity schema exposes `checkpointJson` optional; generateStatus enum already has `unknown`.
- Thin service `apps/web/src/features/opening/teaching/activity-service.ts` — create/get/list/associate only.

### 3. Content versions + drafts + clientInit (V2-05)

- `getClientInit(scope, activityId)` → ActivitySpecClientInit with redacted blocks, `contentVersion`, `sanitizeCheckpointForRestore(checkpoint)`.
- `sanitizeCheckpointForRestore` strips answerKeys / solutions / unrevealedAnswers and nulls hidden answer_key content.
- `saveDraftAnchors`: CAS `expectedVersion === content_version`; merges `{ ...prev, drafts }`; lost blockIds → `{ ok:false, mismatch:"draft_anchor_lost", lostBlockIds }` (no LWW drop).
- Contracts: `teachingDraftAnchorSchema`, `teachingDraftAnchorsSaveInputSchema` / Result.
- Service `teaching-content-service.ts` exposes `getClientInit` + `saveDraftAnchors`.
- HTTP: `GET .../teaching-activities/[id]/client-init` **exists**. **No** `POST .../draft-anchors` or `POST .../checkpoint` route under `apps/web/src/app/api/opening/` (inventory).
- OpeningApi: `getTeachingClientInit` exists; **no** draft-save / resume client helpers.
- UI: `block-renderer.tsx` notes draft save needs server draft-anchors API.

### 4. Commands / train of thought (V2-12)

- Checkpoint keys owned by commands: `branchStack`, `commandLog`, `currentBlockId`, `skippedBlockIds` (+ `commandReplay` store); merge via `mergeCheckpointPreservingPrefs` **preserves** `interventionPrefs` / `interventionDecisions` / `drafts` / unknown keys.
- `TEACHING_COMMAND_CHECKPOINT_KEYS` documents disjointness from V2-11.
- Commands CAS on `expectedVersion` (+ optional path/revision); conflicts force reread — never silent overwrite.
- Continuable actions today: why / rephrase / expand / example / skip / branch / return (when stack non-empty) via `POST .../teaching/activities/{id}/commands`.

### 5. Help / attempts / observations (V2-13 + learning facts)

- Help: `insertOpeningDeliveredHelp` persists `kind`, `activity_id`, `item_version_id`; **no** `listByActivity` reader yet.
- Attempts / observations carry `activity_id` from session; list APIs remain primarily course/session-scoped (`read-service.ts` course evidence).
- Open problems: **no** dedicated table or checkpoint key today — must be **derived** (Plan default) from attempts/observations (e.g. in-progress / incorrect / unverified without later independent correct head) and/or optional checkpoint `openProblemIds` mirror — **not** a parallel problem product.

### 6. Jobs / materials / permission

- Permission: `assertOwnedActivity` — other owner → NOT_FOUND (no cross-workspace leak). Same pattern for resume.
- Materials: `admitLearningSources` requires uploaded + chunks present + **not** privacy-excluded; else `VALIDATION` “source unavailable or privacy-excluded”. Source version rows track `availability`. Withdrawn / deleted sources → resume must flag material unavailable (do not pretend blocks still authoritative).
- Unknown jobs: compile handler maps provider timeout/network → `generateStatus=unknown`; queued/generating also block rewrite commands (`generate_in_flight`). Resume must expose these so UI can wait / fail-soft without inventing success.

### 7. Chat resume (boundary — do not reuse as teaching resume)

- `apps/web/src/features/opening/tutor/conversation-continuity.ts` `buildConversationResume` → conversationId + boundedHistory + sticky page/chunk.
- Acceptable as **tutor chat** continuity; **insufficient** for V2-14 acceptance (G7 anti-example: “只恢复聊天窗口”).

### 8. Local storage

- Teaching feature tree: **no** `localStorage` / IndexedDB for drafts (only shell sidebar collapsed key).
- Plan implication: M1 “local only holds unsent drafts” = **in-memory / component state** until POST; optional durable local buffer is Experience concern and must never become official authority.

### 9. Related slices (boundaries)

| Slice | Relation |
|---|---|
| V2-04 | Activity + checkpoint bag — **nest here** |
| V2-05 | clientInit + draft anchors — **wire + compose** |
| V2-07 | generateStatus / unknown jobs — **resume gates** |
| V2-11 | interventionPrefs/Decisions — **disjoint keys** |
| V2-12 | branchStack/commandLog/currentBlockId — **thought train** |
| V2-13 | help kind + activity_id — **help delivered projection** |
| V2-15 | interaction params for matrix_transform — reserve `interactionParams` key; do not implement widget |
| Tutor conversation resume | **Out of product** for teaching resume |

## Out of scope (OOS) for V2-14 Understand+Plan

- **No product Implement** / no Experience UI (`resume-card.tsx`) / no ALTER / migrate / commit / push / hermes / stash / reset.
- Inventing migration numbers (keep `00xx`; tip ends **0057**).
- Parallel resume / second activity product / Episode-as-truth / chat-as-resume.
- V2-15 matrix widget Implement; inventing mastery from resume.
- Flipping `tasks.json` → verified / in_progress.
- Rewriting tutor-turn orchestration or conversation resume APIs as the teaching path.

## Open decisions for PM / Paula

1. **Open problems storage:** Plan default = **derive** from attempt/observation heads (+ optional non-authoritative `checkpoint.openProblemIds` cache). Confirm if Integrator wants an indexed table → then DDL `00xx`.
2. **HTTP shape:** Plan default = `GET .../teaching/activities/{id}/resume` (LearningResume package) + `POST .../checkpoint` (or draft-anchors) for writes — align naming with plan.md §6.3.
3. **Pause write in same Data slice?** Status enum already has `paused`; Plan default = include thin `setStatus` (active↔paused) with ownership CAS so cross-device lists can show paused activities.
4. **Summary:** Confirm auto-summary remains **best-effort** and never gates draft save / resume (Plan encodes this).
5. **Local durable draft buffer:** Experience may add later; Data M1 does not require IndexedDB.

Escalate only if a Plan default is rejected.

## Stronger-review note

Restatement matches PM locks 1–7. Risk if Implement only wires chat resume or only returns `getClientInit` without attempts/help/open-problems/gates: would fail G7 acceptance. Risk if draft save waits on summary job: violates lock 2. Risk if new `opening_learning_resume` table forks state: violates lock 6.
