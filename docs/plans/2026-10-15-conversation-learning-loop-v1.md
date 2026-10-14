# Conversation → Diagnosis → Task Preview → Evidence-driven Replan (V1)

**Branch:** feat/conversation-learning-loop-preview, stacked on feat/adaptive-loop-v2 (PR #43).  
**Status:** implemented as an **authenticated, feature-gated read-only preview**; NOT an autonomous chat agent or an accepted task workflow.  
**Switch:** OPENING_ADAPTIVE_PLANNING=1. No new migration.

## Why this seam

Existing Tutor calls the model once and returns text/candidates; it does not load the full task calendar or run a multi-step tool loop.
Existing planning accepts versioned drafts and has hard concurrency/authorization rules. This feature **does not bypass those rules**.

The V1 seam is:

1. POST a user message and **owned** course ID.
2. Extract bounded, **provisional** natural-language intent (zero-LLM deterministic fallback).
3. Load server-owned knowledge nodes, complete/partial qualified learning-summary aggregates, and accessible sources.
4. Diagnose using verified evidence only; self-reported difficulty is a hint for **diagnosis**, never a mastery upgrade.
5. Offer a conditional study session and time-slot preview. Use existing planDay and lock all accepted blocks; do not mutate tasks or plans.
6. For a **later server-qualified observation**, run replanAfterVerifiedObservation and recommendConversationDelta to produce next-step suggestions. Neither function persists results or changes mastery.

## API (implemented)

POST /api/opening/learning-agent/preview

- Requires authenticated Opening workspace, feature switch, owned non-archived course.
- Strict JSON body with maximum 8 KiB:

```json
{
  "message": "我十天后要考线性代数，矩阵乘法不太懂，每天晚上只有一小时，帮我安排一下，最好边讲边练。",
  "courseId": "<owned UUID>",
  "date": "2026-10-15"
}
```

- Date defaults to the workspace's local today and can be today to +14 days. Source of truth: planning_settings.timeZone, never a browser clock.
- Response shape (full Zod schemas in packages/contracts/src/opening/conversation-learning-loop.ts):

```ts
{
  policyVersion: "conversation-learning-v1",
  courseId,
  intent: {
    version: "conversation-intent-v1", extraction: "rule_fallback",
    kind: "study_and_plan", topic: "矩阵乘法",
    examInDays: 10, dailyMinutes: 60, selfReportedDifficulty: true,
    preferredStyle: "explain_then_practice", missing: []
  },
  diagnosis: {
    topic: "矩阵乘法", evidenceStatus: "unobserved",
    evidenceCount: 0, action: "diagnostic",
    reasonCodes: ["self_report_not_evidence","no_qualified_evidence"],
    masteryUpdated: false
  },
  session: {
    totalMinutes: 60, conditional: true,
    steps: [
      { kind: "diagnostic", minutes: 5, ... },
      { kind: "explain", minutes: 10, ... },
      { kind: "independent_practice", minutes: 25, ... },
      { kind: "transfer_check", minutes: 15, ... },
      { kind: "reflection", minutes: 5, ... }
    ]
  },
  plan: {
    date, proposedClientKey, proposedTask, proposedBlock,
    status: "scheduled" | "unscheduled" | "no_planning_settings",
    retainedAcceptedBlockCount, unscheduledReason, isCommitted: false
  },
  warnings: [], readOnly: true
}
```

NOTE: The intent's **relative exam date is provisional** and NOT automatically saved to course goals. A topic only matches if it occurs in authorized course knowledge/learning labels; unknown labels return a confirmation warning.
If a course has >200 summary groups or eligibility is updating, summaryComplete=false prevents false "unobserved" or "mastered" conclusions.
A summary read may update **derived eligibility projection** internally; no learning observations, mastery facts, tasks or accepted plans are committed by the preview.

## Pure evidence-driven replan (implemented, internal)

The domain function **must** receive persisted, server-verified eligibility, not browser-submitted fields:

```ts
const next = replanAfterVerifiedObservation({
  observationId: savedObservation.id,
  outcome: savedObservation.outcome,
  assistance: savedObservation.assistance,
  eligibility: qualifiedEligibility,
  remainingMinutes: 20
});
// => verify_evidence | guided_repair | independent_retry |
//    transfer_check | consider_next_topic

const delta = recommendConversationDelta({
  acceptedBlocks, tasks, now, evidenceReplan: next
});
// => { offer: boolean, taskIds, reason } (no writes)
```

Rules:
- unknown correctness / version applicability / inconsistent outcome -> verify_evidence
- verified incorrect -> guided_repair
- checked correct but assisted -> independent_retry
- checked independent current-version correct -> transfer_check
- checked **delayed** independent correct -> consider_next_topic
- no result, not even delayed success, marks mastery as changed; source of truth remains the Assessment pipeline.

## Permission and consistency boundaries

- GET-like preview call is POST only because it carries private chat text. Cache-Control: no-store.
- No autonomous acceptance in V1. Draft acceptance remains the existing PlanDraft optimistic-lock + clientKey operation in PR #43 L3.
- Existing accepted blocks are passed as kind=locked to planDay, and their task IDs are excluded from the remaining task list. No silent override or shifting.
- Other pending tasks may consume all remaining slots: status=unscheduled is not a failure and never invents free time.
- Model JSON or text cannot create a course, modify a workspace preference, assert an observation, or select a task ID.
- Preview task UUID comes from a workspace-scoped deterministic SHA-256 derivation; no DB row is created.

## Future work (NOT implemented in this slice)

1. Wire a bounded LLM semantic parser to the existing runBudgetedCall ledger, with schema validation and deterministic fallback.
2. Replace label-only topic matching with knowledgeNodeId + requirementKey identity across heterogeneous subject requirements.
3. Build a UI plan card in the assistant / Jingwei, with user confirmations for provisional exam deadlines, unrecognized topics and study windows.
4. Once PR #43 L2/L3 provides a real LearnerSnapshot and draft-accept transaction, map a confirmed contextual task to the **existing** SuggestedTask/PlanDraft accept pipeline, not a direct task INSERT.
5. Invoke evidence-driven replan from the persisted attempt/eligibility handler; offer a delta PlanDraft through existing proposeDeltaPlan. Never accept raw outcome or eligibility from a client.
6. Connect true AI teaching provider and interventions; keep fallback if it is unavailable.
7. Benchmark learning outcomes (delayed independent accuracy, transfer), not just task completion.

## Verification

- Unit: npx vitest run --project unit packages/domain/src/opening/adaptive/conversation-loop.test.ts
- Type: npm run typecheck -w @aistudy/contracts && npm run typecheck -w @aistudy/domain && npm run typecheck -w @aistudy/web
- Handler integration with isolated DB: npx vitest run --project integration tests/integration/handler/opening-conversation-learning-preview.test.ts
- Browser / real model: NOT performed; this slice has no UI and no LLM call.
- Rollback: disable OPENING_ADAPTIVE_PLANNING, or revert the PR; no migration was added.
