# Conversation → learning loop v1: API contracts and integration map

Base: `feat/adaptive-loop-v2` / PR #43. This is a **stacked, draft-only domain slice**, not a deployed autonomous Agent.

## Concrete example

User: "十天后考线性代数，矩阵乘法不懂，每晚 60 分钟，边讲边练。"

1. LLM extracts only untrusted `IntentCandidate`; the server resolves courseId ownership and topic against the current course knowledge snapshot. **Never guess** an absolute exam date from "十天后" without a reference date / time zone and user confirmation.
2. `resolveConversationIntent(candidate, { ownedCourseIds, supportedTopics })` -> `IntentResolution`. Issues are displayed as clarification chips. Neither self-reported difficulty nor self-reported success is valid independent evidence.
3. Read the current server-owned `LearningEvidenceSnapshot` from eligibility / retest repositories. Unknown or still-projecting evidence must be flagged `evidencePending`, not asserted correct.
4. `proposeLearningSession(resolution, evidence, availableMinutes)` -> `LearningSessionProposal` with diagnosis / explanation / independent practice / transfer / review steps. It refuses unknown course, topic, missing daily budget, or too little capacity.
5. `buildConversationTaskDraft({proposal, intentKey, idFor, free, options})` -> schedulable `TaskItem[]` plus `planDay` preview. `intentKey` is based on the persisted user turn id; ids are deterministically derived on server. Tasks are **not persisted** by this function.
6. On user confirmation, convert into existing `PlanDraft` suggested tasks, following `OPENING_ADAPTIVE_PLANNING` L2/L3. Only the *server-side* draft accept transaction may create `origin=agent` tasks; current public `taskCreateInputSchema` correctly refuses callers setting agent origin.
7. Start learning through existing teaching activity or practice APIs, then record actual attempts (not just clicks or minutes). Query refreshed evidence; `previewEvidenceTriggeredReplan` creates only a preview and never changes accepted blocks.

## Proposed HTTP API (NOT yet implemented in this PR)

All routes below require the existing Opening authentication / workspace authorization, Zod input/output validation, rate and cost budgets, and feature flag `OPENING_PLAN_AGENT`. All writes need idempotency keys and expected accepted version. Avoid client-trusted evidence or schedule authority.

### POST /api/opening/agent/intent-preview

Request:
```json
{
  "conversationId": "owned-uuid",
  "sourceTurnId": "owned-uuid",
  "candidate": {
    "courseId": "owned-course-uuid",
    "topic": "矩阵乘法",
    "examDate": null,
    "dailyMinutes": 60,
    "preferences": ["explanation", "practice"],
    "selfReportedDifficulty": true
  }
}
```

Response (example):
```json
{
  "status": "needs_clarification",
  "issues": ["ambiguous_exam_date"],
  "intent": { "courseId": "owned-course-uuid", "topic": "矩阵乘法", "examDate": null, "dailyMinutes": 60, "preferences": ["explanation", "practice"], "selfReportedDifficulty": true }
}
```

The LLM should receive a **small explicit tool catalog** (read learner state, read calendar, propose plan) rather than database credentials. Evidence facts are loaded by service and not accepted in the request body.

### POST /api/opening/agent/learning-preview

Request:
```json
{ "sourceTurnId": "owned-uuid", "intentRevision": 1, "clientKey": "turn:owned-uuid:learning", "expectedAcceptedVersion": 0 }
```

Response:
```json
{
  "status": "draft",
  "draftId": "server-uuid",
  "totalMinutes": 60,
  "steps": [
    {"kind":"diagnostic","minutes":6,"reasonCode":"self_report_not_evidence"},
    {"kind":"explain","minutes":12,"reasonCode":"guided_explanation"},
    {"kind":"independent_practice","minutes":24,"reasonCode":"independent_evidence_needed"},
    {"kind":"transfer","minutes":12,"reasonCode":"transfer_evidence_needed"},
    {"kind":"review","minutes":6,"reasonCode":"retention_plan"}
  ],
  "requiresAcceptance": true
}
```

The exact allocations in this example apply when explanation is preferred, no qualified independent evidence exists, and the full 60 minutes is available. Return real per-step minutes from the pure function, not canned client-side values.

### POST /api/opening/agent/replan-preview

Request:
```json
{ "date": "2026-10-20", "expectedAcceptedVersion": 1, "clientKey": "replan:turn-uuid:event-uuid" }
```

Response:
```json
{ "status": "draft", "reason": "missed_block", "requiresAcceptance": true, "blocks": [], "unscheduledTaskIds": [] }
```

Server loads actual confirmed blocks, tasks, free slots, and current instant. Empty blocks above are placeholders for the response shape, NOT successful scheduling evidence.

## Required follow-up implementation

- Add Zod schemas in `packages/contracts/src/opening/` for intent candidate, preview request, draft response, and replan response.
- Create read-only learner snapshot adapter in `apps/web/src/features/opening/agent/` using the existing owned-course, eligibility, card due, and timetable repositories.
- Integrate L2/L3 draft storage and acceptance: ensure course ownership, knowledge node identity (`nodeId + requirementKey` where available), `clientKey` idempotency, concurrency and rollback.
- Wire a bounded multi-step Agent loop in Worker, reusing `runBudgetedCall`, saved conversation privacy epoch, and existing turn ownership checks. Do not retrofit arbitrary write access into `provider.ts`.
- Link accepted Task → TeachingActivity → Attempt → Eligibility revision → optional replan. Task completion alone must not mark mastery.
- Use `@aistudy/jingwei` to render a rich preview / reasons / confirmation card; Jingwei is presentation, not the reasoning engine.

## Verification

Focused tests (once a checked-out environment with dependencies is available):

```bash
npx vitest run --project unit packages/domain/src/opening/adaptive/conversation-learning.test.ts packages/domain/src/opening/adaptive/conversation-task-draft.test.ts
npm run typecheck -w @aistudy/domain
```

Then handler/integration and real-provider E2E after wiring. Do **not** call this an end-to-end completed feature until those are green and user browser acceptance passes.
