# V2-14 Learning resume — Understand-stage evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`) — equals PM tip baseline after V2-13 merge  
**Stage:** Understand only (paired Plan written same turn). **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** Understand complete → Plan written; **not ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`

## Diff scope (this stage)

### Written

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-understand.md` | Understand |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-understand.md` | This evidence |

### Explicitly not touched

- No `apps/web/src/features/opening/teaching/resume-service.ts` product file
- No `resume-card.tsx` Experience UI
- No `packages/contracts/src/opening/teaching-resume.ts` / domain teaching-resume product code
- No edits to `read-service.ts` / teaching activity / content / commands product code
- No migration SQL; no ALTER
- No `tasks.json` verified / in_progress flip
- No push / hermes / stash / reset / commit

## Tip / branch verification

```text
$ git rev-parse HEAD
a8eb1937abd901691c4a926fa95f0832fe0aa584

$ git rev-parse --short HEAD
a8eb193

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
a8eb193 feat(opening): V2-13 teaching/answer evidence semantics (0057)

$ test ! -f apps/web/src/features/opening/teaching/resume-service.ts && echo RESUME_SERVICE_ABSENT
RESUME_SERVICE_ABSENT

$ test ! -f apps/web/src/features/opening/teaching/resume-card.tsx && echo RESUME_CARD_ABSENT
RESUME_CARD_ABSENT

$ test ! -f packages/contracts/src/opening/teaching-resume.ts && echo CONTRACT_RESUME_ABSENT
CONTRACT_RESUME_ABSENT

$ test ! -f packages/domain/src/opening/teaching-resume.ts && echo DOMAIN_RESUME_ABSENT
DOMAIN_RESUME_ABSENT

$ ls packages/database/src/migrations/*.sql | tail -1
packages/database/src/migrations/0057_opening_help_exposure_kind.sql

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:19 CST
```

## Inventory Reads (commands / paths)

### Authority

- `docs/plans/2026-10-11-ai-led-learning-v2.md` (charter G2/G7/G8, M1 pause→cross-device)
- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-14 (~L605–623) + §6.3 checkpoint API
- `docs/superpowers/plans/ai-led-learning-v2/tasks.json` id V2-14
- `docs/superpowers/plans/opening-release/review-test-gates.md`
- Style: `v2-12-teaching-commands-understand.md` / plan; `v2-13-teaching-answer-evidence-understand.md` / plan / evidence

### Required inventory paths

- `apps/web/src/features/opening/learning/read-service.ts` — course summarize only; pattern ref
- `apps/web/src/features/opening/teaching/activity-service.ts` — no pause/status
- `apps/web/src/features/opening/teaching/teaching-content-service.ts` — getClientInit + saveDraftAnchors (no HTTP drafts)
- `apps/web/src/features/opening/teaching/command-service.ts` — V2-12 commands
- `apps/web/src/features/opening/tutor/conversation-continuity.ts` — chat resume boundary
- `packages/contracts/src/opening/teaching-activity.ts` — status/generateStatus/checkpointJson; intent `resume`
- `packages/contracts/src/opening/teaching-content.ts` — clientInit + draft anchor schemas
- `packages/contracts/src/opening/teaching-commands.ts` — thought-train frames / log
- `packages/contracts/src/opening/learning.ts` — helpExposureKind (V2-13)
- `packages/domain/src/opening/teaching-commands.ts` — TEACHING_COMMAND_CHECKPOINT_KEYS; merge preserving prefs
- `packages/domain/src/opening/intervention-policy.ts` — interventionPrefs/Decisions keys
- `packages/database/src/repositories/opening-teaching-activities.ts` — assertOwned; setGenerateStatus; enqueueCompile; **no setStatus**
- `packages/database/src/repositories/opening-teaching-content.ts` — sanitizeCheckpointForRestore; getClientInit; saveDraftAnchors
- `packages/database/src/repositories/opening-teaching-commands.ts` — CAS commands + checkpoint merge
- `packages/database/src/repositories/opening-learning-help.ts` — insert delivered help (+ activity_id); no listByActivity
- `packages/database/src/repositories/opening-learning-facts.ts` — admitLearningSources (material gate)
- `packages/database/src/migrations/0053_opening_teaching_activities.sql` — checkpoint_json + paused + unknown
- `packages/database/src/migrations/0057_opening_help_exposure_kind.sql` — tip after V2-13
- `apps/worker/src/jobs/compile-teaching-unit.ts` — mapFailureStatus → unknown
- API routes: `teaching-activities/[id]/client-init` exists; **no** resume / checkpoint / draft-anchors routes
- OpeningApi: getTeachingClientInit + postTeachingCommand; **no** resume/checkpoint client
- Teaching tree localStorage: **none** for drafts

## Stronger-review (restatement vs PM)

| Lock | Encoded in Understand? |
|---|---|
| 1 Breakpoint fields | Yes — mapped to activity versions + checkpoint keys + fact tables |
| 2 Summary independence | Yes — resume/draft must not depend on summarize |
| 3 Server authority / local unsent only | Yes — no teaching draft localStorage; server CAS |
| 4 Permission / materials / unknown jobs | Yes — assertOwned + admitLearningSources + generateStatus |
| 5 Not chat window | Yes — ConversationResume called out as anti-example |
| 6 Nest / Integrator migration # | Yes — prefer no DDL; tip 0057; placeholder 00xx |
| 7 No push/hermes | Yes |

## Outcome

Understand complete. Paired Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md`. Awaiting Integrator Plan ACCEPT before any product Implement.
